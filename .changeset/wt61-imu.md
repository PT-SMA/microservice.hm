---
"microservice-hm": minor
---

feat: read the travel direction's IMU from a WT61 through wt61-driver
(HOUR_METER_IMU_SOURCE=wit)

With `HOUR_METER_IMU_SOURCE=wit` the travel-direction estimator takes its IMU
from a WitMotion WT61 read by wt61-driver (`WT61_URL`, default
`tcp://127.0.0.1:6699`; NDJSON over TCP, protocol v1) instead of the hour
meter's IMU stream: 100 Hz through the module's 10 Hz low-pass filter, so
launches are decided without touching the hour meter's `imuStreamHz`.
`WT61_FORWARD_AXIS` is the module's mount; `HOUR_METER_FORWARD_AXIS` stays the
compass's (`forwardHeadingDeg`). The link reconnects after a close or
`WT61_STALE_MS` of silence, counts the cycles the driver lost from `seq` gaps,
and resets the estimator when it comes back. `GET /health` gains `wt61`. No
Redis payload changes.

The estimator keeps the IMU's and the compass's mounts apart, and a WT61 stream
counts as frozen only after 0.5 s of identical frames (its gyro reads exactly 0
at rest). Tests: the contract fixture (byte-identical to the driver's,
`deno task wt61:verify`), the link against a fake driver, a launch through the
WT61 path, the split mount.

Docs: updated README.md, CLAUDE.md, .env.example;
FMS-Backend/docs/ecosystem/integrations/wt61-driver-to-hm.md (new),
components/wt61-driver.md (new), components/microservice-hm.md,
integrations/hm-to-geofencer.md, README.md, glossary/terms.md.
