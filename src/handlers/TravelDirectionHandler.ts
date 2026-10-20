import { BaseHandler } from "classes/bases";
import { HM_EVENTS } from "consts";
import {
  type DirectionChange,
  type DirectionHealth,
  type DirectionSnapshot,
  type ForwardAxis,
  TravelDirectionEstimator,
} from "direction";
import { formatDeviceId, parseGpsFix, toImuSample } from "helpers";
import { type DecodedMessage, decodeStatusFlags } from "hour-meter";
import type { DirectionRecorder } from "modules";
import type { EventEmitter } from "node:events";
import type { HandlerType } from "types";

/** Where direction changes go — `HourMeterHandler`. */
export interface DirectionPublisher {
  publishDirectionChange(
    change: DirectionChange,
    deviceId: string | null,
  ): Promise<void>;
}

export interface TravelDirectionOptions {
  forwardAxis: ForwardAxis;
  reverseMaxKmh: number;
  publisher: DirectionPublisher;
  recorder?: DirectionRecorder | null;
  now?: () => number;
  /** how often staleness is checked; null = never (tests drive `tick`) */
  tickMs?: number | null;
}

/**
 * Feeds the travel-direction estimator: the IMU stream and TELEMETRY from
 * the sensor, fixes from `microservice.gps`, device boots. Each change it
 * decides goes out through `HourMeterHandler.publishDirectionChange`.
 *
 * It runs inside the serial read pump and on a Redis subscription callback,
 * so nothing may escape: an internal error is logged once, `unknown` is
 * published, and the feature switches itself off until restart.
 */
export class TravelDirectionHandler extends BaseHandler {
  override type: HandlerType = "general";

  readonly estimator: TravelDirectionEstimator;
  #publisher: DirectionPublisher;
  #recorder: DirectionRecorder | null;
  #now: () => number;
  #tickMs: number | null;
  #timer?: ReturnType<typeof setInterval>;
  #deviceId: number | null = null;
  #disabled: string | null = null;

  constructor(options: TravelDirectionOptions) {
    super();
    this.#publisher = options.publisher;
    this.#recorder = options.recorder ?? null;
    this.#now = options.now ?? Date.now;
    this.#tickMs = options.tickMs === undefined ? 1000 : options.tickMs;
    this.estimator = new TravelDirectionEstimator({
      forwardAxis: options.forwardAxis,
      reverseMaxKmh: options.reverseMaxKmh,
      onChange: (change) => this.onChange(change),
      onTrace: this.#recorder
        ? (trace) => this.#recorder!.write("trace", { ...trace })
        : undefined,
    });
    this.#recorder?.write("config", {
      forwardAxis: options.forwardAxis,
      reverseMaxKmh: options.reverseMaxKmh,
    });
    this.onImu = this.onImu.bind(this);
    this.onTelemetry = this.onTelemetry.bind(this);
    this.onEvent = this.onEvent.bind(this);
    this.onGpsMessage = this.onGpsMessage.bind(this);
  }

  /** `microservice.gps` (the Redis listener). */
  override handle(message: string): void {
    this.onGpsMessage(message);
  }

  attach(emitter: EventEmitter): void {
    emitter.on(HM_EVENTS.imu, this.onImu);
    emitter.on(HM_EVENTS.telemetry, this.onTelemetry);
    emitter.on(HM_EVENTS.event, this.onEvent);
  }

  start(): void {
    if (this.#tickMs === null || this.#timer) return;
    this.#timer = setInterval(
      () => this.guard(() => this.estimator.tick(this.#now())),
      this.#tickMs,
    );
  }

  stop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#recorder?.close();
  }

  onImu(msg: DecodedMessage, ctx: { missedFrames?: number } = {}): void {
    this.guard(() => {
      const sample = toImuSample(msg, ctx.missedFrames ?? 0);
      if (sample === null) return;
      this.#deviceId = msg.deviceId;
      const t = this.#now();
      this.#recorder?.write("imu", { ...sample });
      this.estimator.onImu(sample, t);
    });
  }

  onTelemetry(msg: DecodedMessage): void {
    this.guard(() => {
      const v = msg.values;
      const status = {
        engineRunning: v.alternator === true,
        statusFlagNames: typeof v.statusFlags === "number"
          ? decodeStatusFlags(v.statusFlags)
          : [],
        ...(typeof v.heading === "number" ? { headingDeg: v.heading } : {}),
      };
      this.#deviceId = msg.deviceId;
      this.#recorder?.write("status", status);
      this.estimator.onDeviceStatus(status, this.#now());
    });
  }

  onEvent(msg: DecodedMessage): void {
    this.guard(() => {
      if (msg.values.eventKind !== 1) return; // a boot restarts the IMU's state
      this.#recorder?.write("reset", { reason: "boot" });
      this.estimator.onReset("boot", this.#now());
    });
  }

  onGpsMessage(message: string): void {
    this.guard(() => {
      const fix = parseGpsFix(message);
      if (fix === null) return;
      this.#recorder?.write("gps", { raw: message });
      this.estimator.onGps(fix, this.#now());
    });
  }

  snapshot(): DirectionSnapshot | null {
    if (this.#disabled) {
      return {
        travelDirection: "unknown",
        changedAtMs: 0,
        headingOffsetDeg: 0,
      };
    }
    return this.estimator.snapshot();
  }

  health(): DirectionHealth & { disabled?: string } {
    const health = this.estimator.health(this.#now());
    return this.#disabled
      ? { ...health, travelDirection: "unknown", disabled: this.#disabled }
      : health;
  }

  private onChange(change: DirectionChange): void {
    const id = this.#deviceId === null ? null : formatDeviceId(this.#deviceId);
    console.log(
      `travel direction: ${change.previousTravelDirection} → ${change.travelDirection}` +
        (change.basis.length ? ` (${change.basis.join(", ")})` : "") +
        (change.correction ? " — corrected" : ""),
    );
    void this.#publisher.publishDirectionChange(change, id);
  }

  private guard(fn: () => void): void {
    if (this.#disabled) return;
    try {
      fn();
    } catch (err) {
      this.#disabled = err instanceof Error ? err.message : String(err);
      console.error(
        `travel direction: internal error, switched off until restart: ${this.#disabled}`,
      );
      const t = this.#now();
      void this.#publisher.publishDirectionChange({
        travelDirection: "unknown",
        previousTravelDirection: this.estimator.snapshot().travelDirection,
        changedAtMs: t,
        basis: [],
        correction: false,
      }, this.#deviceId === null ? null : formatDeviceId(this.#deviceId));
    }
  }
}
