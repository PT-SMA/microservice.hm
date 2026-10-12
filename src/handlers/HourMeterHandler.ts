import { BaseHandler } from "classes/bases";
import { HM_CHANNELS, HM_STATE_KEY, LOGGING } from "consts";
import {
  bootHash,
  toHourMeterEvent,
  toHourMeterUpdate,
  toStateHash,
} from "helpers";
import { type DecodedMessage, MSG } from "hour-meter";
import { redisPublisher } from "modules";
import type { BootSummary, HandlerType, HourMeterPublisher } from "types";

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
 * - anything else (the 10 Hz IMU stream, ACKs) → nothing.
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

  /**
   * `publisher` defaults to Redis; `tests/handler.test.ts` passes a recorder,
   * so the publish contract is asserted without a live Redis.
   */
  constructor(
    publisher: HourMeterPublisher = redisPublisher,
    {
      newId = () => crypto.randomUUID(),
      now = () => Date.now(),
    }: { newId?: () => string; now?: () => number } = {},
  ) {
    super();
    this.#publisher = publisher;
    this.#newId = newId;
    this.#now = now;
  }

  override async handle(
    msg: DecodedMessage,
    context: FrameContext = {},
  ): Promise<void> {
    try {
      if (msg.msgType === MSG.TELEMETRY) await this.#publishUpdate(msg);
      else if (msg.msgType === MSG.EVENT) {
        await this.#publishEvent(msg, context.bootCount ?? 0);
      } else return;
      this.#recovered();
    } catch (err) {
      this.#failed(err);
    }
  }

  async #publishUpdate(msg: DecodedMessage) {
    const update = toHourMeterUpdate(msg, {
      uuid: this.#newId(),
      now: this.#now(),
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
