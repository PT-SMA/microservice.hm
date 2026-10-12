# microservice.hm

> Verified: 2026-10-12

The on-vehicle **hour-meter adaptor** of the SMART FMS ecosystem. It reads the
ESP32 hour meter / totalizer (`embedded-totalizer-hour-meter`) over its serial
link, decodes its SensorFrame v1 frames, and publishes each reading to the
vehicle's local Redis for **geofencer** on the same vehicle.

The device has no network stack — USB, UART pins or Bluetooth SPP at 115200 8N1
are its only outputs — so this service must run on the box it is plugged into.

Ecosystem docs hub: `../FMS-Backend/docs/README.md`. Component card:
`../FMS-Backend/docs/ecosystem/components/microservice-hm.md`.

## Quick start

```bash
cp .env.example .env.local   # then set HOUR_METER_PORT
deno task dev                # watch mode, reads .env.local
deno task start              # serial port (-A: see "Permissions")
deno task start:tcp          # tcp:// target, explicit permissions
deno task test               # hermetic — no Redis, no device
deno task check              # typecheck
deno task vendor:verify      # the device code mirror is untouched
```

Deno is pinned to **2.8.x** across the ecosystem.

## Configuration (`.env.example` / `src/constants/index.ts`)

| Var                             | Default                  | Meaning                                                                                                                                                        |
| ------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL`                     | `redis://localhost:6379` | the vehicle's local Redis (the one geofencer subscribes on)                                                                                                    |
| `PORT`                          | `9000`                   | HTTP: `GET /`, `GET /health`                                                                                                                                   |
| `HOUR_METER_PORT`               | `/dev/ttyUSB0`           | serial path — prefer `/dev/serial/by-id/…` — `/dev/rfcomm0` (Bluetooth), or `tcp://host:port` (simulator / serial-to-TCP bridge). **Keep the `tcp://` prefix** |
| `HOUR_METER_BAUD`               | `115200`                 | serial only                                                                                                                                                    |
| `HOUR_METER_BT_PIN`             | —                        | Bluetooth sessions are locked until unlocked with the device PIN                                                                                               |
| `HOUR_METER_STALE_MS`           | `15000`                  | no frame this long → probe the device; `/health` 503                                                                                                           |
| `HOUR_METER_RECONNECT_DELAY_MS` | `5000`                   | pause before reopening a lost link                                                                                                                             |
| `HOUR_METER_TIME_SYNC`          | `true`                   | send `setTime` when the device reports it lost the time (never with an unset host clock)                                                                       |
| `LOGGING`                       | `false`                  | one line per TELEMETRY                                                                                                                                         |

### Permissions

A serial port needs `-A`. Deno refuses `Deno.open("/dev/tty…")` under
`--allow-read --allow-write` with
`NotCapable: Requires all access … run again
with the --allow-all flag`. With a
`tcp://` target, `deno task start:tcp` (`--allow-net --allow-env --allow-read`)
is the whole set.

## Is the hour meter alive?

`GET /health` — 200 only when TELEMETRY arrived within `HOUR_METER_STALE_MS`;
503 otherwise, so a container healthcheck can use it directly.

```bash
curl -s localhost:9000/health
```

- **`healthy` is freshness, not `status`.** An open port is `RUNNING` but not
  healthy until the device talks; IMU frames (`frames.imu`) prove the link, not
  the hour meter.
- **`silentReason`** is set when the device stopped sending but **answered** a
  status request. Usually its `output` setting sends telemetry to the UART pins
  only (2), or a Bluetooth session is locked (set `HOUR_METER_BT_PIN`). The port
  is deliberately **not** reopened then: opening a USB port reboots the device,
  and it can lose up to `persistIntervalS` (60 s) of hour meter each time. Fix
  the setting with the device's configurator — stop this service first; the port
  is single-client.
- `bootCount`, `lastBootCause`, `fwVersion`: device restarts seen (a boot EVENT,
  or `seq` going backwards when that EVENT was lost to noise).
- `frameErrors`: CRC / COBS failures. A few right after opening are normal.
- `unknownTags`: tags newer firmware sent that this build ignores.
- `redis`: connection state of the three clients (commands, publish, subscribe).
  It does not make the service unhealthy — restarting it cannot fix Redis.

Log lines worth grepping: `hour meter: opened …` (port open),
`receiving from
device …` (first frame — the device is talking),
`device … booted (resetReason,
lastCause, lastStage)`, `status flags …` (on
change; `timeInvalid`, `rtcBatteryLost`, `eepromMissing`, `storageError` need a
person), `publish failed, dropping readings until Redis is back` /
`publishing resumed`.

## Running in a container

Host networking on a cab box, like microservice.gps; the device node passed in
under a stable name:

```yaml
microservice-hm:
  image: registry.pt-sma.co.id/microservice.hm:<tag>
  restart: always
  network_mode: host
  devices:
    - /dev/serial/by-id/usb-<vendor>_<product>_<serial>-if00-port0:/dev/hourmeter
  environment:
    - HOUR_METER_PORT=/dev/hourmeter
    - REDIS_URL=redis://localhost:<published-redis-port>
    - PORT=8802
```

- **Use `/dev/serial/by-id/`**, not `/dev/ttyACM0`: the GPS receiver is on
  `ttyACM0`, and a CDC-class hour-meter board would race it across boots.
- **`devices:` is bound at container start.** If the USB device re-enumerates
  (unplugged, brown-out) the container cannot see the new node until it
  restarts. Two ways out: `device_cgroup_rules: ["c 188:* rmw"]` (ttyUSB; 166
  for ttyACM) plus a `/dev:/dev` bind, or a host-side bridge —
  `socat
  TCP-LISTEN:5555,bind=127.0.0.1,reuseaddr
  FILE:/dev/serial/by-id/…,b115200,raw,echo=0`
  as a systemd unit — with `HOUR_METER_PORT=tcp://127.0.0.1:5555` and no device
  in the container at all.
- `docker stop` sends SIGTERM; the service closes the port before exiting.

## Trying it without a device

The device repo's simulator speaks firmware 2.4.0 byte for byte:

```bash
cd ../embedded-totalizer-hour-meter/simulator
deno run --unstable-detect-cjs --allow-read --allow-run=socat --allow-net \
  main.ts --tcp 5555 --scenario no-rtc-battery --scenario corrupt=5 --scenario reboot=25
# (`deno task start --tcp 5555` there fails on Deno 2.8 with "require is not
#  defined" — the same CommonJS detection this repo enables in deno.json)

HOUR_METER_PORT=tcp://127.0.0.1:5555 deno task start:tcp
redis-cli SUBSCRIBE hour-meter:update hour-meter:event   # ~1 update/s, events on boot
redis-cli HGETALL hour-meter:state
```

`no-rtc-battery` shows `deviceUptimeS` until the clock is set, then
`measuredAt`; `reboot` publishes a `kind: "boot"` event; `corrupt` / `noise`
raise `frameErrors` while readings keep flowing. `--pty /tmp/ttyHourMeter`
instead of `--tcp` exercises the real serial path (`deno task start`).

## The one contract that matters

Every TELEMETRY frame becomes one message on **`hour-meter:update`**; boot,
calibration and module changes go to **`hour-meter:event`**; the latest reading
is kept in the hash **`hour-meter:state`**, written before each publish so a
booting geofencer can seed from it.

In the other direction geofencer reads and changes the device's settings: it
publishes **`hour-meter:command`** (`getSettings` / `setSettings`), this service
checks the change, sends the COMMAND, reads the result back, and answers once on
**`hour-meter:reply`** with the same `requestId`. `output`, `uartBaud` and
`bluetooth` are read-only that way — each can cut the link this service reads
through — and `btPin` is never sent (`HM_READ_ONLY_SETTINGS` /
`HM_HIDDEN_SETTINGS` in `src/constants/hour-meter.ts`). Nothing is queued: with
no device link the answer is `unavailable`.

The payloads are a **contract** with geofencer —
`../FMS-Backend/docs/ecosystem/integrations/hm-to-geofencer.md`. Update it in
the same commit as any change to `src/helpers/hour-meter*.ts`,
`src/@types/hour-meter.ts` or `src/constants/hour-meter.ts`.
`tests/mapping.test.ts` pins the mapping against the firmware's own frames.

## Layout

```
main.ts                     entry → src/app.ts; SIGTERM closes the port
src/app.ts                  MainApp: GET /, GET /health, wiring, Redis connect with backoff
src/sensors/hour-meter.ts   the link loop, stale probe, boot tracking, health()
src/helpers/hour-meter.ts   frame → wire payload (the contract, in code)
src/handlers/HourMeterHandler.ts  hash, then publish; never throws
src/handlers/HourMeterCommandHandler.ts  settings commands, one at a time
src/helpers/hour-meter-settings.ts  what may be set, validation, read-back
src/modules/hour-meter.ts   the only import of vendor/
src/modules/redis.ts        command + publish clients (no offline queue)
vendor/hour-meter/          byte-identical mirror of the device's codec + reader
scripts/vendor-*.ts         sync and verify the mirror
tests/                      hermetic suite; tests/fixtures/ generated by vendor:sync
```

## Rules

- `vendor/` and `tests/fixtures/` are generated — change the device repo, then
  `deno task vendor:sync`. `vendor:verify` must print `mirror matches …`; in CI
  and Docker it prints `L2 SKIPPED` (no sibling checkout), which is expected
  there and nowhere else.
- The wire payload changes only together with its contract file and a test.
- Ships with a test, a changeset (`deno task changeset`), and a doc touch — see
  `CLAUDE.md`.
