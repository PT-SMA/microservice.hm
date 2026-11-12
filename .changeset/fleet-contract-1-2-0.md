---
"microservice-hm": patch
---

docs: mirror FLEET_CONTRACT.md 1.2.0 — `device:command` to update-daemon

- `docs/FLEET_CONTRACT.md` and its manifest move to 1.2.0, written by
  `yarn fleet-contract:sync` in FMS-Backend. §5 adds `device:command`, the
  single generic relay from map-editor to update-daemon on the box: the tracker
  relays it, and geofencer forwards it to the cab-Redis channel `update:command`
  and acks with `update:reply`. §7 names map-editor as a publisher of
  `unit:command`. Both channels are on the cab Redis this service uses too, but
  it neither publishes nor reads them; no code here changes.

Docs: updated docs/FLEET_CONTRACT.md (mirror, 1.2.0)
