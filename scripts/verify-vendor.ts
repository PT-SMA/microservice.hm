/**
 * Prove `vendor/hour-meter/` is still the upstream bytes it claims to be.
 *
 * L1 (always): every file in `UPSTREAM.json` hashes to its recorded sha256.
 *    A mismatch means someone edited the mirror here — run `vendor:sync`.
 * L2 (when an upstream checkout exists): every mirrored file equals
 *    `git show <pinned commit>:<path>` in that checkout, whatever branch it is
 *    on. Then, advisory only: how far upstream has moved on those paths.
 *
 * With no checkout (CI, the Docker build) L2 cannot run, and says so loudly.
 * Read the output, not the exit code: a skipped check that reports success is
 * the failure mode `FMS-Backend/docs/ecosystem/glossary/naming-rules.md` warns
 * about. `--strict` turns a skip into a failure.
 */

import {
  MANIFEST,
  type Manifest,
  sha256,
  UPSTREAM_REPO,
  upstreamPath,
} from "./vendor-common.ts";

const STRICT = Deno.args.includes("--strict");

function fail(message: string): never {
  console.error(`vendor:verify: FAIL — ${message}`);
  Deno.exit(1);
}

function skip(message: string): void {
  console.warn(`vendor:verify: L2 SKIPPED — ${message}`);
  if (STRICT) Deno.exit(1);
}

async function git(
  upstream: string,
  ...args: string[]
): Promise<{ ok: boolean; stdout: Uint8Array }> {
  const out = await new Deno.Command("git", {
    args: ["-C", upstream, ...args],
    stdout: "piped",
    stderr: "null",
  }).output();
  return { ok: out.code === 0, stdout: out.stdout };
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();

const manifest: Manifest = JSON.parse(
  await Deno.readTextFile(MANIFEST).catch(() =>
    fail(`cannot read ${MANIFEST} — run deno task vendor:sync`)
  ),
);

// L1 — the mirror was not edited here.
const edited: string[] = [];
for (const file of manifest.files) {
  const bytes = await Deno.readFile(file.path).catch(() => null);
  if (bytes === null) edited.push(`${file.path} (missing)`);
  else if (await sha256(bytes) !== file.sha256) edited.push(file.path);
}
if (edited.length > 0) {
  fail(
    `vendored files differ from ${MANIFEST}:\n  ${edited.join("\n  ")}\n` +
      `  vendor/ is a mirror — never edit it here. Change it upstream in ` +
      `${UPSTREAM_REPO}, then run deno task vendor:sync`,
  );
}
console.log(`vendor:verify: L1 ok — ${manifest.files.length} files unedited`);

// L2 — the mirror is the pinned upstream commit.
const upstream = upstreamPath();
const pinned = manifest.commit;
const short = pinned.slice(0, 12);
const hasCheckout = await Deno.stat(`${upstream}/.git`).then(() => true)
  .catch(() => false);

if (!hasCheckout) {
  skip(`no upstream checkout at ${upstream} (set HM_UPSTREAM_PATH)`);
} else if (!(await git(upstream, "cat-file", "-e", `${pinned}^{commit}`)).ok) {
  skip(`pinned commit ${short} is not in ${upstream} — git fetch there`);
} else {
  const drifted: string[] = [];
  for (const file of manifest.files) {
    if (file.upstream === undefined) continue; // generated fixture: L1 only
    const shown = await git(upstream, "show", `${pinned}:${file.upstream}`);
    if (!shown.ok || await sha256(shown.stdout) !== file.sha256) {
      drifted.push(file.upstream);
    }
  }
  if (drifted.length > 0) {
    fail(
      `mirror ≠ ${UPSTREAM_REPO}@${short}:\n  ${drifted.join("\n  ")}\n` +
        `  the manifest was synced from uncommitted upstream bytes ` +
        `(--allow-dirty) or hand-edited; run deno task vendor:sync`,
    );
  }
  console.log(`vendor:verify: mirror matches ${UPSTREAM_REPO}@${short}`);

  const paths = manifest.files.flatMap((f) =>
    f.upstream ? [f.upstream] : f.generatedFrom ?? []
  );
  const ahead = text(
    (await git(upstream, "log", "--oneline", `${pinned}..HEAD`, "--", ...paths))
      .stdout,
  );
  if (ahead !== "") {
    const n = ahead.split("\n").length;
    console.warn(
      `vendor:verify: note — upstream is ${n} commit(s) ahead on vendored ` +
        `paths; review and run deno task vendor:sync when ready:\n${ahead}`,
    );
  }
}
