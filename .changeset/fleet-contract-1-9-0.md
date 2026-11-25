---
"microservice-hm": patch
---

docs: mirror FLEET_CONTRACT.md 1.9.0 — an online excavator's own radii drive the hauler's auto-cycle

Docs: updated docs/FLEET_CONTRACT.md

- `docs/FLEET_CONTRACT.md` and its manifest move to 1.9.0, written by
  `yarn fleet-contract:sync` in FMS-Backend. §6 adds an excavator's
  `extra_props.departure_radius` / `loading_radius`; §5's excavator beacon now
  also feeds the auto-cycle, for excavators that are online. Nothing on this
  service's surface (§4) changes.
