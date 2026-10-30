/**
 * The Redis surface geofencer consumes. A contract, not an internal detail:
 * FMS-Backend/docs/ecosystem/integrations/hm-to-geofencer.md — change it in
 * the same commit as anything here.
 */
export const HM_CHANNELS = Object.freeze({
  /** One message per TELEMETRY frame, ~1 Hz. */
  update: "hour-meter:update",
  /** Boot, calibration finished, modules changed. Rare. */
  event: "hour-meter:event",
  /** geofencer → here: read or change the device's settings. */
  command: "hour-meter:command",
  /** here → geofencer: one per command, matched by `requestId`. */
  reply: "hour-meter:reply",
  /** here → geofencer: each change of the travel direction. */
  travelDirection: "travel-direction:update",
  /**
   * here → geofencer: the travel direction's IMU, decimated to
   * HOUR_METER_IMU_HZ (10 Hz). For diagnostics; nothing depends on it.
   */
  imu: "hour-meter:imu",
});

/** microservice.gps's fixes on the same Redis (speed, course) — read, never written. */
export const GPS_CHANNEL = "microservice.gps";

/**
 * Device settings that `hour-meter:command` may read but not change. Each one
 * can cut the very link this service reads the device through, or opens it
 * to others — they are changed on site, with the device's configurator:
 *
 * - `output`: 2 sends TELEMETRY to the UART pins only, 1 to USB only.
 * - `uartBaud`: an adaptor on the UART pins stops understanding the device.
 * - `bluetooth`: an adaptor on Bluetooth loses its link; on, it opens a radio.
 * - `btPin`: the Bluetooth PIN. Never sent to geofencer at all (below).
 */
export const HM_READ_ONLY_SETTINGS: readonly string[] = Object.freeze([
  "output",
  "uartBaud",
  "bluetooth",
  "btPin",
]);

/** Settings never put on the wire, not even when read. */
export const HM_HIDDEN_SETTINGS: readonly string[] = Object.freeze(["btPin"]);

/** Hash of the latest TELEMETRY, written before each `hour-meter:update`. */
export const HM_STATE_KEY = "hour-meter:state";

/**
 * The IMU chosen at runtime (`setImuSource`): `hm` or `wit`. While set it
 * overrides HOUR_METER_IMU_SOURCE, also after a restart (applied once Redis
 * connects); `setImuSource` with null deletes it.
 */
export const HM_IMU_SOURCE_KEY = "hour-meter:imu-source";

/**
 * In-process emitter events, sensor → handler. Deliberately not the channel
 * names: one string meaning two things is how gps's `gps:update` confuses.
 */
export const HM_EVENTS = Object.freeze({
  telemetry: "hm:telemetry",
  event: "hm:event",
  /** IMU stream frames (msgType 128), with `{ missedFrames }` */
  imu: "hm:imu",
});

/** A header timestamp below this (2000-01-01) is seconds since boot, not UTC. */
export const UPTIME_EPOCH_LIMIT = 946_684_800;

/**
 * A host clock earlier than this is wrong (a cab box booted without RTC or
 * NTP); sending it as `setTime` would corrupt the device's good RTC.
 */
export const MIN_PLAUSIBLE_HOST_TIME_MS = Date.UTC(2026, 0, 1);
