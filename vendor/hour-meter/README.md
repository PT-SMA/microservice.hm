# vendor/hour-meter — mirror, never edit

Byte-identical copies of the hour-meter device's host-side code from
[`embedded-totalizer-hour-meter`](../../../embedded-totalizer-hour-meter):

| Here | Upstream | What it is |
|---|---|---|
| `sensorframe/js/` | `sensorframe/js/` | SensorFrame v1 codec (COBS + CRC16 + TLV), zero-dependency CommonJS |
| `configurator/src/links.ts` | same | serial (`Deno.open` + `stty`) and `tcp://` byte links |
| `configurator/src/sensorframe.ts` | same | loads the codec via `createRequire`; `FrameSplitter` |
| `configurator/src/device.ts` | same | `DeviceClient`: frames, COMMAND/ACK with retries, `enableAutoTimeSync()` |
| `configurator/src/tags.ts` | same | the tag table, checked against the firmware by `esp32/scripts/check-docs.ts` |

The layout is upstream's, so `sensorframe.ts`'s `require('../../sensorframe/js/index.js')`
resolves unchanged and no file needs editing. `UPSTREAM.json` pins the commit and a
sha256 per file.

- **Refresh:** `deno task vendor:sync` (reads `../embedded-totalizer-hour-meter`, or
  `HM_UPSTREAM_PATH`). It also regenerates `tests/fixtures/frames.json` from the firmware's
  frame catalog.
- **Check:** `deno task vendor:verify` — must print `mirror matches …@<commit>`. In CI and the
  Docker build there is no upstream checkout, so it prints `L2 SKIPPED` and only proves the
  files were not edited here.
- **Import:** only through `src/modules/hour-meter.ts`.
- **Why not npm/jsr, a path import or a submodule:** the codec is private, the sibling repo is
  outside the Docker build context, and a submodule pulls the firmware/PCB repo into every
  clone (a missing `--recurse-submodules` fails silently). Publishing `sensorframe` to a
  private registry would retire this directory (BACKLOG HM-03).
