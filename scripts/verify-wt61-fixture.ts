/**
 * The WT61 contract fixture must be one file in two repos:
 *   wt61-driver/tests/fixtures/wt61-stream-v1.ndjson — what the driver must send
 *   tests/fixtures/wt61/stream-v1.ndjson             — what this parser reads
 * Contract: FMS-Backend/docs/ecosystem/integrations/wt61-driver-to-hm.md.
 *
 *   deno task wt61:verify      (WT61_DRIVER_PATH overrides ../wt61-driver)
 *
 * Without the sibling repo (CI) it says so and passes: the hermetic suite
 * still checks this copy against the parser.
 */
const LOCAL = new URL(
  "../tests/fixtures/wt61/stream-v1.ndjson",
  import.meta.url,
);
const driverRoot = Deno.env.get("WT61_DRIVER_PATH") ??
  new URL("../../wt61-driver", import.meta.url).pathname;
const UPSTREAM = `${driverRoot}/tests/fixtures/wt61-stream-v1.ndjson`;

const sha = async (bytes: Uint8Array<ArrayBuffer>) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("").slice(0, 12);

const local = await Deno.readFile(LOCAL);
let upstream: Uint8Array<ArrayBuffer>;
try {
  upstream = await Deno.readFile(UPSTREAM);
} catch {
  console.log(
    `wt61:verify: ${UPSTREAM} not found — skipped (local copy ${await sha(
      local,
    )})`,
  );
  Deno.exit(0);
}
const [a, b] = [await sha(local), await sha(upstream)];
if (a !== b) {
  console.error(
    `wt61:verify: the fixture differs from wt61-driver's (${a} here, ${b} there).\n` +
      `  If the driver changed on purpose: review the contract doc, then\n` +
      `  cp ${UPSTREAM} tests/fixtures/wt61/stream-v1.ndjson`,
  );
  Deno.exit(1);
}
console.log(`wt61:verify: fixture matches wt61-driver (${a})`);
