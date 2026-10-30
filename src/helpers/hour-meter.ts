/**
 * Frame → wire payload. The ONE place a decoded SensorFrame becomes the
 * `hour-meter:*` contract (FMS-Backend/docs/ecosystem/integrations/
 * hm-to-geofencer.md); `tests/mapping.test.ts` pins it against the
 * firmware's own frame catalog.
 *
 * Explicit allow-list: tags the codec does not know come out as `tag_<n>` and
 * never reach the wire (newer firmware may add data; INTEGRATION-GUIDE §9).
 * Optional fields are omitted, never null (naming-rules.md rule 4).
 */

import { UPTIME_EPOCH_LIMIT } from "consts";
import {
  type DecodedMessage,
  decodeStatusFlags,
  EVENT_KIND,
  LAST_CAUSE,
  LAST_STAGE,
  MSG,
  type Value,
} from "hour-meter";
import type { DirectionSnapshot, ImuSource } from "direction";
import type {
  BootSummary,
  HourMeterDevices,
  HourMeterEnvelope,
  HourMeterEvent,
  HourMeterEventKind,
  HourMeterReading,
  HourMeterUpdate,
} from "types";

/** Per-message facts the frame does not carry. */
export interface MessageContext {
  uuid: string;
  /** Adaptor clock, ms. */
  now: number;
  /** The travel-direction estimator's state, when the feature is on. */
  direction?: DirectionSnapshot | null;
  /**
   * The IMU HOUR_METER_IMU_SOURCE selects; absent = the hour meter's. With
   * `wt61`, `rollDeg`/`pitchDeg` are the WT61's latest (`wt61Attitude`; left
   * out while it has none fresh), never TELEMETRY's. `headingDeg` and the
   * vibration are the hour meter's either way.
   */
  imu?: {
    source: ImuSource;
    wt61Attitude?: { rollDeg: number; pitchDeg: number } | null;
  };
}

/** statusFlags bit 18: the device booted without I2C (INTEGRATION-GUIDE §5.5). */
const SAFE_MODE_BIT = 18;

/** Tag 55 bits. */
const DEVICE_BITS: Record<keyof HourMeterDevices, number> = {
  eeprom: 1,
  rtc: 2,
  imu: 4,
  mag: 8,
};

/** Optional TELEMETRY records: device name → wire name, and whether scaled. */
const OPTIONAL_FIELDS = [
  ["roll", "rollDeg", true],
  ["pitch", "pitchDeg", true],
  ["heading", "headingDeg", true],
  ["vibRms", "vibRmsMg", false],
  ["vibPeak", "vibPeakMg", false],
] as const;

/**
 * The codec multiplies by 0.01, which leaves float noise (57 × 0.01 =
 * 0.5700000000000001); every ×0.01 tag has exactly two decimals.
 */
const centi = (value: number) => Math.round(value * 100) / 100;

const num = (value: Value | undefined): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const bool = (value: Value | undefined): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

/** Header deviceId (u32, bytes 2..5 of the ESP32 MAC) as `"1a2b3c4d"`. */
export function formatDeviceId(deviceId: number): string {
  return (deviceId >>> 0).toString(16).padStart(8, "0");
}

/** Tag 241 `0x00MMmmpp` → `"M.m.p"`. */
export function formatFwVersion(raw: number): string {
  return `${(raw >>> 16) & 0xff}.${(raw >>> 8) & 0xff}.${raw & 0xff}`;
}

/** The device sends uptime instead of UTC while its clock is unknown. */
export function isUptime(timestamp: number): boolean {
  return timestamp < UPTIME_EPOCH_LIMIT;
}

/** The header timestamp as exactly one of `measuredAt` / `deviceUptimeS`. */
export function headerTime(
  timestamp: number,
): { measuredAt: string } | { deviceUptimeS: number } {
  return isUptime(timestamp)
    ? { deviceUptimeS: timestamp }
    : { measuredAt: new Date(timestamp * 1000).toISOString() };
}

function envelope(
  msg: DecodedMessage,
  { uuid, now }: MessageContext,
): HourMeterEnvelope {
  return {
    uuid,
    deviceId: formatDeviceId(msg.deviceId),
    receivedAt: new Date(now).toISOString(),
    ...headerTime(msg.timestamp),
    // calibration EVENTs carry no tag 50; the header says the same thing
    timeValid: bool(msg.values.timeValid) ?? !isUptime(msg.timestamp),
  };
}

/** Tags 1–5, or null when any is missing — without them a frame is useless. */
function reading(values: DecodedMessage["values"]): HourMeterReading | null {
  const hourMeterS = num(values.runSeconds);
  const hourMeterH = num(values.runHours);
  const totalizerPulses = num(values.totalCount);
  const totalizerUnits = num(values.totalUnits);
  const engineRunning = bool(values.alternator);
  if (
    hourMeterS === undefined || hourMeterH === undefined ||
    totalizerPulses === undefined || totalizerUnits === undefined ||
    engineRunning === undefined
  ) {
    return null;
  }
  return {
    hourMeterS,
    hourMeterH: centi(hourMeterH),
    totalizerPulses,
    totalizerUnits: centi(totalizerUnits),
    engineRunning,
  };
}

/** `hour-meter:update` for a TELEMETRY frame; null for anything else. */
export function toHourMeterUpdate(
  msg: DecodedMessage,
  ctx: MessageContext,
): HourMeterUpdate | null {
  if (msg.msgType !== MSG.TELEMETRY) return null;
  const counters = reading(msg.values);
  const statusFlags = num(msg.values.statusFlags);
  if (counters === null || statusFlags === undefined) return null;

  const update: HourMeterUpdate = {
    ...envelope(msg, ctx),
    ...counters,
    statusFlags,
    statusFlagNames: decodeStatusFlags(statusFlags),
  };
  const imuSource = ctx.imu?.source ?? "hour-meter";
  for (const [from, to, scaled] of OPTIONAL_FIELDS) {
    // the attitude is the selected IMU's; heading and vibration only exist here
    if (imuSource === "wt61" && (to === "rollDeg" || to === "pitchDeg")) {
      continue;
    }
    const value = num(msg.values[from]);
    if (value !== undefined) update[to] = scaled ? centi(value) : value;
  }
  const wt61 = imuSource === "wt61" ? ctx.imu?.wt61Attitude : null;
  if (wt61) {
    update.rollDeg = centi(wt61.rollDeg);
    update.pitchDeg = centi(wt61.pitchDeg);
  }
  if (update.rollDeg !== undefined || update.pitchDeg !== undefined) {
    update.imuSource = imuSource;
  }
  const direction = ctx.direction;
  if (direction) {
    update.travelDirection = direction.travelDirection;
    update.travelDirectionChangedAt = new Date(
      direction.changedAtMs || ctx.now,
    ).toISOString();
    if (update.headingDeg !== undefined) {
      update.forwardHeadingDeg = centi(
        ((update.headingDeg + direction.headingOffsetDeg) % 360 + 360) % 360,
      );
    }
  }
  return update;
}

const nameOf = (table: readonly string[], index: number) =>
  table[index] ?? `unknown(${index})`;

/** Named records only, JSON-safe; the codec's `tag_<n>` unknowns are dropped. */
function diagnostics(
  values: DecodedMessage["values"],
): Record<string, number | boolean | string> {
  const out: Record<string, number | boolean | string> = {};
  for (const [name, value] of Object.entries(values)) {
    if (name.startsWith("tag_")) continue;
    if (typeof value === "number" || typeof value === "boolean") {
      out[name] = value;
    } else if (typeof value === "bigint") {
      out[name] = Number.isSafeInteger(Number(value))
        ? Number(value)
        : value.toString();
    } else {
      out[name] = Array.from(value, (b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  }
  return out;
}

/** `hour-meter:event` for an EVENT frame; null for anything else. */
export function toHourMeterEvent(
  msg: DecodedMessage,
  ctx: MessageContext & { bootCount: number },
): HourMeterEvent | null {
  if (msg.msgType !== MSG.EVENT) return null;
  const eventKind = num(msg.values.eventKind);
  if (eventKind === undefined) return null;

  const { values } = msg;
  const event: Omit<HourMeterEvent, "values"> = {
    ...envelope(msg, ctx),
    kind: (EVENT_KIND[eventKind] ?? "unknown") as HourMeterEventKind,
    eventKind,
    bootCount: ctx.bootCount,
    ...reading(values),
  };

  const fwVersion = num(values.fwVersion);
  if (fwVersion !== undefined) event.fwVersion = formatFwVersion(fwVersion);
  const resetReason = num(values.resetReason);
  if (resetReason !== undefined) event.resetReason = resetReason;
  const lastCause = num(values.lastCause);
  if (lastCause !== undefined) event.lastCause = nameOf(LAST_CAUSE, lastCause);
  const lastStage = num(values.lastStage);
  if (lastStage !== undefined) event.lastStage = nameOf(LAST_STAGE, lastStage);

  const devices = num(values.devices);
  if (devices !== undefined) {
    event.devices = {
      eeprom: (devices & DEVICE_BITS.eeprom) !== 0,
      rtc: (devices & DEVICE_BITS.rtc) !== 0,
      imu: (devices & DEVICE_BITS.imu) !== 0,
      mag: (devices & DEVICE_BITS.mag) !== 0,
    };
  }

  const statusFlags = num(values.statusFlags);
  if (statusFlags !== undefined) {
    event.statusFlags = statusFlags;
    event.statusFlagNames = decodeStatusFlags(statusFlags);
    event.safeMode = ((statusFlags >>> SAFE_MODE_BIT) & 1) === 1;
  }

  // last, so the diagnostic dump does not bury the fields above
  return { ...event, values: diagnostics(values) };
}

/**
 * `hour-meter:state`: the latest update as flat strings (arrays comma-joined),
 * plus the boot facts. Replaced whole on every update, so an optional field
 * the device stopped sending disappears instead of going stale.
 */
export function toStateHash(
  update: HourMeterUpdate,
  boot?: BootSummary,
): Record<string, string> {
  const hash: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...update, ...boot })) {
    if (value === undefined) continue;
    hash[key] = Array.isArray(value) ? value.join(",") : String(value);
  }
  return hash;
}

/** The hash fields an EVENT updates without touching the latest reading. */
export function bootHash(boot: BootSummary): Record<string, string> {
  const hash: Record<string, string> = {};
  for (const [key, value] of Object.entries(boot)) {
    if (value !== undefined) hash[key] = String(value);
  }
  return hash;
}
