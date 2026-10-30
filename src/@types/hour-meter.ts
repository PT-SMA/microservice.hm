import type { ForwardAxis, ImuSource, TravelDirection, Vec3 } from "direction";

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
  /**
   * Tags 40–44: present only when the device sent them (IMU fitted …). With
   * HOUR_METER_IMU_SOURCE=wit, `rollDeg`/`pitchDeg` are the WT61's instead
   * (its own axes), present while it streams; `imuSource` says which.
   */
  rollDeg?: number;
  pitchDeg?: number;
  /** Whose `rollDeg`/`pitchDeg` these are; present with either of them. */
  imuSource?: ImuSource;
  /** Magnetic heading of the board — not the GPS course. */
  headingDeg?: number;
  vibRmsMg?: number;
  vibPeakMg?: number;
  /**
   * Which way the unit travels (absent when HOUR_METER_DIRECTION is off):
   * stopped, forward, reversing, moving (direction not decided) or unknown.
   */
  travelDirection?: TravelDirection;
  /** When `travelDirection` last changed, ISO-8601 UTC. */
  travelDirectionChangedAt?: string;
  /**
   * Heading of the vehicle's front: `headingDeg` corrected for how the board
   * is mounted (and for the compass offset, once proven against GPS).
   */
  forwardHeadingDeg?: number;
}

/** `travel-direction:update` — one per change of the travel direction. */
export interface TravelDirectionUpdate {
  uuid: string;
  deviceId?: string;
  changedAt: string;
  travelDirection: TravelDirection;
  previousTravelDirection: TravelDirection;
  /** what decided it: launch, turn, gpsHeading, compass, fastTravel, gpsSpeed, imuStill, shuttle */
  basis: string[];
  /** forward ↔ reversing without a stop: an earlier decision was wrong */
  correction: boolean;
}

/**
 * `hour-meter:imu` — the IMU the travel direction reads (`source`), one
 * message per window of 1 / HOUR_METER_IMU_HZ s. Axes are the sensor's own:
 * x right, y up the board, z out of it (+1 g flat at rest); `forwardAxis` is
 * the one that points to the vehicle's front.
 */
export interface HourMeterImu {
  /** the hour meter's, when it is the source */
  deviceId?: string;
  source: ImuSource;
  forwardAxis: ForwardAxis;
  /** this box's clock, ISO-8601 UTC: the end of the window */
  at: string;
  windowMs: number;
  /** samples averaged into this message */
  samples: number;
  /** samples lost in the window, by the source's sequence */
  missedFrames: number;
  /** the window's mean, g */
  accelG: Vec3;
  /** the window's mean, °/s */
  gyroDps: Vec3;
  /**
   * The latest attitude: x roll, y pitch, z yaw. A WT61's yaw drifts (it has
   * no magnetometer); the hour meter's z is its magnetic heading.
   */
  angleDeg?: Vec3;
  /** the latest; a WT61 only */
  temperatureC?: number;
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
  action: "getSettings" | "setSettings" | "getImuSource" | "setImuSource";
  /**
   * `setSettings`: the settings to change, by device name
   * (`{ "telemetryIntervalMs": 2000 }`). The rest stay as they are. All or
   * nothing: one invalid value and nothing is applied.
   */
  settings?: Record<string, number | boolean>;
  /**
   * `setImuSource`: `hm` or `wit` (or the wire's `hour-meter` / `wt61`) to
   * switch to and keep across restarts; null to go back to
   * HOUR_METER_IMU_SOURCE.
   */
  imuSource?: string | null;
}

/** Which IMU is in use, and why: the `imu` of a get/setImuSource reply. */
export interface HourMeterImuSourceState {
  /** the IMU in use now; null when none works (a bad setting) */
  source: ImuSource | null;
  /** what HOUR_METER_IMU_SOURCE says; null when it is not hm or wit */
  configured: ImuSource | null;
  /** the runtime choice in `hour-meter:imu-source`, overriding it; null when none */
  override: ImuSource | null;
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
  /** `getImuSource` / `setImuSource`, `ok`: the IMU now in use. */
  imu?: HourMeterImuSourceState;
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
