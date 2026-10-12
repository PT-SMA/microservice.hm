/**
 * One file holds the version, and this asserts it stays that way.
 *
 * `package.json` is the source of truth: `@changesets/cli` can only read and
 * write a `package.json` with `name` + `version`, and the runtime already
 * imports it — `src/app.ts` imports `../package.json` with a strict JSON import
 * precisely because `deno.json` is JSONC and importing *that* took
 * `microservice.tracker` down completely once.
 *
 * `deno.json` used to carry a mirrored copy, kept in step by a sync script and
 * gated in CI. It drifted anyway, twice: once after a merge, and once when a
 * release was bumped by editing `deno.json` — the file that *looks* canonical
 * for a Deno service — leaving the index route reporting the old number from
 * `package.json`. The tooling was correct and the ergonomics beat it.
 *
 * So the mirror is gone. Nothing reads `deno.json`'s version at runtime, and
 * none of these repos publish to JSR (no `name`, no `exports`), which is what
 * made the key vestigial in the first place. This script now fails if anyone
 * puts it back — a duplicate that cannot be created cannot drift.
 *
 * Usage (both forms behave identically; `--check` is kept so CI configs and
 * habits that pass it keep working):
 *
 *   deno run --allow-read scripts/verify-version.ts
 *   deno run --allow-read scripts/verify-version.ts --check
 */

const PKG = "package.json";
const DENO = "deno.json";

/** A top-level `"version": "…"` line — the shape the mirror used to take. */
const VERSION_LINE = /^(\s*)"version"\s*:\s*"([^"]*)"/m;

const fail = (message: string): never => {
  console.error(`verify-version: ${message}`);
  Deno.exit(1);
};

const pkgRaw = await Deno.readTextFile(PKG).catch(() =>
  fail(`cannot read ${PKG} — it is the changesets manifest and must exist`)
);

let pkgVersion: string;
try {
  const parsed = JSON.parse(pkgRaw) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version === "") {
    fail(
      `${PKG} has no "version" string; changesets cannot version this package`,
    );
  }
  pkgVersion = parsed.version as string;
} catch (error) {
  fail(`${PKG} is not valid JSON: ${(error as Error).message}`);
}

const denoRaw = await Deno.readTextFile(DENO).catch(() => "");
const stray = denoRaw.match(VERSION_LINE);

if (stray !== null) {
  fail(
    `${DENO} carries a "version" key (${stray[2]}).\n` +
      `  ${PKG} is the only source of truth — the runtime reads it and changesets ` +
      `writes it.\n` +
      `  A second copy drifts: this exact key once said 0.3.3 while ${PKG} said ` +
      `0.3.2, so the\n` +
      `  bump never reached the index route. Delete the line from ${DENO}.\n` +
      `  To release, run: deno task release`,
  );
}

console.log(`verify-version: ${pkgVersion!} (${PKG} is the only source)`);
