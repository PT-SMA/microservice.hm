---
"microservice-hm": patch
---

docs: mirror FLEET_CONTRACT.md 1.7.0 — one open session per operator, and automatic events

Docs: updated docs/FLEET_CONTRACT.md

- `docs/FLEET_CONTRACT.md` and its manifest move to 1.7.0, written by
  `yarn fleet-contract:sync` in FMS-Backend. §6 "Operator login" adds
  `ended_sessions`; §5 "Session commands" adds the optional `event_log_uuid`,
  `cause` and `remarks` of `session:end` (a forced logout now records the
  device's fresh `hour-meter:state` reading as the login's end hour meter); §6
  adds the master dataset `auto-event-schedules` and Geo Fence
  `properties.auto_event`. Nothing on this service's surface (§4) changes.
