---
"microservice-hm": minor
---

feat: say whether the unit is moving forward or reversing (travelDirection,
travel-direction:update)

The IMU stream (msgType 128), until now only counted, feeds a travel-direction
estimator together with microservice.gps on the same Redis. Every
`hour-meter:update` (and the `hour-meter:state` hash) carries `travelDirection`
— `stopped`, `forward`, `reversing`, `moving` (not decided yet) or `unknown` —
with `travelDirectionChangedAt`, and `forwardHeadingDeg` (the heading of the
vehicle's front, corrected for the board's mount). Each change is merged into
the hash and published at once on `travel-direction:update` (basis, and
`correction` when an earlier decision is reversed without a stop).

It decides per movement: at launch from the gravity-free forward acceleration
(gravity tracked by the gyro, bias learned at every stop), in turns from lateral
acceleration vs yaw rate with the board's lever arm learned, on straights from
the GPS course against a GPS-anchored gyro heading (and the compass once proven
in three quadrants), and through short stops from a velocity anchored to steady
GPS. `HOUR_METER_DIRECTION` (off on excavators), `HOUR_METER_FORWARD_AXIS`,
`HOUR_METER_REVERSE_MAX_KMH` (0 for graders), `HOUR_METER_DIRECTION_RECORD`
(calibration recordings, `scripts/replay-direction.ts`). `GET /health` gains
`direction`, including a mount self-check that warns but never flips.

Not field-calibrated (HM-08): creep below ~1–2 km/h reads stopped, and the
device's default 10 Hz stream is too slow for launches — set imuStreamHz to 100.
Tests: scripted drives in `tests/direction.test.ts` on a generator that can
reverse (the device simulator cannot), plus the wiring.

Docs: updated README.md, CLAUDE.md, .env.example;
FMS-Backend/docs/ecosystem/integrations/hm-to-geofencer.md (travel direction).
