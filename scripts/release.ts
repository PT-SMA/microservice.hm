/**
 * Cut a release: check it is safe, say what is missing, bump, commit.
 *
 * The ecosystem's rules (FMS-Backend/docs/ecosystem/versioning.md) put changesets
 * in charge of the narrative and leave everything around it to a human:
 * `"commit": false` in every `.changeset/config.json`, so nothing is staged for
 * you; the release commit subject is fixed at `chore: bump version X.Y.Z`; and
 * changesets is "used as a version + changelog generator, **never to publish**".
 *
 * This script is that manual procedure, with the three checks that would have
 * caught real failures already sitting in these repos:
 *
 *   1. `deno.json` must not carry a version. It used to mirror `package.json`,
 *      and the mirror drifted twice — most recently a release bumped `deno.json`
 *      to 0.3.3 while `package.json` stayed 0.3.2, so the index route, which
 *      reads `package.json`, kept reporting the old number. The key is gone; this
 *      fails if it comes back.
 *   2. Every pending changeset must name the package in `package.json`. Eight of
 *      microservice.route-topology's nine named a package that does not exist, so
 *      `changeset version` could not have consumed them.
 *   3. Every pending changeset must carry a `Docs:` line. `docs/README.md` admits
 *      this gate is manual today ("the gate is the changeset's `Docs:` line at
 *      review time"); it costs nothing to assert it here.
 *
 * It also reports what shipped **without** a changeset, since the last commit that
 * touched `CHANGELOG.md`. That is how geofencer's changelog fell two minor
 * versions behind, and the current remedy is a hand-written "Record shipped work
 * that predates changeset versioning" entry — needed in four repos so far.
 *
 * It does not tag, push, or publish. There are no tags anywhere in this ecosystem
 * and nothing reacts to one, so creating them would be new policy rather than
 * conformance.
 *
 * Usage:
 *   deno task release --dry-run           # print everything, change nothing
 *   deno task release                     # refuse if commits are uncovered
 *   deno task release --accept-uncovered  # list them in the changelog instead
 */

const DRY_RUN = Deno.args.includes("--dry-run");
const ACCEPT_UNCOVERED = Deno.args.includes("--accept-uncovered");

const PKG = "package.json";
const CHANGESET_DIR = ".changeset";

function fail(message: string): never {
  console.error(`release: ${message}`);
  Deno.exit(1);
}

function step(message: string): void {
  console.log(`\n\x1b[1m${message}\x1b[0m`);
}

async function run(
  cmd: string[],
  { quiet = false } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const out = new TextDecoder().decode(stdout);
  const err = new TextDecoder().decode(stderr);
  if (!quiet && out.trim()) console.log(out.trimEnd());
  return { code, stdout: out, stderr: err };
}

async function git(...args: string[]): Promise<string> {
  const { code, stdout, stderr } = await run(["git", ...args], { quiet: true });
  if (code !== 0) fail(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim();
}

// ---------------------------------------------------------------- preflight

step("1. Preflight");

const dirty = await git("status", "--porcelain");
if (dirty !== "" && !DRY_RUN) {
  fail(
    "the working tree is dirty. A release commit should contain the bump and " +
      "nothing else:\n" + dirty.split("\n").map((l) => `    ${l}`).join("\n"),
  );
}
console.log(`  working tree: ${dirty === "" ? "clean" : "dirty (dry run)"}`);

const pkg = JSON.parse(await Deno.readTextFile(PKG));
const pkgName: string = pkg.name;
const pkgVersion: string = pkg.version;
if (typeof pkgName !== "string" || typeof pkgVersion !== "string") {
  fail(`${PKG} needs both "name" and "version"`);
}
console.log(`  package:      ${pkgName}@${pkgVersion}`);

// The version files must already agree. `version-packages` runs the same sync
// afterwards, but a *pre-existing* drift is somebody's unmade decision.
const sync = await run(
  ["deno", "run", "--allow-read", "scripts/verify-version.ts"],
  { quiet: true },
);
if (sync.code !== 0) {
  fail(
    "deno.json carries a version key again, which is a decision, " +
      "not something a release should overwrite:\n    " +
      (sync.stderr || sync.stdout).trim(),
  );
}
console.log("  versions:     package.json is the only source");

// ------------------------------------------------------- changeset validation

step("2. Pending changesets");

const changesets: { file: string; body: string }[] = [];
for await (const entry of Deno.readDir(CHANGESET_DIR)) {
  if (!entry.isFile || !entry.name.endsWith(".md")) continue;
  if (entry.name === "README.md") continue;
  changesets.push({
    file: entry.name,
    body: await Deno.readTextFile(`${CHANGESET_DIR}/${entry.name}`),
  });
}

if (changesets.length === 0) {
  fail("no pending changesets — there is nothing to release.");
}

const problems: string[] = [];
for (const { file, body } of changesets) {
  const front = body.match(/^---\n([\s\S]*?)\n---/);
  if (front === null) {
    problems.push(`${file}: no front matter`);
    continue;
  }
  // Every declared package must be this one. A name that is not in package.json
  // cannot be resolved by `changeset version`.
  const names = [...front[1].matchAll(/^\s*"([^"]+)"\s*:/gm)].map((m) => m[1]);
  for (const name of names) {
    if (name !== pkgName) {
      problems.push(
        `${file}: names "${name}", but package.json says "${pkgName}"`,
      );
    }
  }
  if (!/^Docs:/m.test(body)) {
    problems.push(
      `${file}: no "Docs:" line (updated <path>, or none — <reason>)`,
    );
  }
}

if (problems.length > 0) {
  fail(
    `${problems.length} problem(s) in ${CHANGESET_DIR}:\n` +
      problems.map((p) => `    ${p}`).join("\n"),
  );
}
console.log(`  ${changesets.length} changeset(s), all valid`);

// ------------------------------------------------- commits without a changeset

step("3. What shipped without a changeset");

// No tags exist anywhere in this ecosystem, so the last release is anchored on
// the last commit that touched CHANGELOG.md.
const since = await git("log", "-1", "--format=%H", "--", "CHANGELOG.md");
const range = since === "" ? "HEAD" : `${since}..HEAD`;

// ASCII unit/record separators: a commit body containing a blank line would
// split one commit into two under the obvious \n\n delimiter.
const RS = "\x1e";
const raw = await git(
  "log",
  "--first-parent",
  `--format=%s%x1e`,
  range,
);
const subjects = raw.split(RS).map((s) => s.trim()).filter((s) => s !== "");

// Conventional-ish. This ecosystem also uses `feat(fix):` to mean a fix, plus
// `api:`, `version:`, `contract:`, `docker(fix):` — so anything unmatched is
// *listed*, never dropped. Silently discarding a fifth of the history is how the
// changelog fell behind in the first place.
const CONVENTIONAL =
  /^(?<type>[a-z]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?:\s*(?<desc>.+)$/;
const RELEASE_SUBJECT = /^chore: bump version /;

const summaries = changesets.map(({ body }) =>
  body.replace(/^---[\s\S]*?---\s*/, "").split("\n")[0].trim().toLowerCase()
);

const uncovered = subjects.filter((subject) => {
  if (RELEASE_SUBJECT.test(subject)) return false;
  if (/^Merge /.test(subject)) return false;
  const desc = CONVENTIONAL.exec(subject)?.groups?.desc?.toLowerCase() ??
    subject.toLowerCase();
  // Covered if some changeset summary reads like this commit subject. The
  // versioning doc asks for exactly that: "the changeset summary and the commit
  // subject should read the same".
  return !summaries.some((s) =>
    s === desc || s.includes(desc.slice(0, 30)) || desc.includes(s.slice(0, 30))
  );
});

console.log(`  range:        ${range}`);
console.log(`  commits:      ${subjects.length}`);
if (uncovered.length === 0) {
  console.log("  uncovered:    none — every commit maps to a changeset");
} else {
  console.log(`  uncovered:    ${uncovered.length}`);
  for (const s of uncovered) console.log(`    - ${s}`);
  if (!ACCEPT_UNCOVERED) {
    fail(
      "those commits have no changeset. Write one (the summary should read like\n" +
        "  the commit subject), or re-run with --accept-uncovered to list them in\n" +
        "  the changelog as-is.",
    );
  }
}

// ------------------------------------------------------------------- release

step("4. Release");

if (DRY_RUN) {
  console.log("  --dry-run: stopping here. Nothing was changed.");
  console.log("  would run: deno task version-packages");
  console.log("             deno task verify:version");
  console.log(`             git commit -m "chore: bump version <new>"`);
  Deno.exit(0);
}

const version = await run(["deno", "task", "version-packages"]);
if (version.code !== 0) {
  fail(`version-packages failed:\n${version.stderr}`);
}

const verify = await run(
  ["deno", "run", "--allow-read", "scripts/verify-version.ts"],
  { quiet: true },
);
if (verify.code !== 0) {
  fail(`versions disagree after the bump:\n    ${verify.stderr.trim()}`);
}

const newVersion: string = JSON.parse(await Deno.readTextFile(PKG)).version;
console.log(`  ${pkgVersion} -> ${newVersion}`);

if (ACCEPT_UNCOVERED && uncovered.length > 0) {
  // Appended to the entry `changeset version` just wrote, so the changelog says
  // what shipped even where nobody wrote a changeset for it.
  const changelog = await Deno.readTextFile("CHANGELOG.md");
  const marker = `## ${newVersion}\n`;
  const at = changelog.indexOf(marker);
  if (at !== -1) {
    const insert = at + marker.length;
    const block = "\n### Also in this release\n\n" +
      "Commits without a changeset, recorded verbatim:\n\n" +
      uncovered.map((s) => `- ${s}`).join("\n") + "\n";
    await Deno.writeTextFile(
      "CHANGELOG.md",
      changelog.slice(0, insert) + block + changelog.slice(insert),
    );
    console.log(
      `  recorded ${uncovered.length} uncovered commit(s) in CHANGELOG.md`,
    );
  }
}

// -------------------------------------------------------------------- commit

step("5. Commit");

await git("add", "-A");
await git("commit", "-m", `chore: bump version ${newVersion}`);
console.log(`  committed: chore: bump version ${newVersion}`);

console.log(`
Not done, deliberately — no tag, no push, no publish. There are no tags in this
ecosystem and nothing reacts to one, and every package is private. When you are
ready:

    git push origin $(git rev-parse --abbrev-ref HEAD)
`);
