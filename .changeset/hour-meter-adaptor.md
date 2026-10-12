---
"microservice-hm": minor
---

feat: read the hour meter over serial and publish it to the vehicle's Redis

The scaffold becomes the hour-meter adaptor. It reads the ESP32 hour meter /
totalizer over its serial link (or a `tcp://` bridge), decodes its SensorFrame
v1 frames with the device repo's own codec and reader (mirrored byte-identical
in `vendor/hour-meter/`, checked by `deno task vendor:verify`), and publishes
for geofencer:

- `hour-meter:update` — one message per TELEMETRY frame (~1 Hz): hour meter,
  totalizer, engine running, status flags, orientation and vibration when
  fitted.
- `hour-meter:event` — boot (with its cause and firmware), calibration finished,
  modules changed.
- `hour-meter:state` — the latest reading, written before each publish.

The reader reopens a lost link, but probes a silent device (`get=3`) before
reopening, since opening USB reboots it. It sets the device clock when the
device asks (`HOUR_METER_TIME_SYNC`). `GET /health` is 503 unless TELEMETRY is
fresh. Sequelize, socket.io, the sample routes and the api-key middleware are
removed.

Docs: updated README.md, CLAUDE.md, .env.example; added
FMS-Backend/docs/ecosystem/integrations/hm-to-geofencer.md and
components/microservice-hm.md.
