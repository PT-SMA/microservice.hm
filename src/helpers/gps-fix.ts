import type { GpsFix } from "direction";

/**
 * A `microservice.gps` message → the fix this service uses, or null. Never
 * throws: it runs on a Redis subscription callback.
 *
 * Units per the gps.js parser microservice.gps uses: `speed` km/h, `track`
 * degrees true (course over ground). `track` keeps its last value when the
 * receiver stops reporting a course (slow or stopped) — the estimator only
 * trusts it at speed. `time` (the receiver's) makes each epoch count once.
 */
export function parseGpsFix(message: string): GpsFix | null {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const { speed, track, fix, time } = raw as Record<string, unknown>;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0) {
    return null;
  }
  if (fix !== "2D" && fix !== "3D") return null;
  if (typeof time !== "string" || time === "") return null;
  const parsed: GpsFix = { speedKmh: speed, fix, time };
  if (typeof track === "number" && Number.isFinite(track)) {
    parsed.trackDeg = ((track % 360) + 360) % 360;
  }
  return parsed;
}
