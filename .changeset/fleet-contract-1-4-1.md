---
"microservice-hm": patch
---

docs: mirror FLEET_CONTRACT.md 1.4.1 — the Platform's live speed is km/h

- `docs/FLEET_CONTRACT.md` and its manifest move to 1.4.1, copied from FMS-Backend after
  `yarn fleet-contract:stamp`. The Platform's `TrackHandler` no longer multiplies
  `track:update.speed` by 3.6, so §7's speed defect is gone. The tracker's payload is unchanged;
  no code here changes.

Docs: updated docs/FLEET_CONTRACT.md (mirror, 1.4.1)
