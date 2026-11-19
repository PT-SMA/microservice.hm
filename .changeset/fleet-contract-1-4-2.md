---
"microservice-hm": patch
---

docs: mirror FLEET_CONTRACT.md 1.4.2 — the Platform's webhook capture trigger on shared tables

- `docs/FLEET_CONTRACT.md` and its manifest move to 1.4.2, copied from FMS-Backend after
  `yarn fleet-contract:stamp`. §7 "Shared Postgres" documents `webhook_capture`, the Platform's
  AFTER INSERT OR UPDATE trigger on `mine_cycle` and `event_logs`, which records each committed
  change for the Platform's outbound webhooks. Nothing in this service touches those tables; no code here changes.

Docs: updated docs/FLEET_CONTRACT.md (mirror, 1.4.2)
