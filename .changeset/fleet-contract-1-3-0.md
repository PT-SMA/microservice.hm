---
"microservice-hm": patch
---

docs: mirror FLEET_CONTRACT.md 1.3.0 — `voice-note:new`, dispatcher voice notes
to the cab

Docs: updated docs/FLEET_CONTRACT.md

- `docs/FLEET_CONTRACT.md` and its manifest move to 1.3.0, written by
  `yarn fleet-contract:sync` in FMS-Backend. §5 adds `voice-note:new` (a notice;
  the cab fetches the audio over HTTP), §6 the three `/api/apps/voice-notes`
  routes geofencer calls, §7 the allowlist entry; §0 points the in-cab UI at
  `GRIDLOCK_CONTRACT.md`. Nothing on this service's surface changes.
