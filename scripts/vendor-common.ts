/** Shared by `vendor-sync.ts` and `verify-vendor.ts`; see the former. */

export const UPSTREAM_REPO = "embedded-totalizer-hour-meter";
export const VENDOR_ROOT = "vendor/hour-meter";
export const MANIFEST = `${VENDOR_ROOT}/UPSTREAM.json`;
export const FIXTURE_FRAMES = "tests/fixtures/frames.json";
export const FIXTURE_VECTORS = "tests/fixtures/sensorframe-test-vectors.json";

/**
 * Upstream paths mirrored byte-identical under `VENDOR_ROOT`. The four
 * configurator files import only each other and `../../sensorframe/js/`.
 */
export const MIRRORED = [
  "sensorframe/js/package.json",
  "sensorframe/js/index.js",
  "sensorframe/js/index.d.ts",
  "sensorframe/js/src/cobs.js",
  "sensorframe/js/src/codec.js",
  "sensorframe/js/src/constants.js",
  "sensorframe/js/src/crc16.js",
  "sensorframe/js/src/errors.js",
  "sensorframe/js/src/formats.js",
  "sensorframe/js/src/stream.js",
  "configurator/src/links.ts",
  "configurator/src/sensorframe.ts",
  "configurator/src/device.ts",
  "configurator/src/tags.ts",
] as const;

export interface ManifestFile {
  /** Path in this repo. */
  path: string;
  /** Path in the upstream repo, for files copied verbatim. */
  upstream?: string;
  /** Upstream docs a generated fixture was extracted from. */
  generatedFrom?: string[];
  sha256: string;
}

export interface Manifest {
  repo: string;
  commit: string;
  generatedAt: string;
  files: ManifestFile[];
}

export function upstreamPath(): string {
  return Deno.env.get("HM_UPSTREAM_PATH") ?? `../${UPSTREAM_REPO}`;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
