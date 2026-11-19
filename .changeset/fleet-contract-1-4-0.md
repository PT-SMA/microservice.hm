---
"microservice-hm": patch
---

docs: mirror FLEET_CONTRACT.md 1.4.0 — the intercom, live push-to-talk between
dispatchers and operators

Docs: updated docs/FLEET_CONTRACT.md

- `docs/FLEET_CONTRACT.md` and its manifest move to 1.4.0, written by
  `yarn fleet-contract:sync` in FMS-Backend. §5 adds "Intercom"
  (`intercom:start` with a delivery ack, volatile `intercom:frame` /
  `intercom:end`, the cab's `intercom:talk-*`) and the voice note's `source`; §7
  adds the bus channels `intercom:downlink` and `intercom:uplink`. Nothing on
  this service's surface changes.
