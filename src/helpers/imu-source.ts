import type { ImuSource } from "direction";

/**
 * HOUR_METER_IMU_SOURCE → the IMU, or null. `hm` is the hour meter's own,
 * `wit` a WitMotion WT61 through wt61-driver; the wire's spellings
 * (`hour-meter`, `wt61` — `source` on `hour-meter:imu`) are accepted too.
 */
export function parseImuSource(value: string): ImuSource | null {
  switch (value.trim().toLowerCase()) {
    case "hm":
    case "hour-meter":
      return "hour-meter";
    case "wit":
    case "wt61":
      return "wt61";
    default:
      return null;
  }
}
