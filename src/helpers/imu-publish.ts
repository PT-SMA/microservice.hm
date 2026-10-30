import type { ForwardAxis, ImuSample, ImuSource, Vec3 } from "direction";
import type { DecodedMessage } from "hour-meter";
import type { HourMeterImu, Wt61Sample } from "types";
import { toImuSample } from "./imu-sample.ts";
import { toImuSampleFromWt61 } from "./wt61.ts";

/**
 * The travel direction's IMU, decimated for `hour-meter:imu`. Each window
 * becomes one message: the mean accel and gyro (a mean rather than one sample
 * in n, so vibration does not alias into the trace), the latest attitude and
 * temperature, and how many samples it held and lost. Pure: the caller's
 * clock opens and closes windows.
 */

/** One IMU sample with what the estimator does not use: the attitude. */
export interface ImuReading extends ImuSample {
  angleDeg?: Vec3;
  temperatureC?: number;
}

export interface ImuWindow {
  /** when its first sample arrived; null while empty */
  startedAt: number | null;
  samples: number;
  missedFrames: number;
  /** sums, divided by `samples` when the window closes */
  accel: Vec3;
  gyro: Vec3;
  angleDeg?: Vec3;
  temperatureC?: number;
}

const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const add = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});
const round = (value: number, places: number) =>
  Math.round(value * 10 ** places) / 10 ** places;
const mean = (sum: Vec3, n: number, places: number): Vec3 => ({
  x: round(sum.x / n, places),
  y: round(sum.y / n, places),
  z: round(sum.z / n, places),
});
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const imuWindow = (): ImuWindow => ({
  startedAt: null,
  samples: 0,
  missedFrames: 0,
  accel: zero(),
  gyro: zero(),
});

export function addSample(
  window: ImuWindow,
  sample: ImuReading,
  at: number,
): ImuWindow {
  return {
    startedAt: window.startedAt ?? at,
    samples: window.samples + 1,
    missedFrames: window.missedFrames + sample.missedFrames,
    accel: add(window.accel, sample.accelG),
    gyro: add(window.gyro, sample.gyroDps),
    angleDeg: sample.angleDeg ?? window.angleDeg,
    temperatureC: sample.temperatureC ?? window.temperatureC,
  };
}

/** The window as a message, or null when it holds nothing. */
export function closeWindow(
  window: ImuWindow,
  at: number,
  meta: { source: ImuSource; forwardAxis: ForwardAxis; deviceId?: string },
): HourMeterImu | null {
  if (window.samples === 0 || window.startedAt === null) return null;
  return {
    ...(meta.deviceId === undefined ? {} : { deviceId: meta.deviceId }),
    source: meta.source,
    forwardAxis: meta.forwardAxis,
    at: new Date(at).toISOString(),
    windowMs: Math.max(0, at - window.startedAt),
    samples: window.samples,
    missedFrames: window.missedFrames,
    accelG: mean(window.accel, window.samples, 4),
    gyroDps: mean(window.gyro, window.samples, 2),
    ...(window.angleDeg === undefined ? {} : {
      angleDeg: {
        x: round(window.angleDeg.x, 2),
        y: round(window.angleDeg.y, 2),
        z: round(window.angleDeg.z, 2),
      },
    }),
    ...(window.temperatureC === undefined
      ? {}
      : { temperatureC: window.temperatureC }),
  };
}

/** A WT61 sample, with its attitude and temperature. */
export function imuReadingFromWt61(
  sample: Wt61Sample,
  missedFrames = 0,
): ImuReading {
  return {
    ...toImuSampleFromWt61(sample, missedFrames),
    ...(sample.angleDeg ? { angleDeg: { ...sample.angleDeg } } : {}),
    ...(finite(sample.temperatureC)
      ? { temperatureC: sample.temperatureC }
      : {}),
  };
}

/**
 * An IMU stream frame (msgType 128), with roll, pitch and heading (tags
 * 40–42) when the device sent all three; null without accel and gyro.
 */
export function imuReadingFromFrame(
  msg: DecodedMessage,
  missedFrames = 0,
): ImuReading | null {
  const sample = toImuSample(msg, missedFrames);
  if (sample === null) return null;
  const { roll, pitch, heading } = msg.values;
  return finite(roll) && finite(pitch) && finite(heading)
    ? { ...sample, angleDeg: { x: roll, y: pitch, z: heading } }
    : sample;
}
