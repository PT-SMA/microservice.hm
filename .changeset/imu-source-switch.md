---
"microservice-hm": minor
---

feat: the IMU can be switched while running — setImuSource / getImuSource on
hour-meter:command — and the choice is kept in hour-meter:imu-source across
restarts until cleared

`HOUR_METER_IMU_SOURCE` chose the IMU only at boot, so trying the other one
meant editing the env and restarting. geofencer's dev console now switches it.

- **`setImuSource { imuSource: "hm" | "wit" | null }`** on `hour-meter:command`
  (`MainApp.setImuSource`). The travel direction, `hour-meter:imu` and
  `rollDeg`/`pitchDeg` move to the other IMU together, and the travel direction
  starts over on it: `stopImu` detaches the handlers and closes the WT61 link,
  `startImu` builds them again.
  - `null` deletes the choice and goes back to `HOUR_METER_IMU_SOURCE`.
  - Anything else is `invalid`.
  - The reply's `imu` is `{ source, configured, override }`.
- **`getImuSource`:** the same `imu`, with no device involved.
- **Kept:** the choice is stored in `hour-meter:imu-source` before switching.
  When that write fails, nothing is switched and the reply is `error`. At the
  first Redis connection after a restart, a stored choice wins over the env; a
  stored value that is neither hm nor wit is logged and ignored.
- **`/health`** gains `imuSourceOverride` while a choice is set.
- **GPS feed:** a travel direction built by a switch still gets fixes, because
  the `microservice.gps` subscription goes through `MainApp.onGps`, and it is
  subscribed when a switch first creates one.

Tests: `tests/imu-source-switch.test.ts` (parse, the command handler, the switch
over `hour-meter:command`, the restore, a failed write, no IMU → one);
`settings.test.ts` pins the larger action list.

Docs: updated README.md, CLAUDE.md, .env.example,
FMS-Backend/docs/ecosystem/integrations/hm-to-geofencer.md
