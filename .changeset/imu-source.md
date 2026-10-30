---
"microservice-hm": minor
---

feat: HOUR_METER_IMU_SOURCE (hm | wit) picks the one IMU that feeds the travel
direction, hour-meter:imu and rollDeg/pitchDeg

`HOUR_METER_IMU_SOURCE=hm` (default) is the hour meter's own IMU, when it has
one fitted; `wit` is a WitMotion WT61 through wt61-driver (`WT61_URL`, now
defaulting to `tcp://127.0.0.1:6699`). Setting `WT61_URL` alone no longer
switches to the WT61 — it is read only with `wit`, and a `WT61_URL` set with
`hm` is warned about.

- The travel direction, **`hour-meter:imu`** (`source`) and `rollDeg`/`pitchDeg`
  on **`hour-meter:update`** and the hash all come from the selected IMU — never
  a mix. With `wit` they are the WT61's latest roll and pitch (its own x and y
  angles), left out while it has sent none in the last second.
- New field **`imuSource`** (`hour-meter` | `wt61`) on `hour-meter:update`,
  present with `rollDeg`/`pitchDeg`: whose they are.
- `headingDeg`, `forwardHeadingDeg` and the vibration stay the hour meter's
  either way: the WT61 has no compass, and its 10 Hz filter removes engine
  vibration.
- `hour-meter:imu` goes out with or without travel direction (an excavator can
  chart its IMU too). An invalid value is logged and leaves no IMU and no travel
  direction; the hour meter itself goes on. `GET /health` gains `imuSource`.

Tests: `tests/imu-source.test.ts` (the setting, the mapping, the WT61's
freshness, the app with each value and a bad one); the contract payload pins
gain `imuSource`.

Docs: updated README.md, CLAUDE.md, .env.example;
FMS-Backend/docs/ecosystem/integrations/hm-to-geofencer.md,
integrations/wt61-driver-to-hm.md, components/microservice-hm.md,
components/wt61-driver.md.
