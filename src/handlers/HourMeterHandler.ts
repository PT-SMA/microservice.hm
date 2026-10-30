import { BaseHandler } from "classes/bases";
import { HM_CHANNELS, HM_STATE_KEY, LOGGING } from "consts";
import {
  bootHash,
  type MessageContext,
  toHourMeterEvent,
  toHourMeterUpdate,
  toStateHash,
} from "helpers";
import type { DirectionChange, DirectionSnapshot } from "direction";
import { type DecodedMessage, MSG } from "hour-meter";
import { redisPublisher } from "modules";
import type {
  BootSummary,
  HandlerType,
  HourMeterPublisher,
  TravelDirectionUpdate,
} from "types";

/** What the sensor knows about the device that a single frame does not. */
export interface FrameContext {
  /** Device boots seen since this adaptor started. */
  bootCount?: number;
}

/**
 * Turns decoded frames into the `hour-meter:*` Redis surface geofencer reads
 * (FMS-Backend/docs/ecosystem/integrations/hm-to-geofencer.md):
 *
 * - TELEMETRY → replace `hour-meter:state`, **then** publish
 *   `hour-meter:update` (naming-rules.md rule 13: publish after the write), so
 *   a consumer that hears the message can always read the state it describes.
 * - EVENT → publish `hour-meter:event`; a boot also updates the boot facts in
 *   the hash.
 * - anything else (the IMU stream, ACKs) → nothing.
 * - a travel-direction change (`publishDirectionChange`) → merge it into
 *   `hour-meter:state`, then publish `travel-direction:update`.
 *
 * Every write goes through one chain, in order: a direction merged into the
 * hash cannot be overwritten by a replace that was already in flight.
 *
 * Never throws. A Redis failure is logged once per outage and the reading is
 * dropped: the reader must never stop over a dependency it does not have.
 */
export class HourMeterHandler extends BaseHandler {
  override type: HandlerType = "general";

  #publisher: HourMeterPublisher;
  #newId: () => string;
  #now: () => number;
  #boot: BootSummary = { bootCount: 0 };
  #failing = false;
  #dropped = 0;
  #direction: () => DirectionSnapshot | null;
  #imu: () => MessageContext["imu"];
  #chain: Promise<void> = Promise.resolve();

  /**
   * `publisher` defaults to Redis; `tests/handler.test.ts` passes a recorder,
   * so the publish contract is asserted without a live Redis.
   */
  constructor(
    publisher: HourMeterPublisher = redisPublisher,
    {
      newId = () => crypto.randomUUID(),
      now = () => Date.now(),
      direction = () => null,
      imu = () => undefined,
    }: {
      newId?: () => string;
      now?: () => number;
      /** the travel-direction estimator's state; null while it is off */
      direction?: () => DirectionSnapshot | null;
      /** the selected IMU (HOUR_METER_IMU_SOURCE); undefined = the hour meter's */
      imu?: () => MessageContext["imu"];
    } = {},
  ) {
    super();
    this.#direction = direction;
    this.#imu = imu;
    this.#publisher = publisher;
    this.#newId = newId;
    this.#now = now;
  }

  override handle(
    msg: DecodedMessage,
    context: FrameContext = {},
  ): Promise<void> {
    if (msg.msgType === MSG.TELEMETRY) {
      return this.#enqueue(() => this.#publishUpdate(msg));
    }
    if (msg.msgType === MSG.EVENT) {
      return this.#enqueue(() =>
        this.#publishEvent(msg, context.bootCount ?? 0)
      );
    }
    return Promise.resolve();
  }

  /** A change of the travel direction: into the hash first, then announced. */
  publishDirectionChange(
    change: DirectionChange,
    deviceId: string | null,
  ): Promise<void> {
    return this.#enqueue(async () => {
      const changedAt = new Date(change.changedAtMs).toISOString();
      await this.#publisher.mergeHash(HM_STATE_KEY, {
        travelDirection: change.travelDirection,
        travelDirectionChangedAt: changedAt,
      });
      const message: TravelDirectionUpdate = {
        uuid: this.#newId(),
        ...(deviceId === null ? {} : { deviceId }),
        changedAt,
        travelDirection: change.travelDirection,
        previousTravelDirection: change.previousTravelDirection,
        basis: change.basis,
        correction: change.correction,
      };
      await this.#publisher.publish(
        HM_CHANNELS.travelDirection,
        JSON.stringify(message),
      );
    });
  }

  #enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.#chain.then(async () => {
      try {
        await job();
        this.#recovered();
      } catch (err) {
        this.#failed(err);
      }
    });
    this.#chain = run;
    return run;
  }

  async #publishUpdate(msg: DecodedMessage) {
    const update = toHourMeterUpdate(msg, {
      uuid: this.#newId(),
      now: this.#now(),
      direction: this.#direction(),
      imu: this.#imu(),
    });
    if (update === null) {
      console.warn(
        `hour-meter: TELEMETRY seq ${msg.seq} lacks the counters — dropped`,
      );
      return;
    }
    await this.#publisher.replaceHash(
      HM_STATE_KEY,
      toStateHash(update, this.#boot),
    );
    await this.#publisher.publish(HM_CHANNELS.update, JSON.stringify(update));

    if (LOGGING) {
      console.log(
        `[${update.receivedAt}] hour meter ${update.hourMeterH} h, ` +
          `totalizer ${update.totalizerUnits}, engine ` +
          (update.engineRunning ? "running" : "off"),
      );
    }
  }

  async #publishEvent(msg: DecodedMessage, bootCount: number) {
    const event = toHourMeterEvent(msg, {
      uuid: this.#newId(),
      now: this.#now(),
      bootCount,
    });
    if (event === null) return;

    if (event.fwVersion !== undefined) this.#boot.fwVersion = event.fwVersion;
    if (event.kind === "boot") {
      this.#boot = {
        ...this.#boot,
        bootCount,
        lastBootAt: event.receivedAt,
        lastBootCause: event.lastCause,
      };
    }
    await this.#publisher.mergeHash(HM_STATE_KEY, bootHash(this.#boot));
    await this.#publisher.publish(HM_CHANNELS.event, JSON.stringify(event));
  }

  #failed(err: unknown) {
    this.#dropped += 1;
    if (this.#failing) return;
    this.#failing = true;
    console.error(
      `hour-meter: publish failed, dropping readings until Redis is back: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  #recovered() {
    if (!this.#failing) return;
    console.log(
      `hour-meter: publishing resumed (${this.#dropped} message(s) dropped)`,
    );
    this.#failing = false;
    this.#dropped = 0;
  }
}
