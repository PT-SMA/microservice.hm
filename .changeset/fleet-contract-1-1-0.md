---
"microservice-hm": patch
---

docs: mirror FLEET_CONTRACT.md 1.1.0 — the Platform reads tracker.coordinates for cycle distances

- `docs/FLEET_CONTRACT.md` and its manifest move to 1.1.0, written by
  `yarn fleet-contract:sync` in FMS-Backend. §7's `tracker` row adds the
  Platform's new read-only use of the table: `POST /api/v2/cycles/distances`
  measures each finished cycle from `equipment_id`, `time`, `coordinates`,
  `created_at` and `deleted_at`. No code here changes.

Docs: updated docs/FLEET_CONTRACT.md (mirror, 1.1.0)
