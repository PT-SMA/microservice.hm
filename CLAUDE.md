# CLAUDE.md

**microservice.hm** — the on-vehicle hour-meter adaptor of the SMART FMS
ecosystem: reads the ESP32 hour meter / totalizer
(`../embedded-totalizer-hour-meter`) over serial (or a `tcp://` bridge), decodes
SensorFrame v1, and publishes to the vehicle's local Redis: `hour-meter:update`
(each TELEMETRY), `hour-meter:event` (boot / calibration / modules changed),
hash `hour-meter:state` (latest, written before each publish). Its one consumer
is **geofencer** on the same vehicle.

- The Redis surface is a contract:
  `../FMS-Backend/docs/ecosystem/integrations/hm-to-geofencer.md`. Update it in
  the same commit as any change to `src/helpers/hour-meter.ts` (the only frame →
  payload mapping), `src/@types/hour-meter.ts` or `src/constants/hour-meter.ts`.
- `vendor/hour-meter/` is a byte-identical mirror of the device repo's codec and
  reader. **Never edit it** — change upstream, then `deno task vendor:sync`.
  Only `src/modules/hour-meter.ts` imports it. `deno.json` needs
  `"unstable": ["detect-cjs"]` for the CommonJS codec; do not remove it.
- Settings commands (`hour-meter:command` → `hour-meter:reply`) are validated in
  `src/helpers/hour-meter-settings.ts` before anything reaches the device.
  `output`, `uartBaud` and `bluetooth` stay read-only and `btPin` is never sent:
  each can cut this service's own link or expose the device. Only
  `redisSubscriberClient` may `subscribe()`.
- Never reopen the port just because the device is quiet: opening USB reboots
  the ESP32 and can lose up to 60 s of hour meter. The sensor probes (`get=3`)
  first; keep it so.
- Serial needs `-A` (Deno refuses `/dev/tty*` otherwise); `start:tcp` is the
  explicit set.
- Env in `src/constants/index.ts`. Docker pins Deno 2.8.x (ecosystem pin).

Ecosystem docs hub: `../FMS-Backend/docs/ecosystem/README.md` (atomic — load
only what you need). Work items: `../FMS-Backend/docs/BACKLOG.md` §HM.

## Ships with a test, a changeset, and a doc touch

Every change to an endpoint, Redis channel/key, payload field, or the reader's
link handling lands with:

1. **A test** in this repo's hermetic suite (`deno task test`) — one that fails
   without the change. No infrastructure: hermetic suites are the ones CI runs,
   and a check that needs a live server is a check that will not run on the
   commit that breaks it.
2. **A changeset** (`deno task changeset`) whose summary matches the commit
   subject, naming any backlog ID it addresses, with a `Docs:` line —
   `updated <path>` or `none — <reason>`. See
   `FMS-Backend/docs/ecosystem/versioning.md`.
3. **A doc touch in the same commit** when the change affects an endpoint, Redis
   channel/key, schema, or business rule: the contract that owns the surface
   (`FMS-Backend/docs/ecosystem/integrations/hm-to-geofencer.md`) and any
   handbook chapter whose facts moved. Full policy: `FMS-Backend/docs/README.md`
   § "Keeping these docs alive" — never hand-write volatile facts (branches,
   versions, counts); name the command instead.

Use the canonical vocabulary in `FMS-Backend/docs/ecosystem/glossary/`.
