import { BaseHandler } from "classes/bases";
import { HM_CHANNELS } from "consts";
import type { ImuSource } from "direction";
import {
  parseCommand,
  parseImuSource,
  readSettings,
  settingsSchema,
  validateSettings,
} from "helpers";
import {
  ACK_STATUS,
  AckError,
  type DecodedMessage,
  GET,
  tags,
} from "hour-meter";
import { redisPublisher } from "modules";
import { DeviceUnavailableError } from "sensors";
import type {
  HandlerType,
  HourMeterImuSourceState,
  HourMeterPublisher,
  HourMeterReply,
} from "types";

/** What the handler needs from the device side — `HourMeterSensor`. */
export interface DeviceCommander {
  command(
    values: Record<string, number | boolean>,
    options?: { timeoutMs?: number; retries?: number },
  ): Promise<DecodedMessage>;
  currentDeviceId(): string | null;
}

/** What the handler needs to read and switch the IMU — `MainApp`. */
export interface ImuSourceControl {
  get(): HourMeterImuSourceState;
  /** switch to `source` and keep it; null goes back to HOUR_METER_IMU_SOURCE */
  set(source: ImuSource | null): Promise<HourMeterImuSourceState>;
}

const describe = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * `hour-meter:command` → the device → `hour-meter:reply`: geofencer reads and
 * changes the hour meter's settings (contract:
 * FMS-Backend/docs/ecosystem/integrations/hm-to-geofencer.md § Commands).
 *
 * - `getSettings`: COMMAND `get=2`, reply with the settings and their schema.
 * - `setSettings`: checked here first (`validateSettings` — unknown,
 *   read-only and out-of-range settings never reach the device), sent as one
 *   COMMAND (the device applies it all or nothing), then read back with
 *   `get=2` so the reply says what the device holds now.
 * - `getImuSource` / `setImuSource`: which IMU this service reads, and a
 *   switch to the other (`ImuSourceControl`, kept across restarts) — no
 *   device involved.
 *
 * Commands run one at a time, so a change and its read-back cannot interleave
 * with another request. Exactly one reply per command that carries a
 * `requestId`. Never throws: it runs on a subscription callback.
 */
export class HourMeterCommandHandler extends BaseHandler {
  override type: HandlerType = "general";

  #device: DeviceCommander;
  #publisher: Pick<HourMeterPublisher, "publish">;
  #imu: ImuSourceControl | null;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    device: DeviceCommander,
    publisher: Pick<HourMeterPublisher, "publish"> = redisPublisher,
    imu: ImuSourceControl | null = null,
  ) {
    super();
    this.#device = device;
    this.#publisher = publisher;
    this.#imu = imu;
  }

  /** Resolves once this command has been answered. */
  override handle(message: string): Promise<void> {
    const run = this.#queue.then(() => this.#answer(message));
    this.#queue = run.catch(() => {});
    return this.#queue;
  }

  async #answer(message: string): Promise<void> {
    const parsed = parseCommand(message);
    if (parsed === null) {
      console.warn("hour-meter: command without a requestId — ignored");
      return;
    }

    let reply: HourMeterReply;
    if ("error" in parsed) {
      reply = {
        requestId: parsed.requestId,
        status: "invalid",
        message: parsed.error,
      };
    } else {
      try {
        reply = parsed.action === "getImuSource"
          ? this.#getImuSource(parsed.requestId)
          : parsed.action === "setImuSource"
          ? await this.#setImuSource(parsed.requestId, parsed.imuSource)
          : parsed.action === "setSettings"
          ? await this.#setSettings(parsed.requestId, parsed.settings)
          : await this.#getSettings(parsed.requestId);
      } catch (err) {
        reply = this.#failure(parsed.requestId, err);
      }
    }

    try {
      await this.#publisher.publish(HM_CHANNELS.reply, JSON.stringify(reply));
    } catch (err) {
      console.error(
        `hour-meter: could not reply to ${reply.requestId}: ${describe(err)}`,
      );
    }
  }

  #getImuSource(requestId: string): HourMeterReply {
    if (this.#imu === null) return this.#noImuControl(requestId);
    return { ...this.#identity(requestId), status: "ok", imu: this.#imu.get() };
  }

  async #setImuSource(
    requestId: string,
    value: unknown,
  ): Promise<HourMeterReply> {
    if (this.#imu === null) return this.#noImuControl(requestId);
    const source = value === null
      ? null
      : typeof value === "string"
      ? parseImuSource(value)
      : undefined;
    if (source === undefined || (value !== null && source === null)) {
      return {
        requestId,
        status: "invalid",
        message: `imuSource must be hm, wit or null, not ${
          JSON.stringify(value ?? "nothing")
        }`,
      };
    }
    const imu = await this.#imu.set(source);
    console.log(
      `hour-meter: IMU ${
        source === null ? "back to HOUR_METER_IMU_SOURCE" : `set to ${source}`
      } by request ${requestId}; in use: ${imu.source ?? "none"}`,
    );
    return { ...this.#identity(requestId), status: "ok", imu };
  }

  #noImuControl(requestId: string): HourMeterReply {
    return {
      requestId,
      status: "invalid",
      message: "this service cannot switch its IMU",
    };
  }

  async #getSettings(requestId: string): Promise<HourMeterReply> {
    const ack = await this.#device.command({ get: GET.settings });
    return this.#ok(requestId, ack);
  }

  async #setSettings(
    requestId: string,
    settings: unknown,
  ): Promise<HourMeterReply> {
    const check = validateSettings(settings);
    if (!check.ok) {
      const reply: HourMeterReply = {
        requestId,
        status: "invalid",
        message: check.message,
      };
      if (check.setting !== undefined) reply.setting = check.setting;
      return reply;
    }

    await this.#device.command(check.values);
    console.log(
      `hour-meter: settings changed by request ${requestId}: ${
        JSON.stringify(check.values)
      }`,
    );

    // Applied. A read-back that fails must not turn that into a failure.
    try {
      const ack = await this.#device.command({ get: GET.settings });
      return this.#ok(requestId, ack);
    } catch (err) {
      return {
        ...this.#identity(requestId),
        status: "ok",
        message: `applied; reading the settings back failed: ${describe(err)}`,
      };
    }
  }

  #ok(requestId: string, ack: DecodedMessage): HourMeterReply {
    return {
      ...this.#identity(requestId),
      status: "ok",
      settings: readSettings(ack),
      schema: settingsSchema(),
    };
  }

  #failure(requestId: string, err: unknown): HourMeterReply {
    if (err instanceof DeviceUnavailableError) {
      return { requestId, status: "unavailable", message: err.message };
    }
    if (err instanceof AckError) {
      const status = Number(err.ack.values.ackStatus);
      const tag = Number(err.ack.values.rejectedTag);
      const reply: HourMeterReply = {
        ...this.#identity(requestId),
        status: "rejected",
        ackStatus: ACK_STATUS[status] ?? String(status),
        message: err.message,
      };
      const setting = tag ? tags[tag]?.name : undefined;
      if (setting !== undefined) reply.setting = setting;
      return reply;
    }
    // the vendored client's "no ACK after N attempts"
    if (err instanceof Error && err.message.startsWith("no ACK")) {
      return {
        ...this.#identity(requestId),
        status: "timeout",
        message: err.message,
      };
    }
    console.error(`hour-meter: command ${requestId} failed: ${describe(err)}`);
    return { requestId, status: "error", message: describe(err) };
  }

  #identity(requestId: string): Pick<HourMeterReply, "requestId" | "deviceId"> {
    const deviceId = this.#device.currentDeviceId();
    return deviceId === null ? { requestId } : { requestId, deviceId };
  }
}
