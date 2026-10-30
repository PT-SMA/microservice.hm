import { BaseHandler } from "classes/bases";
import { HM_CHANNELS, HM_EVENTS, WT61_EVENTS } from "consts";
import type { ForwardAxis, ImuSource } from "direction";
import {
  addSample,
  closeWindow,
  formatDeviceId,
  type ImuReading,
  imuReadingFromFrame,
  imuReadingFromWt61,
  type ImuWindow,
  imuWindow,
} from "helpers";
import type { DecodedMessage } from "hour-meter";
import type { EventEmitter } from "node:events";
import type { HandlerType, HourMeterPublisher, Wt61Sample } from "types";

export interface ImuPublishOptions {
  /** the travel direction's IMU: the same one, never both */
  source: ImuSource;
  forwardAxis: ForwardAxis;
  /** messages per second; 0 publishes nothing */
  hz: number;
  publisher: Pick<HourMeterPublisher, "publish">;
  now?: () => number;
}

/**
 * Publishes the travel direction's IMU on `hour-meter:imu`, decimated to
 * `hz` (`helpers/imu-publish.ts`): the WT61's samples (`WT61_EVENTS.sample`)
 * or the hour meter's own stream (`HM_EVENTS.imu`). For geofencer's dev
 * console; nothing depends on it.
 *
 * Fire and forget: it runs inside the read pumps, so nothing may escape. A
 * publish that fails (Redis down: `disableOfflineQueue` fails it at once) is
 * dropped, said once, and said again when publishing is back.
 */
export class ImuPublishHandler extends BaseHandler {
  override type: HandlerType = "general";

  readonly source: ImuSource;
  readonly hz: number;
  #forwardAxis: ForwardAxis;
  #publisher: Pick<HourMeterPublisher, "publish">;
  #now: () => number;
  #window: ImuWindow = imuWindow();
  #deviceId: string | undefined;
  #failing = false;

  constructor(options: ImuPublishOptions) {
    super();
    this.source = options.source;
    this.hz = options.hz;
    this.#forwardAxis = options.forwardAxis;
    this.#publisher = options.publisher;
    this.#now = options.now ?? Date.now;
    this.onImu = this.onImu.bind(this);
    this.onWt61Sample = this.onWt61Sample.bind(this);
  }

  /** Not used: it listens to the emitter (`attach`). */
  override handle(): void {}

  attach(emitter: EventEmitter): void {
    if (this.hz <= 0) return;
    if (this.source === "wt61") {
      emitter.on(WT61_EVENTS.sample, this.onWt61Sample);
    } else {
      emitter.on(HM_EVENTS.imu, this.onImu);
    }
  }

  /** Stop listening (the IMU was switched); a window in progress is dropped. */
  detach(emitter: EventEmitter): void {
    emitter.off(WT61_EVENTS.sample, this.onWt61Sample);
    emitter.off(HM_EVENTS.imu, this.onImu);
    this.#window = imuWindow();
  }

  onImu(msg: DecodedMessage, ctx: { missedFrames?: number } = {}): void {
    try {
      const reading = imuReadingFromFrame(msg, ctx.missedFrames ?? 0);
      if (reading === null) return;
      this.#deviceId = formatDeviceId(msg.deviceId);
      this.add(reading);
    } catch (err) {
      console.error("hour-meter:imu: a frame could not be read:", err);
    }
  }

  onWt61Sample(sample: Wt61Sample, ctx: { missedFrames?: number } = {}): void {
    try {
      this.add(imuReadingFromWt61(sample, ctx.missedFrames ?? 0));
    } catch (err) {
      console.error("hour-meter:imu: a sample could not be read:", err);
    }
  }

  private add(reading: ImuReading): void {
    const now = this.#now();
    this.#window = addSample(this.#window, reading, now);
    if (now - this.#window.startedAt! < 1000 / this.hz) return;
    const message = closeWindow(this.#window, now, {
      source: this.source,
      forwardAxis: this.#forwardAxis,
      ...(this.source === "hour-meter" && this.#deviceId !== undefined
        ? { deviceId: this.#deviceId }
        : {}),
    });
    this.#window = imuWindow();
    if (message === null) return;
    this.#publisher.publish(HM_CHANNELS.imu, JSON.stringify(message)).then(
      () => {
        if (!this.#failing) return;
        this.#failing = false;
        console.log("hour-meter:imu: publishing again");
      },
      (err: unknown) => {
        if (this.#failing) return;
        this.#failing = true;
        console.error(
          `hour-meter:imu: publish failed, dropping until Redis is back: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      },
    );
  }
}
