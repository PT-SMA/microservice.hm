import { assertEquals } from "@std/assert";
import { codec } from "hour-meter";
import { hex } from "./_helpers.ts";

/**
 * The vendored codec runs here at all.
 *
 * It is CommonJS loaded through `createRequire` from a project whose
 * `deno.json` says `"nodeModulesDir": "none"`. Without `"unstable":
 * ["detect-cjs"]` Deno loads `index.js` as ESM and every import of the reader
 * dies with `ReferenceError: require is not defined` — so this is the first
 * thing that has to hold, before anything is built on the codec.
 *
 * The vectors are the codec's own (`sensorframe/test-vectors.json`). They are
 * compared by raw wire value: the vectors use the library's generic tag table
 * (tag 4 = temperature i16), not the firmware's (tag 4 = runHours u32), and
 * the codec takes each record's format from the wire, not the table.
 */

interface Vector {
  name: string;
  header: { msgType: number; seq: number; deviceId: number; timestamp: number };
  records: Array<{ tag: number; fmt: string; value: unknown }>;
  frameHex: string;
}

const VECTORS: Vector[] = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/sensorframe-test-vectors.json", import.meta.url),
  ),
);

/** A raw value in the vectors' JSON form (bytes as hex, 64-bit as strings). */
function asVectorValue(raw: unknown): unknown {
  if (raw instanceof Uint8Array) {
    return Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (typeof raw === "bigint") return raw.toString();
  return raw;
}

for (const vector of VECTORS) {
  Deno.test(`codec decodes the '${vector.name}' vector`, () => {
    const msg = codec.decodeFrame(hex(vector.frameHex)) as unknown as {
      msgType: number;
      seq: number;
      deviceId: number;
      timestamp: number;
      records: Array<{ tag: number; fmt: string; raw: unknown }>;
    };

    assertEquals(
      {
        msgType: msg.msgType,
        seq: msg.seq,
        deviceId: msg.deviceId,
        timestamp: msg.timestamp,
      },
      vector.header,
    );
    assertEquals(
      msg.records.map((r) => ({
        tag: r.tag,
        fmt: r.fmt,
        value: asVectorValue(r.raw),
      })),
      vector.records.map(({ tag, fmt, value }) => ({ tag, fmt, value })),
    );
  });
}

Deno.test("a frame with a flipped byte is rejected, not misread", () => {
  const frame = hex(VECTORS[0].frameHex);
  frame[8] ^= 0xff;
  let code: string | undefined;
  try {
    codec.decodeFrame(frame);
  } catch (err) {
    code = (err as { code?: string }).code;
  }
  assertEquals(code, "CRC");
});
