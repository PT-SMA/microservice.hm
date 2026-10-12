/**
 * Wire types of the `hour-meter:*` channels — the contract with geofencer
 * (FMS-Backend/docs/ecosystem/integrations/hm-to-geofencer.md). Optional
 * fields are omitted, never null. Built only by `helpers/hour-meter.ts`.
 */

/** What every hour-meter message carries. */
export interface HourMeterEnvelope {
  /** Minted per message; downstream idempotency key. */
  uuid: string;
  /** Header deviceId (u32) as 8 lowercase hex digits. */
  deviceId: string;
  /** Adaptor clock, ISO-8601 UTC. The ordering and freshness clock. */
  receivedAt: string;
  /** Device RTC time, ISO-8601 UTC. Only when the device knows the time. */
  measuredAt?: string;
  /** Seconds since device boot. Only when it does not (xor `measuredAt`). */
  deviceUptimeS?: number;
  timeValid: boolean;
}

/** The counters: tags 1–5. */
export interface HourMeterReading {
  /** Tag 1 `runSeconds`: engine run time — the hour meter. */
  hourMeterS: number;
  /** Tag 4 `runHours`: the same, in hours, 2 decimals. */
  hourMeterH: number;
  /** Tag 2 `totalCount`: totalizer, raw pulses. */
  totalizerPulses: number;
  /** Tag 5 `totalUnits`: pulses ÷ the device's `pulsesPerUnit`, 2 decimals. */
  totalizerUnits: number;
  /** Tag 3 `alternator`: engine running now (debounced). */
  engineRunning: boolean;
}

/** `hour-meter:update` — one TELEMETRY frame. */
export interface HourMeterUpdate extends HourMeterEnvelope, HourMeterReading {
  /** Tag 53, the raw bitset; future bits survive here. */
  statusFlags: number;
  /** Names of the set bits, e.g. `["imuMissing", "magMissing"]`. */
  statusFlagNames: string[];
  /** Tags 40–44: present only when the device sent them (IMU fitted …). */
  rollDeg?: number;
  pitchDeg?: number;
  /** Magnetic heading of the board — not the GPS course. */
  headingDeg?: number;
  vibRmsMg?: number;
  vibPeakMg?: number;
}

export type HourMeterEventKind =
  | "boot"
  | "calibrationDone"
  | "devicesChanged"
  | "unknown";

export interface HourMeterDevices {
  eeprom: boolean;
  rtc: boolean;
  imu: boolean;
  mag: boolean;
}

/** `hour-meter:event` — one EVENT frame. */
export interface HourMeterEvent
  extends HourMeterEnvelope, Partial<HourMeterReading> {
  kind: HourMeterEventKind;
  /** Tag 8 as sent. */
  eventKind: number;
  /** Device boots this adaptor has seen since it started. */
  bootCount: number;
  /** Tag 241, `"2.4.0"`. */
  fwVersion?: string;
  /** Tag 58: 1 power-on, 3 software, 4 crash, 5–7 watchdog, 9 brown-out. */
  resetReason?: number;
  /** Tag 62 by name: why the previous run ended. */
  lastCause?: string;
  /** Tag 63 by name: what the device was doing then. */
  lastStage?: string;
  /** Tag 55 bits: which modules are fitted. */
  devices?: HourMeterDevices;
  statusFlags?: number;
  statusFlagNames?: string[];
  /** statusFlags bit 18: booted without I2C after repeated self-restarts. */
  safeMode?: boolean;
  /** Every named record, scaled — diagnostics (rtcTemp, i2cErrors, calibration). */
  values: Record<string, number | boolean | string>;
}

/** `hour-meter:command` — geofencer asks; one `hour-meter:reply` answers. */
export interface HourMeterCommand {
  /** Chosen by the caller; the reply carries it back. */
  requestId: string;
  action: "getSettings" | "setSettings";
  /**
   * `setSettings`: the settings to change, by device name
   * (`{ "telemetryIntervalMs": 2000 }`). The rest stay as they are. All or
   * nothing: one invalid value and nothing is applied.
   */
  settings?: Record<string, number | boolean>;
}

/** How a command ended. */
export type HourMeterReplyStatus =
  /** done; `settings` is what the device now holds */
  | "ok"
  /** refused here, nothing sent to the device (unknown, read-only, out of range) */
  | "invalid"
  /** the device refused it (`ackStatus`) */
  | "rejected"
  /** no device link right now */
  | "unavailable"
  /** the device did not answer */
  | "timeout"
  | "error";

/** One device setting, for a UI to render and validate. */
export interface HourMeterSettingSchema {
  type: "integer" | "number" | "boolean";
  min: number;
  max: number;
  /** The only accepted values (uartBaud). */
  values?: number[];
  /** Named values (streamMode, output). */
  options?: Record<string, number>;
  unit?: string;
  help: string;
  /** False for the settings in HM_READ_ONLY_SETTINGS. */
  writable: boolean;
}

/** `hour-meter:reply`. Optional fields omitted, never null. */
export interface HourMeterReply {
  requestId: string;
  status: HourMeterReplyStatus;
  deviceId?: string;
  /** `ok`: every setting the device reports, except `btPin`. */
  settings?: Record<string, number | boolean>;
  /** `ok`: how each of those may be set. */
  schema?: Record<string, HourMeterSettingSchema>;
  /** `invalid` / `rejected`: the setting at fault, when there is one. */
  setting?: string;
  /** `rejected`: the device's ackStatus name (InvalidValue, StorageError …). */
  ackStatus?: string;
  /** Human-readable, for logs and error responses. */
  message?: string;
}

/** Boot facts the adaptor keeps alongside the latest reading in the hash. */
export interface BootSummary {
  bootCount: number;
  fwVersion?: string;
  lastBootAt?: string;
  lastBootCause?: string;
}

/** Just enough of Redis to publish, so tests can supply a recorder. */
export interface HourMeterPublisher {
  publish(channel: string, message: string): Promise<unknown>;
  /** Replace the whole hash (DEL + HSET), so absent fields really are absent. */
  replaceHash(key: string, fields: Record<string, string>): Promise<unknown>;
  /** Set some fields, keep the rest. */
  mergeHash(key: string, fields: Record<string, string>): Promise<unknown>;
}
