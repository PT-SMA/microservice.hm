export const REDIS_URL = Deno.env.get("REDIS_URL") ?? "redis://localhost:6379";
export const PORT = Number(Deno.env.get("PORT") ?? "9000");
export const LOGGING = Deno.env.get("LOGGING") === "true";

/**
 * Where the hour meter is: a serial path (`/dev/serial/by-id/...` is stable
 * across reboots; `/dev/ttyUSB0`, `/dev/rfcomm0` for Bluetooth) or
 * `tcp://host:port` (the simulator, or a serial-to-TCP bridge). Keep the
 * `tcp://` prefix: a bare `host:port` is taken for a file path. Same name the
 * device's configurator uses.
 */
export const HOUR_METER_PORT = Deno.env.get("HOUR_METER_PORT") ??
  "/dev/ttyUSB0";
export const HOUR_METER_BAUD = Number(
  Deno.env.get("HOUR_METER_BAUD") ?? "115200",
);
/** Unlocks a Bluetooth session, which sends nothing until then. */
export const HOUR_METER_BT_PIN = Deno.env.get("HOUR_METER_BT_PIN") || undefined;
/**
 * No frame for this long: probe the device, and `/health` turns 503. Not
 * lower — reopening a USB port reboots the board (see HourMeterSensor).
 */
export const HOUR_METER_STALE_MS = Number(
  Deno.env.get("HOUR_METER_STALE_MS") ?? "15000",
);
export const HOUR_METER_RECONNECT_DELAY_MS = Number(
  Deno.env.get("HOUR_METER_RECONNECT_DELAY_MS") ?? "5000",
);
/** Send `setTime` when the device reports it does not know the time. */
export const HOUR_METER_TIME_SYNC =
  (Deno.env.get("HOUR_METER_TIME_SYNC") ?? "true") === "true";

/**
 * Travel direction (forward / reversing / stopped) from the IMU stream and
 * microservice.gps. Off on excavators: a board in the cab turns with the
 * house, not with the tracks.
 */
export const HOUR_METER_DIRECTION =
  (Deno.env.get("HOUR_METER_DIRECTION") ?? "true") === "true";
/** Which board axis points to the vehicle's front: +x, -x, +y or -y. */
export const HOUR_METER_FORWARD_AXIS =
  Deno.env.get("HOUR_METER_FORWARD_AXIS") ??
    "+x";
/**
 * Above this GPS speed the unit is taken to be going forward (evidence, and
 * the mount self-check). 0 turns it off — graders and compactors reverse fast.
 */
export const HOUR_METER_REVERSE_MAX_KMH = Number(
  Deno.env.get("HOUR_METER_REVERSE_MAX_KMH") ?? "20",
);
/** A directory to record the direction inputs to (calibration), or unset. */
export const HOUR_METER_DIRECTION_RECORD =
  Deno.env.get("HOUR_METER_DIRECTION_RECORD") || undefined;

/**
 * Which IMU this service uses and broadcasts: `hm` — the hour meter's own
 * (when it has one fitted) — or `wit`, a WitMotion WT61 through wt61-driver.
 * The one choice feeds the travel direction, `hour-meter:imu`, and
 * `rollDeg`/`pitchDeg` on `hour-meter:update`; `headingDeg` and the vibration
 * stay the hour meter's (the WT61 has no compass, and filters out vibration).
 */
export const HOUR_METER_IMU_SOURCE = Deno.env.get("HOUR_METER_IMU_SOURCE") ??
  "hm";
/**
 * Where wt61-driver listens (`tcp://host:port`), read only with
 * HOUR_METER_IMU_SOURCE=wit. Contract:
 * FMS-Backend/docs/ecosystem/integrations/wt61-driver-to-hm.md.
 */
export const WT61_URL = Deno.env.get("WT61_URL") || "tcp://127.0.0.1:6699";
/** WT61_URL was set, not defaulted — worth a warning if it is not read. */
export const WT61_URL_SET = Boolean(Deno.env.get("WT61_URL"));
/**
 * Which WT61 axis points to the vehicle's front: +x, -x, +y or -y. The module
 * lies flat, Z up. HOUR_METER_FORWARD_AXIS still describes the hour meter's
 * board — its compass.
 */
export const WT61_FORWARD_AXIS = Deno.env.get("WT61_FORWARD_AXIS") ?? "+x";
/**
 * No line from the driver for this long: reconnect. Harmless, unlike the hour
 * meter's USB port — the driver keeps its serial port open, and sends a
 * status line every second even when the module is gone.
 */
export const WT61_STALE_MS = Number(Deno.env.get("WT61_STALE_MS") ?? "2000");
export const WT61_RECONNECT_DELAY_MS = Number(
  Deno.env.get("WT61_RECONNECT_DELAY_MS") ?? "2000",
);

/**
 * How often the IMU HOUR_METER_IMU_SOURCE selects is published on
 * `hour-meter:imu`, each message the window's mean: 0 turns it off, at most
 * 50. geofencer's dev console charts it.
 */
export const HOUR_METER_IMU_HZ = Math.min(
  50,
  Math.max(0, Number(Deno.env.get("HOUR_METER_IMU_HZ") ?? "10") || 0),
);

export * from "./hour-meter.ts";
export * from "./wt61.ts";
