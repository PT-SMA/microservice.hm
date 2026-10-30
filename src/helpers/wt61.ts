import type { ImuSample, Vec3 } from "direction";
import type {
  Wt61Hello,
  Wt61Message,
  Wt61Sample,
  Wt61SerialState,
  Wt61Status,
} from "types";

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;
const isSerial = (v: unknown): v is Wt61SerialState =>
  v === "open" || v === "closed";

function vec3(v: unknown): Vec3 | null {
  if (v === null || typeof v !== "object") return null;
  const { x, y, z } = v as Record<string, unknown>;
  return isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(z)
    ? { x, y, z }
    : null;
}

/**
 * One wt61-driver line → the message, or null when it is not one this build
 * understands (garbage, an unknown `type`, a field missing or not finite) —
 * the contract says to ignore those. Never throws: it runs in the read loop.
 * A hello of another protocol version still parses; the link refuses it.
 */
export function parseWt61Line(line: string): Wt61Message | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case "sample": {
      const accelG = vec3(m.accelG), gyroDps = vec3(m.gyroDps);
      if (!isCount(m.seq) || accelG === null || gyroDps === null) return null;
      if (typeof m.readAt !== "string") return null;
      const sample: Wt61Sample = {
        type: "sample",
        seq: m.seq,
        readAt: m.readAt,
        accelG,
        gyroDps,
      };
      const angleDeg = vec3(m.angleDeg);
      if (angleDeg !== null) sample.angleDeg = angleDeg;
      if (isFiniteNumber(m.temperatureC)) sample.temperatureC = m.temperatureC;
      return sample;
    }
    case "status": {
      if (typeof m.at !== "string" || !isSerial(m.serial)) return null;
      const counters = [
        m.samples,
        m.checksumErrors,
        m.incompleteCycles,
        m.droppedBytes,
      ];
      if (!counters.every(isCount)) return null;
      const status: Wt61Status = {
        type: "status",
        at: m.at,
        serial: m.serial,
        samples: m.samples as number,
        checksumErrors: m.checksumErrors as number,
        incompleteCycles: m.incompleteCycles as number,
        droppedBytes: m.droppedBytes as number,
      };
      if (typeof m.error === "string") status.error = m.error;
      return status;
    }
    case "hello": {
      if (!isCount(m.version) || !isSerial(m.serial)) return null;
      if (typeof m.startedAt !== "string") return null;
      const hello: Wt61Hello = {
        type: "hello",
        version: m.version,
        driver: typeof m.driver === "string" ? m.driver : "",
        driverVersion: typeof m.driverVersion === "string"
          ? m.driverVersion
          : "",
        device: typeof m.device === "string" ? m.device : "",
        baudRate: isFiniteNumber(m.baudRate) ? m.baudRate : 0,
        serial: m.serial,
        startedAt: m.startedAt,
      };
      return hello;
    }
    default:
      return null;
  }
}

/**
 * A WT61 sample → the estimator's IMU sample, in the module's frame (its
 * mount is WT61_FORWARD_AXIS). The angles are never used: their roll and
 * pitch already contain the acceleration.
 */
export function toImuSampleFromWt61(
  sample: Wt61Sample,
  missedFrames = 0,
): ImuSample {
  return {
    accelG: { ...sample.accelG },
    gyroDps: { ...sample.gyroDps },
    missedFrames,
  };
}

/** `tcp://host:port` → where to connect, or null. */
export function parseWt61Url(
  url: string,
): { hostname: string; port: number } | null {
  const m = /^tcp:\/\/(\[[^\]]+\]|[^:/\s]+):(\d{1,5})\/?$/.exec(url.trim());
  if (m === null) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { hostname: m[1].replace(/^\[|\]$/g, ""), port };
}
