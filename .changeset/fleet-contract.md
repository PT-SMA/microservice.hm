---
"microservice-hm": patch
---

docs: mirror FLEET_CONTRACT.md, the one versioned contract between gps, hm,
geofencer, the tracker and the Platform (ECO-11)

- `docs/FLEET_CONTRACT.md` and `docs/fleet-contract.manifest.json` are byte
  copies of FMS-Backend's canonical contract (1.0.1), written by
  `yarn fleet-contract:sync` there. Never edit them here.
- `scripts/verify-fleet-contract.ts` (byte-identical in the four Deno repos),
  run as `deno task fleet-contract:verify` in CI: the copy must match its
  manifest's hash and version and, with FMS-Backend checked out beside it, the
  canonical file. Both files are excluded from `deno fmt`.

Docs: updated docs/FLEET_CONTRACT.md (new mirror), CLAUDE.md, README.md
