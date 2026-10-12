---
"microservice-hm": minor
---

feat: geofencer reads and changes the hour meter's settings over Redis

`hour-meter:command` (`getSettings` / `setSettings`) → the device → one
`hour-meter:reply` with the same `requestId`. A change is validated here first —
unknown, read-only, wrong-type and out-of-range settings never reach the device
— sent as one COMMAND (all or nothing, like the device), then read back with
`get=2`, so the reply says what the device holds now. Replies say `ok`,
`invalid`, `rejected` (with the device's `ackStatus` and the setting),
`unavailable` (no link — nothing is queued for later) or `timeout`.

`output`, `uartBaud` and `bluetooth` are read-only that way: each can cut the
link this service reads the device through. `btPin` is never sent, not even on
read. Commands run one at a time. A third Redis connection is the only one that
subscribes; `/health` reports it as `redis.subConnected`.

Docs: updated README.md, CLAUDE.md;
FMS-Backend/docs/ecosystem/integrations/hm-to-geofencer.md (§ Commands).
