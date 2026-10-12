import { assertEquals } from "@std/assert";
import { MANIFEST, type Manifest, sha256 } from "../scripts/vendor-common.ts";

/**
 * L1 of `deno task vendor:verify`, inside the suite as well: a hand edit to
 * `vendor/` or `tests/fixtures/` fails `deno task test` even where nobody runs
 * the verify task. Fix by changing upstream and running `vendor:sync`.
 */

const root = new URL("../", import.meta.url);

Deno.test("the vendored mirror and fixtures are unedited", async () => {
  const manifest: Manifest = JSON.parse(
    await Deno.readTextFile(new URL(MANIFEST, root)),
  );
  const edited: string[] = [];
  for (const file of manifest.files) {
    const bytes = await Deno.readFile(new URL(file.path, root));
    if (await sha256(bytes) !== file.sha256) edited.push(file.path);
  }
  assertEquals(edited, [], "vendor/ is a mirror — run deno task vendor:sync");
});
