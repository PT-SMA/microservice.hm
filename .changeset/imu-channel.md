---
"microservice-hm": minor
---

feat: publish the travel direction's IMU on hour-meter:imu, decimated to
HOUR_METER_IMU_HZ (10 Hz), for geofencer's dev console

The IMU stream was read for the travel direction and never published, so nothing
outside this service could see the gyro or the accelerometer.

- **`hour-meter:imu`** (`ImuPublishHandler`, pure core
  `src/helpers/imu-publish.ts`): the same IMU the estimator reads, either the
  WT61's samples (`HOUR_METER_IMU_SOURCE=wit`) or the hour meter's own stream
  (msgType 128), never both. Each message is one window of 1 /
  `HOUR_METER_IMU_HZ` s:
  - `accelG` (g) and `gyroDps` (°/s): the window's mean, in the sensor's axes,
    so vibration does not alias into the trace;
  - `angleDeg`: the latest attitude. From a WT61 it is roll, pitch and a yaw
    that drifts; from the hour meter it is roll, pitch and magnetic heading
    (tags 40–42);
  - `temperatureC` (WT61 only), plus `samples`, `missedFrames`, `windowMs`,
    `source`, `forwardAxis`, `at`, and `deviceId` when the source is the hour
    meter.
- **`HOUR_METER_IMU_HZ`:** default 10, at most 50; 0 publishes nothing.
- **Fire and forget:** a failed publish (Redis down) is dropped and logged once,
  never queued or retried.

Docs: updated README.md, CLAUDE.md, .env.example,
FMS-Backend/docs/ecosystem/integrations/hm-to-geofencer.md
