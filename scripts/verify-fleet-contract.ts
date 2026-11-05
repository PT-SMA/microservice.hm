/**
 * Checks this repo's copy of the fleet wire contract (docs/FLEET_CONTRACT.md and
 * docs/fleet-contract.manifest.json): `deno task fleet-contract:verify`, run in CI.
 *
 * The canonical contract lives in FMS-Backend, which owns it; the copy here is written only by
 * `yarn fleet-contract:sync` there. **Never edit the copy.** To change the contract, edit
 * FMS-Backend/docs/FLEET_CONTRACT.md, bump its version, then `yarn fleet-contract:stamp` and
 * `yarn fleet-contract:sync` in FMS-Backend.
 *
 * Checks:
 *   1. The document's sha256 is the one its manifest records, so the copy was not edited.
 *   2. The version marker matches the manifest, and §Changelog has an entry for it.
 *   3. When FMS-Backend is checked out beside this repo (or FLEET_CONTRACT_CANONICAL names
 *      its docs/FLEET_CONTRACT.md), the copy is byte-identical to it, so it is not stale.
 *      Pass --no-canonical to skip this check.
 *
 * This file is byte-identical in geofencer, microservice.tracker, microservice.hm and
 * microservice.gps.
 */

const DOC = "docs/FLEET_CONTRACT.md";
const MANIFEST = "docs/fleet-contract.manifest.json";
const DEFAULT_CANONICAL = "../FMS-Backend/docs/FLEET_CONTRACT.md";

const MARKER = /^<!-- fleet-contract:version (\d+\.\d+\.\d+) -->$/m;

async function sha256(bytes: Uint8Array): Promise<string> {
  // a copy, so the buffer is a plain ArrayBuffer as subtle.digest's type wants
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
  );
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return `sha256:${hex}`;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

async function readOrNull(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function main(): Promise<number> {
  const problems: string[] = [];

  const doc = await readOrNull(DOC);
  const manifestBytes = await readOrNull(MANIFEST);

  if (!doc || !manifestBytes) {
    console.error(
      `fleet-contract: ${DOC} or ${MANIFEST} is missing; run \`yarn fleet-contract:sync\` in FMS-Backend`,
    );
    return 1;
  }

  const text = new TextDecoder().decode(doc);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  const version = text.match(MARKER)?.[1];

  if (manifest.document?.sha256 !== await sha256(doc)) {
    problems.push(
      `${DOC} is not the document its manifest records: it was edited here. ` +
        "Never edit this copy; change FMS-Backend/docs/FLEET_CONTRACT.md and sync it.",
    );
  }

  if (!version) {
    problems.push(`${DOC} has no <!-- fleet-contract:version X.Y.Z --> marker`);
  } else {
    if (version !== manifest.contractVersion) {
      problems.push(
        `the marker says ${version} but the manifest records ${manifest.contractVersion}`,
      );
    }

    if (
      !new RegExp(`^### ${version.replaceAll(".", "\\.")}(\\s|$)`, "m").test(
        text,
      )
    ) {
      problems.push(`§Changelog has no "### ${version}" entry`);
    }
  }

  if (!Deno.args.includes("--no-canonical")) {
    const canonicalPath = Deno.env.get("FLEET_CONTRACT_CANONICAL") ??
      DEFAULT_CANONICAL;
    const canonical = await readOrNull(canonicalPath);

    if (!canonical) {
      console.log(
        `fleet-contract: ${canonicalPath} not found, staleness not checked`,
      );
    } else if (!sameBytes(doc, canonical)) {
      problems.push(
        `${DOC} differs from ${canonicalPath}: this copy is stale. ` +
          "Run `yarn fleet-contract:sync` in FMS-Backend.",
      );
    }
  }

  if (problems.length > 0) {
    console.error("fleet-contract:");
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  console.log(`fleet-contract: ${DOC} ${version} is an intact copy`);
  return 0;
}

Deno.exit(await main());
