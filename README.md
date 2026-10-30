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

| Var                             | Default                  | Meaning                                                                                                                                                                                            |
| ------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL`                     | `redis://localhost:6379` | the vehicle's local Redis (the one geofencer subscribes on)                                                                                                                                        |
| `PORT`                          | `9000`                   | HTTP: `GET /`, `GET /health`                                                                                                                                                                       |
| `HOUR_METER_PORT`               | `/dev/ttyUSB0`           | serial path — prefer `/dev/serial/by-id/…` — `/dev/rfcomm0` (Bluetooth), or `tcp://host:port` (simulator / serial-to-TCP bridge). **Keep the `tcp://` prefix**                                     |
| `HOUR_METER_BAUD`               | `115200`                 | serial only                                                                                                                                                                                        |
| `HOUR_METER_BT_PIN`             | —                        | Bluetooth sessions are locked until unlocked with the device PIN                                                                                                                                   |
| `HOUR_METER_STALE_MS`           | `15000`                  | no frame this long → probe the device; `/health` 503                                                                                                                                               |
| `HOUR_METER_RECONNECT_DELAY_MS` | `5000`                   | pause before reopening a lost link                                                                                                                                                                 |
| `HOUR_METER_TIME_SYNC`          | `true`                   | send `setTime` when the device reports it lost the time (never with an unset host clock)                                                                                                           |
| `LOGGING`                       | `false`                  | one line per TELEMETRY                                                                                                                                                                             |
| `HOUR_METER_DIRECTION`          | `true`                   | travel direction (forward / reversing / stopped); **`false` on excavators** — a board in the cab turns with the house, not the tracks                                                              |
| `HOUR_METER_FORWARD_AXIS`       | `+x`                     | the board axis pointing to the vehicle's front: `+x`, `-x`, `+y` or `-y`. `/health.direction.mountCheck` says when it looks wrong                                                                  |
| `HOUR_METER_REVERSE_MAX_KMH`    | `20`                     | above this GPS speed the unit is taken to be going forward; **`0` for graders and compactors**, which reverse fast                                                                                 |
| `HOUR_METER_DIRECTION_RECORD`   | —                        | a directory to record the direction inputs to, for calibration (`scripts/replay-direction.ts`)                                                                                                     |
| `HOUR_METER_IMU_SOURCE`         | `hm`                     | which IMU is used and broadcast: `hm` (the hour meter's own, when fitted) or `wit` (a WT61 through wt61-driver) — for the travel direction, `hour-meter:imu`, and `rollDeg`/`pitchDeg` (see below) |
| `HOUR_METER_IMU_HZ`             | `10`                     | the selected IMU on `hour-meter:imu`, messages per second (each a window's mean); `0` off, at most `50`                                                                                            |
| `WT61_URL`                      | `tcp://127.0.0.1:6699`   | wt61-driver; read only with `HOUR_METER_IMU_SOURCE=wit`                                                                                                                                            |
| `WT61_FORWARD_AXIS`             | `+x`                     | the WT61 axis pointing to the vehicle's front (module flat, Z up); `HOUR_METER_FORWARD_AXIS` stays the compass's                                                                                   |
| `WT61_STALE_MS`                 | `2000`                   | no line from the driver this long → reconnect (harmless: the driver holds the serial port)                                                                                                         |
| `WT61_RECONNECT_DELAY_MS`       | `2000`                   | pause before reconnecting to the driver                                                                                                                                                            |

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

## Travel direction: forward, reversing, stopped

With `HOUR_METER_DIRECTION` on, every `hour-meter:update` carries
`travelDirection` — `stopped`, `forward`, `reversing`, `moving` (direction not
decided yet) or `unknown` — and each change is published at once on
**`travel-direction:update`** (the hash first). It is estimated in
`src/direction/` from the IMU stream (msgType 128, which is read here and never
published) and from `microservice.gps` on the same Redis:

- **launch** — which way the vehicle starts moving from a standstill, from the
  gravity-free forward acceleration (gravity tracked by the gyro, never the
  firmware's roll/pitch, which already contain the acceleration);
- **turns** — lateral acceleration = speed × yaw rate (+ the board's lever arm,
  learned): its sign is the sign of the speed;
- **GPS course vs heading** — on straights, the course against a gyro heading
  anchored to GPS (and the compass, once it has agreed with GPS in three course
  quadrants);
- **velocity through short stops** — a speed anchored to steady GPS and
  integrated through braking, a brief stop and what follows.

A vehicle can only change direction through zero speed, so a decision holds for
the movement and is confirmed or corrected (`correction: true`) along it.

What it cannot do, stated plainly:

- **Creep below ~1–2 km/h reads `stopped`.** An IMU cannot see steady creep.
- **The default IMU stream (10 Hz) is too slow for launches.** The device sends
  snapshots, so idle engine vibration aliases to near-DC; a launch then decides
  nothing on its own and the state stays `moving` until a turn or GPS settles
  it. Set **`imuStreamHz` to 100** (50 over Bluetooth) — geofencer's
  `PATCH /api/hour-meter/settings {"imuStreamHz":100}`; `/health.direction.imu`
  shows the measured rate and why it is degraded.
- **The thresholds are not field-calibrated** (`src/direction/tuning.ts`). They
  are pinned by synthetic drives (`tests/direction.test.ts`; the device
  simulator cannot reverse). Treat the state as advisory until a session on a
  real machine: record with `HOUR_METER_DIRECTION_RECORD=<dir>`, replay with
  `deno run --allow-read --allow-env scripts/replay-direction.ts <files> [--trace]`,
  tune, replay again (BACKLOG HM-08).

### Which IMU: `HOUR_METER_IMU_SOURCE`

One IMU feeds everything that uses one — never a mix:

|                                             | `hm` (default)                                                       | `wit`                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| the IMU                                     | the hour meter's own stream (msgType 128), when it has an IMU fitted | a WitMotion WT61 read by **wt61-driver** (`../wt61-driver`, Bun) at `WT61_URL`          |
| travel direction                            | ✓                                                                    | ✓                                                                                       |
| `hour-meter:imu` (`source`)                 | `hour-meter`                                                         | `wt61`                                                                                  |
| `rollDeg`/`pitchDeg` on `hour-meter:update` | TELEMETRY's                                                          | the WT61's latest (its own x/y angles); left out while it has none from the last second |
| mount                                       | `HOUR_METER_FORWARD_AXIS`                                            | `WT61_FORWARD_AXIS` (module flat, Z up)                                                 |

`hour-meter:update` says whose roll and pitch it carries (`imuSource`).
`headingDeg`, `forwardHeadingDeg` and the vibration stay the hour meter's either
way: the WT61 has no compass, and its filter removes engine vibration.
`hour-meter:imu` goes out whether or not travel direction is on; an invalid
value is logged and leaves no IMU (the hour meter itself goes on).

It can also be switched while running, from geofencer's dev console:
`setImuSource` on `hour-meter:command` (below) moves everything above to the
other IMU — the travel direction starts over on it — and keeps the choice in
**`hour-meter:imu-source`**, which wins over `HOUR_METER_IMU_SOURCE`, also after
a restart (it is applied once Redis connects), until `setImuSource` with `null`
clears it. `/health` shows it as `imuSourceOverride`.

### The WT61

The module streams 100 Hz through a 10 Hz on-chip low-pass filter, so nothing
aliases and the hour meter's `imuStreamHz` no longer matters.
`HOUR_METER_FORWARD_AXIS` still describes the hour meter's board, whose compass
`forwardHeadingDeg` comes from.

The link is NDJSON over TCP, protocol v1 — a contract with the driver,
`../FMS-Backend/docs/ecosystem/integrations/wt61-driver-to-hm.md`, pinned by
`tests/fixtures/wt61/stream-v1.ndjson`, a byte-identical copy of the driver's
own (`deno task wt61:verify`). It reconnects after a close or `WT61_STALE_MS` of
silence — harmless here: the driver holds the module's serial port. When the
link comes back the estimator drops what it integrated across the hole; an
hour-meter boot no longer resets it. `GET /health` → `wt61`: the link, the
driver, its serial port, samples and the cycles it lost (`seq` gaps). Like
`direction`, it never makes the service unhealthy.

`GET /health` → `direction`: the state, IMU status and measured rate, GPS age,
gyro bias learned, idle vibration, heading anchor, compass verdict,
**`mountCheck`** (`ok`, `suspectReversed` or `suspectSwapped` with
`suggestedAxis` — it only warns, it never changes the setting), lever arm,
evidence, flips and warnings. It never makes the service unhealthy.

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

With travel direction on, each update also carries `travelDirection`,
`travelDirectionChangedAt` and `forwardHeadingDeg` (the heading of the vehicle's
front — `headingDeg` corrected for the mount), and every change goes out on
**`travel-direction:update`**.

The IMU `HOUR_METER_IMU_SOURCE` selects — the hour meter's own stream or the
WT61's — goes out on **`hour-meter:imu`**, decimated to `HOUR_METER_IMU_HZ` (10
Hz): each message is a window's mean accel (g) and gyro (°/s) in the sensor's
axes, its latest attitude and, from a WT61, temperature. With or without travel
direction; geofencer's dev console charts it, and nothing depends on it.

In the other direction geofencer reads and changes the device's settings: it
publishes **`hour-meter:command`** (`getSettings` / `setSettings`), this service
checks the change, sends the COMMAND, reads the result back, and answers once on
**`hour-meter:reply`** with the same `requestId`. `output`, `uartBaud` and
`bluetooth` are read-only that way — each can cut the link this service reads
through — and `btPin` is never sent (`HM_READ_ONLY_SETTINGS` /
`HM_HIDDEN_SETTINGS` in `src/constants/hour-meter.ts`). Nothing is queued: with
no device link the answer is `unavailable`. `getImuSource` / `setImuSource`
(`imuSource`: `hm`, `wit` or `null`) read and switch the IMU instead, with no
device involved; the reply's `imu` is `{ source, configured, override }`. A
choice that cannot be stored in Redis is not switched to.

A WT61 (`HOUR_METER_IMU_SOURCE=wit`) reaches this service over a second
contract, with wt61-driver —
`../FMS-Backend/docs/ecosystem/integrations/wt61-driver-to-hm.md`, NDJSON over
TCP; see "Which IMU".

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
src/handlers/TravelDirectionHandler.ts  feeds the estimator; never throws
src/sensors/wt61.ts         the wt61-driver link (NDJSON over TCP), health()
src/helpers/wt61.ts         wt61-driver lines → IMU samples (that contract, in code)
src/direction/              travel-direction estimator (pure; tuning.ts holds every threshold)
scripts/replay-direction.ts replay a calibration recording
src/helpers/hour-meter-settings.ts  what may be set, validation, read-back
src/modules/hour-meter.ts   the only import of vendor/
src/modules/redis.ts        command, publish and subscribe clients (no offline queue)
vendor/hour-meter/          byte-identical mirror of the device's codec + reader
scripts/vendor-*.ts         sync and verify the mirror
scripts/verify-wt61-fixture.ts  the WT61 fixture is the driver's (wt61:verify)
tests/                      hermetic suite; tests/fixtures/ generated by vendor:sync,
                            except fixtures/wt61/ (copied from wt61-driver)
```

## Rules

- `vendor/` and `tests/fixtures/` are generated — change the device repo, then
  `deno task vendor:sync`. `vendor:verify` must print `mirror matches …`; in CI
  and Docker it prints `L2 SKIPPED` (no sibling checkout), which is expected
  there and nowhere else.
- The wire payload changes only together with its contract file and a test.
- Ships with a test, a changeset (`deno task changeset`), and a doc touch — see
  `CLAUDE.md`.
