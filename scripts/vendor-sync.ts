/**
 * Refresh `vendor/hour-meter/` from the device repo.
 *
 * The hour meter speaks SensorFrame v1 over a serial line. Its repo
 * (`embedded-totalizer-hour-meter`) already ships a working Deno reader for it
 * — the configurator's `links.ts`, `sensorframe.ts`, `device.ts`, `tags.ts` and
 * the zero-dependency CommonJS codec in `sensorframe/js/`. That code is
 * private (not on npm or jsr) and lives outside this repo's Docker build
 * context, so it is mirrored here byte for byte rather than imported by path.
 *
 * The upstream layout is preserved under `vendor/hour-meter/` so that
 * `configurator/src/sensorframe.ts`'s `require('../../sensorframe/js/index.js')`
 * resolves unchanged: no file is edited, so every hash in `UPSTREAM.json` can
 * be compared against upstream exactly (`deno task vendor:verify`).
 *
 * It also regenerates the test fixtures that come from the same repo:
 *   - `tests/fixtures/frames.json` — every hex dump in
 *     `esp32/docs/FRAME-CATALOG.md` (`<!-- frame:<id> -->`) and
 *     `esp32/docs/INTEGRATION-GUIDE.md` (`<!-- golden:<id> -->`). These are
 *     firmware-accurate: the simulator's `test/catalog.test.ts` proves the
 *     catalog equals the frames it builds.
 *   - `tests/fixtures/sensorframe-test-vectors.json` — the codec's own vectors.
 *
 * Usage:
 *   deno task vendor:sync                 # refuses if upstream paths are dirty
 *   deno task vendor:sync --allow-dirty   # mirror uncommitted upstream bytes anyway
 *   HM_UPSTREAM_PATH=/path/to/checkout deno task vendor:sync
 */

import {
  FIXTURE_FRAMES,
  FIXTURE_VECTORS,
  MANIFEST,
  type Manifest,
  MIRRORED,
  sha256,
  UPSTREAM_REPO,
  upstreamPath,
  VENDOR_ROOT,
} from "./vendor-common.ts";

const ALLOW_DIRTY = Deno.args.includes("--allow-dirty");

/** The docs the frame fixtures are extracted from. */
const FRAME_SOURCES = {
  catalog: "esp32/docs/FRAME-CATALOG.md",
  golden: "esp32/docs/INTEGRATION-GUIDE.md",
} as const;

const VECTORS_SOURCE = "sensorframe/test-vectors.json";

function fail(message: string): never {
  console.error(`vendor:sync: ${message}`);
  Deno.exit(1);
}

async function git(upstream: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: ["-C", upstream, ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    fail(
      `git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr).trim()}`,
    );
  }
  return new TextDecoder().decode(out.stdout).trim();
}

/**
 * Every `<!-- frame:<id> -->` / `<!-- golden:<id> -->` hex block, whitespace
 * removed. Same shape the simulator's catalog test parses; the guide's golden
 * blocks use a bare fence, the catalog's a `text` fence.
 */
function extractFrames(
  markdown: string,
  marker: "frame" | "golden",
): Record<string, string> {
  const blocks: Record<string, string> = {};
  const pattern = new RegExp(
    `<!-- ${marker}:([\\w-]+) -->\\n\`\`\`\\w*\\n([\\s\\S]*?)\\n\`\`\``,
    "g",
  );
  for (const [, id, body] of markdown.matchAll(pattern)) {
    blocks[id] = body.replace(/\s+/g, "").toLowerCase();
  }
  return blocks;
}

const upstream = upstreamPath();
try {
  await Deno.stat(`${upstream}/.git`);
} catch {
  fail(
    `no upstream checkout at ${upstream} (set HM_UPSTREAM_PATH to override)`,
  );
}

const sourcePaths = [
  ...MIRRORED,
  VECTORS_SOURCE,
  FRAME_SOURCES.catalog,
  FRAME_SOURCES.golden,
];
const dirty = await git(
  upstream,
  "status",
  "--porcelain",
  "--",
  ...sourcePaths,
);
if (dirty !== "" && !ALLOW_DIRTY) {
  fail(
    `upstream has uncommitted changes in mirrored paths:\n${dirty}\n` +
      `  commit them upstream first, or pass --allow-dirty (the manifest ` +
      `commit will then not describe the mirrored bytes)`,
  );
}
const commit = await git(upstream, "rev-parse", "HEAD");

const manifest: Manifest = {
  repo: UPSTREAM_REPO,
  commit,
  generatedAt: new Date().toISOString(),
  files: [],
};

for (const rel of MIRRORED) {
  const bytes = await Deno.readFile(`${upstream}/${rel}`);
  const path = `${VENDOR_ROOT}/${rel}`;
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeFile(path, bytes);
  manifest.files.push({ path, upstream: rel, sha256: await sha256(bytes) });
}

await Deno.mkdir("tests/fixtures", { recursive: true });

const vectors = await Deno.readFile(`${upstream}/${VECTORS_SOURCE}`);
await Deno.writeFile(FIXTURE_VECTORS, vectors);
manifest.files.push({
  path: FIXTURE_VECTORS,
  upstream: VECTORS_SOURCE,
  sha256: await sha256(vectors),
});

const frames = {
  catalog: extractFrames(
    await Deno.readTextFile(`${upstream}/${FRAME_SOURCES.catalog}`),
    "frame",
  ),
  golden: extractFrames(
    await Deno.readTextFile(`${upstream}/${FRAME_SOURCES.golden}`),
    "golden",
  ),
};
if (Object.keys(frames.catalog).length === 0) {
  fail(`no <!-- frame:… --> blocks found in ${FRAME_SOURCES.catalog}`);
}
const framesBytes = new TextEncoder().encode(
  JSON.stringify(frames, null, 2) + "\n",
);
await Deno.writeFile(FIXTURE_FRAMES, framesBytes);
manifest.files.push({
  path: FIXTURE_FRAMES,
  generatedFrom: [FRAME_SOURCES.catalog, FRAME_SOURCES.golden],
  sha256: await sha256(framesBytes),
});

await Deno.writeTextFile(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

console.log(
  `vendor:sync: mirrored ${MIRRORED.length} files + 2 fixtures from ` +
    `${UPSTREAM_REPO}@${commit.slice(0, 12)}${dirty ? " (DIRTY)" : ""}\n` +
    `  frames: ${Object.keys(frames.catalog).length} catalog, ` +
    `${Object.keys(frames.golden).length} golden`,
);
