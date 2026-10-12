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

export * from "./hour-meter.ts";
