---
"microservice-hm": patch
---

docs: mirror FLEET_CONTRACT.md 1.8.0 — Geo Fence polygons as loading/dumping sites, and a GPS-error margin around polygons

Docs: updated docs/FLEET_CONTRACT.md

- `docs/FLEET_CONTRACT.md` and its manifest move to 1.8.0, written by
  `yarn fleet-contract:sync` in FMS-Backend. §6 adds `properties.site_type`
  on a `Geo Fence` polygon (a loading or dumping site for the cab's
  auto-cycle) and `polygon_threshold` in the geofence defaults (a margin
  outside a polygon that still counts as inside). Nothing on this service's
  surface (§4) changes.
