import type { ImuSample } from "direction";
import type { DecodedMessage } from "hour-meter";

const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/**
 * An IMU stream frame (msgType 128) → accel (g) and gyro (°/s), board frame.
 * Filtered tags (30–35, streamMode 2 or 3) when present, else raw (20–25);
 * null without a full accel + gyro set. The codec has already scaled them.
 */
export function toImuSample(
  msg: DecodedMessage,
  missedFrames = 0,
): ImuSample | null {
  const v = msg.values;
  for (const prefix of ["", "raw"] as const) {
    const key = (axis: string, kind: string) =>
      prefix === ""
        ? `${kind}${axis}`
        : `raw${kind[0].toUpperCase()}${kind.slice(1)}${axis}`;
    const ax = num(v[key("X", "accel")]),
      ay = num(v[key("Y", "accel")]),
      az = num(v[key("Z", "accel")]);
    const gx = num(v[key("X", "gyro")]),
      gy = num(v[key("Y", "gyro")]),
      gz = num(v[key("Z", "gyro")]);
    if ([ax, ay, az, gx, gy, gz].every((x) => x !== undefined)) {
      return {
        accelG: { x: ax!, y: ay!, z: az! },
        gyroDps: { x: gx!, y: gy!, z: gz! },
        missedFrames,
      };
    }
  }
  return null;
}
