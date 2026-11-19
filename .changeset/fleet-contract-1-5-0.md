---
"microservice-hm": patch
---

docs: mirror FLEET_CONTRACT.md 1.5.0 — the Platform estimates the empty phase timestamps of finished cycles

- `docs/FLEET_CONTRACT.md` and its manifest move to 1.5.0, copied from FMS-Backend after
  `yarn fleet-contract:stamp`. §5 "Estimated phase timestamps" and the `mine_cycle` row of §7
  document the Platform filling a finished cycle's empty phase columns (event logs first, then
  interpolated from similar complete cycles) and the Platform-only column
  `mine_cycle.interpolated_timestamps` that marks the estimates. Nothing in this service touches `mine_cycle`; no code here changes.

Docs: updated docs/FLEET_CONTRACT.md (mirror, 1.5.0)
