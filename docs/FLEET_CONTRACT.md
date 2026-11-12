# Fleet wire contract

<!-- fleet-contract:version 1.2.0 -->

The single source of truth for every wire surface between the five services that carry a vehicle's data from the cab to the Platform: GPS fixes, hour-meter readings, geofence crossings, event logs, sessions, cycles, master data and the commands that flow back.

| Repo | Runs on | Role here |
|---|---|---|
| **FMS-Backend** ("the Platform") | server | Owns this contract. The canonical file is `docs/FLEET_CONTRACT.md`, with `docs/fleet-contract.manifest.json`. Serves master data and operator login to the cab; shares Postgres and Redis with the tracker. |
| **microservice.tracker** ("the tracker") | server | Ingests everything the cab sends, keeps live state, relays Platform commands to the cab over its socket. Holds a mirror. |
| **geofencer** | vehicle | The cab's offline-first backend: consumes gps and hm on the cab's Redis, buffers, and syncs to the tracker and the Platform. Holds a mirror. |
| **microservice.gps** | vehicle | Reads gpsd and publishes fixes on the cab's Redis. Holds a mirror. |
| **microservice.hm** | vehicle | Reads the hour-meter board over serial/TCP and publishes readings on the cab's Redis; answers settings commands. Holds a mirror. |

## 0. How to use this file

### Commands

| Where | Command | Does |
|---|---|---|
| FMS-Backend | `yarn fleet-contract:verify` | Checks the document against its manifest (the version was bumped if the text changed, §10 has an entry for it) and byte-compares every mirror checked out beside the repo. Runs in `pretest` and CI. `--no-mirrors` skips the mirrors. |
| FMS-Backend | `yarn fleet-contract:stamp` | Records the document's sha256 under its version in the manifest. Refuses a changed document whose version did not go up, and a version with no §10 entry. Writes nothing when nothing changed. |
| FMS-Backend | `yarn fleet-contract:sync` | Byte-copies the document and manifest into `docs/` of each sibling checkout. Refuses unless the canonical copy verifies and the sibling's `deno.json` excludes both files from `deno fmt`. Never commits. |
| geofencer, microservice.tracker, microservice.hm, microservice.gps | `deno task fleet-contract:verify` | Checks the mirror is unedited (hash = manifest), consistent (marker = manifest, §10 entry), and, when FMS-Backend is checked out beside it, not stale. Runs in CI. |

### Changing the contract — every change bumps the version

1. Edit **only** `FMS-Backend/docs/FLEET_CONTRACT.md`. The copies in the other four repos are written by `sync`; an edit there fails their `fleet-contract:verify`.
2. Bump the marker under the title, **for every change**, by its effect on the wire:
   - **patch** — wording, corrections that bring the text in line with what the code already does, new defect notes, clarifications;
   - **minor** — anything added: a new optional field, endpoint, channel, socket event, Redis key or whole surface, or a newly documented behaviour that consumers may rely on;
   - **major** — anything breaking: a field removed, renamed, re-typed or re-meant, a unit changed, an idempotency key or status code consumers rely on changed. A major bump needs a coordinated deploy of every repo on that surface.
3. Add a `### X.Y.Z — YYYY-MM-DD` entry at the top of §10 saying what changed and which repos are affected.
4. `yarn fleet-contract:stamp`, then `yarn fleet-contract:sync`.
5. Ship it like any change in this ecosystem: a changeset in FMS-Backend **and in every repo whose mirror changed**, each with a `Docs:` line naming `docs/FLEET_CONTRACT.md` and the backlog ID if there is one. A payload change in code lands in the same commit as the contract change that describes it.

The contract's version is not a service version: it travels with this file, and the services keep their own versions (see `docs/ecosystem/versioning.md`).

### Reading it

- It is written **as implemented**. Where the code does something it should not, the text says what the code does and marks it `> ⚠️ DEFECT (ID): …`, with the backlog ID where one exists; the intended behaviour is stated next to it. When the fix lands, the note goes, in a patch bump.
- Code is cited as `repo: path (symbol)`. **Cite this file by section number and heading, never by line number.**
- Producer-version gates such as "geofencer ≥ 0.4.40" mark when a behaviour started; a consumer may rely on it only against that version or later.

### What is not here

| Surface | Contract |
|---|---|
| Haul-road routing (FMS-Backend ⇄ microservice.route-topology ⇄ FMS-frontend) | `FMS-Backend/docs/HAUL_CONTRACT.md` |
| In-cab UI (gridlock) ⇄ geofencer | `geofencer/docs/CONTRACT-gridlock.md` |
| wt61-driver → microservice.hm | `FMS-Backend/docs/ecosystem/integrations/wt61-driver-to-hm.md` |
| Dashboard (FMS-frontend) ⇄ Platform | `FMS-Backend/docs/ecosystem/integrations/web-platform.md` |
| Box maintenance: map-editor ⇄ update-daemon on the box (its actions, replies, status report, jobs and polling) | `update-daemon/docs/CONTRACT-map-editor.md`. This file covers only the hops it rides: `device:command` (§5) and `unit:command` / `unit:reply` (§7) |

API specs move with this file: a shape change on the tracker also updates `microservice.tracker/src/docs/openapi.ts`, and one on geofencer updates `geofencer/docs/geofencer-docs.json`.

## 1. Topology

```
 VEHICLE (one per unit)                                     │  SERVER
                                                            │
 gpsd ──► microservice.gps ──┬──────► geofencer ════════════╪═ HTTP + Socket.IO ═══► microservice.tracker
                             │          ▲  │  ║             │                                 ║
                  cab Redis  ▼          │  │  ║             │                                 ║  shared Postgres,
 hour-meter ──► microservice.hm ────────┘  │  ║             │                                 ║  Redis bus + keys,
 board            ▲                        │  ║             │                                 ║  JWT secret
                  └── hour-meter:command ──┘  ╚═════════════╪═ HTTP master data, login ════► FMS-Backend
```

| § | Surface | Between | Transport | Cadence |
|---|---|---|---|---|
| 3 | GPS fixes | gps → geofencer, gps → hm | cab Redis pub/sub `microservice.gps`, plus GPS status keys | every receiver epoch |
| 4 | Hour meter | hm ⇄ geofencer | cab Redis pub/sub `hour-meter:*`, `travel-direction:update`, hash `hour-meter:state` | about 1 Hz, plus events and commands |
| 5 | Cab ⇄ server | geofencer ⇄ tracker | HTTP (`x-api-key`, `x-equipment-uuid`), Socket.IO both ways, reads on the tracker's Redis | per event, plus the sync tick |
| 6 | Master data and login | geofencer ⇄ Platform | HTTP | at boot, on reconnect, on command, per shift slot, per tick |
| 7 | Server side | tracker ⇄ Platform | shared Postgres, shared Redis channels and keys, shared JWT secret — **no HTTP** | continuous |

There are **no** direct edges between microservice.gps or microservice.hm and the server: their data reaches the tracker and the Platform only through geofencer. Requests from off the vehicle to geofencer go as commands over the tracker's socket (§5), never as HTTP to the unit, apart from the API-key routes listed in §6.

**map-editor** is not one of the five, and it appears here for one thing only. It publishes `unit:command` on the server bus, and only for `device:command`: box maintenance, which geofencer hands to **update-daemon** on the same box (§5 "Device maintenance — `device:command`", §7). Both map-editor and update-daemon sit outside this contract; what they say to each other is in update-daemon's contract (§0 "What is not here").

## 2. Conventions

These hold across the five services unless a section says otherwise. `docs/ecosystem/glossary/naming-rules.md` is normative for **new** surfaces; existing surfaces keep the shapes documented here.

### Two Redis instances

| Redis | Where | Used for |
|---|---|---|
| **Cab Redis** | on the vehicle; geofencer's `REDIS_URL`, gps and hm's `REDIS_URL` | §3 and §4 pub/sub, GPS status keys, `hour-meter:state`; geofencer ⇄ update-daemon on `update:command` / `update:reply` (§5 "Device maintenance") |
| **Server Redis** | shared by the tracker and the Platform; geofencer's `REDIS_SVR_URL` | §7's bus and keyspace; geofencer only reads it (§5's excavator beacon) |

A message on the cab Redis carries no vehicle identity: the vehicle is the Redis it lands on. geofencer attaches the identity before anything leaves the cab.

### Identity

| Id | Minted by | Where it appears |
|---|---|---|
| Equipment `uuid` | Platform (`equipment.uuid`) | the `x-equipment-uuid` and `equipment-uuid` headers, socket payloads' `equipment_uuid`, server Redis keys `equipment:{uuid}`, `state:{uuid}` |
| Equipment `id` | Platform / tracker (shared Postgres integer) | path parameters such as `/event-logs/current/:id`, `/session/:id`; geofencer's `svr_id` |
| Row `uuid` (v4) | geofencer for its rows; gps per fix; hm per message | idempotency keys, see each section |
| `synced_id` | geofencer | its local row → the server row id after a push |
| `deviceId` | the hour-meter board (8 hex digits) | §4 only; the equipment is attached by geofencer |
| `hull_number` | fleet operations | operator-facing equipment name |

### Time and units

- Timestamps on the wire are ISO-8601 with a timezone, normally UTC (`Z`). The site timezone is Asia/Makassar; shifts resolve only through the Platform.
- Know the clock: GPS `time` is the **receiver's** clock; hm's `receivedAt` is the hm host's clock and `measuredAt` the board's RTC; geofencer stamps its own rows with its clock and corrects session times for a learned skew against the tracker (§5).
- Redis status strings that GPS and geofencer write for humans (`last:listened`, `gps:update`, …) are locale-formatted local time, **not** ISO — never parse them as wire timestamps.
- `speed` is **km/h** from the GPS parser to the tracker's database; nothing converts it.
- Angles are degrees; hm names carry units (`hourMeterS`, `rollDeg`, `vibRmsMg`); older surfaces do not.

### Field casing, absent fields, envelopes

| Surface | Casing | Absent optional field |
|---|---|---|
| §3 GPS fix | short lower-case names (`lat`, `lon`, `speed`) | omitted, or `null` until the receiver reports it |
| §4 hour meter | camelCase with units | omitted, never `null` |
| §5, §6, §7 | snake_case (legacy) | often `null` — see each field |

| Envelope | Used by |
|---|---|
| `{ data, status: true }` (+ `elapsedTime`) | Platform success |
| `{ data }` | tracker and geofencer success |
| `{ errors: [{ msg, … }] }` | errors everywhere, with the HTTP status that matches; the Platform's `token` middleware answers `{ message }`, and a tracker zod 400 has no `errors` array (§5) |

### Headers

| Header | Meaning | Read by |
|---|---|---|
| `x-api-key` | registered-app key | tracker; Platform `token` middleware (plaintext compare, SEC-08) |
| `x-equipment-uuid` | which vehicle a request concerns | tracker |
| `equipment-uuid` | the same, un-prefixed (legacy) | Platform `equipmentParser`; geofencer sends both until ECO-07 cleans the headers up |
| `Authorization: Bearer <jwt>` | operator identity (14 h JWT); dashboard users | Platform; the tracker for dashboard requests (§7) |
| `x-socket-id` | geofencer's socket id, sent to the tracker only | nobody — dead (ECO-07) |

### Delivery

- **Offline-first.** The cab is often disconnected. Everything geofencer sends is buffered locally and retried, so every server endpoint in §5 and §6 must be idempotent on the keys each section names, and fast: a slow or 5xx answer makes the cab retry and pile up.
- **At-most-once on the cab bus.** §3 and §4 are plain Redis pub/sub: a subscriber that is down misses messages. Latest state that must survive a restart is also kept in a key (`hour-meter:state`).
- **Commands are request/reply** with a correlation id and a deadline (`requestId` on §4, Socket.IO acks on §5).

## 3. microservice.gps → geofencer, microservice.hm

**Transport.** Local Redis pub/sub on the vehicle's own Redis, one instance shared by all three services (`REDIS_URL`, default `redis://localhost:6379` in each; the cab compose `setup-scripts: docker-compose.imu.yml` gives microservice.gps and microservice.hm `redis://localhost:6369` on the host network and geofencer `redis://redis-microservice:6379` on the bridge — the same container). microservice.gps publishes one message on channel `microservice.gps` per receiver epoch that passes its fix gate and its dedupe, stationary or moving (1 Hz on a receiver at the usual default rate). geofencer always subscribes; microservice.hm subscribes only while its travel direction is on. Fire-and-forget: no acknowledgement, no replay, and a subscriber that is down or not yet subscribed misses whatever was published meanwhile. microservice.gps also keeps liveness strings in Redis keys that geofencer serves over HTTP.

| Surface | Kind | Written by → read by | Cadence |
|---|---|---|---|
| `microservice.gps` | channel | microservice.gps → geofencer, microservice.hm | one per receiver epoch, after the 1500 ms dedupe |
| `last:listened` | string key | microservice.gps → geofencer `GET /api/gps`, geofencer-configurator | after each fix that passed gate and dedupe |
| `last:polling` | string key | microservice.gps (TCP reader only) → geofencer `GET /api/gps` | every NMEA line |
| `last:watchdog-reconnect` | string key | microservice.gps (TCP reader only) → nobody | each watchdog-forced reconnect |
| Socket.IO `gps:update` | socket event on microservice.gps's HTTP port | microservice.gps → nobody | every reader event — not part of this contract |

### Fix — `microservice.gps` (microservice.gps → geofencer, microservice.hm)

Produced by `microservice.gps: src/handlers/GPSHandler.ts (GPSHandler.handle)`, called from `microservice.gps: src/app.ts (App.handleSensorEvent)`. The values are the accumulated state of the npm `gps` NMEA parser, fed by `microservice.gps: src/sensors/gps.ts (GPSSensor)`. Published on the client the code calls `redisSubClient`, which only ever publishes. Consumed by `geofencer: src/handlers/RedisGPSHandler.ts (RedisGPSHandler.handle)` (type `GPSState` in `geofencer: src/@types/handlers.ts`) and `microservice.hm: src/helpers/gps-fix.ts (parseGpsFix)`.

#### Payload

```jsonc
{
  "lat": -3.00191234,                          // WGS-84 degrees, unrounded
  "lon": 121.81179876,
  "alt": 412.5,                                // metres above mean sea level (GGA); null when GGA's field is empty; absent before the first GGA
  "speed": 15.37,                              // km/h (knots × 1.852) — not m/s; absent until the first RMC/VTG carrying one
  "track": 271.4,                              // course over ground, degrees true; holds its last value when the receiver stops reporting one
  "fix": "3D",                                 // "2D" | "3D"; never null on the wire
  "time": "2026-10-15T07:41:58.000Z",          // receiver time, ISO-8601 UTC (see the defect on its date part)
  "uuid": "f1f0a3d6-0000-4000-8000-000000000001", // minted per published message
  // only when the receiver sends HDT (dual-antenna heading):
  "heading": 271.2,
  "trueNorth": true,                           // boolean, not a number
  // only with READER=tcp or SIMULATE=true — absent on the default gpspipe reader:
  "errors": 0,
  "processed": 18342
}
```

| Field | Type | Presence | Notes |
|---|---|---|---|
| `lat`, `lon` | number, degrees WGS-84 | always | from the last RMC, GGA, GLL or GNS. Published unrounded — geofencer's filter judges implied speed between fixes (pinned by `microservice.gps: tests/gps-handler.test.ts`) |
| `alt` | number (m) \| `null` | after the first GGA | GGA antenna altitude above mean sea level; `null` when GGA's altitude field is empty. Named `alt`, not `altitude`, on this hop |
| `speed` | number (km/h) | after the first RMC/VTG that carried a speed | speed over ground; the parser converts knots × 1.852 (`parseKnots`). Never `null`: an empty field keeps the previous value |
| `track` | number (degrees true, 0–360) | after the first RMC/VTG that carried a course | course over ground, not the vehicle's heading. An empty field keeps the previous value, so at a standstill it is the last course — trust it only at speed |
| `fix` | `"2D"` \| `"3D"` | always | from the last GSA (mode 1 parses to `null`, which the gate refuses). GGA quality and RMC status are not checked |
| `time` | string, ISO-8601 UTC with ms | always | a JS `Date` serialised by `JSON.stringify`. RMC and ZDA carry the receiver's date; GGA, GLL and GNS carry only the time of day, and the parser puts that on the box clock's current UTC date |
| `uuid` | string (v4) | always | `crypto.randomUUID()` per published message in `App.handleSensorEvent`. geofencer's local `Track` primary key and the tracker's `POST /track` idempotency key (ECO-01, pinned by `tests/gps-handler.test.ts`) |
| `heading` | number (degrees) | only when the receiver sends HDT | true heading; `null` if HDT's heading field is empty. Read by nobody |
| `trueNorth` | boolean | with `heading` | HDT's reference field is `T` |
| `errors` | number | only with `READER=tcp` or `SIMULATE=true` | the parser's count of sentences it could not parse since start |
| `processed` | number | only with `READER=tcp` or `SIMULATE=true` | the parser's count of sentences fed since start |

Not on the wire: `hdop`, `pdop`, `vdop`, `satsActive`, `satsVisible` — the parser has them, `GPSHandler.handle` does not publish them.

> ⚠️ DEFECT (GPS-07): the two readers emit different shapes. The default `gpspipe` reader (`GPSSensor.readFromGPSPipeOnce`) emits a hand-picked object without `errors` and `processed`; the TCP reader and the simulator emit the whole parser state. So `errors`/`processed` exist only with `READER=tcp` or `SIMULATE=true`. geofencer's `GPSState` nevertheless declares `errors: number` (and `track`, `speed`) required; `microservice.gps: tests/gps-handler.test.ts` builds its fixture with `trueNorth: 271.4` and `errors: {}` and asserts that `heading`, `trueNorth`, `errors` and `processed` are all published — a shape no default-reader fix from a receiver without HDT has.

> ⚠️ DEFECT: `time`'s date part depends on which sentence set it last. GGA, GLL and GNS give only the time of day, so the parser's `parseTime` dates them by the box clock (UTC), while RMC and ZDA bring the receiver's date. On a box whose clock has the wrong date — or for a sentence parsed across UTC midnight — `time` can move by a day between sentences of one epoch; because the dedupe hashes `time`, that epoch can then go out twice with two different `time`s. geofencer's filter and microservice.hm's "one epoch counts once" both key on `time`.

#### When a message is published

- **Gate** (`App.handleSensorEvent`): `lat`, `lon` and `fix` all non-null in the parser state; otherwise nothing is published and "GPS not fix" is logged. `fix` comes only from GSA, so a receiver configured without GSA publishes nothing at all.
- **Snapshot, not a sentence:** each reader event emits the parser's whole accumulated state — the gpspipe reader once per stdout chunk, the TCP reader once per NMEA line. The fields of one message need not come from the same epoch: `speed`/`track` (RMC/VTG), `alt` (GGA) and `fix` (GSA) are whatever the last such sentence said when the message went out.
- **Dedupe** (`App.isDuplicateMessage`): hash of `lat` and `lon` to 6 decimals plus `time` in ms. Equal to the previous accepted hash and under 1500 ms after it → dropped. Only the previous hash is compared; an unchanged position and time is published again once 1500 ms have passed, with a new `uuid` and the same `time`.
- **Rate:** therefore one message per receiver epoch at the receiver's own rate, moving or standing — `time` changes every epoch. There is no movement gate.
- **Order:** the publish, then `last:listened` (fire-and-forget, after the publish so a stalled Redis cannot delay the fix).

#### Consumer behaviour — geofencer

Subscribed in `geofencer: src/app.ts (MainApp.init)` on its subscriber client once its Redis connection is up. For each message `RedisGPSHandler.handle`:

1. Stamps its own key `gps:update` with the arrival time (an id-ID string; geofencer-owned, served by `GET /api/gps` as `gps_status`).
2. Drops a message whose `lat` or `lon` is not a finite number, or that is exactly 0/0.
3. Steps its Kalman filter (`geofencer: src/helpers/kalman.ts`) with `time` as the measurement time (arrival time when `time` does not parse); a fix the filter does not accept stops here.
4. `speed` in km/h: at or below 1 km/h — or absent — the reported position is pinned where the truck stopped, released by speed or by drifting more than 10 m; pinned 90 s is parked (`gps:park` / `gps:unpark`) (`geofencer: src/helpers/gps-output.ts (holdStep)`).
5. Emits every accepted raw fix in-process as `gps:fix` with geofencer's arrival time — the auto-cycle rings and geofencer's own GPS travel-direction detector read it.
6. Replaces `track` before any output: the hour meter's heading when fresh and calibrated, else the GPS course, turned 180° while the truck reverses or stands where a reverse left it (`frontCourse`, `geofencer: src/helpers/hour-meter.ts (trackFromHeading)`; see §4 consumer behaviour).
7. Writes its own hash `gps:state` (`lat`, `lon`, `track`, `speed`, `date`).
8. Posts to the tracker when `sendDecision` says so (an unpinned point at least 1 m from the last one sent and at least 1 s after it, or a 60 s heartbeat): the whole message object with the filtered `lat`/`lon` and replaced `track`, every other field as received (`uuid`, `alt`, `fix`, `heading`, `trueNorth`, `errors`, `processed`), to `POST /track`. A failed post is buffered and stored in the local SQLite `Track` table with `uuid` as primary key and `alt` as `altitude` (0 when absent); buffered points are de-duplicated by `uuid`. See §5.

geofencer does not read `fix`, `heading`, `trueNorth`, `errors` or `processed`.

> ⚠️ DEFECT (GEO-09): geofencer does not check that `uuid` is present. microservice.gps always sends one today, but a regression would be stored and posted as `undefined` rather than rejected.

#### Consumer behaviour — microservice.hm

Subscribed in `microservice.hm: src/app.ts (MainApp.connectRedis)` only when the travel direction is on: `HOUR_METER_DIRECTION` (default `true`, `false` on excavators) with a valid `HOUR_METER_FORWARD_AXIS` and an IMU source that works. It writes nothing to this channel.

- `parseGpsFix` reads only `speed` (finite, ≥ 0, km/h), `fix` (`"2D"` or `"3D"`), `time` (non-empty string) and, when finite, `track` (normalised to [0, 360)). Anything else missing or malformed → the message is ignored; it never throws. A message without `speed` (before the receiver's first RMC/VTG) is ignored entirely.
- `TravelDirectionEstimator.onGps` (`microservice.hm: src/direction/estimator.ts`): freshness is judged by arrival — GPS counts as fresh for 2.5 s after the last message (`src/direction/tuning.ts`, `gps.freshMs`); the same `time` string twice is one epoch, counted once.
- Uses: stop and start thresholds (below 1 km/h a stop, from 2 km/h a start), `HOUR_METER_REVERSE_MAX_KMH` (default 20, 0 off: above it the unit is taken to be going forward, basis `fastTravel`), and the course from 4 km/h against its GPS-anchored gyro heading (basis `gpsHeading`). `lat`, `lon`, `uuid` and the rest are not read.

Any payload change must keep `speed` (km/h), `track` (degrees true), `fix` and `time` with these meanings.

#### Failure behaviour

- **Redis unreachable, producer side:** see the defect below — fixes queue in memory and replay on reconnect.
- **microservice.gps down, or the receiver silent:** no messages and no signal on the channel. geofencer has no GPS staleness check and no seed (unlike the hour meter); `last:listened` stops advancing. microservice.hm stops counting GPS after 2.5 s and its travel direction turns `unknown` after 3 s if its IMU is silent too. microservice.gps's own `GET /health` turns 503 after `GPS_DATA_STALE_MS` (15 s) without data.
- **Reader faults:** the gpspipe reader restarts `gpspipe` `GPS_RECONNECT_DELAY_MS` (5 s) after it exits, but has no stall watchdog — a `gpspipe` that stays up and sends nothing stops the feed until the service restarts (GPS-02). The TCP reader's watchdog checks every 5 s and reconnects after 15 s without data (`GPS_DATA_STALE_MS`) or 120 s without a fix (`GPS_FIX_STALE_MS`), writing `last:watchdog-reconnect`.
- **A subscriber down:** it misses everything published meanwhile; pub/sub has no catch-up. node-redis re-subscribes by itself after a reconnect on either consumer.

> ⚠️ DEFECT: microservice.gps creates its clients with node-redis' default offline queue (`microservice.gps: src/modules/redis.ts`). While Redis is unreachable every publish (and every `last:*` write) waits in memory, unbounded, and on reconnect the backlog goes out at once — a burst of stale fixes, each with its original `time` and its own `uuid`. geofencer's filter steps them by `time`, but its tracker send gate (≥ 1 s apart) and its `gps:fix` timestamps run on arrival time, so most of the burst is not posted and what is passes downstream as current; microservice.hm judges GPS freshness by arrival too, so replayed speeds count as current for its travel direction. microservice.hm (`disableOfflineQueue`) and geofencer's command client (refuses to publish unless `isReady`) avoid exactly this.

### Liveness keys — `last:listened`, `last:polling`, `last:watchdog-reconnect` (microservice.gps → geofencer)

Operational signals, not part of the message contract. All three are strings written with `Date.prototype.toLocaleString("id-ID")` in the container's local time zone (the cab compose sets `TZ=Asia/Makassar`): `D/M/YYYY, HH.mm.ss`, e.g. `15/10/2026, 15.41.58` — no zone, not ISO-8601, not sortable. Every write is fire-and-forget (`.catch(() => {})`). No TTL.

| Key | Value | Written | Read by |
|---|---|---|---|
| `last:listened` | id-ID local time | after every fix that passed gate and dedupe, whether or not its publish succeeded (`App.handleSensorEvent`) | geofencer `GET /api/gps` (`last_listened`); geofencer-configurator's GPS pipeline view (`geofencer-configurator: src-tauri/src/gps/mod.rs (pipeline)`) |
| `last:polling` | id-ID local time | TCP reader only, after every NMEA line it parses (`GPSSensor.readConnection`) | geofencer `GET /api/gps` (`last_polling`) |
| `last:watchdog-reconnect` | `<id-ID local time> - <reason>`, reason `no data from GPSD for <n>s` or `no GPS fix update for <n>s` | TCP reader only, when its watchdog forces a reconnect (`GPSSensor.forceReconnect`) | nobody |

geofencer's `GET /api/gps` (`geofencer: src/routes/gps.ts`, no auth) answers `{ "data": { "location": <gps:state hash>, "gps_status": <gps:update>, "last_polling": …, "last_listened": … } }` — `location` is `{}` and the others `null` when their key is absent.

- On the default gpspipe reader `last:polling` and `last:watchdog-reconnect` are never written, so `last_polling` is `null` — or, with no TTL, whatever an earlier TCP-reader run left behind, indefinitely.
- `last:listened` also stops when the receiver loses its fix (the gate), not only when the service or Redis is down.

### Socket.IO `gps:update` (not part of the contract)

microservice.gps serves Socket.IO on its own HTTP port (`PORT`, default 9000; 8801 in the cab compose) and emits `gps:update` to every connected client on every reader event: before the fix gate and the dedupe, without `uuid`, as the raw reader object (the gpspipe reader's 12 fields including `hdop`/`pdop`/`vdop`; the TCP reader's and simulator's whole parser state). No service consumes it — geofencer's Socket.IO client connects to the tracker (`GPS_SERVER_URL`), not here. The name is unrelated to geofencer's Redis key `gps:update`.

> ⚠️ DEFECT: `App.initSocket` adds an emitter listener for every connection and never removes it on disconnect, so each client that ever connected keeps being emitted to and the listener count only grows.

### Wire-rule deviations

- The channel is named `microservice.gps`, not `<domain>:<verb>` (naming rule 13).
- No units in field names: `speed` (km/h), `alt` (m), `track` and `heading` (degrees) (rule 5).
- `alt` and `heading` can be `null` instead of omitted (rule 4); the other optional fields are omitted (`undefined` is dropped by `JSON.stringify`).
- `time` is ISO-8601 UTC; the `last:*` keys are locale strings in local time.

## 4. microservice.hm ⇄ geofencer

**Transport.** Local Redis on the vehicle — the same instance as §3. microservice.hm owns the only link to the ESP32 hour meter / totalizer (`embedded-totalizer-hour-meter`, over serial or a serial-to-TCP bridge). It publishes readings, device events and travel-direction changes, and keeps the latest reading in the hash `hour-meter:state`; geofencer subscribes after its own boot and seeds from the hash. In the other direction geofencer publishes settings commands, each answered exactly once. Every channel is fire-and-forget and nothing is queued on either side: microservice.hm's three clients run with `disableOfflineQueue`, so a reading it cannot publish is dropped (the next one supersedes it), and geofencer refuses to publish a command while its Redis is not ready. microservice.hm also reads `microservice.gps` (§3) and writes nothing there.

The only frame → payload mapping is `microservice.hm: src/helpers/hour-meter.ts (toHourMeterUpdate, toHourMeterEvent, toStateHash)`, types in `microservice.hm: src/@types/hour-meter.ts`, pinned by `microservice.hm: tests/mapping.test.ts` against the firmware's frame catalog. Published by `microservice.hm: src/handlers/HourMeterHandler.ts (HourMeterHandler)`. geofencer consumes with `geofencer: src/handlers/RedisHourMeterHandler.ts (RedisHourMeterHandler)`, guards in `geofencer: src/helpers/hour-meter.ts`.

| Surface | Kind | Direction | Cadence |
|---|---|---|---|
| `hour-meter:update` | channel | microservice.hm → geofencer | one per device TELEMETRY frame — device `telemetryIntervalMs`, default 1000 ms |
| `hour-meter:event` | channel | microservice.hm → geofencer | one per device EVENT frame: boot, calibration done, modules plugged or lost |
| `hour-meter:state` | hash | microservice.hm writes, geofencer reads | replaced (`DEL` + `HSET`, one `MULTI`) before each `hour-meter:update`; merged on each event and each travel-direction change |
| `travel-direction:update` | channel | microservice.hm → geofencer | one per change of the travel direction, at most 2/s; only while travel direction is on |
| `hour-meter:command` | channel | geofencer → microservice.hm | on request |
| `hour-meter:reply` | channel | microservice.hm → geofencer | exactly one per command that carries a `requestId` |
| `hour-meter:imu` | channel | microservice.hm → geofencer (dev console only) | `HOUR_METER_IMU_HZ`, default 10 Hz |
| `hour-meter:imu-source` | string key | microservice.hm only | written on `setImuSource` |
| `GET` / `PATCH /api/hour-meter/settings` | HTTP on geofencer, `x-api-key` | on-vehicle caller → geofencer → `hour-meter:command` | on request |

Wire rules (naming-rules.md): camelCase, units in names, ISO-8601 UTC times, optional fields omitted — never `null` — except where listed under deviations. Consumers must ignore fields they do not know; fields are only ever added within this contract version.

An hm build older than its WT61 support answers `getImuSource` / `setImuSource` `invalid` ("unknown action"), never publishes `hour-meter:imu`, never sends `imuSource`, and ignores `hour-meter:imu-source`; against such a build geofencer's dev console `GET`/`PUT /api/dev/hour-meter/imu-source` answers 400 and its IMU page stays empty. Nothing in geofencer's service path depends on these.

### Reading — `hour-meter:update` (microservice.hm → geofencer)

Built by `toHourMeterUpdate` from one TELEMETRY frame; published by `HourMeterHandler` after the hash is replaced (naming rule 13).

#### Payload

```jsonc
{
  "uuid": "1abdf56c-0e67-40d8-ac35-45dcc4bc5b07", // minted per message
  "deviceId": "1a2b3c4d",                         // 8 lowercase hex digits, bytes 2..5 of the ESP32 MAC
  "receivedAt": "2026-10-12T06:35:46.218Z",       // microservice.hm's clock: THE ordering and freshness clock
  "measuredAt": "2026-10-12T06:35:45.000Z",       // device RTC; replaced by "deviceUptimeS": <s> while the device has no time
  "timeValid": true,
  "hourMeterS": 4500011,                          // engine run time, s — the hour meter
  "hourMeterH": 1250,                             // the same in h, 2 decimals
  "totalizerPulses": 15039,
  "totalizerUnits": 15039,                        // pulses ÷ the device's pulsesPerUnit, 2 decimals; unit not on the wire
  "engineRunning": true,
  "statusFlags": 96,
  "statusFlagNames": ["imuNotCalibrated", "magNotCalibrated"],
  "rollDeg": 2.5, "pitchDeg": -0.47,              // when the selected IMU has them
  "headingDeg": 33.23,                            // MAGNETIC heading of the board — not the GPS course
  "vibRmsMg": 38, "vibPeakMg": 108,               // after the first vibration window
  "travelDirection": "forward",                   // only while travel direction is on
  "travelDirectionChangedAt": "2026-10-12T06:35:40.120Z",
  "forwardHeadingDeg": 33.23                      // headingDeg + the board's mount offset: the vehicle's front
}
```

| Field | Type | Presence | Notes |
|---|---|---|---|
| `uuid` | string (v4) | always | minted per message by the producer; idempotency key downstream |
| `deviceId` | string | always | header `deviceId` (u32) as 8 lowercase hex digits = bytes 2..5 of the ESP32 MAC; not configurable. One device per cab, so the vehicle is implicit (as for GPS) |
| `receivedAt` | ISO-8601 UTC | always | microservice.hm's clock when the frame arrived — the same box and clock as geofencer. **The ordering and freshness clock** |
| `measuredAt` | ISO-8601 UTC | only while the device knows the time | header `timestamp` (the device RTC); informational |
| `deviceUptimeS` | number (s) | only while it does not | header `timestamp` below 2000-01-01 is seconds since device boot. Exactly one of `measuredAt` / `deviceUptimeS` is present |
| `timeValid` | boolean | always | tag 50; `false` ⇒ `deviceUptimeS`. microservice.hm sets the device clock when it sees `false` (`HOUR_METER_TIME_SYNC`, default on) and its own clock is plausible (not before 2026-01-01) |
| `hourMeterS` | number (s) | always | tag 1 `runSeconds`: **the hour meter**, total engine run time |
| `hourMeterH` | number (h) | always | tag 4 `runHours`: the same, 2 decimals, for display |
| `totalizerPulses` | number | always | tag 2 `totalCount`: totalizer, raw pulses |
| `totalizerUnits` | number | always | tag 5 `totalUnits`: pulses ÷ the device's `pulsesPerUnit` setting (e.g. litres), 2 decimals. The unit is whatever the device was configured for — not carried on the wire |
| `engineRunning` | boolean | always | tag 3 `alternator`: engine running now (alternator signal, debounced) |
| `statusFlags` | number | always | tag 53, the raw bitset; future bits survive here |
| `statusFlagNames` | string[] | always (may be empty) | decoded bit names. Need a person: `timeInvalid`, `rtcBatteryLost`, `eepromMissing`, `storageError`, `safeMode` |
| `rollDeg`, `pitchDeg` | number (degrees) | when the selected IMU has them | with `HOUR_METER_IMU_SOURCE=hm` (the default): the hour meter's tags 40, 41, board orientation, 2 decimals, pitch nose-up positive (firmware ≥ 2.4.0). With `wit`: the WT61's latest angles about **its own** x and y, absent while it sent none in the last second — never the hour meter's instead |
| `imuSource` | `"hour-meter"` \| `"wt61"` | with `rollDeg` or `pitchDeg` | whose `rollDeg`/`pitchDeg` these are; the same IMU as `hour-meter:imu`'s `source` |
| `headingDeg` | number (degrees) | when the magnetometer gives a heading | tag 42: the board's **magnetic** heading — not the GPS course. Always the hour meter's (a WT61 has no compass) |
| `vibRmsMg`, `vibPeakMg` | number (mg) | after the first vibration window | tags 43, 44: vibration with gravity removed. Always the hour meter's |
| `travelDirection` | `"stopped"` \| `"forward"` \| `"reversing"` \| `"moving"` \| `"unknown"` | while travel direction is on (`HOUR_METER_DIRECTION`, off on excavators) | which way the unit travels — see the travel direction below |
| `travelDirectionChangedAt` | ISO-8601 UTC | with `travelDirection` | when it last changed |
| `forwardHeadingDeg` | number (degrees) | with `travelDirection` and `headingDeg` | the heading of the vehicle's **front**: `headingDeg` + the board's mount offset (+ the compass offset once proven against GPS), 2 decimals. Prefer it to `headingDeg` |

Not on the wire: the device `seq`, the firmware version (on `hour-meter:event` and in the hash), tags this build does not know (the codec's `tag_<n>`), ACKs, and the IMU stream itself (decimated on `hour-meter:imu`). A TELEMETRY frame missing any of tags 1–5 or 53 is logged and dropped, never published.

#### Semantics consumers must respect

- **`hourMeterS` can go backwards** across a device restart: the device persists its counters at most every `persistIntervalS` (factory default 60 s) while the engine runs, so an unplanned reset loses up to that much (INTEGRATION-GUIDE §9 rule 7). Seen in testing: 4500011 → 4500000 after a simulated watchdog reset. Never compute a duration as `end − start` without allowing for it; a `kind: "boot"` event precedes such a step.
- **Order and freshness by `receivedAt`**, never by `measuredAt` (a device clock can be wrong or absent) or `uuid`.
- **Stale** = `receivedAt` older than the producer's `HOUR_METER_STALE_MS` (15 s): the device is unplugged or silent, or microservice.hm is down. geofencer uses 30 s (`HOUR_METER_FRESH_MS`) so one slow restart does not flap it.
- A missing optional field means "not measured", not zero.

### Device event — `hour-meter:event` (microservice.hm → geofencer)

Built by `toHourMeterEvent` from one EVENT frame. Before each publish microservice.hm merges its boot facts into `hour-meter:state`.

```jsonc
{
  "uuid": "…", "deviceId": "1a2b3c4d",
  "receivedAt": "2026-10-12T06:30:02.511Z",
  "deviceUptimeS": 2,                  // or measuredAt — the same envelope as hour-meter:update
  "timeValid": false,
  "kind": "boot",
  "eventKind": 1,                      // tag 8 as sent
  "bootCount": 2,                      // boots this microservice.hm has seen since it started
  // boot only: the counters restored from the device's EEPROM
  "hourMeterS": 4500000, "hourMeterH": 1250, "totalizerPulses": 15039, "totalizerUnits": 15039, "engineRunning": false,
  "fwVersion": "2.4.0", "resetReason": 5, "lastCause": "watchdog", "lastStage": "IMU",
  "devices": { "eeprom": true, "rtc": true, "imu": true, "mag": true },
  "statusFlags": 4, "statusFlagNames": ["timeInvalid"], "safeMode": false,
  "values": { "rtcTemp": 31.25, "i2cErrors": 0 } // every named record of the frame — diagnostics only
}
```

| Field | Type | Presence | Notes |
|---|---|---|---|
| `uuid`, `deviceId`, `receivedAt`, `measuredAt` \| `deviceUptimeS`, `timeValid` | as on `hour-meter:update` | always | the shared envelope; with no tag 50 (calibration events) `timeValid` follows the header |
| `kind` | `"boot"` \| `"calibrationDone"` \| `"devicesChanged"` \| `"unknown"` | always | from tag 8 `eventKind` (1, 2, 3; anything else `unknown`) |
| `eventKind` | number | always | tag 8 as sent |
| `bootCount` | number | always | device boots this microservice.hm has seen since it started |
| `hourMeterS`, `hourMeterH`, `totalizerPulses`, `totalizerUnits`, `engineRunning` | as on `hour-meter:update` | only when the frame carries all five (`boot`) | the counters restored from the device's EEPROM |
| `fwVersion` | string | when sent (`boot`, `devicesChanged`) | tag 241, e.g. `"2.4.0"` |
| `resetReason` | number | when sent (`boot`, `devicesChanged`) | tag 58: 1 power-on, 3 software, 4 crash, 5–7 watchdog, 9 brown-out |
| `lastCause` | string | when sent (`boot`, `devicesChanged`) | tag 62 by name — why the previous run ended: `none`, `watchdog`, `i2cStuck`, `usbStalled`, `panicSignal`, `rebootCommand`, `crash` (`unknown(<n>)` beyond the table) |
| `lastStage` | string | when sent (`boot`, `devicesChanged`) | tag 63 by name — what it was doing then, e.g. `IMU`, `EEPROM`, `starting I2C` |
| `devices` | `{eeprom, rtc, imu, mag}` booleans | when sent (`boot`, `devicesChanged`) | tag 55: modules fitted now |
| `statusFlags`, `statusFlagNames` | as on `hour-meter:update` | when sent | |
| `safeMode` | boolean | with `statusFlags` | bit 18: the device booted without I2C after repeated self-restarts — counting in RAM only |
| `values` | object | always | every named record of the frame, scaled (`rtcTemp`, `i2cErrors`, calibration values …). Diagnostics — not for business logic |

### Latest reading — `hour-meter:state` (hash, microservice.hm → geofencer)

- **Content:** every `hour-meter:update` field as a string — `statusFlagNames` comma-joined (`""` = none), booleans `"true"`/`"false"`, numbers in JS `String()` form — plus `bootCount` (`"0"` until microservice.hm has seen a boot) and, once seen, `fwVersion`, `lastBootAt` (the boot event's `receivedAt`), `lastBootCause` (`toStateHash`).
- **Replaced whole** (`MULTI` `DEL` + `HSET`) before each `hour-meter:update` is published, so an optional field the device stopped sending (`deviceUptimeS` after the clock was set, `rollDeg` after the IMU was unplugged) disappears instead of going stale.
- **Merged** (`HSET` only) with the boot facts before each `hour-meter:event`, and with `travelDirection` / `travelDirectionChangedAt` before each `travel-direction:update`. Replaces and merges run on one ordered write chain in `HourMeterHandler`, so a direction merged into the hash cannot be overwritten by a replace already in flight.
- **No TTL:** when the device is unplugged the last reading stays; judge it by `receivedAt`. A hash that holds only boot facts (an event before the first reading) fails geofencer's guard and is ignored.

### Travel direction — `travel-direction:update` (microservice.hm → geofencer)

Which way the unit travels, judged by microservice.hm (`microservice.hm: src/direction/`, fed by `src/handlers/TravelDirectionHandler.ts (TravelDirectionHandler)`) from the device's IMU stream (msgType 128, or a WT61's) and `microservice.gps` (§3). Published by `HourMeterHandler.publishDirectionChange` after the hash merge. Only while `HOUR_METER_DIRECTION` is on and `HOUR_METER_FORWARD_AXIS` is valid.

| `travelDirection` | Means |
|---|---|
| `stopped` | confirmed standstill. **Creep below ~1–2 km/h reads `stopped`** — an IMU cannot see steady creep |
| `forward` / `reversing` | moving, direction decided |
| `moving` | moving, direction not decided yet (or an earlier decision retracted) |
| `unknown` | no usable input: no IMU stream and no fresh GPS for 3 s. Also published once when the estimator hits an internal error, after which travel direction stays off until restart |

```jsonc
{
  "uuid": "…",                                  // per message
  "deviceId": "1a2b3c4d",                       // once the device was heard
  "changedAt": "2026-10-15T07:41:58.120Z",      // microservice.hm's clock
  "travelDirection": "reversing",
  "previousTravelDirection": "stopped",
  "basis": ["launch", "gpsHeading"],            // what decided it
  "correction": false                           // true: forward ↔ reversing without a stop
}
```

| Field | Type | Presence | Notes |
|---|---|---|---|
| `uuid` | string (v4) | always | per message |
| `deviceId` | string | once the device was heard | as on `hour-meter:update` |
| `changedAt` | ISO-8601 UTC | always | when the published value changed (producer clock) |
| `travelDirection`, `previousTravelDirection` | as in the table above | always | |
| `basis` | string[] | always (may be empty) | what decided it: `launch` (accelerating away from a stop, or a velocity tracked through a short stop), `turn` (lateral acceleration vs yaw rate), `gpsHeading` (course vs a GPS-anchored gyro heading), `compass` (only once it agreed with GPS in three course quadrants), `fastTravel` (GPS above `HOUR_METER_REVERSE_MAX_KMH`), `gpsSpeed` / `imuStill` (stops and starts), `imuMotion` (already moving when first heard), `shuttle` |
| `correction` | boolean | always | an earlier direction in the same movement turned out wrong |

How it decides, and what consumers must assume:

- **Per movement.** A vehicle changes direction only through zero speed, so a decision holds until the next stop (or a shuttle), confirmed or corrected along the way. A fresh start keeps publishing `stopped` for up to 1.5 s while undecided; at most one change per 500 ms (`src/direction/tuning.ts`, `state`).
- **The device's default IMU stream (10 Hz) is too slow for launches.** The device sends snapshots, so idle engine vibration aliases to near-DC. At 10 Hz a launch alone decides nothing and the state stays `moving` until a turn or GPS settles it. Set the device's `imuStreamHz` to 100 (50 over Bluetooth) — `PATCH /api/hour-meter/settings`.
- **Not field-calibrated.** Thresholds (`microservice.hm: src/direction/tuning.ts`) are pinned by synthetic drives; the device simulator cannot reverse. Treat the state as **advisory** until calibrated on real machines (BACKLOG HM-08).
- **Excavators:** off (`HOUR_METER_DIRECTION=false`) — a board in the cab turns with the house, not with the tracks. geofencer also reports `null` for an Excavator.
- **Mounting:** `HOUR_METER_FORWARD_AXIS` (`+x`, `-x`, `+y`, `-y`; default `+x`) says which board axis points forward; an invalid value switches travel direction off. microservice.hm's `GET /health` `direction.mountCheck` warns when the evidence disagrees (it never changes the setting).
- **The IMU can be a WT61:** `HOUR_METER_IMU_SOURCE=wit` reads one through wt61-driver (see `FMS-Backend/docs/ecosystem/integrations/wt61-driver-to-hm.md`) — 100 Hz and filtered on the module, so the `imuStreamHz` advice does not apply; `WT61_FORWARD_AXIS` gives its mount. `forwardHeadingDeg` still comes from the hour meter's compass and `HOUR_METER_FORWARD_AXIS`. Switching the IMU at run time (`setImuSource`) starts the travel direction over.

### IMU — `hour-meter:imu` (microservice.hm → geofencer)

The IMU that `HOUR_METER_IMU_SOURCE` selects — the device's own IMU stream (msgType 128, `hm`, the default) or a WT61's samples (`wit`), never both, the same one the travel direction reads — decimated by `microservice.hm: src/handlers/ImuPublishHandler.ts (ImuPublishHandler)` (`src/helpers/imu-publish.ts (closeWindow)`) to `HOUR_METER_IMU_HZ` messages per second (default 10, at most 50, `0` off). Published whether or not travel direction is on (an excavator charts its IMU too). With `hm` and no IMU fitted, nothing is published; a window closes on the first sample after 1 / `HOUR_METER_IMU_HZ` s, so a silent source publishes nothing. For diagnostics: geofencer subscribes only with `ENABLE_DEV_API` and charts it on its dev console (`imuTrail`); nothing in its service path reads it.

```jsonc
{
  "deviceId": "1a2b3c4d",                       // only when source is "hour-meter"
  "source": "hour-meter",                       // or "wt61"
  "forwardAxis": "+x",
  "at": "2026-10-29T06:00:00.100Z",             // producer clock: the end of the window
  "windowMs": 100, "samples": 10, "missedFrames": 0,
  "accelG": { "x": 0.008, "y": -0.004, "z": 0.998 }, // window mean, g
  "gyroDps": { "x": 0.1, "y": -0.1, "z": 0 },        // window mean, °/s
  "angleDeg": { "x": 2.5, "y": -0.48, "z": 33.5 }    // latest attitude
  // "temperatureC": 31.2 — WT61 only
}
```

| Field | Type | Presence | Notes |
|---|---|---|---|
| `deviceId` | string | only when `source` is `"hour-meter"` and a frame has been read | as on `hour-meter:update` |
| `source` | `"hour-meter"` \| `"wt61"` | always | `HOUR_METER_IMU_SOURCE` (`hm` / `wit`) or the runtime override; the same as `imuSource` on `hour-meter:update` |
| `forwardAxis` | `"+x"` \| `"-x"` \| `"+y"` \| `"-y"` | always | the sensor axis pointing to the vehicle's front (`WT61_FORWARD_AXIS` / `HOUR_METER_FORWARD_AXIS`) |
| `at` | ISO-8601 UTC | always | producer clock: the end of the window |
| `windowMs`, `samples`, `missedFrames` | number | always | the window's length (ms), how many samples it averaged, how many the source's sequence says were lost |
| `accelG` | `{x, y, z}` (g) | always | the window's **mean**, 4 decimals, sensor axes: x right, y up the board, z out of it (+1 g flat at rest) |
| `gyroDps` | `{x, y, z}` (°/s) | always | the window's mean, 2 decimals (a WT61 reads exactly 0 below 0.122 °/s) |
| `angleDeg` | `{x, y, z}` (degrees) | when the source gave an attitude | the latest: x roll, y pitch, z yaw. A WT61's yaw **drifts** (no magnetometer); the hour meter's is present when its frame carried roll, pitch and heading (tags 40–42), z being its magnetic heading |
| `temperatureC` | number (°C) | WT61 only | the latest |

Means, not samples, so vibration does not alias into the trace; for the raw stream read wt61-driver directly or record with `HOUR_METER_DIRECTION_RECORD`. A publish that fails (Redis down) is dropped, logged once, never queued.

### Command and reply — `hour-meter:command` / `hour-meter:reply` (geofencer → microservice.hm → geofencer)

geofencer reads and changes the hour meter's own settings (the device's tags 110–128: telemetry interval, IMU rates, pulses per unit, input debounce, filters …). microservice.hm owns the only link to the device, so it carries the command out and answers once. Client: `geofencer: src/modules/hour-meter-commands.ts (HourMeterCommandClient.request, handleReply)`, timeout `HOUR_METER_COMMAND_TIMEOUT_MS` (`geofencer: src/constants/index.ts`). Server: `microservice.hm: src/handlers/HourMeterCommandHandler.ts (HourMeterCommandHandler)`, parsing and validation in `microservice.hm: src/helpers/hour-meter-settings.ts (parseCommand, validateSettings, readSettings, settingsSchema)`, read-only list in `microservice.hm: src/constants/hour-meter.ts (HM_READ_ONLY_SETTINGS, HM_HIDDEN_SETTINGS)`.

#### Payloads

```jsonc
// geofencer → hour-meter:command
{ "requestId": "5fdfef94-…", "action": "getSettings" }
{ "requestId": "01091d90-…", "action": "setSettings",
  "settings": { "telemetryIntervalMs": 3000, "pulsesPerUnit": 100 } }  // only what changes

// microservice.hm → hour-meter:reply
{ "requestId": "01091d90-…", "status": "ok", "deviceId": "1a2b3c4d",
  "settings": { "telemetryIntervalMs": 3000, "pulsesPerUnit": 100, "output": 1 /* … every setting but btPin */ },
  "schema": { "telemetryIntervalMs": { "type": "integer", "min": 100, "max": 60000,
              "unit": "ms", "help": "TELEMETRY period", "writable": true } /* … */ } }
{ "requestId": "…", "status": "rejected", "deviceId": "1a2b3c4d", "ackStatus": "InvalidValue",
  "setting": "imuStreamHz", "message": "device answered InvalidValue (tag 112: imuStreamHz)" }
{ "requestId": "…", "status": "invalid", "setting": "uartBaud",
  "message": "uartBaud cannot be changed remotely: …" }                // no deviceId: the device was not asked
```

| Field | Type | Presence | Notes |
|---|---|---|---|
| `requestId` | string | always | chosen by the caller (geofencer: a v4 uuid); the reply carries it back. A command with no non-empty `requestId`, or that is not a JSON object, is ignored — no reply |
| `action` | `"getSettings"` \| `"setSettings"` \| `"getImuSource"` \| `"setImuSource"` | command | anything else → `invalid` |
| `settings` | object, name → number \| boolean | `setSettings`; `ok` replies that read the device | device setting names. A change names only what it changes; the reply has every setting the device reports except `btPin` (`f32` values rounded to 7 significant digits) |
| `imuSource` | `"hm"` \| `"wit"` \| `null` (also `"hour-meter"` / `"wt61"`) | `setImuSource` | see the IMU source actions below |
| `status` | `"ok"` \| `"invalid"` \| `"rejected"` \| `"unavailable"` \| `"timeout"` \| `"error"` | reply | below |
| `deviceId` | string | `ok`, `rejected`, `timeout` replies, once the device was heard | as on `hour-meter:update`; absent from `invalid`, `unavailable` and `error` |
| `schema` | object, name → `{type, min, max, values?, options?, unit?, help, writable}` | `ok` replies that read the device | how each setting may be set — enough for a UI to render and pre-validate; `type` is `integer` \| `number` \| `boolean`, `writable` false for the read-only settings; `btPin` absent |
| `setting` | string | `invalid` / `rejected`, when one setting is at fault | for `rejected`, the device's `rejectedTag` by name |
| `ackStatus` | string | `rejected` | the device's reason: `InvalidValue`, `UnknownTag`, `StorageError`, `DeviceMissing`, `Busy`, `Unsupported`, `Failed`, `Locked`, `BadPin` … |
| `imu` | `{source, configured, override}` | `ok` replies to the IMU actions | below |
| `message` | string | when there is something to say | human-readable |

| `status` | Means | Device touched? |
|---|---|---|
| `ok` | done; `settings` is what the device holds **now** (read back with `get=2` after a change). If only the read-back failed: `ok` with a `message` and no `settings` / `schema` | yes |
| `invalid` | refused by microservice.hm: unknown, hidden or read-only setting, wrong type, out of range or not an allowed value, empty change, `settings` not an object, unknown action | **no** |
| `rejected` | the device refused it (e.g. `imuStreamHz` above `imuSampleHz`) | asked; nothing applied |
| `unavailable` | microservice.hm has no device link right now. geofencer also answers this itself, at once, when its Redis is not ready, the publish throws, or the publish reached 0 subscribers | no |
| `timeout` | the device did not ACK after 3 attempts (microservice.hm), or no reply within 10 s (geofencer) | unknown — read before retrying |
| `error` | anything else | unknown |

#### Rules and timing

- **All or nothing**, like the device: one bad value and nothing is applied (`validateSettings` stops at the first; the device applies one COMMAND whole or not at all).
- **Read-only from here:** `output`, `uartBaud`, `bluetooth` — each can cut the link microservice.hm reads the device through (or open a radio). **`btPin` is never sent**, not even on read, and is "unknown" to a change. These are changed on site with the device's configurator.
- **One command at a time** in microservice.hm (a promise chain), so a change and its read-back never interleave with another request — the IMU-source actions wait in the same line.
- **Device timing:** each device request is up to 3 attempts × 1500 ms ≈ 4.5 s (`DeviceClient.request` in the vendored codec). `getSettings` is one request; `setSettings` is the change then the read-back, up to ≈ 9 s. geofencer waits 10 s from its publish, no retry — so a command queued behind a slow one can reach geofencer as `timeout` and still be carried out afterwards, its reply going to nobody.
- **No queueing.** A command published while Redis or the device is away is answered `unavailable`, never carried out later. A `timeout` may still have been applied — read the settings again before retrying a change.
- **Matching:** geofencer registers the `requestId` before publishing, resolves with the first reply carrying it, and ignores replies for ids it is not waiting for (another process, or one that already timed out).
- Settings persist in the device (EEPROM) and apply at once.

#### IMU source actions — `getImuSource` / `setImuSource`

Which IMU microservice.hm reads (`HOUR_METER_IMU_SOURCE`: `hm`, the hour meter's own, or `wit`, a WT61), read and switched while it runs — geofencer's dev console does this. No device is involved. Server side: `microservice.hm: src/app.ts (MainApp.imuState, MainApp.setImuSource, MainApp.restoreImuSource)`.

```jsonc
// geofencer → hour-meter:command
{ "requestId": "…", "action": "getImuSource" }
{ "requestId": "…", "action": "setImuSource", "imuSource": "wit" }   // or "hm", or null

// microservice.hm → hour-meter:reply
{ "requestId": "…", "status": "ok", "deviceId": "1a2b3c4d",
  "imu": { "source": "wt61", "configured": "hour-meter", "override": "wt61" } }
```

| Field | Type | Presence | Notes |
|---|---|---|---|
| `imu.source` | `"hour-meter"` \| `"wt61"` \| `null` | always in `imu` | the IMU in use now; `null` when none works (e.g. a bad setting) |
| `imu.configured` | same | always in `imu` | what `HOUR_METER_IMU_SOURCE` says; `null` when it is neither `hm` nor `wit` |
| `imu.override` | same | always in `imu` | the runtime choice, kept in the Redis key `hour-meter:imu-source` as `hm` \| `wit`; `null` when none |

- `setImuSource` with `hm` or `wit` (the wire's `hour-meter` / `wt61` too, case-insensitive) switches the travel direction, `hour-meter:imu` and `rollDeg`/`pitchDeg` to that IMU together; **the travel direction starts over** on it. `null` deletes the key and goes back to `HOUR_METER_IMU_SOURCE`. Anything else, or no `imuSource`, is `invalid`.
- The choice is stored **before** switching; when the write fails (Redis down: `disableOfflineQueue` fails it at once) nothing is switched and the reply is `error`. It survives a restart of microservice.hm: applied once Redis first connects (the env's IMU runs until then), until cleared. A stored value other than `hm`/`wit` is logged and ignored. `GET /health` shows it as `imuSourceOverride`.

#### HTTP facade — `/api/hour-meter/settings` (on geofencer)

`geofencer: src/routes/hour-meter.ts (createHourMeterRoutes, sendHourMeterReply)` relays to the command channel above; it adds no state of its own.

- **Auth:** header `x-api-key` equal to this unit's `API_KEY`, compared in constant time (`geofencer: src/middlewares/api-key.ts (apiKeyAuth)`). Missing or wrong — or no `API_KEY` configured — → 401 `{ "errors": [{ "msg": "Unauthorized access" }] }`.
- `GET /api/hour-meter/settings` → `getSettings`.
- `PATCH /api/hour-meter/settings` with a JSON object of setting → value → `setSettings` with the body as `settings`, unchanged (an empty object is hm's `invalid` "no settings to change"). A body that is not a JSON object → 400 from geofencer without publishing.
- **200** `{ "data": { "device_id": …, "settings": …, "schema": …, "message"?: … } }` — `device_id`, `settings`, `schema` are `null` when the reply lacks them (an `ok` whose read-back failed).
- **Errors** `{ "errors": [{ "msg": <message or status>, "setting"?: …, "ack_status"?: … }] }`:

| Reply `status` | HTTP |
|---|---|
| `ok` | 200 |
| `invalid` | 400 |
| `rejected` with `ackStatus` `Busy` (a calibration is running) | 409 |
| `rejected` with `ackStatus` `StorageError` (the device's EEPROM write failed — it needs service) | 502 |
| `rejected` with `ackStatus` `Locked` (a locked Bluetooth session) | 503 |
| `rejected`, any other `ackStatus` | 400 |
| `unavailable` | 503 |
| `timeout` | 504 — the change may still have landed: `GET` before retrying |
| `error`, anything else | 502 |

The dev console (only with `ENABLE_DEV_API` / `ENABLE_DEV_CONSOLE`, `geofencer: src/routes/dev.ts`) uses the same client and mapping: `GET /api/dev/hour-meter/settings`, and `GET` / `PUT /api/dev/hour-meter/imu-source` (`PUT { "source": "hm" | "wit" | null }` → `setImuSource`; 200 `{ "data": <imu> }`, an `ok` without `imu` → 502).

> ⚠️ DEFECT: `/api/hour-meter/settings` is an HTTP route on the unit, guarded by the shared `x-api-key` that its middleware describes as "for calls from the Platform"; guardrail 17 (ADR D-7) says a request from off the vehicle reaches a cab only as `unit:command` over the tracker's socket. Nothing off the vehicle calls it today; it keeps serving on-vehicle callers until HM-06 moves it to `hour-meter:settings:get` / `:set` on `unit:command`.

### Consumer behaviour (geofencer)

1. **Guards** (`geofencer: src/helpers/hour-meter.ts`) return `null` on anything unusable and never throw — they run on Redis subscription callbacks, where a throw kills the process. `parseHourMeterUpdate` (messages and the hash alike) requires `uuid`, `deviceId`, a parseable `receivedAt`, boolean `timeValid` and `engineRunning` (`"true"`/`"false"` from the hash), finite non-negative `hourMeterS`, `hourMeterH`, `totalizerPulses`, `totalizerUnits` and `statusFlags`, and `statusFlagNames` as an array (or a comma string); optional fields that do not parse are left out, `travelDirectionChangedAt` is kept only with a valid `travelDirection`, and `imuSource` is not kept. `parseHourMeterEvent` requires `uuid`, `deviceId`, `receivedAt`, a finite `eventKind`; `parseTravelDirectionUpdate` requires `uuid`, `changedAt` and both directions; `parseHourMeterReply` requires `requestId` and a known `status`.
2. **Seed** (`RedisHourMeterHandler.seed`): `HGETALL hour-meter:state` through the same guard, run after subscribing and not awaited — pub/sub dropped everything published while the cab booted, and a seed older than an update that already arrived is ignored.
3. **Order:** an update whose `receivedAt` is older than the last accepted is dropped (equal is kept); a `travel-direction:update` whose `changedAt` is older than the last is dropped. Each accepted reading is re-emitted in-process (`hour-meter:reading`), each direction change likewise (`hour-meter:direction-changed`).
4. **Heading → track** (geofencer ≥ 0.4.40): the `track` sent with each GPS fix is `forwardHeadingDeg`, else `headingDeg`, when the latest reading carries one, is fresh (≤ 30 s by `receivedAt`) and `statusFlagNames` has no `magNotCalibrated`; otherwise the GPS course (`boardHeading`, `trackFromHeading`). Magnetic, uncorrected for declination (under 1° on site). From geofencer 0.4.48 the GPS course is turned 180° while the truck reverses, and while it stands where a reverse left it, so `track` is always the truck's front.
5. **Engine starts** (geofencer ≥ 0.4.40, `geofencer: src/handlers/EngineStartHandler.ts`): each reading where `engineRunning` goes false → true becomes one row in the cab's local `engine_starts` (hour meter, totalizer, `receivedAt` / `measuredAt`, equipment, login and operator), unique by the reading's `uuid`. The previous state is kept in `hour-meter:engine-running`, so a start while geofencer was down is caught at the boot seed; with no state known the first reading is a baseline. Pushed to microservice.tracker (`POST /api/engine-start`, at most 50 per pass; HM-07) — see §5.
6. **Motion** (geofencer ≥ 0.4.41, `MotionStateHandler`, `reduceMotion`): from `engineRunning` and `vibRmsMg` (the device sends no speed). Engine off → `engine-off` at once; engine running and `vibRmsMg` ≥ 60 mg for 3 s → `moving`; ≤ 40 mg for 10 s → `idle`; in between, no change; engine on with no vibration measured yet → `unknown`. Thresholds are env-configurable (`MOTION_*`) and not yet calibrated on a real truck. Kept in `hour-meter:motion`, served on `GET /api/states` as `motion`; a stale reading reads `unknown`.
7. **Travel direction** (geofencer ≥ 0.4.42): `travelDirection` / `travelDirectionChangedAt` from the hash are served on `GET /api/states` as `motion.direction` / `motion.direction_since` — `unknown` when the reading is stale, `null` without them and always `null` on an Excavator (`geofencer: src/routes/states.ts (motionForUi)`).
8. **Spotting and the cycle driver** (geofencer ≥ 0.4.44, HM-10): geofencer's `TravelDirectionHandler` combines this direction with a GPS detector of its own (judged against this board's heading whenever it is fresh and calibrated, geofencer ≥ 0.4.50) — the gyro first, GPS filling in when the hour meter is absent, stale, `unknown` or still `moving`, one source per movement. `SpottingHandler` stamps the open cycle's `start_spotting` / `end_spotting` from it (reversing at Arrived at Load until it stops; a truck that reversed into the departure ring starts at its arrival), and `start_dump_spotting` / `end_dump_spotting` the same at Arrived at Dump (geofencer ≥ 0.4.48), with auto-cycle on or off. Under auto-cycle a reversal that ends in a 5 s stop starts Loading (at Arrived at Load) or Dumping (at Arrived at Dump), and moving forward after Dumping is Travelling — each dated to its trigger. No excavator is involved.
9. **Raw readings** (geofencer ≥ 0.4.47, `HourMeterReadingHandler`): every accepted reading, field for field, goes to the cab's `hour_meter_readings` outbox and on to microservice.tracker (`POST /api/hour-meter-readings`, 200 per batch, deleted once acknowledged; through an outage only the newest 259 200 rows — three days at 1 Hz — are kept) — see §5. `bootCount` and `fwVersion` are not parsed, so they are not recorded.
10. **Device events** are logged (a boot with its reset reason, cause, stage and firmware; `safeMode` as a warning) and re-emitted in-process (`hour-meter:device`), which nothing listens to.
11. `GET /api/states` serves the hash, guarded, as `hour_meter` with `fresh` (≤ 30 s).

### Failure behaviour

- **Redis unreachable, microservice.hm side:** every publish and hash write fails at once (`disableOfflineQueue`); the reading is dropped, logged once per outage with a count on recovery. A travel-direction change in that window is lost as a message (its hash merge fails first, so nothing is published); the next `hour-meter:update` after recovery carries the current `travelDirection` again. Commands cannot arrive, and a reply that cannot be published is logged — geofencer then answers `timeout`. Reading the device, `/health` and the device clock sync carry on.
- **Redis unreachable, geofencer side:** `request` answers `unavailable` at once ("this unit's Redis is not connected") rather than queue a stale command. If only geofencer's subscriber connection is down, the command goes out and the reply is missed → `timeout`. node-redis re-subscribes after a reconnect on both sides.
- **microservice.hm down:** no publishes; `hour-meter:state` keeps the last reading (no TTL) and turns stale after 30 s by `receivedAt` in geofencer (motion `unknown`, direction `unknown`, heading → GPS course). A command reaches 0 subscribers → geofencer answers `unavailable` (503) at once.
- **Device unplugged or silent:** microservice.hm publishes nothing (the hash keeps the last reading); it answers commands `unavailable` while its link is down, `timeout` when the link is open but the device does not ACK. Its `/health` turns 503 after `HOUR_METER_STALE_MS` (15 s).
- **geofencer down:** it misses every message meanwhile; at boot it seeds from the hash, and a missed engine start is caught by comparing with `hour-meter:engine-running`. Missed `hour-meter:event`s and `travel-direction:update`s are not recovered (the hash carries the current direction).

### Wire-rule deviations

- `hour-meter:state` stores every value as a string (Redis hash) — booleans `"true"`/`"false"`, arrays comma-joined.
- `hour-meter:imu-source` stores `hm` / `wit`, while the wire says `hour-meter` / `wt61`.
- The `imu` reply object uses `null` for "none" rather than omitting.
- geofencer's HTTP facade answers snake_case (`device_id`, `ack_status`) with `null`s, in geofencer's own API style.
- `hour-meter:event`, `hour-meter:command` and `hour-meter:imu` end in a noun, not the verb of naming rule 13.

### Operational signals (not part of the contract)

microservice.hm's `GET /health` (port `PORT`, default 9000; 8802 in the cab compose) answers 200 only while TELEMETRY is fresh (`HOUR_METER_STALE_MS`, 15 s), 503 otherwise or while starting. It reports the link target and status, frame and telemetry ages, `deviceId`, `fwVersion`, `timeValid`, status flags, `bootCount`, last boot time and cause, frame counts, `frameErrors`, `unknownTags`, `silentReason` (a device that answers commands but sends no telemetry), reconnects, the three Redis connections (reported, never unhealthy), the travel direction's diagnostics with `mountCheck`, and `imuSource`, `imuSourceOverride` and `wt61`.

> ⚠️ DEFECT: geofencer's `HOUR_METER_SERVICE_URL` (`geofencer: src/constants/index.ts`) defaults to `http://localhost:9000`, and the cab compose does not set it. geofencer runs on the bridge network, so that is geofencer's own container, while microservice.hm listens on the host network at port 8802 — the dev console's `GET /api/dev/hour-meter` (microservice.hm's `/health`) cannot reach it on a cab. Only the dev console uses this URL; nothing in the service path does.

## 5. geofencer ⇄ microservice.tracker

geofencer runs on each vehicle computer. It reads GPS (microservice.gps) and the hour meter (microservice.hm), runs the geofence state machine, the event log, the session and the haul cycle, and keeps an offline outbox of everything it owes the server. microservice.tracker is the server-side ingest the cab talks to. It stores GPS history, keeps each unit's live state in Redis, writes event logs, sessions and cycles into the shared Postgres the Platform reads, and holds each cab's Socket.IO connection. The Platform never calls a cab directly: everything it asks of a cab rides this pair's socket (§ Socket.IO below).

This section covers every HTTP call geofencer makes to the tracker, the Socket.IO connection in both directions, and the tracker Redis that geofencer reads. The tracker's Redis bus towards the Platform (`track:update`, `cycle:*`, `event-log:*`, `session:*`, model publish hooks, the bus smoke check) belongs to §7; it is referenced here only where the cab's payload passes through.

### Transport & auth

- **HTTP base.** geofencer's `trackerRequest` (`geofencer: src/modules/request.ts`) is an axios instance on `GPS_SERVER_URL` + `/api`, using Deno's native `fetch` adapter. Its default timeout is **15 s** (`DEFAULT_TIMEOUT_MS`). Callers that pass their own timeout are listed under Operational parameters.
- **Any change to the shapes in this section must also update `microservice.tracker/src/docs/openapi.ts` in the same change.** The tracker serves that spec at `/api/docs` and `/api/docs/openapi.json`.

> ⚠️ DEFECT (TRK-04): `openapi.ts` has drifted from the code. It has no `/api/reconcile`, it documents a `/api/equipment/data` that does not exist, and it describes `/api/equipment` as geo-registration when that route is a retired no-op.

**Headers.** A request interceptor on `trackerRequest` stamps every tracker request with these headers:

| Header | Value | Read by the tracker |
| --- | --- | --- |
| `x-api-key` | geofencer's `API_KEY` | Yes. It must match a `registered_apps.api_key`. The match is cached at `api-key:{key}` (`microservice.tracker: src/middlewares/auth/apikey.ts (apiKey)`). |
| `x-equipment-uuid` | `equipment:details.uuid` from cab Redis (`""` when the cab has no identity yet) | Yes. It is resolved to the unit (`microservice.tracker: src/utils/middlewares/EquipmentUtil.ts (checkEquipment)`), which is cached in the hash `equipment:{uuid}`. Every per-unit route takes the unit from this header and never from the body or the path. |
| `equipment-uuid` | the same uuid | No. It is a legacy duplicate that the Platform reads. |
| `x-socket-id` | `equipment:details.socket_id` (the cab's current socket id) | No. |

> ⚠️ DEFECT (ECO-07): `equipment-uuid` and `x-socket-id` are dead weight on this pair. geofencer sends both on every request and the tracker reads neither.

**Status codes and bodies.** Status and body by situation (`microservice.tracker: src/handlers/AppErrorHandler.ts`):

| Situation | Status | Body |
| --- | --- | --- |
| `x-api-key` missing | 403 | `{"errors":[{"msg":"Forbidden","name":"ForbiddenError"}]}` |
| `x-api-key` unknown | 403 | `{"errors":[{"msg":"Invalid API key.",…}]}` |
| `x-equipment-uuid` missing | 403 | `{"errors":[{"msg":"Forbidden access",…}]}` |
| `x-equipment-uuid` unknown (or `""`) | 403 | `{"errors":[{"msg":"Invalid equipment ID",…}]}` |
| `AuthError` (`GET /api/session/:id` when the unit has no live session) | 401 | `{"errors":[{"msg":…,"name":"AuthError"}]}` |
| `NotFoundError` (unknown location code, hull number, cycle id, event-log id; `settings:shifts` not cached) | 404 | `{"errors":[{"msg":…,"name":"NotFoundError"}]}` |
| request body or query fails its `zValidator` schema | 400 | zod's raw result, `{"success":false,"error":{…}}`, **with no `errors` array** |
| a `ZodError` thrown inside a handler | 400 | `{"errors":[{"msg":"validation error","errors":[…issues]}]}` |
| `GeneralError`, any other `Error` (database constraint violations included) | 500 | `{"errors":[{"msg":…,"name":…}]}` |

- **Middleware order varies.** On `POST /api/cycles`, `PATCH /api/cycles/:id`, `POST /api/event-logs` and `PATCH /api/event-logs/:id` the schema check runs first. A malformed body with a bad key is therefore a 400, not a 403. Every other cab route authenticates first.
- **`GET /api/pinned-events` takes `x-api-key` only**, with no unit header check.
- **What the cab must check.** A drain may mark a row synced only against `assertTrackerAck` (`geofencer: src/helpers/tracker-ack.ts`). That helper requires the call not to throw (axios throws on any non-2xx), then requires no `errors` array, then requires a non-null `data`. Keep all three checks. A 2xx body that carries an `errors` array is still a rejection, and a zod 400 has no `errors` array, so checking only one of the two signals misses failures.

**Socket.IO.** The socket is served on the tracker's HTTP host and port.

- geofencer connects once at boot with `socket.io-client` on `GPS_SERVER_URL`: `transports: ["websocket"]`, `reconnection: true`, no auth payload (`geofencer: src/app.ts (MainApp.socketClient)`).
- When the tracker runs clustered (`CLUSTER_WORKERS` > 1), it refuses long-polling, so websocket transport is mandatory (`microservice.tracker: src/app.ts (MainApp.io allowRequest)`).
- Every request from off the vehicle reaches the cab over this socket: a `unit:command` relayed with an ack, or a prompt event such as `new:mine-plan`. Nothing reaches the cab by HTTP to the unit or by a Redis key the cab is expected to act on (FMS-Backend `docs/BACKLOG.md` guardrail 17).
- geofencer's own HTTP routes guarded by `x-api-key` (`/api/auto-cycle`, `/api/mine-plan-schedule`, `/api/hour-meter`) are **not part of this pair**. The tracker never calls them. They belong to §6, with GEO-21, GEO-22 and HM-06.

> ⚠️ DEFECT: the socket is unauthenticated on both ends. Any client that can reach the tracker's port can emit `equipment:connected` with another unit's uuid. The tracker then records that client's socket as the unit's, so the impostor receives the unit's commands and plan notices and answers them. The cab's 421 address check cannot help, because the real cab never sees the command.

### Idempotency & reconciliation

Every write endpoint on this pair is safe to retry with the same key. The cab therefore retries by default after an ambiguous outcome, such as a timeout or a lost response, instead of guessing whether the push landed.

| Endpoint | Idempotency key | Mechanism on the tracker | A repeat answers |
| --- | --- | --- | --- |
| `POST /api/track` (realtime) | `uuid` | `tracker.uuid` is UNIQUE | **500** (unique violation), after live state and `track:update` have run again. See the defect under Realtime ingest. |
| `POST /api/track` (array) | `id` (the same point uuid) | `tracker.uuid` UNIQUE; each row inserted on its own | 200; the duplicate is left out of `length` |
| `POST /api/event-logs` | `uuid` | `findOne({ uuid })` first; a unique conflict on `uuid` counts as success (`microservice.tracker: src/utils/routes/EventLogUtil.ts (createEventLog)`) | 200 with the stored row |
| `POST /api/cycles` | `uuid` | the same pattern (`microservice.tracker: src/utils/routes/CycleUtils.ts (createCycle)`) | 200 with the stored row |
| `POST /api/geofence` | `uuid` (optional) | `bulkCreate(…, { ignoreDuplicates: true })` (`ON CONFLICT DO NOTHING`) | 200; nothing is written again |
| `POST /api/session/late` | create path: `(equipment_id, operator_id, done_at)` | idempotent create of an already-closed session | 200 per element |
| `POST /api/engine-start` | `readingUuid` | `ON CONFLICT DO NOTHING` on `reading_uuid`; ids are read back with soft-deleted rows included | 200 `stored` with the existing id |
| `POST /api/hour-meter-readings` | `(equipment_id, receivedAt)` | `ON CONFLICT DO NOTHING` on the hypertable key | 200; the reading is counted in `stored` |

- **Array bodies are answered per element** on `POST /api/event-logs`, `POST /api/cycles`, `POST /api/session/late` and `POST /api/engine-start`, keyed by the element's own key. A draining outbox marks rows against that list, never against the status code. `POST /api/track` (array) and `POST /api/hour-meter-readings` answer counts only. `POST /api/geofence` (array) answers a count of the rows submitted.
- **Crossings sent without `uuid`** still store, and still duplicate on retry: the column is nullable so that older units keep working. Such crossings cannot be reconciled. geofencer sends its local row id as `uuid` on the realtime path and on the drain alike.

#### Reconciliation — `GET /api/reconcile` (geofencer → tracker)

This endpoint is read-only. It answers the question "which of my rows do you actually hold?", so that a unit can prove its outbox worked rather than assume it. The server publishes a summary of what it holds; the unit, which is the authority on rows it originated, does the diff. The server is never asked what it is missing, because a row it never received leaves no trace (`microservice.tracker: src/routes/reconcile.ts`).

```
GET /api/reconcile?stream=event_logs&from=<iso>&to=<iso>&buckets=12        phase 1
GET /api/reconcile?stream=event_logs&from=<iso>&to=<iso>&list=0,5          phase 2
    x-api-key, x-equipment-uuid
```

```jsonc
{ "data": {
  "equipment_id": 42,
  "stream": "event_logs",
  "window": { "from": "2026-10-01T00:00:00.000Z", "to": "2026-10-01T14:00:00.000Z" }, // AUTHORITATIVE
  "algo": { "digest": "fnv1a64-xor", "over": "uuid" },
  "count": 187,
  "digest": "9f3ac21b04de77a1",
  "buckets": [ { "i": 0, "count": 15, "digest": "0011aabb22334455" } /* … */ ],
  "rows": { "0": ["<uuid>", "…"], "5": ["…"] },   // phase 2 only
  "truncated": true                               // phase 2 only, when a bucket held > 500
} }
```

| Field | Type | Presence | Notes |
| --- | --- | --- | --- |
| `stream` (query) | `event_logs` \| `cycles` \| `geofence_logs` | optional, default `event_logs` | Time column used for each stream: `event_logs.start`, `mine_cycle.arrived_at_load` (rows where `start_equipment_id` is the unit), `geofence_logs.time`. |
| `from`, `to` (query) | ISO-8601 | optional | `to` defaults to now and `from` to `to − 26 h`. A window longer than **26 h** is refused. |
| `buckets` (query) | integer | optional | Default 12, clamped to 1–48. Buckets split the window **by time**, not by hash, so a contiguous loss lands in one or two buckets. |
| `list` (query) | comma-separated bucket indexes | optional | Asks for phase 2. At most **4** buckets per call and at most **500** uuids per bucket; overflow sets `truncated: true`. |
| `window` | object | always | **Authoritative.** Both sides resolve shifts from their own settings and can disagree by one boundary row. The unit filters its local rows against this echoed window, never against its own. |
| `count`, `digest` | integer, hex string | always | XOR of FNV-1a-64 over `uuid` only, never over row state. State divergence is already covered by `sync_hash`. The digest helper `reconcile-digest.ts` exists in both repos with pinned test vectors. |
| `buckets[]` | `{ i, count, digest }` | always | |

- **Rows with a null `uuid` are excluded.** Server-created rows have no uuid on the unit, so including them would leave a mismatch the unit could never resolve. Those rows travel `GET /api/event-logs` instead.
- **What the cab does** (`geofencer: src/handlers/ReconcileHandler.ts`): it reconciles `event_logs` and `geofence_logs`, each stream on its own. It runs as the last step of every on-connect pass, with the default window of `SYNC_LOOKBACK_MS` = 36 h. It also runs at each shift changeover against the shift that just ended (`SHIFT_RECONCILE_WINDOW_MS` = 14 h). Phase 2 is requested only for buckets that disagree. Rows the server is missing are **re-armed**, never sent from here: the cab clears `sync_hash` on an event log, or clears `synced_at` on a crossing, so that the normal drain picks the row up again. At most 200 rows are re-armed per run (`MAX_REPAIR_PER_RUN`). Server-only rows are counted and logged, nothing more.

> ⚠️ DEFECT: the endpoint is broken. The stream check is inverted (`if (streamKind.includes(stream)) throw`), so every valid stream answers **500** `unknown stream`, and any other name falls through to the cycles query. The type also lists an `operator` stream that loads cycles. geofencer's on-connect call asks for a 36 h window, which would be refused against the 26 h cap even once the inversion is fixed. Today reconciliation never runs; geofencer logs the failure and carries on.

### Realtime ingest — `POST /api/track` single object (geofencer → tracker)

**Sender:** `geofencer: src/handlers/RedisGPSHandler.ts (handle, _sendLocation)`. The **timeout is 45 s**. The cab ignores the response body. A success clears the cab's `disconnected` flag.

**Which fixes go out (geofencer ≥ 0.4.47).**

- **Filtering.** Each fix from microservice.gps first goes through a Kalman filter (`geofencer: src/helpers/kalman.ts`). A fix the filter rejects, a fix at `0, 0`, and a fix without finite coordinates are never sent.
- **Position.** `lat`/`lon` are the **filtered** position. While the receiver reports ≤ 1 km/h, they stay pinned where the truck stopped; the pin releases when speed rises or the filtered position drifts more than 10 m (`geofencer: src/helpers/gps-output.ts (holdStep)`).
- **Send rule.** A point is sent when the truck is not pinned, is at least 1 m from the last point sent, and at least 1 s has passed since then (`sendDecision`).
- **Heartbeat.** After 60 s with nothing sent, the current point goes anyway with `update: true`. The heartbeat is also how a disconnected cab probes the link: it is attempted even while disconnected, and a success clears the flag.
- **Socket gate.** While the socket is disconnected (`socket:disconnect`), a point due to be sent skips HTTP and goes straight to the delayed buffer.

```jsonc
{
  "uuid": "6a1f…",                     // REQUIRED. Point identity & idempotency key; one per fix (microservice.gps mints it)
  "lat": 0.569215,                     // REQUIRED. degrees, filtered / pinned
  "lon": 124.302153,                   // REQUIRED. degrees
  "time": "2026-10-19T01:35:28.000Z",  // REQUIRED. the GPS receiver's time; geofencer's clock if the fix had none
  "track": 181.0,                      // degrees, the truck's FRONT (see below)
  "speed": 15.6,                       // km/h, as the receiver reports it
  "alt": 85,                           // metres
  "fix": "3D",                         // "2D" | "3D" | null
  "update": false,                     // true on the 60 s heartbeat
  "errors": 0,                         // microservice.gps pass-through
  "processed": 1, "heading": 181.0, "trueNorth": 180.6  // microservice.gps pass-through
}
```

| Field | Type | Presence | Notes |
| --- | --- | --- | --- |
| `uuid` | string (uuidv4) | required | Unique per fix and never reused. A re-sent point must reuse it. |
| `lat`, `lon` | number | required | The Kalman-filtered position, pinned while stopped. `0, 0` is echoed back unstored (`{"data": <body>}`); geofencer never sends it. |
| `time` | ISO-8601 string | required | The receiver's GPS time, falling back to geofencer's `new Date().toISOString()`. The tracker stores the string as sent and compares `new Date(time)`. A value without a zone would be read in the tracker process's timezone; geofencer always sends `Z`. |
| `track` | number (degrees, [0, 360)) | present | Where the truck's **front** points (geofencer ≥ 0.4.40, ≥ 0.4.48): the hour meter's `forwardHeadingDeg`, else `headingDeg`, when the latest reading is ≤ 30 s old and has no `magNotCalibrated` flag. Otherwise it is the GPS course, turned 180° while the truck reverses or stands where a reverse left it (`geofencer: src/helpers/hour-meter.ts (boardHeading, trackFromHeading)`, `src/helpers/gps-output.ts (frontCourse)`). This is a magnetic heading with no declination correction (the site's declination is under 1°). |
| `speed` | number | present | **km/h.** microservice.gps's parser emits km/h; neither geofencer nor the tracker converts it. It is stored as received in `tracker.speed` and `state:{uuid}.speed`. |
| `alt` | number (m) | optional | Stored as the `altitude` column. |
| `fix` | `"2D"` \| `"3D"` \| null | optional | |
| `update` | boolean | present | `true` on the heartbeat. The tracker ignores it. |
| `errors`, `processed`, `heading`, `trueNorth` | as microservice.gps publishes them | present | The tracker does not store them, but they ride along into `track:update`. |

**Tracker side** (`microservice.tracker: src/utils/routes/TrackUtil.ts (insertToDB, updateState)`):

1. `distance` is measured from the unit's previous live position.
2. The live-state compare-and-set runs: `UPDATE_EQUIPMENT_STATE_SCRIPT` in `microservice.tracker: src/modules/redis-scripts.ts`. The point wins unless the stored `last_updated_ms` is **strictly greater** than its time, so an equal time wins again. A winning point writes `state:{uuid}`, GEOADDs to `location:{category}`, publishes `track:update` (the request body spread, plus `coordinates`, equipment identity and the previous `last_updated`), and, for a fresh excavator fix, publishes `excavator:update` (§ Tracker Redis read by geofencer).
3. The row is inserted into `tracker` with `is_realtime: true`. Out-of-order points are stored but never move live state or publish.

The answer is `200 {"data": {…the stored row, "last_updated", "distance"}}`. `last_updated` is `state:{uuid}.last_updated` read after the compare-and-set (this point's own `time` when it won). `distance` is in metres.

> ⚠️ DEFECT: the compare-and-set and both publishes run **before** the insert. A re-sent uuid therefore moves live state and re-publishes `track:update` (and the beacon), then fails the unique constraint. On the realtime path that failure answers 500. geofencer never re-sends a realtime uuid itself; the case arises when a response is lost and the point is later drained as delayed (see Short-count resolution).

> ⚠️ DEFECT (ECO-04): `track:update` carries the cab's `alt` unchanged while the Platform reads `altitude`. The field is owned by §7, but the value originates here.

**Failure handling on the cab.** **Any** failure (timeout, 5xx, a refused connection) sets `disconnected` and pushes the point into the in-memory delayed buffer:

- The buffer is deduplicated by `uuid` and capped at **5000** points, dropping the oldest when full.
- It is flushed to the SQLite `Track` table every **5** points or **10 s**, and on SIGTERM. A failed insert stays buffered; a duplicate id counts as stored (`RedisGPSHandler (handleDisconnectedNetwork, flushDelayedTracks, _storeDelayedDataToDB)`).
- The buffered point keeps its `track`, so its delayed twin carries the same heading.

Nothing is lost, but the point is downgraded from realtime (a blue track on the dashboards) to delayed (red). **Tracker-side 5xx or responses slower than 45 s silently degrade the live map.** Treat sustained growth of `is_realtime = false` rows as an alert condition, not as network weather.

### Delayed backfill & offline-first rules

#### Delayed backfill — `POST /api/track` array (geofencer → tracker)

**Sender:** `geofencer: src/utils/others/DataUtils.ts (_sendDelayedTracks)` through `src/helpers/sync-data.ts (DataSyncer.sendDelayedTrackData)`.

- **When it runs.** In step 10 of the 60 s tick, in the on-connect pass, and whenever the truck is within 120 m of the charging-station location `RS-S-0208`. The charging-station trigger fires at most every 5 s and flushes the in-memory buffer first.
- **Concurrency guard.** One drain at a time per `DataUtils` instance, and never twice within 5 s.
- **Read.** The oldest **200** `Track` rows by `time`, read with `raw: true`.
- **Send.** Sequential chunks of **50**. Each chunk is retried up to 5 times with exponential backoff from 1 s, capped at 30 s, and chunks are spaced 500 ms apart. A failed chunk is skipped (`continue`), never allowed to block the rest.

```jsonc
[
  {
    "id": "6a1f…",                                                         // REQUIRED. the point's uuid (the realtime identity)
    "time": "2026-10-19T01:20:11.000Z",                                    // REQUIRED. GPS time, else geofencer's clock at buffering
    "coordinates": "{\"type\":\"Point\",\"coordinates\":[124.3021,0.5692]}", // REQUIRED. GeoJSON Point, [lon, lat]
    "track": 181.0,                                                        // degrees, front; 0 when unknown
    "altitude": 85,                                                        // metres; 0 when unknown
    "is_fix": true,
    "speed": 15.6                                                          // km/h
  }
]
```

| Field | Type | Presence | Notes |
| --- | --- | --- | --- |
| `id` | string (uuidv4) | required | Becomes `tracker.uuid`. The duplicate key makes retries idempotent. |
| `time` | ISO-8601 string | required | Passed through as stored on the cab. |
| `coordinates` | GeoJSON Point, as a JSON **string** or an object | required | geofencer sends the stored string (raw rows). The tracker parses it **per row** (`microservice.tracker: src/helpers/track-batch.ts (parseBatchRow)`) and accepts either form. An unreadable row is dropped, logged and left out of `length`. It no longer fails the batch. |
| `track` | number | present | As on the realtime point. |
| `altitude` | number (m) | present | Becomes `alt` and then the `altitude` column. |
| `is_fix` | boolean | present | `true` becomes `fix: "3D"`, anything else `null`. A 2D fix therefore arrives as `"3D"`. |
| `speed` | number (km/h) | present | |
| `created_at`, `updated_at` | — | present | Raw-row columns. The tracker ignores them. |

**Tracker side** (`TrackUtil.insertToDBBatch`):

- Every readable row goes through the same `insertToDB` as a realtime point, all concurrently (`Promise.allSettled`), with `is_realtime: false`.
- **A delayed point that wins the compare-and-set moves live state and publishes `track:update`** exactly like a realtime one. `excavator:update` is held back for any fix older than 2 min, so an excavator draining a backlog does not beacon it. Stale points never move live state.
- The answer is `200 {"data": {"length": <rows inserted>}}`. Duplicates, unreadable rows and failed inserts are all left out of the count and not reported individually.
- There is no maximum batch size (`DELAYED_DATA_CHUNK_SIZE` is defined but unused).

#### Short-count resolution (geofencer side)

Duplicates are excluded from `length`, so a chunk that once partially landed can never answer a full count again. "Keep the whole chunk and retry" would therefore hold those rows at the head of the oldest-first query forever, and the outbox would wedge on the tick and on reconnect alike. Deleting on a short count is no better: it destroys fixes the tracker never stored.

The drain resolves a short count by re-sending the chunk's rows **one at a time**, spending at most `TRACK_FALLBACK_MAX_PER_DRAIN` (50) single-row requests per pass (`DataUtils._resolveShortChunk`). A 1-row array turns the ambiguous count into a per-row verdict:

| Answer to a 1-row array | Meaning | The cab |
| --- | --- | --- |
| `{"data": {"length": 1}}` | proven store | deletes the local row |
| a clean `{"data": {"length": 0}}` (2xx, no `errors`, `data` present) | deterministic refusal: a duplicate the tracker already holds (the usual case) or an unstorable row | moves the row to the local `track_dead_letters` table (capped at `TRACK_DEAD_LETTER_CAP` = 5000, evict-oldest). The row is kept, out of the drain head, and never silently deleted. |
| a throw (timeout, socket error, `errors` envelope, non-2xx) | transient, or a rejection of the push itself | leaves the row in `Track` and stops probing for this pass |

> ⚠️ DEFECT (GEO-18): a clean `length: 0` cannot tell "already stored" from "refused", so the probe dead-letters both. The tracker owes per-id results, or must count duplicate ids as accepted. Once it does, the probe can delete proven duplicates outright.

#### Drain health keys (cab-local Redis)

| Key | Meaning |
| --- | --- |
| `sync:track:attempt` | the drain last ran with rows present |
| `sync:track` | rows were last **proven stored** (never stamped by a pass that made no progress) |
| `sync:track:failed` | consecutive passes with zero progress; deleted on progress (dead-lettering counts as progress) |

#### Sync passes

geofencer drains its outboxes in two kinds of pass.

The **tick** runs every **60 s** (`geofencer: src/utils/others/SyncRunner.ts (SyncRunner.steps)`) under the Redis lock `sync:running` (TTL 600 s). The same runner serves the manual `POST /api/sync { method: "all" }` on the cab. Every step is caught and recorded on its own. The order is: low-volume, high-value pushes first, the session before anything that is attributed to it, and pulls last.

The **on-connect pass** runs on every socket connect, the first one included (`geofencer: src/handlers/NetworkHandler.ts (runConnectSync)`). Only one runs at a time, and it is skipped while the unit has no identity. A **90 s** deadline (`ON_CONNECT_DEADLINE_MS`) is checked between steps: steps past the deadline are skipped for the tick to pick up, and a step already in flight is never aborted.

| # | Tick step | Peer | On-connect pass |
| --- | --- | --- | --- |
| 1 | session sync (`POST /api/session`) | tracker | 2nd, after the master-data pull (Platform), which runs 1st |
| 2 | late session sync (`POST /api/session/late`) | tracker | 3rd |
| 3 | engine start sync (`POST /api/engine-start`) | tracker | 4th |
| 4 | event log sync (`POST`/`PATCH /api/event-logs`) | tracker | 5th |
| 5 | current event push (`PATCH /api/event-logs/current/:id`) | tracker | 9th |
| 6 | cycle sync (`POST`/`PATCH /api/cycles`) | tracker | 7th |
| 7 | prestart check sync | Platform | 6th |
| 8 | equipment status pull | Platform | — |
| 9 | geofence log sync (`POST /api/geofence`) | tracker | — |
| 10 | delayed track sync (`POST /api/track` array) | tracker | 8th |
| 11 | hour meter sync (`POST /api/hour-meter-readings`) | tracker | — |
| 12 | unsynced event log pull (`GET /api/event-logs`, `GET /api/event-logs/current/:id`) | tracker | — |
| 13 | geofence tuning pull | Platform | — |
| 14 | current operator push (`POST`/`DELETE /api/operators/auth`) | tracker | — |
| — | — | — | 10th: reconcile (`GET /api/reconcile`) |

Separately, the cab's `socket:connect` handler (`geofencer: src/handlers/LocalEventHandler.ts (onSocketClientConnect)`) does more on every connect. It reads `GET /api/session/:id`, then runs the current event push, the event log sync, the cycle sync and the current operator push. This runs alongside the on-connect pass.

> ⚠️ DEFECT: the on-connect pass and the `socket:connect` handler each build their own `DataUtils` and do not take the tick's `sync:running` lock. Their drains can therefore run at the same time as the tick's, on the same rows. The tracker's idempotency keeps this safe, but a duplicate track chunk comes back short and its rows get probed and dead-lettered, as described above.

#### Offline-first rules on this surface

These rules were learned in the field, mostly on links where packets vanish instead of connections being refused.

- **A drain selects on state, never on age.** "Pending" is `synced_at IS NULL OR updated_at > synced_at` (`geofencer: src/helpers/pending-window.ts (pendingWhere)`), meaning the server lacks the row or holds a stale copy. The final check is `sync_hash !== createDataHash(row)`. A time-bounded pre-filter makes "old" mean "gone": a cab parked overnight runs no tick, and the window slides past its rows. `GET /api/event-logs/by-date` on the unit reports what is still owed.
- **A drain's limit bounds what it pushes, not what it looks at.** "Pending" cannot be expressed in SQL, so `selectPending` pages oldest-first through up to 10 000 candidates until it has its cap. The caps are 200 event logs, sent 8 at a time, and 100 cycles, all sent at once. Filtering in JS after a `LIMIT` once meant "only ever consider the oldest N"; when those were all synced, nothing newer was ever selected.
- **A drain may only delete or stamp what the tracker acknowledged.** Every drain goes through `assertTrackerAck`, so short counts are resolved row by row, never guessed (see above). `synced_at` is stamped only when the hash of the tracker's echo equals the local hash (`markSynced`). A transformed echo leaves the row pending until the two agree.
- **The unit owns `status` until the event that set it is acknowledged.** A breakdown recorded offline is something the Platform does not know yet, so a status pull on reconnect must not overwrite it. The veto is narrow and lifts as soon as the event log drains.
- **A breakdown is judged by what the unit is doing, not by the payload's age.** The tracker flips `mine_equipments.status` to `Breakdown` for a breakdown-typed log unless a newer event has already moved the unit on (`EventLogUtil (handleBreakdownEvent, supersededByNewerEvent)`). There is no wall-clock cutoff, because an offline buffer produces old but valid rows by design. The flip runs before, and independently of, any session lookup.
- **The session goes first (geofencer ≥ 0.4.21).** A Production login's event logs, current event and cycles are not pushed until its session has a server id (`current:session.id`). On the realtime path, `EventLogHandler.handle` awaits the session push while the session has no id and sends the log and current event only if that push landed. `CycleHandler` sends a cycle only once its own login has a server session. In the drains, the current login's rows are held while its session has no id. Ended logins are never held: their sessions go through the late-session step first. Non-production sessions carry no server id and are never held. Without this ordering, rows reached the tracker before any session existed to attach them to.
- **The session and the current event are pushed on the tick, and on every event transition (geofencer ≥ 0.4.9).** The tracker attributes an event log to the session that covers its `start_time`, found through `current-session:{equipment_id}`, and that pointer is repopulated only by `POST /api/session`. The current-event hash goes stale during any outage. `EventLogHandler.handle` pushes the session right after it merges the new event and a fresh `updated_at`. The push is detached from the request and never serialised behind the event-log push. A logout-code event is the exception: its own chain snapshots the session and pushes it with `done_at`.
- **Order of push and pull.** The tick pushes before it pulls. The on-connect pass pulls master data **first**, because the cycle drain needs `current:plan`. That makes the rule above load-bearing: whatever the cab owns, it keeps until the server acknowledges it.

### Event logs

#### Event-log creation — `POST /api/event-logs` (geofencer → tracker)

**Senders:**

- `geofencer: src/handlers/EventLogHandler.ts (sendToServer)`, realtime, one object per transition, 15 s timeout.
- `geofencer: src/utils/others/DataUtils.ts (syncEventLogs)`, the drain: one object per row, 8 in flight, 200 rows per pass, `POST` while the row has no `synced_id`.

Both build the body in one place, `geofencer: src/helpers/sync-payloads.ts (toTrackerEventLog)`; do not hand-roll it. The tracker also accepts an array, answered per element. geofencer does not send arrays here.

```jsonc
{
  "uuid": "0f8e…",                          // REQUIRED. the unit's row id (uuidv4); idempotency key. Key must be present (null allowed by schema)
  "event_id": 30,                           // REQUIRED. mine_event.id
  "event_code": "CO-S-0030",                // REQUIRED.
  "event_description": "Change Operator",   // REQUIRED. "-" when the unit has none
  "event_status": "STANDBY",                // REQUIRED. joined from the cached Event master row; "-" when unknown
  "start_time": "2026-10-19T01:35:28.000Z", // REQUIRED. ISO-8601 with Z only
  "end_time": null,                         // ISO-8601 with Z, or null
  "latitude": 0.5692,                       // REQUIRED. degrees; 0 when the row has no point
  "longitude": 124.3021,                    // REQUIRED. degrees; 0 when the row has no point
  "location_id": 12, "location_name": "LS-01", // fallback only (see below)
  "remarks": null,
  "cycle_uuid": "4c2d…",                    // the unit's cycle row id, or null
  "operator": "Budi",                       // from the row's own login, or null
  "operator_id": 183                        // server user id from the row's own login, or null
}
```

| Field | Type | Presence | Notes |
| --- | --- | --- | --- |
| `uuid` | uuidv4 \| null | required key | The local `EventLog.id`. A re-POST of a stored uuid returns the stored row. |
| `event_id` | number | required | `zod.coerce.number()`; absent becomes NaN, which is a 400. |
| `event_code`, `event_description`, `event_status` | string | required | `zod.coerce.string()`; see the coercion defect under Cycles. `event_status` has no local column; it is joined from cached `Event` master data. |
| `start_time` | ISO-8601, `Z` suffix | required | `zod.iso.datetime()` refuses offsets. Becomes `start`. |
| `end_time` | ISO-8601 `Z` \| null | optional | Becomes `end`. `completed = end_time != null`. |
| `latitude`, `longitude` | number | required | Derived from the local GeoJSON `Point` (`[lon, lat]`); `0, 0` means no fix. They are the **input** to the server's location label. |
| `location_id`, `location_name` | number \| null, string \| null | optional | Fallback only. |
| `remarks` | string \| null | optional | |
| `cycle_uuid` | uuidv4 \| null | optional | When a cycle with that `uuid` exists, the tracker fills `cycle_id`; the cycle's create and update back-fill it too. |
| `operator` | string (≥ 3 chars) \| null | optional | |
| `operator_id` | integer ≥ 1 \| null | optional | |

**Tracker side** (`microservice.tracker: src/utils/routes/EventLogUtil.ts (createEventLog)`):

- **Idempotent on `uuid`.** The stored row is looked up first, and a unique conflict on `uuid` is treated as success.
- **Breakdown flip** runs first, as described under the offline-first rules.
- **Session claiming.** The live session (`current-session:{equipment_id}`, open, `end_hour_meter = 0`) claims the row only when `start_time` falls inside the session's lifetime (`sessionCovers`). Otherwise the row is stored **session-less**, with `created_by: "geofencer (drained)"`. A missing session never fails the POST.
- **Shift.** `shift` is the shift of `start_time` resolved against `settings:shifts`, even when a session claims the row. The claiming session's shift is used only while the settings are not cached.
- **Location.** The tracker resolves `location`/`location_id` itself, from `latitude`/`longitude`. It takes the nearest active `mine_locations` geometry within `EVENT_LOG_LOCATION_MAX_METERS` (250 m, env-overridable) via PostGIS `ST_Distance`. That distance is 0 anywhere inside a polygon, and lines are matched along their length. The payload's `location_name`/`location_id` are kept only when nothing is in range, when the coordinates are unusable (null, non-finite, or exactly `0, 0`), or when the lookup fails. Both columns always come from one source. A failing lookup never fails the POST. The cab's own label covers much less: it comes from a Redis geo set holding only `Point` locations, searched within 20 m. So send accurate coordinates. `location_to_*` are cycle destination fields and are not touched by this.
- **Operator.** The claiming session's `operator_name`/`operator_id` win. Next comes the payload's `operator`/`operator_id`, and last the mirrored `current-operator:{uuid}` (§ Current operator).
- **Answer.** A single object answers `200 {"data": <row>, "session"?: <session>}`. An array answers `{"data": [{ "uuid", "stored": true, "id" } | { "uuid", "stored": false, "msg" }], "session"?}`. For `session`, see Plan re-sync below.

**Operator attribution (geofencer ≥ 0.4.8).** `operator`/`operator_id` come from the row's **own** `login_history_id`: `LoginHistory.operator_id` (the server id) and the cached `Operator` row for the name (`DataUtils.operatorForEventLog`). They never come from whoever is logged in when the drain runs. A row with no login history, or whose history is gone, is sent with both fields `null`, never `""`, `0` or an absent key, and the tracker then attributes it from the covering session.

#### Event-log update — `PATCH /api/event-logs/:id` (geofencer → tracker)

`:id` is the server's numeric id (the local `synced_id`). There is no `POST /api/event-logs/:id`: a POST to that path is a 404. Three senders use different bodies:

| Sender | When | Body |
| --- | --- | --- |
| `DataUtils.syncEventLogs` | the drain, for a row with `synced_id` | `toTrackerEventLog` (as for POST) |
| `EventLogHandler.updateEventOnServer` | the previous event closed on a transition | `{ "end_time": "<ISO Z>" }` only, followed by the current-event PATCH (60 s timeout) |
| `EventLogHandler.syncPatchedEventLog` | an in-cab correction of the running event | the raw local row (`eventLog.toJSON()`), 15 s timeout |

On the tracker, the schema is the create schema, all fields optional (`createEventLogSchema.partial()`), with unknown keys stripped. The row is found by primary key, and the body is written with `end_time` mapped to `end`. The reply is `{"data": <row>}`, with no plan re-sync.

> ⚠️ DEFECT (ECO-02): `start_time` is not mapped to `start`, so a corrected start never lands. `completed` is not in the schema, so zod strips it. The echo therefore says `completed: false` for a log pushed while open, even though the same reply carries the new `end`.

> ⚠️ DEFECT: the row is found by id alone, with no check that it belongs to the calling unit. Any authenticated unit can amend any event log.

**Update echo (geofencer ≥ 0.4.13).** Because of ECO-02, the cab treats an echoed `end` as finished when it hashes the reply (`createServerEventLogHash`), the tracker's own create rule. Without that, such rows never settled and were re-PATCHed on every tick, filling the drain's window.

#### Un-synced event logs — `GET /api/event-logs` (geofencer pulls from tracker)

**Caller:** `geofencer: src/handlers/UnsyncedEventLogHandler.ts (pullUnsyncedEventLogs)`. It runs at boot and in step 12 of every tick.

Server-created event logs carry `uuid = null`, so the unit has no copy of them. This endpoint returns those rows for the calling unit within the **current shift**. The shift comes from `settings:shifts` on the tracker's Redis, with each entry's date rebased to today (`microservice.tracker: src/middlewares/settings`).

```jsonc
{ "data": {
  "shift": { "name": "DAY", "start": "…", "end": "…" },
  "count": 2,
  "rows": [ /* event_logs rows, uuid = null, ordered by start */ ]
} }
```

- **404** when `settings:shifts` is not cached on the tracker's Redis, or when no shift covers now. **Ops: keep `settings:shifts` seeded on the tracker's Redis instance.**
- **What the cab does with the answer.** Each row is inserted into the local `EventLog` keyed by `synced_id = row.id`, so re-pulls are idempotent. The sync hash is pre-stamped, so the row is never pushed back. A `WO-S-0156` row is stored like any other (§ `equipment:ready`).

#### Current event — `PATCH` / `GET` `/api/event-logs/current/:id` (geofencer ⇄ tracker)

The tracker keeps one current-event hash per unit at `current-event:{numeric equipment id}`. The Platform writes the same key: session end, return to service, the shift-start sweep, a dispatcher's event log. Every dashboard reads it. **Both services write through one compare-and-set script**, `src/helpers/current-event-write.ts` (`CURRENT_EVENT_CAS_SCRIPT`), byte-identical in both repos with its SHA-1 pinned in both test suites.

**PATCH senders:**

- `EventLogHandler.sendCurrenEventToServer` after each transition, 15 s timeout.
- `EventLogHandler.updateEventOnServer`, which adds `operator`/`operator_id` and uses a 60 s timeout.
- The current-event push in the tick and on connect: `DataUtils.syncCurrentEventLog`, which goes through `DataSyncer.syncSingleData`, adds `operator_id`, `operator` and `session_id` from `current:session`, and is skipped while the session has no server id.

The body is the cab's `current:event` hash (`RedisEventLogData`):

```jsonc
{
  "id": "0f8e…",                     // REQUIRED. the unit's row id (uuidv4), never the server's
  "synced_id": "8123",               // the server id, once the row has one / for an adopted server event
  "start_time": "2026-10-19T01:35:28.000Z", // REQUIRED.
  "event_id": "30", "event_code": "CO-S-0030", "event_type": "STANDBY", "event_status": "…",
  "event_description": "…", "event_description_ind": "…",
  "updated_at": "…"
}
```

| Field | Type | Presence | Notes |
| --- | --- | --- | --- |
| `id` | string | required | The local `EventLog` primary key. Identity is `synced_id \|\| id`, so an adopted server event keeps the server's id. The Platform names its own events `log.uuid ?? log.id`, so both writers name one event the same way. |
| `synced_id` | string | optional | |
| `start_time` | ISO-8601 | required | A missing or unparseable value answers `reason: "invalid: start_time"`. A start in the future is ordered by when the push arrived. |
| `event_*` fields, `updated_at` | string | present | All keys in `RedisEventLogData` are part of the contract. A writer that omits one must not leave the previous event's value behind; the script replaces the hash whole. Adding a field the cab reads means adding it to `FMS-Backend/src/helpers/current-event-hash.ts`. |

**Tracker side** (`microservice.tracker: src/controllers/EventLogController.ts (updateCurrent)`). The unit is the `x-equipment-uuid` header; **the path `:id` is ignored**. The compare-and-set decides:

| Situation | Outcome (`reason`) |
| --- | --- |
| a different event, start the same as or later than the stored one | written (`changed`) |
| a different event, older | refused (`older`): an old event drained after an outage cannot move the slot back |
| a cab event over one the Platform wrote, up to `CURRENT_EVENT_CAB_GRACE_MS` (2 min) older | written: cab clocks run behind |
| the event the slot last replaced (`superseded_id`), whatever its start | refused (`superseded`) |
| the same event, Platform-written, pushed by the cab | refused (`platform-owned`): the tick does not undo a dispatcher's edit |
| exactly what is stored (same fingerprint) | `unchanged`: nothing written, nothing announced |

- **The answer is always 200**, even for an unreadable body or a script error: `{"data": {…body, "equipment_id", "synced_at"}, "applied", "reason", "session"?}`. `applied` is true when the slot now holds this event (`changed` or `unchanged`). A refused push is not an error: the cab adopts the newer server event on its next pull.
- **A write that lands** replaces the hash whole and bumps `rev`, which never decreases. It is announced on `current-event:update` (relayed by the Platform as `update:current-event`) and on the frozen `replace-event-log`. The open session's `event_*` follows.
- **Plan re-sync** runs on every call (see below).

**GET**, from `UnsyncedEventLogHandler.pullCurrentEventFromServer` in the tick (step 12) and at boot, returns `{"data": <hash without its bookkeeping fields, rev kept> | {}}`. `GET /api/event-logs/:id` is an **alias** of this endpoint, not a lookup by event-log id; both ignore their parameter. geofencer calls `/event-logs/current/{equipment id}`.

**What the cab does with the answer.** A hash with no `start_time` counts as "no current event". When the server hash names a different event (compared on `synced_id`, then `id`), the cab adopts it:

1. `current:event` is copied to `previous:event`, whose `end_time` becomes the server event's `start_time`.
2. The server hash becomes `current:event`.
3. The local event log that *was* current is completed with that same `end_time`.

A server-side change therefore reaches the cab within one tick. `current:event.id` is always the unit's own row id. The server id lives in `synced_id`, because every local close path matches on `id` against a uuid column.

> ⚠️ DEFECT (GEO-19): the cab never re-adopts an event it already holds. A dispatcher's edit that keeps the event's id and start lands on the server and every dashboard, but never on the cab. Adopting on a higher `rev` is the fix.

> ⚠️ DEFECT (GEO-20): the cab stamps `start_time` with its own clock. The 2 min grace exists only because cab clocks run behind. geofencer already measures `session:clock-skew` but does not apply it to `start_time`.

#### Plan re-sync on event logs (tracker → geofencer, in the reply)

Every event log a **truck** reports re-syncs its session with its mine plan. That covers `POST /api/event-logs` (once per request, also for an array) and `PATCH /api/event-logs/current/:id` (`microservice.tracker: src/utils/others/PlanSyncUtil.ts`, rules in `src/helpers/plan-sync.ts`).

- **Which plan.** The `mine_plans` row with `equipment_type = 'Truck'` and `truck_id` = the truck whose `[shift_start, shift_end)` contains the session's `created_at` + 20 minutes, else its `created_at` (the login's handover rule).
- **Trigger.** The plan's `id` differs from `session.mine_plan_id`, or its `exca_id` differs from `session.exca_id`.
- **Copied.** `mine_plan_id`, `exca_plan_id`, `exca_id/hull_number/asset_name`, `exca_session_id` (the excavator's live session, else null), `loading_location_id/code/name`, `materials`, `blocks`, `foreman_id/name/oracle_number`. The current `material_*` / `dumping_location_*` / `dumping_cell_*` / `block_*` are chosen by the Platform's rule: a live excavator session's selection wins; otherwise the truck's current choice is kept if the plan still offers it; otherwise the plan's first entry. The truck's open cycle follows. The write is an instance update inside a locked transaction, so `session:update` publishes on commit.
- **Not touched.** Excavators and every other category, a truck with no plan for the window (left as is, never blanked), and a truck with no open session. A failure in the sync never fails the event log.
- **Reply.** When the sync changed the session, the fresh row rides as a **`session` sibling of `data`**; `data` is unchanged.

**What the cab does with the answer** (`geofencer: src/helpers/server-session.ts (adoptServerSession)`). Every event-log sender passes the reply through `adoptServerSession`. It merges exactly the copied fields (plus `updated_at`) into `current:session`, and only when a session exists locally **and** its id matches. It then persists the durable subset to `LoginHistory` and emits local `session:update`. The next `POST /api/session` remains the backstop: the copied fields are server-owned, so the unit's stale copies cannot undo them.

### Sessions

#### Session sync — `POST /api/session` (geofencer → tracker)

**Sender:** `geofencer: src/utils/routes/SessionUtils.ts (syncSession)`. It runs in step 1 of the tick, on connect, and on event transitions, with a 15 s timeout.

The body is the whole cached `current:session` blob. It carries undeclared extras (`token`, `last_updated`, `login_history_id`), and on the non-production path it is built from the current event and the shift. Two fields are overridden on the way out:

- `end_hour_meter` comes from the current login's `end_hm`.
- `updated_at` is shifted into the tracker's clock domain (below).

The tracker therefore **merges** the blob rather than applying it wholesale.

```jsonc
{
  "id": 8123,                               // server session id; null for an offline/degraded login not yet created
  "updated_at": "2026-10-19T01:35:29.000Z", // REQUIRED for any field to apply; shifted into the tracker's clock
  "created_at": "2026-10-18T22:56:02.000Z", // the login time; kept on a created row
  "operator_id": 183, "operator_name": "Budi", "loading_location_id": 7, "event_id": 30,  // REQUIRED to create
  "material_id": 1, "material_code": "OB", "material_name": "Overburden",
  "dumping_location_id": 9, "dumping_location_code": "DS-01", "dumping_location_name": "…",
  "dumping_cell_id": null, "dumping_cell_code": null,
  "block_id": 5, "block_code": "B5", "block_request_level": 2,
  "event_code": "…", "event_status": "…", "event_description": "…", "previous_event_id": 29,
  "latitude": 0.5692, "longitude": 124.3021, "speed": 12, "bearing": 181,
  "done_at": null, "done_reason": null, "end_hour_meter": null,
  "shift": "NIGHT", "shift_date": "…", "job_type": "Production", "mine_plan_id": 500,
  "exca_id": 77, "exca_hull_number": "…", "foreman_id": 12, "materials": [], "blocks": []
}
```

| Field class | Fields | Rule |
| --- | --- | --- |
| Unit-owned | `material_id/code/name`, `dumping_location_id/code/name`, `dumping_cell_id/code`, `block_id/code/request_level`, `event_id/status/code/description`, `previous_event_id`, `latitude`, `longitude`, `speed`, `bearing` | applied only when the payload's `updated_at` is **strictly newer** than the row's |
| Fill-only | `done_at`, `done_reason`, `end_hour_meter` | applied on a null → value transition **even when stale**, so clock drift cannot strand a session open |
| Server-owned | `id`, timestamps, counters, `operator_*`, `foreman_*`, `equipment_*`, `exca_*`, `shift`, `shift_date`, `materials`, `blocks`, `mine_plan_id`, `schedule_id`, `job_type`, `start_hour_meter`, and the plan-level `loading_location_*` | ignored on an existing row (`SERVER_OWNED_FIELDS`); a create keeps some (below) |

- **Merge rules** (`microservice.tracker: src/helpers/session-diff.ts (diffSession)`). An `updated_at` that is older, equal, absent or unparseable keeps the server's data; `reason` is `stale`, `equal`, `missing` or `unparseable`. A key absent from the payload is left untouched; it is not a request to clear the column.
- **Ids.** Ids must be positive integers, which rejects the unit's `-1` "no material" sentinel before it can violate a foreign key.
- **Schema.** The schema is deliberately loose (`zod.looseObject`). Only `id`, `updated_at`, `done_at` and the unit-owned ids are checked. `job_type` is not enum-checked, because units in the field send the misspelled `"Non-Prodution"`.
- **Resolution** (`SessionUtil.resolveSession`), first match wins:
  1. the payload `id`, if it is this equipment's session;
  2. the `current-session:{equipment_id}` pointer;
  3. the newest session with `done_at IS NULL`.

  After a sync, the pointer is set to the resolved session.

> ⚠️ DEFECT (TRK-09): steps 1 and 2 never check `done_at`/`done_reason`. A push for a new login can therefore be answered with the previous operator's **closed** session. Separately, `getCurrentSession` (used by event logs, cycles and `GET /api/session/:id`) requires `end_hour_meter = 0`, so it treats a session with `end_hour_meter IS NULL` as closed. geofencer ≥ 0.4.13 refuses such replies (below), but until this is fixed the new login has no session on the tracker.

- **Create fallback.** Only when nothing resolves does the tracker create a session from the payload (`SessionUtil.buildCreateOnCurrentPlan`, `buildUnitCreate`).
  - `equipment_id`, `equipment_hull_number` and `equipment_asset_name` come from the authenticated unit, never the body.
  - `operator_id`, `loading_location_id` and `event_id` must be present and positive. Otherwise the answer is **400** `{"errors":[{"msg":"cannot create a session without …","name":"SessionCreateFieldsError"}]}`.
  - The created row keeps the unit's `created_at`.
- **Cycle propagation.** After the session settles, the unit's still-open cycle (`session_id` match, `finished = false`, newest first) is brought in line with it in the same transaction (`SessionUtil.syncIncompleteCycle`, `mapSessionToCycle`):
  - material, loading point, dumping point and every other correlated column follow;
  - `loading_location_code/name` maps to `location_from_code/name` and `dumping_location_code/name` to `location_to_code/name`;
  - `block_request_level` is coerced to an integer;
  - a null session value never overwrites the cycle's truck, operator, location or excavator names.

  `cycle:update` publishes after commit. This is the mechanism that corrects an in-flight cycle after a mid-shift material change, because the unit's `sync_hash` ignores material/block and so never re-pushes that cycle on its own.

> ⚠️ DEFECT: `PATCH /api/cycles/:id` does **not** ignore the session-owned columns. The stripping (`stripSessionOwnedCycleFields`) is commented out. The cab PATCHes its whole cycle on every timestamp change, carrying the material and dump point it captured when it opened the cycle, so the next phase undoes the propagation.

- **Response.** `{"data": <session>, "sync": {"session": {"id", "created", "reason", "incoming_updated_at", "db_updated_at", "applied": [fields], "skipped": [fields]}, "cycle": {"id", "applied"} | null}}`. A create answers `sync.session = {"id", "created": true, "reason": "created", "applied": [], "skipped": []}`. **`sync` sits outside `data` on purpose:** the unit merges `data` into its Redis session with `JSON.MERGE`, where extra keys pollute it and a `null` deletes the key.

#### What the cab does with the answer (geofencer ≥ 0.4.3, ≥ 0.4.13)

- **The push is ack-checked** with `assertTrackerAck`.
- **`applied: []` is a failure, not a success.** A discarded push still returns 200. The cab classifies the outcome itself (`classifySessionSync`) and records it in `GET /api/sync-logs` with outcome `rejected` and the server's `reason`. A re-push of an unchanged session is exempt: after a successful apply the row carries the server's own stamp, so the next unchanged push necessarily comes back `stale`, and only the unit knows it had nothing new.
- **`updated_at` is sent in the tracker's clock domain.** The gate compares against a stamp Sequelize took from the server's clock. After a rejected push, the cab learns the offset from the reply's `incoming_updated_at` / `db_updated_at` and shifts its own stamp by it (`toServerClock`, `session:clock-skew`). The stamp is shifted, never replaced with "now", so it still means "when this unit last changed the session".
- **Refusing a reply (geofencer ≥ 0.4.13).** Because of TRK-09, `data` may not be the session the cab pushed. The cab refuses to merge a reply that is:
  - **closed** (`done_at` or `done_reason` set) while the pushed session is open. The logout push is closed itself and is unaffected.
  - **another operator's** (`operator_id` differs).

  A refusal is recorded as `rejected` (reason `closed-session` / `other-operator`) and changes nothing locally: no merge, no `LoginHistory.synced_id`, no clock offset. An open session of the same operator under a different id is accepted. That is what a tracker that lost the unit's row answers, and refusing it would stop session sync entirely.
- **A missed dispatcher logout.** When the refused closed session is **this** session and its `updated_by` is `"Dispatch: end session"` (`SESSION_ENDED_BY_DISPATCH`), the cab logs out. This is the `session:end` it missed while offline. A session closed by the shift close-out carries no marker and never logs an offline operator out.
- **Merging.** An accepted reply is merged into `current:session` **without its null values** (`withoutNulls`). The current login's `synced_id` is set from `data.id`, and local `session:update` is emitted. The same null rule applies to the re-synced session on event-log replies.

#### A created session keeps the unit's identity and takes the equipment's current mine plan

This applies to a session the tracker **creates** from a push: the `POST /api/session` fallback and the id-less `POST /api/session/late` create.

- **Kept from the payload** (`CREATE_KEEP_FIELDS`), when present: `operator_name/oracle_number`, `loading_location_code/name`, `exca_id/hull_number/asset_name`, `shift`, `shift_date`, `job_type` (only `Production`/`Non-Production`), `mine_plan_id`, `foreman_*`, `materials`, `blocks`, `equipment_type`. `SERVER_OWNED_FIELDS` still protects existing rows.
- **Then the plan is swapped** for the equipment's current plan (`MinePlanUtil.findPlanAt`). The plan is the newest `mine_plans` row for the equipment (trucks by `truck_id`, excavators by `exca_id`) whose `[shift_start, shift_end)` contains **the login time + 20 minutes**. If the next shift's plan is not out yet, the one containing the login time itself is used. The login time is the payload's `created_at`, or now when that is missing, unparseable or in the future.
- **What the swap replaces.** `mine_plan_id`, `exca_plan_id`, `exca_*`, `exca_session_id`, `loading_location_*`, `materials`, `blocks`, `foreman_*`, `shift`, `shift_date` (= the plan's start), `job_type` (= the plan's `type`) and `equipment_type`. The current material, dumping point and block follow the re-sync rule: the unit's choice is kept while the new plan still offers it, otherwise the plan's first. An excavator's own session carries no excavator names. With no plan at all, the payload's plan is kept, never blanked.
- **Why.** An operator who logs in before the new shift starts (06:45 for a 07:00 shift) belongs to the new shift. A cab that was offline, or had not pulled the new plan yet, only holds the outgoing plan.
- The reply's `data` carries the swapped fields, and the cab merges them as with any reply.

#### A session's shift (geofencer ≥ 0.4.30)

An offline or degraded login builds the session on the unit (`AuthController.createNewSession`). An online login takes the Platform's session instead.

- The shift is the one in force `MINE_PLAN_LEAD_MINUTES` (20 min) after the login, so a login in the last 20 minutes of a shift belongs to the starting shift.
- The cached plan's shift is used when its window contains that moment. Otherwise the label and start come from `settings:shifts`, and the plan still supplies the work assignment.
- The cab refreshes its mine plan one minute after each changeover (`MINE_PLAN_REFRESH_LEAD_MINUTES`, slots from `settings:shifts`), because the Platform serves only the plan of its current shift. A login before a changeover therefore takes the starting shift's label with the ending shift's plan, and the tracker's create-time plan swap above corrects it.
- `foreman_id` is the plan's foreman (geofencer ≥ 0.4.20), never a hard-coded `0`.

#### Current session read — `GET /api/session/:id` (geofencer → tracker, on socket connect)

**Caller:** `geofencer: src/handlers/LocalEventHandler.ts (onSocketClientConnect)`, with `:id` = the numeric equipment id. The tracker ignores `:id` and answers `{"data": <session>}` from `getCurrentSession`: the session behind `current-session:{equipment_id}`, open, `end_hour_meter = 0`. With no such session it answers **401** `AuthError`.

**What the cab does with the answer.** It merges `material_id` (`-1` when null), `material_name` and `material_code` (`"-"` when null) and `materials` into `current:session`.

> ⚠️ DEFECT: this merge ignores `updated_at`. A material the operator changed while offline is overwritten with the tracker's older value, or with the `-1`/`"-"` sentinels, on reconnect. The session push that would have carried the change races it on the same connect. This contradicts the session merge rule that the unit owns material until acknowledged.

#### Late sessions — `POST /api/session/late` (geofencer → tracker)

A **late session** is one that ended on the unit (a logout) but whose closing push never landed. The unit queues every ended session in its `late_sessions` table, one row per login keyed by `login_history.id`, and drains it here: **only ended sessions, never the running one**. `POST /api/session` is not used for this, because it resolves an unknown session through the pointer and the newest open session, and would write an old snapshot onto whoever is logged in now.

**Sender:** `geofencer: src/utils/others/DataUtils.ts (syncLateSessions)`, in step 2 of the tick and on connect. It sends up to 50 rows by `done_at`, each as `{ …the current:session snapshot at logout, "login_history_id": "<local id>" }`.

- It holds back any row whose login is the current one or whose `id` is the live session's.
- It also queues ended logins from the last 7 days that the server knows (`synced_id`) but that were never queued, using a minimal closing payload.
- A second "logout" while nobody is logged in (Mark Ready on a locked cab) never replaces a queued snapshot.

The tracker checks each element on its own (`microservice.tracker: src/helpers/late-session.ts (checkLateSession)`, `SessionUtil.syncLateSession`). The body is an array of 1–50; a longer one is a 400.

| Element | Result |
| --- | --- |
| no `done_at` | `not-ended`, untouched. This is what keeps a running session from being closed here. |
| `id` of a session of **this equipment** | the diff is applied (below) |
| `id` unknown, or another equipment's | `not-found`, untouched, never created |
| no `id` (an offline login the server never saw) | created **already closed** (plan swap as above), keeping the unit's `created_at`. Idempotent on `(equipment_id, operator_id, done_at)`. A missing `operator_id`/`loading_location_id`/`event_id` gives `invalid`. |
| unparseable field, or not an object | `invalid` |

- **The diff** is the session diff. `done_at`, `done_reason` and `end_hour_meter` fill even from a stale payload; an `end_hour_meter` of 0 counts as unset, because the Platform creates sessions with 0. Unit-owned fields apply only when `updated_at` is strictly newer, and server-owned fields never. A `done_at` the server already has is never overwritten.
- **Pointer cleanup.** When `current-session:{equipment_id}` points at the session just closed, the pointer is removed. `session:update` publishes for every write.
- **Answer.** `{"data": [ … ]}`, one entry per element, in order:

```jsonc
{ "key": "<login_history_id>", "stored": true, "id": 8123, "created": false, "reason": "stale", "applied": ["done_at", "done_reason"], "skipped": [] }
{ "key": "<login_history_id>", "id": 8124, "stored": false, "reason": "not-found", "msg": "…" }
```

**What the cab does with the answer.** `invalid`, `not-ended` and `not-found` are final: the cab records them in `late_sessions.sync_error` and stops. `error` (a server-side fault) and any transport failure are retried on the next tick.

### Cycles

#### Cycle creation and update — `POST /api/cycles`, `PATCH /api/cycles/:id` (geofencer → tracker)

**Senders:**

- `geofencer: src/handlers/CycleHandler.ts (sendToServer, updateDataOnServer)`, realtime, 15 s timeout.
- `geofencer: src/utils/others/DataUtils.ts (syncCycle)`, the drain: up to 100 pending cycles, sent concurrently, after `closeOrphanedCycles`, `attachCycleSession` and `repairCyclePlanFields`.

The two methods carry different bodies:

- **POST** (no `synced_id` yet) sends `toTrackerCycle`: the whole local row with `id` renamed to `uuid`, `operator_id` and `tonnes_raw` passed through `Number(… ?? 0)`, and `foreman_id` `0` → `null`.
- **PATCH** sends the **raw local row** (`cycle.toJSON()`), so local-only keys arrive and are stripped by the schema.

```jsonc
{
  "uuid": "4c2d…",                  // REQUIRED. the unit's row id; idempotency key (the local `id` itself is never sent)
  "equipment_id": 21,               // REQUIRED.
  "operator_id": 183, "operator_name": "Budi",          // REQUIRED.
  "foreman_id": 12, "foreman_name": "…",               // REQUIRED keys; foreman_id may be null
  "material_id": 1, "material_code": "OB", "material_name": "Overburden", // REQUIRED.
  "block_id": 5, "block_code": "B5", "block_request_level": 2,           // REQUIRED keys, nullable
  "session_id": 8123,               // the login's server session
  "tonnes_raw": 0,                  // REQUIRED.
  "truck_hull_number": "HD 785 021", "exca_hull_number": "EX HT 5 024",   // REQUIRED; must exist
  "location_from_code": "LS-01", "location_to_code": "DS-01",             // REQUIRED; must exist
  "shift": "DAY",                   // informational, may be "" or null
  "created_at": "2026-10-19T01:20:00.000Z",  // the unit's creation time: the shift anchor
  "arrived_at_load": "…", "start_loading": "…", "finish_loading": "…", "hauling": "…",
  "arrived_at_dump": "…", "start_dumping": "…", "finish_dumping": "…", "travelling": "…", "finish_time": null,
  "start_spotting": null, "end_spotting": null, "start_dump_spotting": null, "end_dump_spotting": null,
  "actual_exca_id": 449, "actual_exca_hull_number": "…", "actual_exca_asset_name": "…",
  "actual_loading_location_id": 7, "actual_loading_location_name": "…", "actual_loading_location_code": "LS-01",
  "actual_dumping_location_id": null, "actual_dumping_location_name": null, "actual_dumping_location_code": null
}
```

| Field | Type | Presence | Notes |
| --- | --- | --- | --- |
| `uuid` | string | required | `zod.coerce.string()`. On POST, a stored `uuid` returns the stored row. |
| `equipment_id`, `operator_id`, `material_id`, `tonnes_raw` | number | required | `zod.coerce.number()`: `undefined` becomes NaN (400); `null` silently becomes `0`. |
| `operator_name`, `foreman_name`, `material_name`, `material_code`, `truck_hull_number`, `exca_hull_number`, `location_from_code`, `location_to_code` | string | required | `zod.coerce.string()`. |
| `foreman_id` | number \| null | required key | `0`, `"0"` and null read as null (TRK-10). |
| `block_id`, `block_request_level` | number \| null | required key | |
| `block_code` | string \| null | required key | |
| `session_id` | number \| null | optional | |
| `shift` | string \| null | optional | Informational only; the tracker derives it (§ Shift labels). |
| `created_at` | ISO-8601 (offset or local) | optional | The shift anchor. On PATCH it is not written. |
| phase timestamps, `finish_time`, spotting fields | ISO-8601 \| null | optional | `zod.iso.datetime({ local: true })`: `Z` or no zone; **an explicit `+hh:mm` offset is a 400**. |
| `actual_*_id` | positive integer \| null | optional | Anything that is not a positive integer reads as null, never a 400. |
| `actual_*_name`, `actual_*_code` | string \| null | optional | |

**Tracker side on POST** (`microservice.tracker: src/utils/routes/CycleUtils.ts (createCycle)`):

- **Idempotent on `uuid`.** The stored row is looked up first, and a unique conflict on `uuid` counts as success.
- **Lookups.** `location_from_code` and `location_to_code` are looked up in `mine_locations`, and `exca_hull_number`/`truck_hull_number` in `mine_equipments` (cached at `equipment:{hull_number}`). **Any miss is a 404** (single object) or `stored: false` (array).
- **Columns.** `location_from_*` comes from the loading location and `location_to_*` from the dumping location (`cycleLocationColumns`). `start_equipment_id`/`finish_equipment_id` come from the header.
- **Session.** The payload's `session_id` is attached when it is this equipment's session; otherwise the current session is used, else null. A backlog drained after the next login therefore keeps the session it happened in.
- **Other columns.** `shift` and material are derived (below). `foreman_id` is stored as sent or null, never substituted from the current session. `finished = travelling != null && finish_time != null`. Absent spotting fields store null.
- **After the write,** event logs with `cycle_uuid = uuid` and no `cycle_id` get the cycle id, and `current-cycle:{equipment_uuid}` is set.
- **Answer.** A single object answers `200 {"data": <mine_cycle row>}`. An array answers `{"data": [{ "uuid", "stored": true, "id" } | { "uuid", "stored": false, "msg" }]}`.

**Tracker side on PATCH** (`microservice.tracker: src/routes/cycles.ts`):

- The cycle is found by primary key.
- `shift` is re-derived from the body's `created_at`, else the stored `arrived_at_load`; the stored label is kept when nothing resolves.
- Every other field in the body is written as sent, **an explicit `null` included**.
- `finished` is recomputed only when the body carries `finish_time` or `travelling`, so a mid-cycle PATCH never resurrects a finished cycle.
- Fields absent from the body, such as an older cab's `actual_*` and spotting fields, are left alone.
- The answer is `{"data": <row>}`.

> ⚠️ DEFECT: the cycle is found by id alone, with no check that it belongs to the calling unit.

> ⚠️ DEFECT: `zod.coerce.string()` turns an absent value into the string `"undefined"` and `null` into `"null"`. This applies to `uuid`, names, codes and hull numbers on POST and PATCH alike. A cycle without a `uuid` is stored under the literal key `"undefined"`, and a null `foreman_name` is stored as `"null"`. `zod.coerce.number()` likewise turns a null `operator_id` or `tonnes_raw` into `0`; geofencer's own `Number(… ?? 0)` does the same on POST.

> ⚠️ DEFECT (TRK-10): a foreign-key violation (for example an `operator_id` with no `users` row) is still a generic **500**, which the unit retries every tick. It should be a 422, so a unit can tell bad data from a server fault. The `foreman_id: 0` case itself is fixed: the tracker reads 0 as null, and geofencer ≥ 0.4.20 never sends 0.

**What the cab does with the answer.** On POST it stores the echoed `id` as `synced_id`. Both methods hash the echo (`createServerCycleHash`), and `synced_at` is stamped only when that hash equals the local hash. A cycle with no dump location, neither on the row nor in its login history, is **not pushed**, because the tracker would 404 it. The cab logs it and retries once the location can be filled (`repairCyclePlanFields`). A missing `foreman_id` is filled from the current plan when the cycle's login used that plan.

#### Cycle timestamp reverts — explicit `null` on `PATCH /api/cycles/:id`

When the in-cab UI corrects the running event (`PATCH /api/event-logs` on the cab), the column the replaced event had stamped never happened. geofencer clears it and, when the corrected event is itself a cycle event, re-stamps that event's own column with the same unchanged `start_time` (`CycleHandler.remapCycleTimestamps`, driven by the `cycle_trigger` map in `settings:cycles`). The cycle PATCH body therefore carries the cleared column as an explicit **`null`**. The tracker writes it as null, so the revert lands. `arrived_at_load` is never sent as null: it anchors the cycle's existence and sits outside the unit's `TIMESTAMP_FIELDS`.

#### Cycle finish and acknowledgement stamps (geofencer ≥ 0.4.14)

- **A logout finishes the open cycle on every logout code,** including Recharging (`R-D-0152`, a DELAY-typed event). The cab stamps `finish_time` and `travelling` with the logout's `start_time`, releases `current:cycle`, and sends **one** `PATCH /api/cycles/:id`, or a `POST` when the cycle was never pushed.
- **Cycles left open by an older unit are closed on the next drain (≥ 0.4.16).** A cycle with no `finish_time` whose login has ended is finished at that logout time, keeping `travelling` if it was pressed, and is pushed like any edited row (`DataUtils.closeOrphanedCycles`). Cycles of a login in progress, and cycles with no login history, are never touched.
- **Arrival rules.** An `arrived_at_load` while a cycle is open closes that cycle and starts the next one once the open cycle has progressed past its own arrival. An arrival on a cycle that has only `arrived_at_load` is a repeat press.
- **A `current:cycle` that names no cycle row is released (≥ 0.4.29).** The next transition logs a warning, deletes the key and carries on as if no cycle were open. `current:cycle` is cab-local, with a 4 h TTL refreshed on every update (`REDIS_KEY_HALF_LIFETIME`).
- **Acknowledgement.** Every acknowledged push, PATCH included, goes through `markSynced`, which stamps `synced_at` when the echo hash equals the local hash. Rows then leave the drain's SQL candidate set once the tracker has confirmed them; the `sync_hash` comparison stays the final word.

#### Cycle material — from the excavator's plan (tracker, on POST only)

A cycle created by `POST /api/cycles` is stored with the material its excavator was planned to dig (`CycleUtils.resolvePlannedMaterial`, `src/helpers/cycle-material.ts (plannedCycleMaterial)`). The rule is `pickMaterial`, the same one the session plan sync uses:

1. the excavator's live session's material;
2. else the unit's `material_id`, when the plan offers it;
3. else the plan's first material.

"The plan" is the excavator's own (`exca_id` from `exca_hull_number`) whose window contains the cycle's shift anchor, with no handover. It is matched by excavator, because several excavators share a loading point. `material_id/code/name` come together from one source. With no plan, or a failed lookup, the unit's three fields are stored as sent: the lookup never fails a cycle.

**Only on create.** `PATCH` stores the material the unit sends (see the defect under Session sync), so a planned material that differs from the unit's lasts only until the cycle's next phase.

#### A cycle's actual excavator and sites — `actual_*` (geofencer ≥ 0.4.24)

Next to the plan it already carries (`exca_hull_number`, `location_from_code`, `location_to_code`), every cycle records what the cab **observed**. These fields ride every `POST` and `PATCH` (`geofencer: src/handlers/CycleHandler.ts`, `src/helpers/excavator.ts (actualExcavatorColumns)`).

| Fields | Captured at | Source |
| --- | --- | --- |
| `actual_exca_id`, `actual_exca_hull_number`, `actual_exca_asset_name` | `arrived_at_load`; replaced at `start_loading` by an excavator alongside at that moment | the nearest excavator the beacon has a **fresh** position for within 100 m (`excavators:positions`), else the **planned** one from the session. At `start_loading` the plan only fills an empty value and never replaces an observed one. |
| `actual_loading_location_id`, `_name`, `_code` | `arrived_at_load`; `start_loading` if still empty | the Loading Site the truck is inside (`current:geofence:loading-site`), else the nearest within 90 m; else left empty, never the plan |
| `actual_dumping_location_id`, `_name`, `_code` | `arrived_at_dump`; `start_dumping` if still empty | the same, for Dumping Sites |

- Ids are server ids (`mine_equipments.id`, `mine_locations.id`) but **not foreign keys** on the tracker. They come from a cab's offline cache, and one stale id would otherwise refuse the cycle on every retry.
- These fields are **not** in the cab's `sync_hash`. They change only together with a timestamp the hash covers.
- On the cab, the columns are added to `cycles` at boot (`afterSync` on the Cycle model), because units run `sync({ alter: false })`.
- Platform columns: FMS-Backend migration `20261001090000-mine-cycle-actual-assignment`, which must run before the tracker model is deployed. Never run the tracker with `DB_ALTER=true` against an older model.

#### A cycle's spotting — `start_spotting`, `end_spotting` (geofencer ≥ 0.4.43) and dump spotting — `start_dump_spotting`, `end_dump_spotting` (geofencer ≥ 0.4.48)

Spotting is the truck reversing under the excavator after it arrived at the loading point; dump spotting is the same reversing to the tipping edge after it arrived at the dump. `SpottingHandler` stamps both from the unit's travel direction: the hour meter's gyro (`travel-direction:update`), with a GPS detector filling its gaps (geofencer ≥ 0.4.44). All four fields are optional, nullable ISO-8601 datetimes on every `POST`/`PATCH`.

| Field | Stamped when |
| --- | --- |
| `start_spotting` / `start_dump_spotting` | the direction turns `reversing` while the current event is Arrived at Load / Arrived at Dump. A second reverse at the same point keeps the first start. A correction to `forward` (a misread reverse) clears an unfinished start. |
| `end_spotting` / `end_dump_spotting` | that reversing stops (`reversing → stopped`). A later stop at the same point moves it. A stop once Loading/Dumping began is recorded once, never later. A truck that reversed *into* the departure ring gets `start_spotting` = its arrival. |

- **Scope (geofencer ≥ 0.4.50).** They are recorded on every truck, with auto-cycle on or off, and only at the arrival and the step it leads to. A reverse during Hauling, Travelling or a delay touches neither. At an arrival they go only to the cycle that arrival opened. Each stamp pushes the cycle at once.
- **With auto-cycle active,** a stop lasting 5 s starts Loading/Dumping dated to the stop, so `start_loading` = `end_spotting` and `start_dumping` = `end_dump_spotting`.
- **A truck that tips outside the dump's rings is still caught.** While Hauling, a reverse that ends in a 5 s stop within 90 m of a dumping site is that dump: `arrived_at_dump` is the reverse's start (= `start_dump_spotting`) and `start_dumping` is its stop.
- They are not in the cab's `sync_hash`. An older cab sends none: a create stores null, and a PATCH without them leaves the stored values alone.
- Platform columns: FMS-Backend migrations `20261015090000-mine-cycle-spotting` and `20261026090000-mine-cycle-dump-spotting`, each run before the tracker model that declares them.
- The direction is advisory until it is calibrated on real trucks (HM-08).

#### Shift labels on cycles and event logs

A row's `shift` is the shift it **happened** in, from its own time, resolved against `settings:shifts` (`microservice.tracker: src/helpers/shift.ts (shiftLabelAt)`). It is never the session's login shift, which routinely runs past 07:00/19:00, and never the drain time.

- **Event logs:** from `start_time`, even when a session claims the row.
- **Cycles:** from the unit's `created_at`, else the first phase timestamp (`cycleShiftAnchor`). The tracker derives it on `POST` and re-derives it on `PATCH`. The unit's `shift` is only a fallback while the settings are not cached, and it may be empty. A session sync never copies the session's shift onto the open cycle. The unit stamps new cycles the same way (`CycleHandler.createNewCycle`), falling back to the session's label when it has no shift settings.
- Both sides resolve windows the same way: today's, yesterday's and tomorrow's rebased `settings:shifts`, keeping the set that contains the moment (`microservice.tracker: src/helpers/shift.ts (parseShift)`, mirrored by `geofencer: src/modules/shift.ts`).

### Engine starts — `POST /api/engine-start` (geofencer → tracker, geofencer ≥ 0.4.40)

An **engine start** is one hour-meter reading in which `engineRunning` went from false to true. `EngineStartHandler` records each one in the cab's `engine_starts` table, and this endpoint drains them into the Platform's `engine_starts` (HM-07, done). The Platform owns the table; the tracker's model is field-for-field the same.

**Sender:** `geofencer: src/utils/others/EngineStartSync.ts (EngineStartSync.run)`, in step 3 of the tick and on connect. It sends rows with `synced_at` and `sync_error` both null, oldest `received_at` first, at most **50** per pass (`ENGINE_START_BATCH_MAX`, which mirrors the tracker's). Each row goes through `buildEngineStartPayload`, an explicit whitelist.

```jsonc
[{
  "readingUuid": "9b2e…",                    // REQUIRED. microservice.hm's message uuid; idempotency key
  "deviceId": "1a2b3c4d",                    // REQUIRED. the hour-meter device
  "hourMeterS": 4500123,                     // REQUIRED. engine run time at the start, s
  "hourMeterH": 1250.03,                     // REQUIRED. h
  "totalizerPulses": 15123,                  // REQUIRED.
  "totalizerUnits": 151.23,                  // REQUIRED.
  "receivedAt": "2026-10-13T01:00:05.000Z",  // REQUIRED. microservice.hm's clock: the ordering clock
  "measuredAt": "2026-10-13T01:00:04.900Z",  // the device RTC, when it knew the time
  "loginHistoryId": "…",                     // the cab-local login at the start
  "operatorId": 949                          // the operator logged in at the start
}]
```

| Field | Type | Presence | Notes |
| --- | --- | --- | --- |
| `readingUuid` | string, 1–64 | required | Unique on the Platform (`reading_uuid`). |
| `deviceId` | string, 1–16 | required | |
| `hourMeterS`, `hourMeterH`, `totalizerPulses`, `totalizerUnits` | number | required | |
| `receivedAt` | ISO-8601 with `Z` or offset | required | |
| `measuredAt` | ISO-8601 with `Z` or offset | optional, **omitted** rather than null | |
| `loginHistoryId` | string, ≤ 255 | optional, omitted when absent | |
| `operatorId` | integer 1–2147483647 | optional, omitted unless a positive integer | |

Never sent: the local `id`, `equipment_id`, `hull_number` (the tracker takes the unit from `x-equipment-uuid`), the sync columns and the timestamps. The body is camelCase. Unknown keys are stripped.

**Tracker side** (`microservice.tracker: src/utils/routes/EngineStartUtil.ts`):

- The body is an array of 1–50; a longer one is a 400 with no `errors` array.
- Each element is checked on its own. The valid ones go in as one `INSERT … ON CONFLICT DO NOTHING` on `reading_uuid`.
- If the database refuses a row (a data exception), every row is retried on its own, so only that row comes back `invalid`. A missing table or a lost connection answers every row `error`, with no per-row retry.
- Ids are read back by `reading_uuid` with soft-deleted rows included, so a reading already stored is `stored`.
- The answer is always 200, `{"data": [ … ]}`, one entry per element in order:

```jsonc
{ "key": "<readingUuid>", "stored": true, "id": 4321, "reason": "stored" }
{ "key": "<readingUuid>", "stored": false, "reason": "invalid", "msg": "receivedAt: …" }
{ "key": "<readingUuid>", "stored": false, "reason": "error", "msg": "…" }
```

**What the cab does with the answer.**

- `stored` (with an integer `id`) sets `synced_at` and `synced_id`.
- `invalid` sets `sync_error` to the tracker's message, and the row is never sent again.
- `error`, an unknown reason or a missing entry leaves the row pending.
- A push that fails as a whole **throws** and leaves every row pending, so the sync log records `failed`. That covers transport failures, an `errors` envelope, and a body without a per-row list.

### Hour-meter readings — `POST /api/hour-meter-readings` (geofencer → tracker, geofencer ≥ 0.4.47)

Every reading `RedisHourMeterHandler` accepts from microservice.hm (`hour-meter:update`, about 1 Hz) is written by `HourMeterReadingHandler` to the cab's `hour_meter_readings` outbox as JSON. The outbox drains here into the tracker's own `hour_meter_readings`, a **TimescaleDB hypertable** on `time`, keyed by `(equipment_id, time)`.

**Sender:** `geofencer: src/utils/others/HourMeterReadingSync.ts (HourMeterReadingSync.run)`, in step 11 of the tick only.

- **Prune first, offline too.** Only the newest `HOUR_METER_READING_KEEP` = **259,200** rows (three days at 1 Hz) are kept.
- **Push.** The oldest **200** rows by `id` (`HOUR_METER_READING_BATCH`; the tracker takes up to 500), as the readings they hold. A corrupt row is deleted with its batch and never sent.
- **Repeat** until the outbox is empty or **20 s** (`HOUR_METER_SYNC_BUDGET_MS`) are spent.

```jsonc
[{
  "uuid": "9b2e…",                          // REQUIRED. microservice.hm's message uuid (stored as reading_uuid, not unique)
  "deviceId": "1a2b3c4d",                   // REQUIRED.
  "receivedAt": "2026-10-21T01:00:05.000Z", // REQUIRED. → time (the key)
  "measuredAt": "…",
  "deviceUptimeS": 512,
  "timeValid": true,                        // REQUIRED.
  "hourMeterS": 4500123, "hourMeterH": 1250.03,          // REQUIRED.
  "totalizerPulses": 15123, "totalizerUnits": 151.23,    // REQUIRED.
  "engineRunning": true,                    // REQUIRED.
  "statusFlags": 0, "statusFlagNames": [],  // REQUIRED.
  "rollDeg": 1.5, "pitchDeg": -2, "headingDeg": 33.2, "forwardHeadingDeg": 213.2,
  "vibRmsMg": 72.5, "vibPeakMg": 180,
  "travelDirection": "forward", "travelDirectionChangedAt": "…"
}]
```

| Field | Type | Presence | Notes |
| --- | --- | --- | --- |
| `uuid` | string, 1–64 | required | |
| `deviceId` | string, 1–16 | required | |
| `receivedAt` | ISO-8601 with `Z` or offset | required | Becomes `time`. Together with the unit, it is the key. |
| `measuredAt`, `travelDirectionChangedAt` | ISO-8601 with `Z` or offset | optional, omitted | |
| `timeValid`, `engineRunning` | boolean | required | |
| `hourMeterS`, `hourMeterH`, `totalizerUnits` | finite number ≥ 0 | required | |
| `totalizerPulses` | integer ≥ 0 | required | |
| `statusFlags` | integer 0–2147483647 | required | |
| `statusFlagNames` | string[] (≤ 64 × ≤ 64 chars) | required | |
| `deviceUptimeS` | finite number ≥ 0 | optional, omitted | |
| `rollDeg`, `pitchDeg`, `headingDeg`, `forwardHeadingDeg`, `vibRmsMg`, `vibPeakMg` | finite number | optional, omitted | |
| `travelDirection` | string, 1–16 | optional, omitted | |

**Tracker side** (`microservice.tracker: src/utils/routes/HourMeterReadingUtil.ts (storeHourMeterReadings)`):

- The body is an array of 1–500. The unit is the authenticated `x-equipment-uuid`; the body names no equipment.
- Each reading is checked on its own. A malformed one is counted in `invalid` and left out. The rest go in as one `INSERT … ON CONFLICT DO NOTHING` on `(equipment_id, time)`. Unknown keys are stripped.
- The answer is `{"data": {"stored": n, "invalid": m}}`. A database failure is a 500.
- The table is created by `scripts/create-own-tables.ts`. The model's `afterSync` makes it a hypertable (1-day chunks). Without TimescaleDB it warns and the table stays plain. No retention is set.

> ⚠️ DEFECT: `stored` counts the readings that passed validation, not rows inserted or already present. Two readings with the same `receivedAt` (a repeated or re-stamped message) collapse into one row, while `stored` still counts both.

**What the cab does with the answer.** Any acknowledged answer (`assertTrackerAck`) deletes the batch by `id ≤` the batch's last id, so a reading recorded meanwhile stays. Invalid readings are deleted too, since they would be refused again. A push that fails (transport, an `errors` envelope, no `data`) **throws** and keeps the rows. The sync log records `failed`.

### Current operator — `POST` / `DELETE` `/api/operators/auth` (geofencer → tracker)

The tracker mirrors the cab's `current:operator` as RedisJSON at `current-operator:{equipment_uuid}`, with a **6 h** TTL that every stored event log refreshes. Event logs fall back to it for their operator (`microservice.tracker: src/routes/operators/auth.ts`).

**Sender:** `geofencer: src/utils/others/DataUtils.ts (syncCurrentOperator)`. It runs in step 14 of the tick and in the `socket:connect` handler, and also at login and logout.

```jsonc
{ "id": 183, "svr_id": 183, "name": "Budi", "username": "budi", "oracle_number": "…", "login_at": "…" }
```

| Field | Type | Presence | Notes |
| --- | --- | --- | --- |
| `id`, `svr_id` | integer | required | Both are the **server** user id (`toTrackerOperator`). |
| `name` | string | required | |
| `username`, `oracle_number`, `login_at` | string \| null | present | |

- **`POST`** runs while someone is logged in. The tracker stores and publishes (`new-operator`) only `{id, name, username, oracle_number, login_at}` (`sanitizeOperator`). Older units that still send the whole local Operator row (a local uuid `id`, a bcrypt `password`) are cleaned up server-side. **400** `{"errors":[{"msg":"an operator needs a server user id (svr_id) and a name"}]}` when either is missing. The answer is `{"data": <stored operator>}`.
- **`DELETE`** runs while nobody is logged in, so a logout that happened offline clears the tracker within a tick of reconnecting. The answer is `{"data": {"removed": boolean}}`.

### Geofence crossings — `POST` / `GET` `/api/geofence` (geofencer → tracker)

The unit runs the geofence state machine itself (`geofencer: src/handlers/RedisGPSHandler.ts`). Per location code it tracks `outside → approaching → inside → departing`, using its own radii (approach 60 m, approach-exit 75 m, enter 20 m, exit 40 m; these defaults are overridable by the Platform's geofence tuning) and a 20 s arrival dwell. It reports each transition here. `gps:entering`/`gps:exit` are mere proximity; `gps:enter`/`gps:exiting` are a confirmed visit.

**Senders:**

- `geofencer: src/handlers/GeofenceSyncHandler.ts (sendToServer)`, realtime: one crossing, only while `status:online`. A rejection leaves the row unsynced.
- `geofencer: src/utils/others/DataUtils.ts (syncGeofenceLogs)`, the drain in step 9 of the tick: up to 500 rows with `synced_at IS NULL` by `time`, in arrays of 100.

```jsonc
{
  "uuid": "7d3c…",                   // the unit's GeofenceLog id; idempotency key (optional on the wire, always sent)
  "location": "DS-01",               // REQUIRED. the location's CODE (the Redis geo member)
  "location_type": "Dumping Site",   // may be null
  "state": "inside",                 // REQUIRED. outside | approaching | inside | departing
  "distance": 12.5,                  // REQUIRED. metres from the location
  "lat": 0.5692, "lon": 124.3021,    // the VEHICLE's position; may be null
  "event": "gps:enter",              // the gps:* event, for auditing
  "time": "2026-10-21T02:15:00.000Z" // REQUIRED. the fix's GPS time, else geofencer's clock
}
```

| Field | Type | Presence | Notes |
| --- | --- | --- | --- |
| `uuid` | string \| null | optional | `geofence_logs.uuid`, UNIQUE and nullable. |
| `location` | string, ≥ 1 | required | Stored as sent; the tracker does not resolve it. |
| `location_type` | `Loading Site` \| `Dumping Site` \| `Geo Fence` \| `Line` \| `General` \| null | optional | Today only Loading and Dumping Sites produce events, because only `Point` locations are geofenced. It is null on a synthetic exit. |
| `state` | enum | required | |
| `distance` | number (m) | required | |
| `lat`, `lon` | number \| null | optional | The **vehicle's** position, never the site's. Both are null on the synthetic exit the cab emits for a site that dropped out of its 90 m search radius, which is stored with `coordinates: null`. |
| `event` | string \| null | optional | |
| `time` | ISO-8601 with `Z` or offset | required | |

- **Tracker side** (`microservice.tracker: src/utils/routes/GeofenceUtil.ts (logEvents)`): one `bulkCreate(…, { ignoreDuplicates: true })` with `created_by` = the hull number, and no publish.
- **Answer.** A single object answers `{"data": <row>}`. An array answers `{"data": {"length": <rows submitted>}}`; duplicates skipped by the conflict rule are not distinguished.
- **What the cab does with the answer.** Any acknowledged answer (`assertTrackerAck`) stamps `synced_at` on the whole chunk. `length` is not compared.
- **Volume.** Proximity events fire on drive-bys, so a haul road past a site is chatty. If it needs trimming, report only `gps:enter`/`gps:exiting`.
- **`GET /api/geofence?from=&to=`** (both ISO-8601 with an offset, `from < to`) returns `{"data": {"count", "rows"}}`: the calling unit's crossings in `[from, to)`, oldest first. It is for verification only.

### Master data — `GET /api/pinned-events` (geofencer pulls from tracker)

**Caller:** `geofencer: src/handlers/DataFetcherHandler.ts` (the `pinned-events` dataset). It runs on every master-data pull (boot, reconnect, handshake, `master-data:pull`) and is cached in cab Redis at `events:pinned` (RedisJSON). The rows are managed in FMS-Backend; the tracker serves them read-only, ordered by `id`. Only `x-api-key` is checked.

```jsonc
{ "data": [{
  "id": 73,
  "event_id": 4,               // mine_event.id
  "equipment_type": "Truck",   // may be null
  "event_type": null,
  "event": { "status": "…", "code": "…", "type": "…", "description": "…" }
}] }
```

### Socket.IO

The tracker's worker processes share one port through `SO_REUSEPORT`, with no Socket.IO adapter. A server → cab emit therefore works per worker: every worker hears the bus message, and only the worker that holds the cab's socket delivers it. Targeting always reads `equipment:{uuid}.socket_id`.

#### Connection and lifecycle — `equipment:connected` / `disconnect` (geofencer → tracker)

On every connect, geofencer stores its socket id in `equipment:details.socket_id` and sets `status:online`. It then emits:

```jsonc
"equipment:connected" { "socketId": "Xb3…", "equipment_uuid": "6f0e2c1a-…" }  // equipment_uuid: equipment:details.uuid
```

The tracker's `SocketHandler` (`microservice.tracker: src/handlers/SocketHandler.ts`) handles the lifecycle:

- **Rejects unusable uuids.** A uuid that is not a string, or that is `""`, `"null"` or `"undefined"`, is refused and logged (`isUsableEquipmentUuid`).
- **Writes state on connect,** using **its own** socket id (the client's `socketId` is ignored):
  - `equipment:{uuid}.socket_id`, with a field TTL of 13 h;
  - `socket:{uuid}` = `{socket_id, connected_at, worker}`, TTL 13 h;
  - `equipment:connection` = `{equipment_uuid, socket_id, connected: true, at, worker}`, published on the bus.
- **On `disconnect`,** a Lua compare-and-delete (`CLEAR_SOCKET_IF_CURRENT_SCRIPT`) removes `socket_id` from both keys only if it still equals the leaving socket's id. A reconnect that landed first, on any worker, is therefore never clobbered. When something was cleared, the tracker writes `disconnected_at` and publishes `connected: false` with Socket.IO's `reason`. `MainApp.shutdown` closes out every open socket the same way.
- **"Connected" is advisory.** A worker killed with SIGKILL fires no `disconnect`, and the state lingers for the TTL. `socket:{uuid}` is kept separate from `equipment:{uuid}` on purpose: `EquipmentUtil` treats `equipment:{uuid}` as a fully populated cache once it has more than one field.
- **`gps:move`** has a tracker listener that only logs. geofencer emits `gps:move` only to its local in-cab socket, never to the tracker, so this listener is dead.

geofencer's `socket:connect`/`socket:disconnect` (local events) also gate the realtime track path and start the on-connect pass (§ Sync passes).

#### Unit commands over the socket — `unit:command` relay (Platform → tracker → geofencer, with ack)

The Platform cannot reach a cab's socket, because cabs connect to the tracker. It publishes a command on the bus and waits for exactly one reply (`microservice.tracker: src/helpers/unit-command.ts (relayUnitCommand)`). map-editor publishes on the same channel, for `device:command` only (§ Device maintenance below). The bus message shapes are owned by §7.

```jsonc
// bus unit:command (Platform → tracker)
{ "request_id": "01J…", "equipment_uuid": "6f0e2c1a-…", "event": "session:end",
  "payload": { "equipment_uuid": "6f0e2c1a-…", "session_id": 55, "event_code": "CO-S-0030" }, "timeout_ms": 5000 }
// bus unit:reply (tracker → Platform)
{ "request_id": "01J…", "status": "ack", "outcome": { "status": 200, "data": { … } } }
```

- **The allowlist.** `event` is checked against `UNIT_COMMAND_EVENTS`: `session:end`, `session:override`, `auto-cycle:toggle`, `auto-cycle:get`, `master-data:pull`, `device:command`. `timeout_ms` must be 500–30 000. A new command is added to the allowlist, to a geofencer socket handler, to the Platform sender and to this contract in one change.
- **One generic event.** Every event above is one command, except `device:command`. It is the single generic relay for update-daemon: its payload is the daemon's command, so a new daemon action changes update-daemon, its contract and map-editor, but not the allowlist or the geofencer handler. This is a deliberate exception to "one event per command", and the only one (Compatibility rule 7).
- **Delivery.** The worker that holds `equipment:{uuid}.socket_id` emits `event` with `payload` **as is**, plus an ack callback.
- **The cab's ack** is always `{ "status": <number>, "data": … }` or `{ "status": <number>, "errors": [{ "msg": "…" }] }`. An ack without a numeric `status` is reported as `outcome {status: 502, errors: [{msg: "the cab answered without a status"}]}`.
- **`unit:reply.status`:**
  - `ack` means the cab answered, and `outcome.status` is its verdict.
  - `timeout` means the socket was reached but the cab did not answer within `timeout_ms`.
  - `no_socket` means no worker holds a socket for the unit.
- **Exactly one reply.** The holder of the socket answers `ack`/`timeout`. When a socket id is on record but its holder no longer has the socket, the worker named in `socket:{uuid}.worker` answers `no_socket`. When no socket id is on record, worker `0` does. There is no broadcast fallback, ever.
- **The relay does not check** that `payload.equipment_uuid` matches the command's. Every geofencer handler does, and answers **421** for another unit.

#### Auto-cycle switch — `auto-cycle:toggle` / `auto-cycle:get` (tracker → geofencer, with ack; geofencer ≥ 0.4.36)

This is the Platform's switch for a cab's GPS-driven cycle advancement. It is carried by the relay, so the Platform needs no address, port or key for the unit. **Handler:** `geofencer: src/handlers/AutoCycleSocketHandler.ts`.

```jsonc
// tracker → cab
"auto-cycle:toggle" { "equipment_uuid": "6f0e2c1a-…", "enabled": true }   // REQUIRED both
"auto-cycle:get"    { "equipment_uuid": "6f0e2c1a-…" }
// cab → tracker, the ack: the same body GET / PUT /api/auto-cycle answer on the cab, plus the status
{ "status": 200, "data": { "enabled": true, "active": true, "source": "api", "updated_at": "…", "default": false, "category": "Truck", "warnings": [] } }
{ "status": 409, "errors": [{ "msg": "ENABLE_GEOFENCE is on for this unit: …" }] }
```

| Status | When |
| --- | --- |
| 200 | done (`toggle`) or read (`get`) |
| 400 | `enabled` is not a boolean |
| 409 | switching **on** while the cab's `ENABLE_GEOFENCE` is on. Switching off is always accepted. |
| 421 | the payload names another unit or none, or the cab has no identity yet (`meant for <uuid \| no unit>, this unit is <uuid \| unidentified>`). Nothing changes. A stale `socket_id` shows up as 421, not as a timeout. |
| 500 | the cab could not read or write its Redis |

- **`enabled` is the target state, not a flip,** so a retried toggle cannot undo itself.
- The switch persists on the cab (`auto-cycle:flag`) and applies at once.
- A missing ack means the cab is offline or older than 0.4.36. The caller should answer 504 rather than retry a toggle.

#### Session commands — `session:end` / `session:override` (tracker → geofencer, with ack; geofencer ≥ 0.4.37)

The dashboard's Equipment Operations actions reach the cab through the relay. **Handler:** `geofencer: src/handlers/SessionSocketHandler.ts`; the decisions live in `src/helpers/session-command.ts`.

```jsonc
// session:end: log the operator out on the event the dispatcher chose
{ "equipment_uuid": "6f0e2c1a-…", "session_id": 55, "event_id": 30, "event_code": "CO-S-0030", "done_reason": "Change Operator", "done_at": "…" }
// session:override: merge a dispatcher's change into current:session
{ "equipment_uuid": "6f0e2c1a-…", "session_id": 55, "fields": { "material_id": 1, "material_code": "OB", "block_id": 5 } }
```

| Field | Type | Presence | Notes |
| --- | --- | --- | --- |
| `equipment_uuid` | string | required | must be this cab's uuid |
| `session_id` | number | required | must be the session this cab runs |
| `event_code` | string | required (`end`) | must be in this cab's event master data |
| `event_id`, `done_reason`, `done_at` | | optional (`end`) | |
| `fields` | object | required (`override`) | only plan-session fields are accepted |

The ack is `{ status: 200, data }` or `{ status, errors: [{ msg }] }`. The checks run in this order:

| Status | When |
| --- | --- |
| 421 | meant for another unit, or the cab has no identity |
| 409 | nobody is logged in, the session has no server id, or the cab runs a different session than `session_id` |
| 400 | no `session_id`; no `event_code` (`end`); no field the cab accepts (`override`) |
| 404 | `session:end` names an event this cab's master data does not have |
| 200 | done: `{ "logged_out": true, "session_id" }` / `{ "applied": [fields] }` |
| 500 | it failed on the cab |

- **`session:end`** opens the event through the normal chain (the running log closes and the event becomes `current:event`). It then runs the cab's own logout (`handleLogoutEvents`) for **any** code, not only `LOGOUT_EVENT_CODES`, and deletes `current:token` / `current:operator` before acking.
- **`session:override`** merges only the plan-session fields (`PLAN_SESSION_FIELDS` without `updated_at`): excavator, loading point, materials/blocks, material, dumping point and cell, block, foreman. It re-stamps `updated_at`, so the cab's next session push carries the change, and emits local `session:update`.
- **Offline.** A cab that missed `session:end` logs out on its next session sync (§ What the cab does with the answer). A missed `session:override` is not replayed.

#### Master-data pull — `master-data:pull` (tracker → geofencer, with ack; geofencer ≥ 0.4.51)

This is the Platform asking a cab to pull master data **now** rather than at its next boot, reconnect or handshake (ECO-17). **Handler:** `geofencer: src/handlers/MasterDataSocketHandler.ts`.

```jsonc
// tracker → cab
"master-data:pull" { "equipment_uuid": "6f0e2c1a-…" }                                       // all of it
"master-data:pull" { "equipment_uuid": "6f0e2c1a-…", "datasets": ["shifts", "mine-plan"] }
// cab → tracker, the ack, once the pull is stored
{ "status": 200, "data": {
    "pull": { "started_at": "…", "finished_at": "…" },
    "datasets": [
      { "dataset": "shifts", "source": "redis:settings:shifts",
        "status": { "ok": true, "stage": null, "at": "…", "last_ok_at": "…", "count": 1, "error": null } },
      { "dataset": "mine-plan", "source": "redis:current:plan",
        "status": { "ok": false, "stage": "pull", "at": "…", "last_ok_at": "…", "count": 1,
                    "error": { "kind": "http", "summary": "HTTP 404 · …", "message": "…", "status": 404, "url": "/apps/mine-plans/21" } } }
    ] } }
{ "status": 400, "errors": [{ "msg": "unknown master-data categories: shift" }] }
{ "status": 421, "errors": [{ "msg": "meant for 6f0e2c1a-…, this unit is 9b1d…" }] }
```

- **`datasets`** names some of `MASTER_DATASETS`: `equipment`, `locations`, `events`, `cycle-settings`, `shifts`, `operators`, `mine-plan`, `prestart-checks`, `materials`, `pinned-events`, `geofence-tuning`. Absent, `null` or `[]` pulls all of them. A name given twice is pulled once.
- **200** comes once the pull is stored. `data` is the cab's `/api/dev/master-data` answer cut to the requested datasets, in `MASTER_DATASETS` order. Each dataset's `status.ok` is true (stored), false (failed at `stage` `pull` or `store`, with `error`) or null (skipped; for example the mine plan of a unit with no identity yet). A 200 can therefore report failed datasets.
- **400**: `datasets` is not an array or names an unknown category. **421**: another unit, none, or no identity. **500**: it failed on the cab. In all three cases nothing is pulled.
- **One pull at a time.** A request during a running full pull (boot, reconnect, handshake, another command) joins it. Any other request waits for the pull ahead of it.
- **Timeout.** The Platform sends this with `timeout_ms: 25000`. A full pull is eleven requests to the Platform, so the ack may arrive after the relay answered `timeout`; the pull still completes. A cab without a socket is not queued for, because it pulls everything on reconnect.
- **After a location changes.** A few seconds after a location is created, changed or deleted on the Platform (a burst counts as one change), the Platform sends every unit `{ "equipment_uuid", "datasets": ["locations", "geofence-tuning"] }`. Storing `locations` takes effect at once:
  - the `locations:*` geo members and the SQLite `Location` rows the Platform no longer lists are removed, never on an empty reply;
  - the auto-cycle driver drops its cached sites (local event `master-data:stored`).

#### Device maintenance — `device:command` (tracker → geofencer, with ack; geofencer ≥ 0.4.58)

This is map-editor asking a box for its maintenance status, or to update, install or restart, through **update-daemon**. update-daemon is a root daemon on the box, outside the five services, that does what the application stack cannot do to itself. The event is the single generic relay for update-daemon (§ Unit commands over the socket, "One generic event"). **Handler:** `geofencer: src/handlers/DeviceCommandSocketHandler.ts`; the request/reply client is `src/modules/device-commands.ts`, and the ack mapping is `src/helpers/device-command.ts (deviceOutcome)`.

**The payload is the daemon's command.** Its actions and fields, the daemon's reply, the status report and the job snapshot are owned by `update-daemon/docs/CONTRACT-map-editor.md` (§4–§6), not by this file. Only `equipment_uuid` and `action` are read on the way.

```jsonc
// bus unit:command (map-editor → tracker); request_id is a UUID from map-editor (§7)
{ "request_id": "3f2b8c1e-…", "equipment_uuid": "6f0e2c1a-…", "event": "device:command",
  "payload": { "equipment_uuid": "6f0e2c1a-…", "action": "restart", "targets": ["stack"] }, "timeout_ms": 25000 }
// tracker → cab: the payload as is
"device:command" { "equipment_uuid": "6f0e2c1a-…", "action": "restart", "targets": ["stack"] }
// cab → update-daemon, cab Redis channel update:command: the payload plus geofencer's own requestId
{ "equipment_uuid": "6f0e2c1a-…", "action": "restart", "targets": ["stack"], "requestId": "9d4e…" }
// update-daemon → cab, cab Redis channel update:reply: exactly one per command
{ "requestId": "9d4e…", "status": "accepted" }
// cab → tracker, the ack
{ "status": 200, "data": { "requestId": "9d4e…", "status": "accepted" } }
{ "status": 409, "errors": [{ "msg": "busy: job 7a1c… is running" }] }
{ "status": 503, "errors": [{ "msg": "update-daemon is not listening" }] }
```

**What the cab does, in this order** (steps 1–4 publish nothing):

1. A payload that is not an object → 400.
2. Its Redis is not ready → 503. A publish would wait in node-redis' queue and reach the daemon as a stale command after the reconnect.
3. The payload names another unit or none, or the cab has no identity → 421.
4. No string `action` → 400. geofencer checks nothing else; the daemon validates the rest.
5. It publishes `{ ...payload, requestId }` on `update:command`. The `requestId` is geofencer's own and replaces any the payload carried. It then waits up to `DEVICE_COMMAND_TIMEOUT_MS` (20 000 ms) for the `update:reply` carrying that `requestId`, and maps it:

| Status | When | Body |
| --- | --- | --- |
| 200 | the daemon replied `accepted` (a job started; `data.requestId` is the job's id) or `ok` (the answer is in the reply) | `data`: the daemon's reply, verbatim |
| 400 | step 1 or 4 failed, or the daemon replied `invalid` | `errors[0].msg`: geofencer's reason, or the daemon's `message` |
| 409 | the daemon replied `rejected`: a job is already running | `errors[0].msg`: the daemon's `message`, `busy: job <requestId> is running` |
| 421 | step 3 failed | as every geofencer handler |
| 500 | geofencer threw | |
| 502 | the daemon replied with a `status` geofencer does not know | |
| 503 | the cab's Redis is down, or the publish reached no subscriber (update-daemon is not running or not subscribed) | `update-daemon is not listening` |
| 504 | no `update:reply` within 20 s | `update-daemon did not answer` |

- **The channel is fixed.** geofencer publishes only on `update:command` and listens only on `update:reply` (`geofencer: src/constants/index.ts (UPDATE_COMMAND_CHANNEL, UPDATE_REPLY_CHANNEL)`). Nothing in the payload chooses a channel, so this event cannot reach any other channel on the cab's Redis.
- **Replies stay under 512 KiB.** The ack carries the daemon's reply verbatim, and socket.io (engine.io's default `maxHttpBufferSize`, 1 MB) drops the cab's **whole socket** on a larger message. update-daemon therefore caps every reply at 512 KiB, dropping a report's logs first (`update-daemon: src/status.rs (MAX_REPLY_BYTES)`; its contract §2).
- **Long actions answer at once.** The relay carries one answer within 30 s. An update, an install or a restart therefore answers `accepted` and runs in the background, and map-editor polls it with the daemon's `status` action. Nothing is pushed back: the tracker republishes nothing a cab emits apart from `equipment:connection`.
- **Nothing is queued.** Both hops are pub/sub. An offline cab is `no_socket`; a cab whose daemon is not subscribed is 503.
- **The path runs through the stack it manages.** geofencer and the cab Redis are containers of the box's stack, so a stack restart or a software update cuts the path until geofencer reconnects, roughly 10–60 s of `no_socket` or 503. A box whose stack is down cannot be reached this way at all. map-editor's SSH `obu-remote` path is the fallback, which is why that path stays outside guardrail 17 (`FMS-Backend: docs/BACKLOG.md`).
- **Older units.** A cab older than 0.4.58 has no handler, so the relay answers `timeout`. An update-daemon that does not know an action answers `invalid`, which the cab acks as 400. Release order: update-daemon, geofencer, microservice.tracker, map-editor.
- **The Platform sends nothing on this event.**

#### A new mine plan — `new:mine-plan` (tracker → geofencer, no ack; geofencer ≥ 0.4.32)

The Platform publishes `mine-plan:create` on the bus right after it writes plans. Its scheduler clones the next shift's plans twenty minutes before the shift, and dispatchers create plans. There is one message per plan, addressed by `equipment_type`: an `Excavator` plan to its excavator, a `Truck` plan to its truck. The tracker validates the message (`microservice.tracker: src/helpers/mine-plan-notice.ts (parseMinePlanCreated)`) and resolves the uuid from `equipment_id` when the Platform sent `null` (`MinePlanHandler`). The worker that holds the unit's socket then emits:

```jsonc
"new:mine-plan" {
  "equipment_id": 21,                     // REQUIRED. positive integer
  "equipment_uuid": "6f0e2c1a-…",         // REQUIRED. the cab acts only when this is its own uuid
  "equipment_hull_number": "HD 785 021",  // may be null
  "equipment_type": "Truck",              // REQUIRED.
  "plan": { "id": 9001, "shift": "NIGHT", "shift_start": "…", "shift_end": "…" /* the whole mine_plans row */ }  // plan.id REQUIRED
}
```

- **Targeted only, with no broadcast fallback.** A unit with no socket on record does not get the notice. A malformed bus message is logged and dropped.
- **What the cab does with it** (`geofencer: src/handlers/MinePlanNoticeHandler.ts`, `src/helpers/plan-notice.ts`):
  - a plan for the shift **running now** replaces `current:plan`;
  - a plan for a shift **not started yet** waits at `next:plan` (RedisJSON, expiring at its `shift_end`), while `current:plan` stays the running shift's until the changeover;
  - an ended plan, or one without an id or a shift window, is ignored.

  The offline login works the plan whose shift covers `now + MINE_PLAN_LEAD_MINUTES`. The changeover refresh drops `next:plan` once it equals `current:plan`.
- **An early notice, not delivery.** A cab that misses it loses nothing: it still pulls its plan at login, on connect and one minute after each changeover.

#### `equipment:ready` (tracker → geofencer, no consumer) and returning a repaired unit to service

The Platform publishes a whole `mine_equipments` row on the bus channel `equipment:ready` when it returns a unit to service. The tracker maps that row to `EquipmentVariable` (`microservice.tracker: src/handlers/EquipmentHandler.ts`):

```jsonc
"equipment:ready" { "equipment_id": "21", "equipment_uuid": "6f0e2c1a-…", "equipment_hull_number": "…", "equipment_asset_name": "…", "equipment_category": "Truck", "equipment_subcategory": "…" }
```

- **Delivery.** Each worker emits it to `equipment:{uuid}.socket_id`. **When no socket id is on record, it is broadcast to every connected cab** (`io.emit`). A row without `uuid` is dropped.
- **Retired trigger.** The old `POST /api/equipment` with `status: "Ready"` no longer triggers anything. That route is retired: it answers `{"data":"OK","status":true,"retired":true}`, checks `x-equipment-uuid` only, and geofencer does not call it.
- **No consumer.** As of geofencer ≥ 0.4.4 the cab has **no `equipment:ready` subscriber**. The Platform's `WO-S-0156` / `created_by = "System (return to service)"` event log is stored by the un-synced pull like any other server-created row. It no longer ends the local session, and it no longer sets `equipment:details.status` or the local `Equipment` row to `Ready`. `created_by` is not part of this contract on the geofencer side.
- **What replaces it.** Returning a unit to service is a deliberate in-cab action: `POST /api/equipment/ready` on the cab (Platform ⇄ geofencer / gridlock sections). It sets the status to `Ready`, opens the wait-operator event and logs the operator out. Nothing server-side can evict a driver from the cab.

> ⚠️ DEFECT: the broadcast fallback is still live, and the tracker's code comment still claims that a cab-side `handleEquipmentReady` filters on `equipment_uuid`. That consumer no longer exists. Any future consumer must filter on `equipment_uuid`, or one dispatcher's click reaches the whole fleet.

### Tracker Redis read by geofencer

Truck cabs read the tracker's Redis directly through `REDIS_SVR_URL` (`geofencer: src/modules/redis.ts`), for the excavator beacon only. Nothing else in this pair crosses Redis.

#### The excavator beacon — channel `excavator:update` (tracker → geofencer trucks, geofencer ≥ 0.4.23)

Every truck keeps the positions of the excavators around it in its own local Redis (`geofencer: src/handlers/ExcavatorPositionHandler.ts`; on by default, `EXCAVATOR_BEACON`). These positions feed the cycle's `actual_exca_*` columns. The auto-cycle driver does not use them (geofencer ≥ 0.4.44 drives loading from spotting and the loading radius). Trucks subscribe to this small channel instead of `track:update`, which carries every unit's fix.

**Publisher** (`microservice.tracker: src/utils/routes/TrackUtil.ts (updateState)`, `src/helpers/excavator-update.ts (excavatorUpdatePayload)`). Right after `track:update`, a point that won the compare-and-set, from the realtime or the delayed path, is also published here when all of these hold:

- the unit's category is `Excavator` and its id is a positive integer;
- the position is finite and not `[0, 0]`;
- the fix is no older than `EXCAVATOR_PUBLISH_MAX_AGE_MS` (2 min), so an excavator draining an offline backlog does not burst it to every truck.

A failed beacon publish is logged and never fails the ingest.

```jsonc
{
  "equipment_id": 449,                                   // REQUIRED. mine_equipments.id (the cab's svr_id)
  "equipment_uuid": "…",                                 // REQUIRED. the EQUIPMENT's uuid (track:update's `uuid` is the per-fix id)
  "hull_number": "EX HT 5 024",                          // may be null
  "asset_name": "EX HT 5 024_EXCAVATOR HITACHI-120T",    // may be null
  "lon": 124.2956, "lat": 0.5773,                        // REQUIRED. degrees
  "at_ms": 1790000000000                                 // REQUIRED. the fix's time, capped at now (epoch ms)
}
```

**What the cab does with it.** Each message is parsed (`geofencer: src/helpers/excavator.ts (parseExcavatorUpdate)`). The cab writes the local geo set `excavators:positions` (member = `equipment_id`) and `excavator:state:{id}` = `{uuid, hull_number, asset_name, at_ms}`. An older `at_ms` never replaces a newer one.

#### Seeding — `location:excavator`, `state:{uuid}`, `equipment:{uuid}`

Pub/sub delivers only what is published while subscribed. So on every (re)connect of the tracker Redis link, and whenever the truck starts entering a Loading Site (`gps:entering`), the cab **seeds** from the tracker's keys. Only one seed runs at a time.

| Tracker key | Written by the tracker | Read by the cab |
| --- | --- | --- |
| geo set `location:excavator` (members = equipment uuids) | the live-state compare-and-set, as `location:{category lowercased}` | `GEOSEARCH` around the truck's last fix (or the entering point), **500 m**, **COUNT 20**, `WITHCOORD` |
| hash `state:{uuid}` (`last_updated_ms`, `last_updated`, `track`, `alt`, `fix`, `speed`, `operator_id`; no TTL) | the compare-and-set | `HGET last_updated_ms` only: the seed's freshness, skipped when older than 2 min |
| hash `equipment:{uuid}` (`equipment_id`, `equipment_hull_number`, `equipment_asset_name`, `equipment_uuid`, `equipment_category`, `equipment_subcategory`, `socket_id`) | `EquipmentUtil.checkEquipment`; `socket_id` from the socket lifecycle | `HGETALL`, only for a seeded uuid the cab's own `Equipment` table does not know; `equipment_id`, `equipment_hull_number` and `equipment_asset_name` are used |

These key names and fields are a contract: renaming one breaks every truck silently.

**Requirements and behaviour:**

- **`REDIS_SVR_URL` must point at the Redis instance the tracker publishes on.** Pub/sub does not cross instances. Left on the cab's own Redis (the `.env` default), the cab never sees an excavator, every cycle records the planned excavator as the actual one, and boot logs a warning. Give the cabs a restricted Redis user with `SUBSCRIBE`, `GEOSEARCH`, `HGET` and `HGETALL`.
- **It never holds up the cab.** node-redis `connect()` never resolves while the server is unreachable, so the subscription is started and left pending. Every seed command has a **3 s** deadline (`EXCAVATOR_REMOTE_TIMEOUT_MS`), because node-redis queues commands on a dead link instead of failing them. Errors are logged once per outage, and node-redis reconnects and resubscribes by itself.
- **Stale is absent.** A position older than `EXCAVATOR_POSITION_FRESH_MS` (2 min, by the fix's own time) is not used. A parked excavator reports once a minute, so one missed heartbeat makes it absent for that moment.
- **Only trucks subscribe.** Excavators need nothing beyond posting their fixes to `POST /api/track`.
- **Deploy smoke check.** On the tracker's Redis, `PUBSUB NUMSUB excavator:update` should be ≥ 1 per connected truck.

### Operational parameters

| Parameter | Where | Value |
| --- | --- | --- |
| Default request timeout (`request`, `trackerRequest`) | geofencer `src/modules/request.ts` `DEFAULT_TIMEOUT_MS` | 15 s |
| Realtime track send timeout | geofencer `RedisGPSHandler._sendLocation` | 45 s |
| Interactive pushes (session, realtime event log, realtime cycle, corrections) | geofencer `INTERACTIVE_SYNC_TIMEOUT_MS` | 15 s |
| Current-event PATCH after a transition closes an event | geofencer `EventLogHandler.updateEventOnServer` | 60 s |
| Track send gate | geofencer `GPS_OUTPUT_LIMITS` | ≥ 1 m and ≥ 1 s since the last point sent; pinned at ≤ 1 km/h (release at 10 m); heartbeat 60 s |
| Board heading freshness | geofencer `HOUR_METER_FRESH_MS` | 30 s |
| Delayed buffer cap | geofencer `RedisGPSHandler.DELAYED_BUFFER_MAX` | 5000 points, drop-oldest |
| Delayed buffer flush to SQLite | geofencer `DELAYED_FLUSH_SIZE` / `DELAYED_FLUSH_INTERVAL_MS` | 5 points / 10 s, and on SIGTERM |
| Sync tick | geofencer `MainApp.initSchedulers` | every 60 s; lock `sync:running`, TTL 600 s |
| On-connect pass deadline | geofencer `ON_CONNECT_DEADLINE_MS` | 90 s, checked between steps |
| Charging-station drain trigger | geofencer `RedisGPSHandler.getNearestLocation` | within 120 m of `RS-S-0208`, ≥ 5 s apart |
| Delayed drain | geofencer `DataUtils._sendDelayedTracks` | oldest 200 by `time`; sequential chunks of 50, 500 ms apart; ≥ 5 s between passes |
| Delayed chunk retry | geofencer `DataUtils.retryConfig` | 5 attempts, backoff 1 s doubling, max 30 s |
| Short-count probe budget | geofencer `TRACK_FALLBACK_MAX_PER_DRAIN` | 50 rows per pass |
| Dead-letter cap | geofencer `TRACK_DEAD_LETTER_CAP` | 5000, evict-oldest |
| Event-log drain | geofencer `DataUtils.syncEventLogs` / `EVENT_LOG_SYNC_CONCURRENCY` | 200 per pass, 8 in flight |
| Cycle drain | geofencer `DataUtils.syncCycle` | 100 per pass |
| Pending scan cap | geofencer `selectPending` `maxScan` | 10 000 rows |
| Geofence-log drain | geofencer `DataUtils.syncGeofenceLogs` | 500 per pass, arrays of 100 |
| Late-session batch | geofencer `syncLateSessions` / tracker `LATE_SESSION_BATCH_MAX` | 50 / max 50 |
| Engine-start batch | `ENGINE_START_BATCH_MAX` (both repos) | 50 |
| Hour-meter batch | geofencer `HOUR_METER_READING_BATCH` / tracker `HOUR_METER_READING_BATCH_MAX` | 200 sent / max 500 |
| Hour-meter outbox kept | geofencer `HOUR_METER_READING_KEEP` | newest 259,200 rows |
| Hour-meter pass budget | geofencer `HOUR_METER_SYNC_BUDGET_MS` | 20 s per tick |
| Reconcile limits | tracker `src/routes/reconcile.ts` | window ≤ 26 h; buckets default 12 (1–48); ≤ 4 buckets per list, ≤ 500 uuids each |
| Reconcile windows asked | geofencer `SYNC_LOOKBACK_MS` / `SHIFT_RECONCILE_WINDOW_MS` | 36 h on connect / 14 h at changeover |
| Reconcile repairs per run | geofencer `ReconcileHandler` `MAX_REPAIR_PER_RUN` | 200 rows |
| Live-state freshness rule | tracker `UPDATE_EQUIPMENT_STATE_SCRIPT` | newest `time` wins; an equal time wins again |
| Event-log location radius | tracker `EVENT_LOG_LOCATION_MAX_METERS` | 250 m (PostGIS, all geometry types) |
| Current-event cab grace | `CURRENT_EVENT_CAB_GRACE_MS` (both services, must match) | 2 min |
| Current-operator TTL | tracker `REDIS_EX` | 6 h |
| Socket state TTL | tracker `REDIS_EXPIRE` | 13 h (`equipment:{uuid}.socket_id`, `socket:{uuid}`) |
| Unit command timeout | tracker `unitCommandSchema.timeout_ms` | 500–30 000 ms (the Platform sends 25 s for `master-data:pull`; map-editor 25 s for `device:command`) |
| Device command wait on the cab | geofencer `DEVICE_COMMAND_TIMEOUT_MS` | 20 s for update-daemon's `update:reply`, then 504 |
| Device command timeout | map-editor `lib/devices/command.ts` | `timeout_ms` 25 000 for every action, so the cab's 504 arrives before the relay's `timeout`; map-editor waits 27 s for `unit:reply` |
| Excavator beacon max age | tracker `EXCAVATOR_PUBLISH_MAX_AGE_MS` | 2 min |
| Excavator freshness on the cab | geofencer `EXCAVATOR_POSITION_FRESH_MS` | 2 min |
| Excavator seed | geofencer `EXCAVATOR_SEED_RADIUS_M`, `COUNT`, `EXCAVATOR_REMOTE_TIMEOUT_MS` | 500 m, 20 results, 3 s per command |
| Excavator capture radius (`actual_exca_*`) | geofencer `EXCAVATOR_CAPTURE_RADIUS_M` | 100 m |
| Plan handover lead | geofencer `MINE_PLAN_LEAD_MINUTES`; tracker `MinePlanUtil.findPlanAt` | 20 min |

### Compatibility rules for this pair

1. **`uuid`/`id` is the idempotency key across both track paths.** Use a fresh uuidv4 per point, and reuse the same uuid when re-sending the same point. Every other write keeps its own key (`uuid` on event logs, cycles and crossings; `readingUuid` on engine starts; `(unit, receivedAt)` on hour-meter readings; `login_history_id` as the answer key on late sessions). A unit must never mint a new key for a row it is re-sending.
2. **Timestamps are ISO-8601 with a zone.** geofencer sends `toISOString()`. Per endpoint:
   - event-log `start_time`/`end_time` accept **only** `Z`;
   - cycle phase timestamps accept `Z` or no zone, and refuse explicit offsets;
   - crossings, hour-meter readings, engine starts and reconcile accept `Z` or an offset;
   - the tracker passes track `time` through unconverted.

   Changing a format is a breaking change.
3. **New optional fields may be added at any time.** The tracker strips unknown keys on every zod-validated body, and the cab ignores unknown reply keys. Removing or renaming any field above, changing a unit (`speed` is km/h, `track` and `heading` are degrees, `distance` and `alt` are metres), or changing a reply from per-element to count or back, is a breaking change. It needs a coordinated deploy of both projects, both sides of this section, and `openapi.ts`.
4. **The tracker must stay fast and non-5xx on `POST /api/track`.** Any error or a response slower than geofencer's 45 s realtime timeout degrades every point to delayed and silently thins the live map. After any tracker deploy, verify with the Swagger docs (`/api/docs`) and one realtime POST.
5. **A drain marks rows only against an acknowledgement.** That means a 2xx, no `errors` array, a non-null `data`, and, where the reply is per element, the element's own verdict. The tracker must keep answering per element where it does today, and must not turn a rejection into a 2xx without an `errors` array.
6. **The unit is always the authenticated `x-equipment-uuid`.** No endpoint may take the unit from the body or the path. Path ids on `GET /api/session/:id` and `GET`/`PATCH /api/event-logs/current/:id` are ignored and kept only for compatibility.
7. **Socket commands are targeted, acked and addressed.** Every server → cab command goes through `unit:command` with an ack, never as a broadcast. The cab answers `{status, data | errors}`, refuses another unit's payload with 421, and treats `new:mine-plan` (and any future prompt event) as a hint, never as the only delivery path. Adding a command means changing `UNIT_COMMAND_EVENTS`, the geofencer handler, the Platform sender and this section together. **The one exception is `device:command`**, the generic relay to update-daemon: it is one allowlist entry and one handler for every daemon action, it is sent by map-editor rather than the Platform, and a new daemon action changes update-daemon, its contract and map-editor only. Its handler forwards only to the fixed channel `update:command`. No other event may be generic.
8. **The tracker Redis keys trucks read are contract.** That covers `excavator:update` and its payload, `location:excavator`, `state:{uuid}.last_updated_ms`, and the `equipment:{uuid}` identity fields. They change only together with geofencer's `ExcavatorPositionHandler`.
9. **Schema changes the tracker declares** (Platform-owned `mine_cycle` columns and the like) ship in the order Platform migration → tracker → cabs. An older cab that omits new optional fields must keep working: a create stores null, and a PATCH leaves the stored values alone.

## 6. geofencer ⇄ FMS-Backend

**Transport.** HTTP with JSON bodies, always opened by geofencer: the axios instance `request` (`geofencer: src/modules/request.ts (request)`), `baseURL` `${SERVER_URL}/api`, Deno's `fetch` adapter, a 15 s default timeout that the interactive calls shorten. geofencer pulls master data and never writes master data back; its only writes to the Platform are the equipment handshake, the operator login and prestart results. GPS, event logs, cycles, sessions and geofence crossings go to microservice.tracker (§5) and reach the Platform through the shared database (§7). The Platform never opens a connection to a cab: every off-vehicle request reaches geofencer as a `unit:command` over the tracker's socket (§5; naming rule 20, BACKLOG guardrail 17).

| Surface | Direction | Auth | When |
|---|---|---|---|
| `POST /api/apps/equipments` (handshake) | geofencer → Platform | `token` | first boot without an identity in Redis; the local equipment pick |
| `GET /api/apps/equipments` | geofencer → Platform | `token` | every full pull; every 60 s sync tick |
| `GET /api/apps/locations` | geofencer → Platform | `token` | every full pull |
| `GET /api/apps/geofences` | geofencer → Platform | `token` | every full pull; every 60 s sync tick |
| `GET /api/apps/events` | geofencer → Platform | `token` | every full pull |
| `GET /api/apps/users` | geofencer → Platform | `token` + `equipmentParser` | every full pull |
| `GET /api/apps/cycle-settings` | geofencer → Platform | `token` | every full pull |
| `GET /api/apps/shifts` | geofencer → Platform | none | every full pull; the shift-change slots |
| `GET /api/apps/mine-plans/:id?category=` | geofencer → Platform | `token` | every full pull; the shift-change slots |
| `GET /api/master-data?type=materials` | geofencer → Platform | `equipmentParser` | every full pull |
| `GET /api/master-data?type=prestart-checks` | geofencer → Platform | `equipmentParser` | every full pull |
| `POST /api/operators/auth` | geofencer → Platform | `equipmentParser` + Joi (no API key) | each online login on a production unit |
| `POST /api/apps/prestart-checks` | geofencer → Platform | `equipmentParser` + `token` + `simpleAuth` | each prestart submission; the outbox drain on every connect and every 60 s tick |
| Platform → geofencer | — | — | no HTTP caller; see "Platform → geofencer" below and §5 |

### Headers geofencer sends

The `request` interceptor sets these on every call to the Platform (`geofencer: src/modules/request.ts (request)`); the in-cab UI's own headers are never forwarded.

| Header | Value | Read by the Platform |
|---|---|---|
| `x-api-key` | `API_KEY`, the same key the cab sends the tracker | `token` |
| `equipment-uuid` | `equipment:details.uuid` on the cab Redis; an empty string before the unit has an identity | `equipmentParser` |
| `x-equipment-uuid` | the same value | nothing |
| `Authorization: Bearer <jwt>` | `current:token` on the cab Redis at the moment of the call, only when present; it is written at login with a 4 h TTL | `simpleAuth` (only `POST /api/apps/prestart-checks` on this surface) |

`x-socket-id` goes only to the tracker (`geofencer: src/modules/request.ts (trackerRequest)`), never to the Platform.

> ⚠️ DEFECT (ECO-07): the unit is named twice on every call; the Platform reads only the un-prefixed `equipment-uuid` and the tracker only `x-equipment-uuid`. Target: `x-equipment-uuid` everywhere, the Platform reading both during the transition.

### Platform middlewares and envelopes, as geofencer meets them

| Middleware | Checks | Failure |
|---|---|---|
| `token` (`FMS-Backend: src/middlewares/token/index.ts (createTokenAuth)`) | `x-api-key` equals a `registered_apps.api_key`, compared in plaintext (SEC-08); sets nothing on the request | 401 `{ "message": "Unauthorized access" }` |
| `equipmentParser` (`FMS-Backend: src/middlewares/equipments/index.ts (createEquipmentParser)`) | `equipment-uuid` names a `mine_equipments` row **and** a `registered_devices` row with that `equipment_id` and `equipment_uuid`; sets `req.equipment` | 403 `{ "errors": [{ "msg": "Cannot access this endpoint", "trace": "equipment middleware" }] }` without the header; 404 `{ "errors": [{ "msg" }] }` for an unknown uuid (the empty string included); 404 `{ "errors": [{ "msg": "Equipment is not registered" }] }` without a device row; in dev mode only, 403 for a unit in `Breakdown` |
| `simpleAuth` (`FMS-Backend: src/middlewares/auth/simple.ts (createSimpleAuth)`) | `Authorization: Bearer <jwt>`, HS256 with `SECRET_KEY`; loads `users` by the token's `id`; no revocation (risk SEC-R3) | 401 `{ "message": "Not Authenticated" }` |
| `joiValidator`, `paramsValidator`, `queryValidator` (`FMS-Backend: src/middlewares/validations/index.ts`) | the route's Joi schema, every error reported | 422 `{ "errors": [{ "msg", "type", "path", "context" }] }` |
| `wrapValidation` (`FMS-Backend: src/middlewares/wrappers/validation.ts`; `/api/master-data` only) | express-validator chain | 400 `{ "errors": [ …express-validator items ] }` |
| `loadSettings` (global, `FMS-Backend: src/middlewares/settings/index.ts (loadSettings)`) | `JSON/settings.json` exists on the Platform | 400 `{ "message": "Please setup site settings first!" }` on every route |

- **Success:** `{ "data": …, "status": true, "elapsedTime"?: <ms> }`. `elapsedTime` is absent on some routes (`/api/apps/shifts`, `/api/apps/mine-plans/:id`). `/api/master-data` answers a page: `data` is `{ count, rows }`.
- **Handler errors** go through `a()` (`FMS-Backend: src/middlewares/wrappers/a.ts (a)`): the status is the error class's code (`AuthError` 401, `NotFoundError` 404, `GeneralError` 500), the body `{ "errors": [{ "msg", "name", "stac" }] }` (`stac` is the wire spelling; in production `name` is `"Server Error"` and `stac` `"Stack Error"`; `msg` is masked only when the error was raised with `hideMessage`). Sequelize validation and unique errors are 422. Anything else is 500.
- **geofencer on a failure:** a master-data pull records the dataset as failed in the `master-data:status` hash and writes RedisJSON `errors:{url}` (`{ message, status, data, last_updated }`, 12 h TTL, diagnostics only — it never suppresses a retry) and keeps what it stored before; a login falls back to the offline login; a prestart result goes to the outbox.

### When geofencer calls the Platform

| Trigger | Calls | Code |
|---|---|---|
| Boot, after `InitHandler`, not awaited | full pull | `geofencer: src/app.ts (MainApp.init)` |
| Every tracker socket connect, the first one included; skipped while `equipment:details.uuid` is empty; one pass at a time; a step is skipped once the pass has run 90 s (`ON_CONNECT_DEADLINE_MS`) | full pull first, then the drains, among them the prestart outbox | `geofencer: src/handlers/NetworkHandler.ts (NetworkHandler.handleConnect)` |
| A successful equipment handshake | full pull | `geofencer: src/handlers/InitHandler.ts (InitHandler)`, `src/controllers/EquipmentController.ts (EquipmentController.create)` |
| `master-data:pull` unit command (§5), including the Platform's own push of `locations` + `geofence-tuning` after a location write | the datasets it names, or all | `geofencer: src/handlers/MasterDataSocketHandler.ts` |
| Every 60 s sync tick, under the cab's `sync:running` lock; also `POST /api/sync { "method": "all" }` on the unit | `GET /api/apps/equipments`, `GET /api/apps/geofences`, the prestart outbox drain | `geofencer: src/utils/others/SyncRunner.ts (SyncRunner.steps)` |
| Shift-change slots: `lead_minutes` before each changeover in `settings:shifts` (default 18, set on the unit with `PUT /api/mine-plan-schedule`) and one minute after it (fixed); re-derived every 30 s; 06:30 and 18:30 while `settings:shifts` is empty | `GET /api/apps/mine-plans/:id`, then `GET /api/apps/shifts` | `geofencer: src/schedulers/mine-plan-slots.ts (minePlanSlots)`, `src/app.ts (MainApp.initSchedulers)` |
| Operator login | `POST /api/operators/auth` | `geofencer: src/controllers/AuthController.ts (AuthController.create)` |
| Prestart submission | `POST /api/apps/prestart-checks` | `geofencer: src/controllers/PrestartCheckController.ts (PrestartCheckController.create)` |
| The dev console | full pull | `geofencer: src/routes/dev.ts` |

- **Pulls run one at a time** (`geofencer: src/handlers/DataFetcherHandler.ts (DataFetcherHandler.handle)`): a request made while a full pull runs or waits joins it; any other waits for the newest pull. Within a pull every dataset's request goes out at once (`Promise.allSettled`) and the answers are stored one by one in `MASTER_DATASETS` order; one dataset's failure never stops another.
- **The plan pull straddles the changeover** because `/api/apps/mine-plans/:id` serves the plan of the shift running on the Platform's clock: the pull before the change refreshes the running shift's plan, the pull after it fetches the new one. The next shift's plan reaches the cab earlier through `new:mine-plan` (§5).

### Master-data pulls (geofencer → Platform)

| Dataset | Platform endpoint | Platform answers (`data`) | Stored on the cab |
|---|---|---|---|
| `equipment` | `GET /api/apps/equipments` | `mine_equipments` rows of category `Grader`, `Compactor`, `Truck`, `Excavator`, `Dozer`, timestamps excluded | SQLite `Equipment`, find-or-create on `svr_id`; an existing row gets `status` and `tonnage`. The unit's own `status` also goes to `equipment:details.status`, unless the cab holds a breakdown the tracker has not stored yet (`geofencer: src/helpers/status-ownership.ts (serverStatusMayOverwrite)`) |
| `locations` | `GET /api/apps/locations` | every `mine_locations` row, deactivated ones included, timestamps excluded | SQLite `Location`, upsert on `svr_id`; Point geometries geo-added to `locations:{kebab(category)}` with the location `code` as member; geo members and SQLite rows the payload no longer lists are removed; an empty payload removes nothing |
| `geofence-tuning` | `GET /api/apps/geofences` | below | the in-memory `GeofenceTuningStore`, persisted to RedisJSON `settings:geofence` |
| `events` | `GET /api/apps/events` (no `type` query) | `mine_event` rows with a non-empty `type` | SQLite `Event`, find-or-create on (`svr_id`, `code`) |
| `operators` | `GET /api/apps/users` | every `users` row of type `Operator` or `Administrator`, every column including the bcrypt `password` | SQLite `Operator` — the local name for these users (ECO-12) — find-or-create on (`svr_id`, `oracle_number`); the hash serves the offline login |
| `cycle-settings` | `GET /api/apps/cycle-settings` | the cycle-settings row with `default: true`; 404 when there is none | RedisJSON `settings:cycles` |
| `shifts` | `GET /api/apps/shifts` | below | RedisJSON `settings:shifts` on the cab Redis |
| `mine-plan` | `GET /api/apps/mine-plans/:id?category=` | below | RedisJSON `current:plan`; deletes `next:plan` when it holds the same plan |
| `prestart-checks` | `GET /api/master-data?type=prestart-checks` | `{ count, rows }` of `prestart_checks` whose `equipment_type` and `equipment_subcategory` are the unit's category and subcategory; columns `id, check, description, category, equipment_type, equipment_subcategory, created_at` | RedisJSON `settings:prestart-check`: the whole envelope `{ data: { count, rows }, status, elapsedTime }` |
| `materials` | `GET /api/master-data?type=materials` | `{ count, rows }` of `mine_materials` | SQLite `Material`, find-or-create on `svr_id`; an existing row gets `name` and `code` |
| `pinned-events` | — | served by the tracker (`GET /api/pinned-events`, §5) | RedisJSON `events:pinned` |

Code: `FMS-Backend: src/routes/apps/equipments.ts`, `src/routes/apps/locations.ts`, `src/routes/apps/geofences.ts`, `src/routes/apps/events.ts`, `src/routes/apps/users.ts`, `src/routes/apps/cycle-settings.ts`, `src/routes/apps/shifts.ts`, `src/routes/apps/mine-plans.ts`, `src/routes/master-data.ts`; `geofencer: src/handlers/DataFetcherHandler.ts (DataFetcherHandler.datasetPulls)`.

> ⚠️ DEFECT: an operator already on the cab is updated with `permission_json` and `type` only (`geofencer: src/handlers/DataFetcherHandler.ts (DataFetcherHandler.findOrCreateOperator)`). A password, name or username changed on the Platform never reaches the cab: the cab's local check then refuses the new password and accepts the old one (see "Operator login"). Target: update every pulled column, `password` included.

#### Geofence tuning — `GET /api/apps/geofences`

Resolved server-side (`FMS-Backend: src/controllers/GeofenceController.ts (GeofenceController.getAll)`, `src/helpers/geofence.ts (resolveGeofence, queryWindowFor)`); the cab does no merging.

```jsonc
{
  "data": {
    "defaults": {
      "enter_radius": 20, "exit_radius": 40, "approach_radius": 60, "approach_exit_radius": 75,
      "arrival_dwell_ms": 20000, "min_transition_ms": 3000,
      "nearest_location_radius": 90, "query_window_factor": 1.2
    },
    "query_windows": { "Loading Site": 108, "Dumping Site": 90 },
    "locations": [
      {
        "id": 31, "code": "LS-07", "name": "Loading Point 7", "category": "Loading Site",
        "active": true,
        "geofence": {
          "enter_radius": 25, "exit_radius": 45, "approach_radius": 70, "approach_exit_radius": 90,
          "arrival_dwell_ms": 20000, "min_transition_ms": 3000
        },
        "source": {
          "enter_radius": "location", "exit_radius": "location", "approach_radius": "location",
          "approach_exit_radius": "location", "arrival_dwell_ms": "site", "min_transition_ms": "fallback"
        }
      }
    ]
  },
  "elapsedTime": 4.2,
  "status": true
}
```

| Field | Type | Presence | Notes |
|---|---|---|---|
| `data.defaults` | object | always | the six engine keys plus `nearest_location_radius` (the event-log nearest-location search) and `query_window_factor`; the site setting `app_settings.geofence_defaults` over the compiled fallback `GEOFENCE_DEFAULTS` |
| `data.query_windows` | object, category → metres | always | the cab's GEORADIUS candidate window per category: the widest `approach_exit_radius` in the category times `query_window_factor`, never below the site default's own window. Authoritative: the cab must not recompute it |
| `data.locations[]` | array | always | Point geometries in `Loading Site` and `Dumping Site` only, whose `active` is not `false` |
| `data.locations[].id`, `.code`, `.name`, `.category` | number, string, string, string | always | from `mine_locations`; the cab keys tuning by `code` |
| `data.locations[].active` | boolean | always | `true` for every served row — see the defect |
| `data.locations[].geofence` | object | always | effective engine radii, metres and ms: per-location override (`mine_locations.properties`) → site setting → compiled fallback |
| `data.locations[].source` | object, key → `location` \| `site` \| `fallback` | always | which layer won per key |

- The radii must nest strictly, `enter < exit < approach < approach_exit`, which the writers enforce (`/api/v2/locations`, `/api/v2/geofence-settings`, `FMS-Backend: src/helpers/geofence.ts (assertGeofenceInvariants)`); the payload is not re-checked. The eight purpose radii (`waiting_radius`, `loading_radius`, …) are a different vocabulary, for the map only, and are not served here.
- On the cab (`geofencer: src/utils/others/GeofenceTuningStore.ts`): a failed pull or a 404 keeps what was last adopted, and a cab that never synced keeps its compiled constants; an empty `locations` list changes the defaults only; each value is coerced and falls back per field; a code marked `active: false` is skipped by the engine; a code absent from the payload uses the site defaults.

> ⚠️ DEFECT: a deactivated location is dropped from the payload (the query filters `active IS NOT false`) instead of being served with `active: false`. Since `GET /api/apps/locations` still lists it, the cab keeps it in its geo set and evaluates it with the site defaults: deactivating a site on the Platform does not stop it firing on the cab. Target: serve deactivated Point sites with `active: false`.

#### Mine plan — `GET /api/apps/mine-plans/:id?category=Truck|Excavator`

- `:id` is `equipment:details.id`, the unit's `mine_equipments.id`. The Platform requires a positive integer and answers 422 otherwise (`FMS-Backend: src/routes/validations/mine-plan.validations.ts (findMinePlanByEquipment)`). geofencer makes no request for an empty, `"undefined"`, `"null"` or non-numeric id and records the dataset as skipped (`geofencer: src/helpers/mine-plan-path.ts (minePlanPath)`).
- `category` is `equipment:details.category`. Only `Truck` and `Excavator` pass (`findMinePlanQuery`, else 422); absent means `Truck`. `Excavator` matches `exca_id`, anything else `truck_id`, together with `equipment_type` and the `shift`, `shift_start`, `shift_end` of the shift running on the Platform's clock (`getShift`).
- Answer: `{ "data": <mine_plans row>, "status": true }`; 404 `Cannot find the plan for this equipment` when there is none, after which the cab keeps its `current:plan`.

> ⚠️ DEFECT: geofencer sends `category` as is, so a `Dozer`, `Grader` or `Compactor` unit gets 422 on every pull and its `mine-plan` dataset reads as failed. Target: skip the pull for categories the endpoint does not serve.

#### Site settings — `GET /api/apps/shifts`

No auth. `data` is the Platform's `JSON/settings.json` as read by `loadSettings`.

```jsonc
{
  "data": {
    "name": "<site name>",
    "code": "<site code>",
    "orgCode": "<organisation code>",
    "shifts": [
      { "start": "2024-05-06T23:00:44.037Z", "end": "2024-05-07T11:00:44.037Z", "label": "DAY" },
      { "start": "2024-05-07T11:00:44.037Z", "end": "2024-05-06T23:00:44.037Z", "label": "NIGHT" }
    ]
  },
  "status": true
}
```

| Field | Type | Presence | Notes |
|---|---|---|---|
| `name`, `code`, `orgCode` | string | always | site identity |
| `shifts[].start`, `shifts[].end` | ISO-8601 string | always | only the time of day counts; every reader rebases it onto the current date |
| `shifts[].label` | string | always | `DAY`, `NIGHT`; the label stored on sessions, plans and cycles |

### Equipment handshake — `POST /api/apps/equipments` (geofencer → Platform)

The box tells the Platform which unit it is in; the Platform records the box in `registered_devices`. It does not tell the box its identity: the box already has it, from `configs/equipment_data.json` at first boot or from the local equipment pick. `equipmentParser` refuses a unit without a `registered_devices` row, so until a handshake has succeeded `GET /api/apps/users`, `GET /api/master-data`, `POST /api/operators/auth` and `POST /api/apps/prestart-checks` all answer 404 `Equipment is not registered`.

```jsonc
{
  "equipment_uuid": "0b6f2c8e-…",            // mine_equipments.uuid
  "device_mac_address": "2c:cf:67:0a:11:3e", // the box's network adapter; "00:00:00:00:00:00" when none is found
  "additional_info": {}
}
```

| Field | Type | Presence | Notes |
|---|---|---|---|
| `equipment_uuid` | string | always | must name a `mine_equipments` row when no device row exists yet |
| `device_mac_address` | string | always | `geofencer: src/helpers/networks.ts (getNetworkInfo)` |
| `additional_info` | object | always | geofencer sends `{}` |

- **Platform** (`FMS-Backend: src/controllers/AppEquipmentController.ts (AppEquipmentController.create)`): no body validation. A `registered_devices` row for that `equipment_uuid` is returned unchanged — a different MAC is neither recorded nor refused. Otherwise the uuid must name a unit (404 `Invalid equipment ID`) and a row is created with `created_by: "geofencer"`.
- **Answer:** `{ "data": <registered_devices row: id, equipment_uuid, equipment_id, device_mac_address, additional_info, ip_address, created_*, updated_*, deleted_at>, "elapsedTime", "status": true }`.
- **geofencer, first boot** (`InitHandler`): only while `equipment:details` holds at most one field and the `handshake` key is not `done`. It writes the identity to `equipment:details` first, then posts in the background with the default timeout; success sets `handshake = done` and runs a full pull.
- **geofencer, local equipment pick** (`EquipmentController.create`): writes the identity, posts, then runs a full pull; on a network error it stores the uuid at `equipment:handshake`.

> ⚠️ DEFECT: a handshake that fails is never retried. The first-boot path writes the identity before it posts and runs only while that identity is absent, so the next boot skips it unless the cab Redis lost the hash; and `DataUtils.syncEquipmentHandshake`, which would post the uuid parked at `equipment:handshake`, has no caller. Such a unit stays unregistered and every `equipmentParser` route answers 404. Target: retry the handshake on every boot and connect until the Platform has answered 2xx.

### Operator login — `POST /api/operators/auth` (geofencer → Platform)

The tracker also serves `/api/operators/auth`, with a different meaning: the cab's current-operator record (§5). This one opens the operator's session on the Platform.

- **Caller** (`geofencer: src/controllers/AuthController.ts (AuthController.create)`): production units only — `Dozer`, `Compactor` and `Grader` (`NON_PRODUCTION_EQUIPMENT`) log in locally without calling the Platform. The operator must first pass the cab's own bcrypt check against the pulled `Operator` row, so an operator not yet pulled cannot log in at all. Then a TCP probe of `SERVER_URL` with 1.5 s (`LOGIN_PROBE_TIMEOUT_MS`), then this request with a 2 s timeout.
- **Auth:** `equipmentParser` and `joiValidator(loginValidation)` (`FMS-Backend: src/routes/validations/operator-auth.validations.ts (loginValidation)`). No `x-api-key` check: the header is sent and ignored.

```jsonc
{
  "username": "op3",
  "password": "<plaintext>",
  "latitude": -0.5123,      // the cab's last fix; 0 without one
  "longitude": 117.1234,
  "current_time": "2026-01-15T10:45:12.004Z"   // the cab's clock
}
```

| Field | Type | Presence | Notes |
|---|---|---|---|
| `username` | string | required | a `users` row of type `Operator` |
| `password` | string | required | compared with bcrypt |
| `latitude` | number | required | stored on a session the login creates |
| `longitude` | number | optional | geofencer always sends it |
| `current_time` | ISO-8601 string | optional | geofencer always sends it; see step 2 |

Any other key is 422. `?check=true` answers the user only; geofencer handles its own `check` locally and never sends it.

**What the Platform does** (`FMS-Backend: src/controllers/OperatorAuthController.ts (OperatrorAuthController.create)`, `src/utils/controllers/OperatorAuthUtils.ts (OperatorAuthUtils)`):

1. A unit in `Breakdown` is refused: 500 `Equipment is in breakdown`.
2. The shift: `resolveOperatorShift` (`FMS-Backend: src/modules/getShift.ts`) — the running shift, or the next one during its last 20 minutes (`OPERATOR_HANDOVER_MINUTES`, the crew handover), evaluated at `current_time` when the body has one.
3. The user: 404 `Invalid ID: <username>` when there is no `Operator` of that name, 401 `Invalid password`.
4. The plan: the unit's `mine_plans` row for that shift (`Truck` → `truck_id`, anything else → `exca_id`); 404 naming the hull and the shift when there is none.
5. The session: the open session `current-session:{equipment_id}` names is reused only when it is on that plan (`isSessionOnPlan`); otherwise it is closed with `done_reason: "Shift Change"` (publishing `session:update`, §7) and a new one is created at the prestart event `PCU-D-0132`, with the plan's excavator, loading point, materials, blocks and foreman. A new session is written to `current-session:{equipment_id}` with a 13 h TTL.
6. The token: `OperatorAuthUtils.signJWT`, HS256 over `{ id, username }` (`id` a number), 14 h, signed with `SECRET_KEY` (§7).
7. An excavator's session id is copied to the sessions of the trucks on its plan (`exca_session_id`).

> ⚠️ DEFECT: step 2 uses the cab's `current_time` whenever it is present, which geofencer always sends — the cab's clock decides the shift. The controller's own comment and `FMS-Backend: tests/operator-login-shift.test.ts` ("the server clock decides, not the cab's current_time") say the Platform's clock decides. Target: resolve on the server clock and keep `current_time` informational.

> ⚠️ DEFECT: the operator's allowed equipment categories (`permission_json.operator.allowedEquipments`) are not checked: `checkOperatorPermissions` is empty, so any `Operator` can open a session on any unit that has a plan.

```jsonc
{
  "data": {
    "user": { "id": 3, "username": "op3", "name": "…", "type": "Operator", "oracle_number": "…", "password": "$2b$…", "permission_json": { "…": "…" } },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.…",
    "session": { "id": 5521, "equipment_id": 7, "operator_id": 3, "mine_plan_id": 100, "event_code": "PCU-D-0132", "shift": "NIGHT", "…": "…" },
    "currentMinePlan": { "id": 100, "shift": "NIGHT", "shift_start": "…", "shift_end": "…", "…": "…" },
    "current_shift": { "start": "…", "end": "…", "label": "NIGHT" }
  },
  "elapsedTime": 41.7,
  "status": true
}
```

| Field | Type | Presence | Notes |
|---|---|---|---|
| `data.user` | object | always | the whole `users` row, the bcrypt `password` included |
| `data.token` | string | always | the operator JWT of step 6 |
| `data.session` | object | always | the `sessions` row reused or created |
| `data.currentMinePlan` | object | always | the `mine_plans` row of the resolved shift |
| `data.current_shift` | object | always | `{ start, end, label }` of the resolved shift |

> ⚠️ DEFECT: the answer carries the operator's password hash, and geofencer passes the whole body on to the in-cab UI. Target: blank `password`, as the deprecated `/old` route did.

- **geofencer on success:** RedisJSON `current:session` = `{ token, last_updated, …session }` (no TTL), `current:operator` and `current:token` (4 h each); a local `LoginHistory` row with `synced_id` = the session id; the prestart event opened locally; the current operator pushed to the tracker (§5); the Platform's body returned to the UI. `currentMinePlan` is not stored — the cab keeps its pulled `current:plan`.
- **Offline login:** when the probe fails, or the request fails for any reason (timeout, 4xx, 5xx), geofencer logs the operator in locally: a session built from `current:plan` (or the last `LoginHistory`), a JWT it signs itself, HS256 over `{ exp: 13 h, id: svr_id, username }` with its own `JWT_SECRET`, stored at the same `current:token`. The session reaches the Platform later through the tracker (§5).
- **Logout** does not use this surface: geofencer never calls `PATCH /api/operators/auth/:id`. The end of a session reaches the Platform as event logs and session updates through the tracker (§5).

> ⚠️ DEFECT: every refusal from the Platform — wrong password, a unit in `Breakdown`, no plan for the shift, a user who is not an `Operator` (`GET /api/apps/users` also ships `Administrator` hashes) — sends the cab into its offline login, which succeeds on the local hash. The Platform's login rules are therefore advisory on the cab. Target: fall back only on transport failures (probe, timeout, 5xx), and show a 4xx to the operator.

> ⚠️ DEFECT: a token signed offline verifies on the Platform and the tracker only when geofencer's `JWT_SECRET` equals the Platform's `SECRET_KEY`; geofencer's `JWT_SECRET` has a compiled-in default (`geofencer: src/constants/index.ts`). With different values every Bearer call after an offline login is refused with 401. Target: the cab's secret provisioned equal to `SECRET_KEY` (§7), or offline tokens never sent upstream.

### Prestart result — `POST /api/apps/prestart-checks` (geofencer → Platform)

- **Caller** (`geofencer: src/controllers/PrestartCheckController.ts (PrestartCheckController.create)`): forwards the in-cab UI's body unchanged, after a 1.5 s probe, with a 3 s timeout. Any failure, or a failed probe, stores the body in the SQLite outbox `prestart_result_histories` (and RedisJSON `current:prestart`, 13 h). `DataUtils.syncPrestartChecks` drains the 50 oldest unsent rows per pass, one at a time, with the default timeout, on every connect and every 60 s tick; a refused row is retried on the next pass, with no limit. geofencer answers the UI 200 whatever happened.
- **Auth:** `equipmentParser`, `token`, then `simpleAuth`. The Bearer is `current:token` at the moment of the call — for a drained row, whoever is logged in at drain time.

```jsonc
{
  "result": {
    "results": [
      { "id": 160, "check": "Kondisi Ban (Tyres)", "description": "…", "condition": true, "category": "A" },
      { "id": 171, "check": "Lampu Kerja (Working Lights)", "description": "…", "condition": false, "category": "C" }
    ],
    "statements": [
      { "statement": "Lama tidur lebih dari 6 jam", "agree": true }
    ]
  },
  "hour_meter": 1444.5,
  "latitude": -0.5123,
  "longitude": 117.1234,
  "current_time": "2026-01-15T22:09:29.012Z"
}
```

| Field | Type | Presence | Notes |
|---|---|---|---|
| `result.results[]` | array of `{ id, check, description, condition, category }` | always | one per checklist item; `id` is `prestart_checks.id`, wording copied at submit; `condition: true` = OK; `category` `A` \| `B` \| `C` |
| `result.statements[]` | array of `{ statement, agree }` | always | the operator's fitness statements; the text is the identity |
| `hour_meter` | number | always | stored on the session, the unit and the Platform's live cache |
| `remarks` | string | optional | the UI does not send it today |
| `latitude`, `longitude` | number | always | 0 without a fix; ignored by the Platform |
| `current_time` | ISO-8601 string | always | the cab's clock at submission; ignored by the Platform |

geofencer's type `CreatePrestartCheckResult` (`geofencer: src/@types/controllers.ts`) declares a flat `results` array; the wire shape is the one above, which geofencer passes through untouched.

- **Platform** (`FMS-Backend: src/controllers/PrestartCheckController.ts (PrestartChecksController.create)`): no body validation. The session is `current-session:{equipment_id}` **at receipt** — the key missing is a 500, a closed session a 401 `There is no session for this equipment.` It inserts a `prestartresults` row (`results`, `statements`, `remarks`, `session_id`, `created_by` = the token's user name, `equipment_id`), writes `hour_meter` to `sessions.start_hour_meter`, `mine_equipments.hour_meter` and the Platform's `equipment:{equipment_id}` hash, and sets `prestart-check-{equipment uuid}` to the new row's id.
- **Answer:** `{ "data": <prestartresults row>, "elapsedTime", "status": true }`.

> ⚠️ DEFECT: units post to `/api/apps/prestart-checks`, which only stores the result. The category-A handling — the unit to `Breakdown`, a breakdown event log `UM-BU-0059` — lives only in `/api/operators/prestart-checks` (`FMS-Backend: src/routes/operators/prestart-checks.ts`), which nothing on the unit calls; a failed category-A item changes nothing. Target: one handler for both routes.

> ⚠️ DEFECT: a drained result lands on whatever session the unit holds when it arrives — possibly a later operator's — overwrites that session's and the unit's hour meter with an older reading, takes `created_by` from the token held at drain time, and is timed at receipt because `current_time` is dropped. A 3 s timeout after the Platform committed makes the drain send it again, and nothing deduplicates. A result the Platform will always refuse (closed session, expired `current:token`) is re-sent every pass forever. Target: send the session id and an idempotency key with the result, honour `current_time`, and dead-letter a 4xx.

### Platform routes geofencer does not call

| Route | Auth | What it is |
|---|---|---|
| `PATCH /api/operators/auth/:id` | `simpleAuth` + `equipmentParser` | operator logout, body `{ event_reason_code, current_time, hour_meter }` |
| `GET /api/operators/auth` | `simpleAuth` + `equipmentParser` | the operator's current session, shift and plan |
| `GET /api/apps/session`, `GET /api/apps/auth`, `GET /api/apps/blocks`, `GET /api/apps/locations/:id`, `GET /api/apps/prestart-checks/:id` | `token` (the first two also a Bearer; `session` and `prestart-checks` also `equipmentParser`) | lookups an app may use |
| `/api/operators/prestart-checks` | `simpleAuth` + `equipmentParser` | the prestart route with the category-A handling (see the defect above) |
| `POST /api/apps/tracks` | none | the Node-RED GPS feed; publishes `haul:fix` (§7) |
| `POST /api/operators/tracks` | `equipmentParser` | a GPS ingest writing `tracks`; publishes `haul:fix`. Cabs post GPS only to the tracker (§5) |
| `GET /api/apps/users/:id` | none | one user row |

> ⚠️ DEFECT: `GET /api/apps/users/:id` answers any user's row, bcrypt `password` included, with no credentials at all (`FMS-Backend: src/routes/apps/users.ts`). Target: `token` + `equipmentParser` like the list, without the hash.

### Platform → geofencer

No HTTP. The Platform has no cab address setting, and `FMS-Backend: tests/geofencer-socket-only.test.ts` fails when its code grows one or builds a URL from a device's `ip_address`. Every request from off the vehicle is a `unit:command` relayed by the tracker to the cab's socket (§5 for the events, §7 for the channel).

geofencer's routes guarded by `x-api-key` accept the key the unit itself sends the Platform (`geofencer: src/middlewares/api-key.ts (apiKeyAuth)`): constant-time compare, 401 `{ "errors": [{ "msg": "Unauthorized access" }] }` otherwise, and a unit with no key configured accepts nobody. The Platform calls none of them; they serve on-vehicle callers such as the configurator.

| Unit route | Off-vehicle path |
|---|---|
| `GET` / `PUT /api/auto-cycle` | `auto-cycle:get` / `auto-cycle:toggle` over `unit:command` (§5) |
| `GET` / `PUT /api/mine-plan-schedule` | none yet (GEO-22: `mine-plan-schedule:get` / `:set`) |
| `GET` / `PATCH /api/hour-meter/settings` | none yet (HM-06: `hour-meter:settings:get` / `:set`) |

> ⚠️ DEFECT (GEO-21): `apiKeyAuth`'s comment still describes these routes as "for calls from the Platform". Target: document them as on-vehicle only.

## 7. microservice.tracker ⇄ FMS-Backend

**Transport.** There is no HTTP between these two services, and neither holds the other's address. They share three things: one Postgres database (the durable path), one Redis instance used both as a pub/sub bus and as a keyspace (the live path — fan-out and live state, never durability), and one JWT secret (the tracker verifies tokens the Platform signs). Nothing authenticates one service to the other on the bus or in the database: they are one trust domain (ECO-14).

| Surface | Direction | Auth | When |
|---|---|---|---|
| Shared Postgres | both ways | the database credentials only | every write |
| Redis pub/sub | both ways | none (ECO-14) | per write, fix, connection and command |
| Redis keyspace | both ways | none | per fix, request, login and session change |
| JWT secret | Platform signs → tracker verifies | HS256 | each dashboard or operator call the tracker authenticates |

### Configuration that must agree

| Concern | Platform | Tracker | Rule |
|---|---|---|---|
| Redis | `REDIS_URL` (host:port; the client prepends `redis://`) for keys; `REDIS_BUS_URL` (defaults to `REDIS_URL`) for publish and subscribe (`FMS-Backend: src/clients/redis.ts`) | `REDIS_URL` (a full URL) for keys and the bus (`microservice.tracker: src/modules/redis.ts`) | all three name **one** instance, with RedisJSON |
| Postgres | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASS`, `DB_DATABASE` | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | one database |
| JWT | `SECRET_KEY` | `JWT_SECRET` | equal, rotated together |
| Current-event grace | `CURRENT_EVENT_CAB_GRACE_MS` | `CURRENT_EVENT_CAB_GRACE_MS` | equal; default 120000 on both |

The keyspace the two share sits on the Platform's `REDIS_URL` client, not on its bus clients: `state:*`, `location:*`, `socket:*`, `equipment:{uuid}`, `current-event:*` (the compare-and-set), `current-session:*`, `current-operator:*` and `settings:shifts`. A Platform whose `REDIS_BUS_URL` is the tracker's but whose `REDIS_URL` is another instance receives every message yet reads no live state, runs the current-event compare-and-set against a different hash than the tracker, and never delivers `settings:shifts`.

### Shared Postgres

- **Schema ownership.** The Platform's migrations (sequelize-cli, ledger `SequelizeMeta`) own the Platform tables. The tracker's migrations (`deno task db:migrate`, ledger `tracker_migrations`, `microservice.tracker: src/db/migrator.ts`) create only the tracker-owned tables and check that the Platform tables they model exist; where `SequelizeMeta` exists they refuse to create them (`microservice.tracker: src/db/migrations/20261021000400-platform-tables.ts`).
- **Models must agree.** Each repo models the shared tables itself; a column one model lacks is silently dropped from that repo's writes. A change to a shared table changes both models in the same change.
- **Hooks do not cross.** A row one service writes fires no hook in the other: the Platform learns of the tracker's writes only through the bus.

> ⚠️ DEFECT (ECO-09): with `DB_ALTER=true` the tracker's cluster primary still runs `sequelize.sync({ alter, force: DB_FORCE })` against the shared database (`microservice.tracker: src/app.ts (MainApp.initDB)`) — a second, uncoordinated schema writer on Platform tables, with a drop-all switch behind it. The ownership also blurs the other way: a Platform migration alters the tracker-owned `geofence_logs` (`FMS-Backend: src/db/migrations/20260829120000-geofence-logs-uuid.js`). Target: no `sync()` in the tracker, each table migrated by its owner only.

| Table | Written by | Read by | Notes |
|---|---|---|---|
| `mine_cycle` | tracker (`POST` / `PATCH /api/cycles` from cabs, `Cycle` model); Platform (its own routes and jobs) | both | Platform schema. Tracker writes publish `cycle:*` |
| `event_logs` | tracker (`POST /api/event-logs`, `PATCH /api/event-logs/:id`, the `cycle_uuid` → `cycle_id` backfill); Platform (dispatcher edits, session end, shift-start sweep, return to service) | both | Platform schema. Tracker writes publish `event-log:*` |
| `sessions` | tracker (`POST /api/session`, `POST /api/session/late`, the plan re-sync on each event log, the current-event follow); Platform (login, shift-change close, session end and override, prestart hour meter) | both | Platform schema. Tracker writes publish `session:*`, which nobody hears (see the channels) |
| `engine_starts` | tracker (`EngineStart.bulkCreate`, `ON CONFLICT DO NOTHING` on `reading_uuid`) | Platform (`GET /api/v2/engine-start`) | Platform schema (`FMS-Backend: src/db/migrations/20261013090000-engine-starts.js`); the two models are field-for-field the same |
| `mine_equipments` | Platform; tracker sets `status = 'Breakdown'` on a breakdown event log (`microservice.tracker: src/utils/routes/EventLogUtil.ts`), a static update that fires no hooks | both | Platform schema |
| `mine_plans` | Platform | tracker (`microservice.tracker: src/utils/others/MinePlanUtil.ts (MinePlanUtil)`, `src/helpers/plan-sync.ts`: re-syncs a truck's open session to its plan on every event log) | Platform schema. The Platform's own copy of that rule (`FMS-Backend: src/modules/event-logs.ts`, case `travelling`) runs only on its own event-log route |
| `mine_event`, `mine_locations`, `mine_materials`, `mine_block`, `pinned_events`, `registered_apps`, `users` | Platform | tracker | Platform schema. `mine_locations`: the nearest location within 250 m (`EVENT_LOG_LOCATION_MAX_METERS`) stamps event logs; `registered_apps`: the cab API key; `users`: the user behind a token |
| `tracker` | tracker (GPS history) | Platform, read-only: `equipment_id`, `time`, `speed`, `created_at`, `deleted_at` for the cycles report's stops (`FMS-Backend: src/helpers/reports.ts (CYCLE_STOPS_SQL)`); `equipment_id`, `time`, `coordinates`, `created_at`, `deleted_at` for cycle distances (`FMS-Backend: src/helpers/cycle-distances.ts (CYCLE_DISTANCE_SQL)`), which is the tracker's own `GET /track/linestring` query (`microservice.tracker: src/utils/routes/TrackUtil.ts (LINESTRING_SQL)`) batched over cycles — the two must measure alike, so a change to either query is a change to both | tracker schema; no primary key, `uuid` unique, soft-deleted; the Platform's queries need `tracker_equipment_id_time_idx` (a tracker migration). `speed` as the cab sent it (km/h); `coordinates` a point geometry in SRID 4326 (lon, lat), null when the fix had none — the distance is a geodesic `ST_Length` over it |
| `geofence_logs` | tracker | — | tracker schema |
| `hour_meter_readings` | tracker (`ON CONFLICT DO NOTHING` on `(equipment_id, time)`) | — | tracker schema; TimescaleDB hypertable on `time` |

The Platform's own GPS tables `tracks` and `track_fixes` receive nothing from cabs, which post GPS only to the tracker.

> ⚠️ DEFECT: the Platform reads the same speed in two units. `TrackHandler` multiplies `track:update.speed` by 3.6 — it takes it for m/s — while `helpers/reports.ts` treats `tracker.speed` as km/h (`STOP_SPEED_KMH`). The tracker stores and publishes the cab's value unconverted (km/h, §2), so the live map's speed is 3.6 times too high. Target: no conversion in `TrackHandler`.

### Shared Redis — channels

The tracker publishes on its `redisSubClient` (a publish-only connection, despite the name) and subscribes on a dedicated `redisSubscriberClient`, wired in `microservice.tracker: src/app.ts (MainApp.initRedis)`; its subscribers are `src/handlers/EquipmentHandler.ts`, `MinePlanHandler.ts` and `UnitCommandHandler.ts`. The Platform publishes on `redisPubClient` and subscribes on `redisSubClient`, both on `REDIS_BUS_URL`; its subscribers are `FMS-Backend: src/handlers/TrackHandler.ts`, `HaulProgressHandler.ts`, `TrackFixHandler.ts`, `RedisSubHandler.ts`, `src/helpers/unit-command.ts (UnitCommandClient)` and `src/helpers/unit-auto-cycle.ts (startAutoCycleQueue)`. Every worker of each service subscribes, so every worker hears every message.

map-editor, outside the five services, is a client of the same bus (`map-editor: lib/live/bus.ts`, on its `FMS_REDIS_BUS_URL`). It publishes on it only `unit:command`, for `device:command`, and it subscribes to `unit:reply` for the answers (`map-editor: lib/devices/command.ts (DeviceCommandClient)`).

| Channel | Publisher | Subscribers | Payload |
|---|---|---|---|
| `track:update` | tracker, for every point — realtime or replayed in a batch — that wins the `state:{uuid}` compare-and-set (`microservice.tracker: src/utils/routes/TrackUtil.ts (TrackUtil.updateState)`) | Platform `TrackHandler` (emits `equipment-move` to its own worker's clients) and `HaulProgressHandler` | below |
| `excavator:update` | tracker, the same winning points for an `Excavator`, not at `[0, 0]`, at most 120 s old | none on the Platform; truck cabs (§5) | `{ equipment_id, equipment_uuid, hull_number, asset_name, lon, lat, at_ms }` |
| `cycle:create`, `cycle:update` | tracker `Cycle` model hooks (`microservice.tracker: src/models/hooks.ts (registerPublishHooks)`) | Platform `RedisSubHandler` → socket `new-cycle`, `update-cycle` | the whole `mine_cycle` row, `id` included |
| `event-log:create`, `event-log:update` | tracker `EventLog` model hooks | Platform `RedisSubHandler` → `new-event-log`, `update-event-log` | the whole `event_logs` row |
| `session:create`, `session:update` | tracker `Session` model hooks; `session:update` also the Platform's `Session.afterUpdate` hook (`FMS-Backend: src/init.ts`) and `src/routes/operators/prestart-checks.ts` | none | the whole `sessions` row |
| `current-event:update` | tracker (`microservice.tracker: src/controllers/EventLogController.ts (EventLogController.announce)`) and Platform (`FMS-Backend: src/helpers/current-event-service.ts (CurrentEventService)`), each only when its compare-and-set lands | Platform `RedisSubHandler` → `update:current-event` to the dashboard rooms | below |
| `replace-event-log` | tracker, on the same landed cab writes | Platform `RedisSubHandler` → `replace-event-log` | `{ …event fields, equipment_id }`; frozen legacy |
| `new-operator` | tracker, `POST /api/operators/auth` from a cab (§5) | Platform `RedisSubHandler` → `new-operator` | `{ id, name, username, oracle_number, login_at }` |
| `equipment:connection` | tracker, a cab socket opening or closing (`microservice.tracker: src/handlers/SocketHandler.ts`) | Platform `startAutoCycleQueue` (on `connected: true` sends the unit's waiting auto-cycle switch, §5) | `{ equipment_uuid, socket_id, connected, at, worker, reason? }`; `at` ISO-8601; `reason` only when `connected` is false |
| `unit:command` | Platform (`FMS-Backend: src/helpers/unit-command.ts (UnitCommandClient.send)`); map-editor (`map-editor: lib/devices/command.ts`), for `device:command` only | every tracker worker (`UnitCommandHandler`) | below; each event's payload in §5 |
| `unit:reply` | tracker (`microservice.tracker: src/helpers/unit-command.ts (relayUnitCommand)`), exactly one per command | every Platform worker and map-editor; the sender claims it by `request_id`, and every other subscriber ignores it | below |
| `mine-plan:create` | Platform after writing a plan: the scheduler's clone before each shift and `POST /api/mine-plans` (`FMS-Backend: src/helpers/mine-plan-publish.ts (publishNewMinePlans)`) | tracker `MinePlanHandler` → socket `new:mine-plan` to that unit only (§5) | `{ equipment_id, equipment_uuid \| null, equipment_hull_number \| null, equipment_type, plan }`; addressed by `equipment_type` (`Excavator` → `exca_id`, `Truck` → `truck_id`, else `equipment_id`); the tracker looks a null uuid up |
| `equipment:ready` | Platform: return to service (`FMS-Backend: src/helpers/return-to-service.ts (ReturnToServiceService)`) and the v1 equipment update to `Ready` (`src/routes/equipments.ts`) | tracker `EquipmentHandler` → socket `equipment:ready` to the unit, or to every cab when no socket id is on record | the whole `mine_equipments` row; must carry `uuid`. geofencer has no listener for the socket event |
| `haul:fix` | Platform track-ingest routes (§6) | Platform `HaulProgressHandler`, `TrackFixHandler` | Platform-internal; it only travels on the shared bus |

- **Relaying.** `RedisSubHandler` relays only on the relay worker, where `PORT − START_PORT = 0` (`FMS-Backend: src/handlers/RedisSubHandler.ts (isRelayWorker)`); with `START_PORT` unset, as in dev, it relays nothing (BOOT-08). `TrackHandler` and `HaulProgressHandler` run on every worker.
- **Publish after the write.** The tracker's model hooks publish after the insert or update, deferred to `afterCommit` inside a transaction, and a publish failure never fails the write: a message implies a committed row, and any code path that writes through those models publishes. The Platform publishes `mine-plan:create` and `equipment:ready` after their writes, and a `unit:command` only after its durable change. The exception is `track:update`, published from the state step **before** the `tracker` row is inserted: a realtime point repeating a stored `uuid` republishes, then fails its insert.
- **Fan-out only.** Losing a message loses a live update, never data; durability rides on the database writes above. Never move durability onto these channels.

> ⚠️ DEFECT (ECO-12): `session:update` from the Platform has no subscriber — neither the tracker nor the cab listens to it; a Platform change reaches a cab only through `unit:command`, the tracker's event-log reply or the cab's session sync (§5). Target: stop publishing it, or give it a consumer.

> ⚠️ DEFECT: the Platform subscribes to neither `session:create` nor `session:update` from the tracker, so a session the tracker creates or changes — a cab's session sync, a late session, the plan re-sync — reaches no dashboard until it re-fetches, while the tracker's cycle and event-log writes are relayed live. Target: relay the tracker's `session:*` as `update:session`.

#### `track:update` payload

```jsonc
{
  "uuid": "6f1c2d0e-…",          // the point's id, tracker.uuid
  "lat": -0.5123,
  "lon": 117.1234,
  "alt": 41.2,
  "speed": 23.4,
  "track": 182.5,
  "fix": "3D",
  "time": "2026-01-15T02:47:35.000Z",
  "update": true,
  "operator_id": 3,
  "hull_number": "HD-07",
  "coordinates": { "type": "Point", "coordinates": [117.1234, -0.5123] },
  "equipment_category": "Truck",
  "equipment_subcategory": "DT",
  "equipment_id": 7,
  "last_updated": "2026-01-15T02:47:34.000Z"
}
```

| Field | Type | Presence | Notes |
|---|---|---|---|
| the cab's point | — | always | realtime: the `POST /api/track` body as the cab sent it, extra keys included (§5); replayed: `{ uuid, lat, lon, alt, speed, track, heading, fix, time, update: false, operator_id: null, hull_number }` |
| `coordinates` | GeoJSON Point | always | `[lon, lat]`; the Platform takes the position from here |
| `equipment_id` | number | always | `mine_equipments.id` |
| `hull_number`, `equipment_category`, `equipment_subcategory` | string | always | from the tracker's `equipment:{uuid}` cache |
| `time` | string | always | the cab's string, not normalised. The Platform parses it with `trackerTimeFormats` (`FMS-Backend: src/consts/index.ts`): ISO-8601, `YYYY-MM-DD HH:mm:ss.SSS Z` or `YYYY-MM-DD HH:mm:ss Z`. An offset is required: without one it is read in the Platform server's local time. `HaulProgressHandler` drops a point whose `time` does not parse; `TrackHandler` then emits `time_diff: null` |
| `last_updated` | string | always | the previous `state:{uuid}.last_updated`, or this point's `time` on the unit's first write |
| `alt` | number | when the cab sent it | metres |
| `speed` | number | when the cab sent it | km/h, unconverted; see the speed defect above |

> ⚠️ DEFECT (ECO-04): the payload carries `alt`, but `TrackHandler` emits `altitude: parsed.altitude`, always undefined; `FMS-Backend: src/helpers/live-tracks.ts` likewise reads `state:{uuid}.altitude`, which the hash stores as `alt`. Target: the publisher maps `alt` → `altitude`, or every reader reads `alt`.

#### `unit:command` and `unit:reply`

```jsonc
// unit:command — Platform (or map-editor, for device:command) → every tracker worker
{
  "request_id": "01JC9Q3V7Y6M0R6Z8K2B4D5E6F",  // a ULID from the Platform; a UUID from map-editor
  "equipment_uuid": "0b6f2c8e-…",
  "event": "master-data:pull",
  "payload": { "equipment_uuid": "0b6f2c8e-…", "datasets": ["locations", "geofence-tuning"] },
  "timeout_ms": 25000
}
// unit:reply — tracker → every Platform worker
{
  "request_id": "01JC9Q3V7Y6M0R6Z8K2B4D5E6F",
  "status": "ack",
  "outcome": { "status": 200, "data": { "…": "…" } }
}
```

| Field | Type | Presence | Notes |
|---|---|---|---|
| `request_id` | string | always, both | the correlation key. A ULID from the Platform, a UUID (v4) from map-editor; the tracker requires only a non-empty string and echoes it |
| `equipment_uuid` | string | always (command) | the unit; the tracker finds its socket at `equipment:{uuid}.socket_id` |
| `event` | string | always (command) | must be in the tracker's allowlist `UNIT_COMMAND_EVENTS`: `session:end`, `session:override`, `auto-cycle:toggle`, `auto-cycle:get`, `master-data:pull`, `device:command` |
| `payload` | object | always (command) | emitted to the cab as is; shapes in §5 (for `device:command`, in update-daemon's contract) |
| `timeout_ms` | integer 500–30000 | always (command) | how long the tracker waits for the cab's ack; the Platform sends 5000, 25000 for `master-data:pull`; map-editor sends 25000 for `device:command` |
| `status` | `ack` \| `timeout` \| `no_socket` | always (reply) | `ack`: the cab answered; `timeout`: the socket holder got no ack in time; `no_socket`: no worker holds a socket for the unit |
| `outcome` | `{ status: number, data?, errors?: [{ msg }] }` | with `ack` | the cab's answer; an ack without a numeric `status` becomes `{ status: 502 }` |

- The tracker checks the command with zod (`microservice.tracker: src/helpers/unit-command.ts (unitCommandSchema)`) and ignores anything else without replying; it never retries. The worker holding the socket emits and replies; `no_socket` comes from the worker `socket:{uuid}.worker` names, or worker `0` when there is none.
- The Platform resolves `unreachable` when no reply arrives within `timeout_ms` + 2000 ms (`UNIT_REPLY_MARGIN_MS`) — the tracker or the bus is down, or the command was ignored. map-editor waits the same `timeout_ms` + 2000 ms.
- **Every subscriber hears every reply.** A sender keeps the `request_id`s it published and ignores any other reply, so the Platform and map-editor never take each other's answers.

#### `current-event:update` and the shared compare-and-set

Both services write `current-event:{equipment_id}` through one Lua compare-and-set, `helpers/current-event-write.ts` in each repo, the same script in both (its SHA-1 is pinned in both test suites) (ECO-16). Rules: the newest start wins, a start being capped at its arrival time; a cab write over a Platform one is allowed `CURRENT_EVENT_CAB_GRACE_MS` behind; an event once replaced cannot come back (`superseded_id`); the same content is a no-op (`fingerprint`); a landed write replaces the hash whole and bumps `rev` to at least Redis's clock in ms.

```jsonc
{
  "id": "88231", "event_id": "12", "event_code": "PCU-D-0132", "event_description": "…",
  "event_description_ind": "…", "event_status": "…", "event_type": "…",
  "start_time": "2026-01-15T22:01:05.000Z", "start": "2026-01-15T22:01:05.000Z",
  "updated_at": "2026-01-15T22:01:05.000Z", "shift": "NIGHT", "operator": "…",
  "end": "", "end_time": "", "completed": "",
  "equipment_id": 7,
  "rev": 1768514465123
}
```

| Field | Type | Presence | Notes |
|---|---|---|---|
| event fields | strings | always | the hash as the landing writer stored it, bookkeeping excluded. A Platform write carries the keys above (`FMS-Backend: src/helpers/current-event-hash.ts (buildCurrentEventHash)`); a cab write carries the cab's fields, `id` = its `synced_id` or `id`, `start` = `start_time`, `updated_at` = arrival (`microservice.tracker: src/helpers/current-event-write.ts (parseCabCurrentEvent)`) |
| `equipment_id` | number | always | `mine_equipments.id` |
| `rev` | number | always | the hash's new revision; a screen applies only a higher `rev` |

### Shared Redis — keys

| Key | Written by | Read by | TTL | Notes |
|---|---|---|---|---|
| `state:{equipment_uuid}` (hash) | tracker, a Lua compare-and-set per winning point (`microservice.tracker: src/modules/redis-scripts.ts (updateEquipmentState)`) | Platform (`FMS-Backend: src/helpers/live-tracks.ts (loadLiveTracks)`, `src/controllers/EquipmentStatesController.ts`, `src/controllers/MinePlanController.ts`, `src/helpers/reports.ts (buildConnectivityRows)`); truck cabs (§5) | none | below. A point is refused only when the stored `last_updated_ms` is greater, so an equal time wins again |
| `location:{category}` (GEO; member = equipment uuid) | tracker, the same script | Platform (`helpers/live-tracks.ts`, `src/helpers/last-known-location.ts (lastKnownLocation)`, the shift-start sweep); truck cabs read `location:excavator` (§5) | none | `category` lower-cased: `location:truck`, `location:excavator`, … |
| `equipment:{equipment_uuid}` (hash) | tracker: the identity cache (`microservice.tracker: src/utils/middlewares/EquipmentUtil.ts (EquipmentUtil.checkEquipment)`) and `socket_id` (`SocketHandler`) | tracker; Platform (`helpers/live-tracks.ts`, `EquipmentStatesController`); truck cabs (§5) | `socket_id` 13 h (a field TTL); the rest none | `{ equipment_id (a string), equipment_hull_number, equipment_asset_name, equipment_uuid, equipment_category, equipment_subcategory, socket_id }`; read as a miss when it has one field or no `equipment_id` |
| `socket:{equipment_uuid}` (hash) | tracker | Platform (`/api/v2/reports/connectivity`); tracker (`unit:command` relay) | 13 h | `{ socket_id, connected_at, disconnected_at, worker }` |
| `current-event:{equipment_id}` (hash) | both, through the shared compare-and-set | both; cabs through the tracker (§5) | none | numeric id only; the event fields, plus bookkeeping `order_ms`, `source`, `fingerprint`, `superseded_id` and `rev`. Readers strip the bookkeeping and keep `rev` |
| `current-session:{equipment_id}` (string: a `sessions.id`) | Platform at login (`OperatorAuthUtils.createNewSession`); tracker when it creates or resolves a session (`microservice.tracker: src/utils/others/SessionUtil.ts (SessionUtil)`). Deleted by the Platform at session end, after copying it to `previous-session:{equipment_id}` (`FMS-Backend: src/helpers/session-end.ts (EndSessionService)`), and by the tracker when the session it names closes | both: the Platform's login, prestart, equipment states and excavator-session lookup; the tracker's session, event-log and cycle resolution | 13 h when the Platform sets it; none when the tracker does (and a tracker `SET` drops the Platform's TTL) | numeric equipment id on both sides |
| `current-operator:{equipment_uuid}` (RedisJSON) | tracker (`POST /api/operators/auth` from the cab, refreshed by event logs, §5); deleted by the tracker's `DELETE /api/operators/auth` and by the Platform's session end | Platform (`helpers/live-tracks.ts`, `src/routes/equipments.ts`, `src/controllers/EquipmentController.ts`) | 6 h | `{ id, name, username, oracle_number, login_at }` |
| `settings:shifts` (RedisJSON `SiteSettings`) | Platform `loadSettings` (`FMS-Backend: src/helpers/settings-reader.ts (createSettingsReader)`) | tracker on every request (`microservice.tracker: src/app.ts (MainApp.initRouteVars)`, `src/middlewares/settings/index.ts (shiftSettings)`): `GET /api/event-logs` answers 404 without it | none | shape in §6 "Site settings". The cab keeps its own copy on the cab Redis, pulled from `GET /api/apps/shifts` |

```jsonc
// state:{equipment_uuid} — all values are strings
{
  "last_updated_ms": "1768444055000",            // the comparison value: new Date(time)
  "last_updated": "2026-01-15T02:47:35.000Z",    // the cab's `time`, verbatim
  "track": "182.5", "alt": "41.2", "fix": "3D", "speed": "23.4",
  "operator_id": "3"                             // "" when the point carried none
}
```

- **`settings:shifts` timing.** The Platform writes it when `JSON/settings.json` changes and otherwise at most once every 60 s, from the request path — only while requests arrive; a failed write is logged, not thrown.
- **Prefixes shared with other keys.** `equipment:` carries three id kinds on this instance: the tracker's `equipment:{uuid}` and `equipment:{hull_number}` (a 13 h cache for cycle lookups) and the Platform's own `equipment:{id}` live cache. `auth:` carries the tracker's user cache `auth:{id}` (13 h) and the Platform's dashboard-token registry `auth:{id}:{token}`; the keys never coincide.

> ⚠️ DEFECT (CFG-01): `settings:shifts` is written from the request path rather than once at boot, so a Platform that receives no request after a Redis flush leaves the tracker without shifts. Target: write it at boot and on each settings change.

> ⚠️ DEFECT (TRK-07): one prefix, several id kinds — `equipment:{uuid}`, `equipment:{hull_number}` and the Platform's `equipment:{id}` (naming rule 12). Target: one key per concept.

### Shared JWT secret

The Platform signs with `SECRET_KEY`: dashboard tokens (`POST /api/auth`, HS256 over `{ id, username }` with `id` a string, 14 h, registered at `auth:{id}:{token}`; `FMS-Backend: src/routes/auth.ts`) and operator tokens (`POST /api/operators/auth`, `id` a number, 14 h, §6). The tracker verifies with `JWT_SECRET`, HS256 only (`microservice.tracker: src/helpers/access-token.ts (verifyAccessToken)`): dashboard tokens on `GET /api/track/linestring` and `/api/playback/*`, which FMS-frontend calls directly, and operator tokens on its `GET /api/operators/auth` (§5). It accepts `id` as a string or a number. The cab's API key is not accepted on those routes.

- `JWT_SECRET` must equal `SECRET_KEY` in every environment. With another value each such call answers 401 `invalid access token` (the cause, a signature mismatch, is logged); with `JWT_SECRET` empty no token can be verified at all. Rotating `SECRET_KEY` means rotating `JWT_SECRET` with it.
- geofencer's offline tokens are signed with its own `JWT_SECRET` and verify on either side only when that equals too (§6).

> ⚠️ DEFECT: the tracker does not consult the Platform's token registry `auth:{id}:{token}`; it caches the user at `auth:{id}` for 13 h. A dashboard token revoked on the Platform (logout) keeps working on the tracker until it expires. Target: the tracker checks the registry key the Platform's `auth` middleware checks.

## 8. Compatibility rules (all surfaces)

Each section ends with the rules particular to its surface; these hold for all of them.

1. **Add, never change, within a major version.** A new optional field, endpoint, channel, socket event or key is a minor bump. Consumers must ignore fields they do not know. Removing, renaming, re-typing or re-meaning a field, changing its unit or its timestamp format, changing an idempotency key, or changing a status code or reply shape that consumers act on, is breaking: a major bump and a coordinated deploy of every repo on that surface.
2. **Idempotency keys are permanent.** A producer re-sending a row reuses its key; it never mints a new one. The keys are listed per surface (the fix `uuid` in §3, the reading `uuid` in §4, §5's idempotency table, §6's handshake). A server answers a repeat as a success, never with a 5xx.
3. **Late, duplicate and out-of-order data is normal.** The cab is offline-first: anything it sends may arrive hours late, twice, or after something newer. Servers keep the newest by the surface's ordering clock, not by arrival, and accept backfill.
4. **Ingest stays fast.** A slow or failing answer is not an error to the cab but a reason to buffer and retry, which piles up. §5 gives the tracker's budget.
5. **Pub/sub is not storage.** The cab bus (§3, §4) and the server bus (§7) drop messages for anyone not listening. State a restart must not lose also lives in a key or a table, and consumers seed from it.
6. **Wire time is ISO-8601 with a zone.** Locale strings, local times and epoch numbers are for humans and logs, unless a section pins a numeric field with its unit in the name (`at_ms`).
7. **A request from off the vehicle reaches a cab only over the tracker's socket** (§5). A new Platform → cab command is the tracker's `UNIT_COMMAND_EVENTS` allowlist entry, a geofencer handler, a Platform sender and this contract, in one change. The one exception is `device:command`: a single generic relay that map-editor sends and geofencer forwards to update-daemon on the fixed channel `update:command`, whose actions are update-daemon's contract and need no change here (§5 "Device maintenance"). It does not license a second generic event.
8. **A new surface between these five services gets its section here in the same change** that adds it, with a minor bump.
9. **Shared tables change in both server repos.** A column on a table both the Platform and the tracker map (cycles, event logs, sessions, …) lands in the Platform's model and migration and in the tracker's model together, in the order Platform migration → tracker → cabs (§7).

## 9. Per-repo standing rules

| Repo | When you change … | … also |
|---|---|---|
| all five | any shape, unit, cadence, key or behaviour another of these services relies on | update this contract in the same commit (canonical copy in FMS-Backend), bump its version, `yarn fleet-contract:stamp` and `yarn fleet-contract:sync`, and add a changeset with a `Docs:` line in every repo whose copy changed |
| all four mirrors | — | never edit `docs/FLEET_CONTRACT.md` or its manifest here; `deno task fleet-contract:verify` fails on an edited or stale copy |
| FMS-Backend | a route geofencer calls, `equipmentParser` / `token`, a Redis channel or key the tracker reads, a shared table | §6 or §7; for a Platform → cab command, the tracker allowlist and geofencer handler too (rule 7) |
| microservice.tracker | a route, validation schema, socket event or Redis key in §5 or §7 | `src/docs/openapi.ts`, and §5/§7 |
| geofencer | anything it sends to the tracker or the Platform, or reads from gps, hm or the tracker's Redis | `docs/geofencer-docs.json` for its own routes, and §3–§6 |
| microservice.hm | `src/helpers/hour-meter.ts` (the only frame → payload mapping), `src/@types/hour-meter.ts`, `src/constants/hour-meter.ts` | §4 |
| microservice.gps | the published payload, its gate, dedupe or channel, the liveness keys | §3 |

## 10. Changelog

Newest first. Every change to this file adds an entry here and bumps the marker under the title (§0).

### 1.2.0 — 2026-11-12

**Added: `device:command`, box maintenance through update-daemon.** map-editor publishes `unit:command` with the new allowlisted event `device:command`, and the tracker relays it like any other command. geofencer (≥ 0.4.58) publishes the payload with its own `requestId` on the fixed cab-Redis channel `update:command`, waits up to 20 s for update-daemon's `update:reply`, and acks: 200 with the daemon's reply for `accepted` or `ok`, otherwise 400, 409, 421, 500, 502, 503 or 504. It is the single generic relay for update-daemon and a deliberate exception to "one event per command". The payload is the daemon's command, owned by `update-daemon/docs/CONTRACT-map-editor.md`, so a new daemon action changes no tracker or geofencer code. update-daemon caps its replies at 512 KiB, because socket.io drops the cab's whole socket above 1 MB.

- §0 "What is not here" points at update-daemon's contract.
- §1 names map-editor and update-daemon; §2 lists the two channels on the cab Redis.
- §5: the allowlist entry and the generic-relay note, the new subsection "Device maintenance — `device:command`", two operational parameters (`DEVICE_COMMAND_TIMEOUT_MS` 20 s; map-editor's `timeout_ms` 25 000), and the exception in compatibility rule 7.
- §7: map-editor publishes `unit:command` and subscribes to `unit:reply`; `request_id` is a ULID from the Platform and a UUID from map-editor; a sender ignores replies it did not ask for.
- §8 rule 7 states the exception.

Affects: microservice.tracker (the allowlist entry), geofencer (the handler, 0.4.58), and two repos that hold no mirror: map-editor (the publisher) and update-daemon (behind the relay). The Platform sends nothing new. microservice.hm and microservice.gps: mirror only. Release order: update-daemon, geofencer, microservice.tracker, map-editor.

### 1.1.0 — 2026-11-11

**Added: the Platform reads `tracker.coordinates`.** `POST /api/v2/cycles/distances` measures how far a truck drove over each finished cycle from the `tracker` table, with the tracker's own `LINESTRING_SQL` batched over cycles, and caches each answer for three days (`cycle-distance:<cycleId>`, Platform-only). The dashboard used to ask the tracker's `GET /track/linestring` once per cycle for this. §7's `tracker` row lists the columns and the rule: the two queries must keep measuring alike, and `coordinates` must stay a point in SRID 4326.

Affects: microservice.tracker (owner of the table and of the original query), the Platform (reader).

### 1.0.1 — 2026-11-05

**Correction, no wire change.** microservice.hm merged `feat/wt61-imu` into `main`, so `hour-meter:imu`, the `getImuSource` / `setImuSource` actions with the reply's `imu`, `imuSource` on `hour-meter:update`, the key `hour-meter:imu-source` and the `HOUR_METER_IMU_SOURCE` / `HOUR_METER_IMU_HZ` / `WT61_*` settings are hm `main` behaviour. §3 and §4 no longer mark them branch-only, and the 1.0.0 defect "geofencer `main` depends on hm's unmerged `feat/wt61-imu`" is resolved; §4 keeps a note on what an older hm build answers.

Affects: microservice.hm (producer), geofencer (consumer).

### 1.0.0 — 2026-11-05

**First version.** One contract for every surface between microservice.gps, microservice.hm, geofencer, microservice.tracker and the Platform, replacing seven files that are now pointers to it: `docs/ecosystem/integrations/{gps-to-geofencer,hm-to-geofencer,geofencer-tracker,geofencer-platform,tracker-platform}.md` here, and the pair `geofencer/docs/CONTRACT-tracker.md` / `microservice.tracker/docs/CONTRACT-geofencer.md`, which claimed to be copies of one document but had diverged. Takes ECO-11 part of the way: a version that must move with every change, checked by hash, and byte mirrors in all five repos checked in their CI; no blocks are generated from code yet.

Affects: all five repos (the mirror, `scripts/verify-fleet-contract.ts`, a `fleet-contract:verify` task and CI step in the four Deno repos; `scripts/fleet-contract.mjs`, `pretest` and CI here).

**Corrected against the code** — the replaced files said otherwise:

- §3: `speed` is km/h, not m/s or unitless; `trueNorth` is a boolean; `errors`/`processed` exist only with `READER=tcp` or `SIMULATE`; one fix per receiver epoch after a 1500 ms dedupe, standing still too, not "~1 Hz while moving"; `fix` is never null; Socket.IO `gps:update` is pre-dedupe, has no `uuid` and has no consumer; `last:polling` and `last:watchdog-reconnect` are written by the TCP reader only.
- §4: `hour-meter:imu`, `getImuSource` / `setImuSource`, `imuSource` and `hour-meter:imu-source` exist only on microservice.hm's unmerged `feat/wt61-imu`; geofencer's guard requires more fields than listed (`timeValid`, `hourMeterH`, `totalizerUnits`, `statusFlags`, `statusFlagNames`); `track` uses `forwardHeadingDeg` before `headingDeg`; a reply's `deviceId` is never on `invalid`, `unavailable` or `error`; the reading outbox keeps the newest 259,200 rows.
- §5: track `time` is the GPS receiver's clock and `track` the truck's front (board heading, else the GPS course turned 180° while reversing); geofencer's realtime timeout is 45 s and its default 15 s, not 10 s / 450 s; a delayed point that wins the compare-and-set also moves live state and publishes `track:update`; backfill `coordinates` may be a string or an object, parsed per row; the sync tick is 60 s in 14 ordered steps, session first, not 2 min; tracker auth failures carry real statuses (TRK-02 is fixed) while a zod 400 has no `errors` array; `POST /api/geofence` accepts `uuid` as its idempotency key; hour-meter `stored` counts valid rows, and two readings with one `receivedAt` collapse into one; `PATCH /api/cycles/:id` does write session-owned columns; `equipment:ready` comes from the Platform's bus message, `POST /api/equipment` being a retired no-op; auto-cycle goes through the `unit:command` relay; a closed session found by id or pointer is returned, not replaced (TRK-09).
- §6: the 60 s tick also re-pulls `/apps/equipments` and `/apps/geofences` and drains prestart results; the full pull runs on every tracker socket connect; `/apps/users` returns `Administrator` too, with every column; deactivated locations are dropped rather than sent `active: false`; login `current_time` is optional and, when sent, picks the shift; geofencer never calls the logout `PATCH`; only `/apps/shifts` lacks auth among the calls geofencer makes.
- §7: the Platform's `REDIS_URL`, not only its bus, must be the tracker's instance; `settings:shifts` is written when the settings change or at most every 60 s; `track:update` timestamps are the cab's strings passed through; `cycle:create` carries the full row with `id`; both services key `current-session:` by numeric equipment id; `session:*` has no subscriber and `haul:fix` is Platform-internal; the Platform does read `location:{category}` and the `tracker` table.

**New defects recorded without a backlog ID** — file them, then put the ID on the note in a patch bump:

- §3: `time`'s date part can come from the box clock, so one epoch can go out twice; microservice.gps queues publishes through a Redis outage and replays them as current; `gps:update` listeners leak per connection.
- §4: geofencer `main` depends on hm's unmerged `feat/wt61-imu`; `/api/hour-meter/settings` is off-vehicle HTTP to the unit (migration is HM-06); geofencer's `HOUR_METER_SERVICE_URL` default cannot reach hm on a cab.
- §5: the socket is unauthenticated on both ends, so a unit can be impersonated; `GET /api/reconcile` answers 500 to every valid stream, and the cab asks for 36 h against a 26 h cap; `PATCH /api/cycles/:id` and `PATCH /api/event-logs/:id` have no ownership check; required cycle strings coerce absent and null to `"undefined"` / `"null"`; on-connect drains run outside the tick's `sync:running` lock; `GET /session/:id` on connect overwrites the cab's offline material choice; the `equipment:ready` broadcast fallback is still live; a repeated realtime `uuid` re-publishes and then answers 500.
- §6: a password changed on the Platform never reaches the cab; deactivated locations keep firing on the cab; Dozer, Grader and Compactor get 422 on every mine-plan pull; a failed handshake is never retried; login resolves the shift on the cab's clock and does not check the operator's equipment categories; the login answer and `GET /api/apps/users/:id` (no auth) carry the password hash; any Platform login refusal falls back to an offline login; an offline token verifies only if the cab's `JWT_SECRET` equals `SECRET_KEY`; prestart safety handling runs only on a route the unit never calls, and a drained prestart result can land on the wrong session, twice, or retry forever.
- §7: `speed` is treated as m/s in `TrackHandler` but km/h in the reports; the tracker's `session:*` channels reach no dashboard; the tracker ignores the Platform's token revocation.
