import { assert, assertEquals } from "@std/assert";
import { WT61_PROTOCOL_VERSION } from "consts";
import { parseWt61Line, parseWt61Url, toImuSampleFromWt61 } from "helpers";
import type { Wt61Sample } from "types";

/**
 * The wt61-driver → microservice.hm contract
 * (FMS-Backend/docs/ecosystem/integrations/wt61-driver-to-hm.md). The fixture
 * is byte-identical to wt61-driver's, whose own test proves the driver sends
 * exactly these lines for known serial bytes (`deno task wt61:verify`).
 */
const FIXTURE = new URL("./fixtures/wt61/stream-v1.ndjson", import.meta.url);
const lines = Deno.readTextFileSync(FIXTURE).split("\n").filter((l) =>
  l !== ""
);

Deno.test("every fixture line parses: hello, status, samples, status", () => {
  const messages = lines.map((l) => parseWt61Line(l));
  assert(messages.every((m) => m !== null), "a fixture line did not parse");
  assertEquals(messages.map((m) => m!.type), [
    "hello",
    "status",
    "sample",
    "sample",
    "sample",
    "sample",
    "status",
  ]);
  const hello = messages[0]!;
  assert(hello.type === "hello");
  assertEquals(hello.version, WT61_PROTOCOL_VERSION);
  assertEquals(hello.serial, "open");
  assertEquals(hello.baudRate, 115200);
  // the driver lost seq 3 (bad checksum) and 5 (acceleration packet lost)
  assertEquals(
    messages.filter((m) => m!.type === "sample").map((m) =>
      (m as Wt61Sample).seq
    ),
    [1, 2, 4, 6],
  );
  const last = messages.at(-1)!;
  assert(last.type === "status");
  assertEquals(
    [
      last.samples,
      last.checksumErrors,
      last.incompleteCycles,
      last.droppedBytes,
    ],
    [4, 1, 2, 17],
  );
});

Deno.test("a sample becomes the estimator's IMU sample: g and °/s, module frame, angles unused", () => {
  const atRest = parseWt61Line(lines[2]) as Wt61Sample;
  assertEquals(toImuSampleFromWt61(atRest), {
    accelG: { x: 0, y: 0, z: 1 },
    gyroDps: { x: 0, y: 0, z: 0 },
    missedFrames: 0,
  });
  const turning = parseWt61Line(lines[5]) as Wt61Sample;
  const imu = toImuSampleFromWt61(turning, 1);
  assertEquals(imu.accelG.x, 205 * 16 / 32768);
  assertEquals(imu.gyroDps.z, 98 * 2000 / 32768);
  assertEquals(imu.missedFrames, 1);
  // values are exact: the module's raw count comes back
  assertEquals(imu.gyroDps.z / (2000 / 32768), 98);
  // full scale and negatives survive
  const full = parseWt61Line(lines[4]) as Wt61Sample;
  assertEquals(full.accelG, { x: 15.99951171875, y: -16, z: 1 });
  assertEquals(full.angleDeg, { x: -180, y: 90, z: -90 });
  assertEquals(full.temperatureC, 33.65);
});

Deno.test("what is not a v1 message is ignored, never thrown", () => {
  const sample = JSON.parse(lines[2]);
  for (
    const bad of [
      "",
      "not json",
      "null",
      "[]",
      JSON.stringify({ type: "command", do: "zero" }),
      JSON.stringify({ ...sample, seq: -1 }),
      JSON.stringify({ ...sample, seq: 1.5 }),
      JSON.stringify({ ...sample, accelG: { x: 0, y: 0 } }),
      JSON.stringify({ ...sample, gyroDps: { x: "0", y: 0, z: 0 } }),
      JSON.stringify({ ...sample, gyroDps: null }),
      JSON.stringify({ ...sample, readAt: 5 }),
      JSON.stringify({ type: "status", at: "t", serial: "maybe" }),
      JSON.stringify({ type: "hello", version: "1", serial: "open" }),
    ]
  ) assertEquals(parseWt61Line(bad), null, bad);
  // unknown fields are fine; missing optional ones too
  const extra = parseWt61Line(
    JSON.stringify({ ...sample, angleDeg: undefined, magnetometer: {} }),
  ) as Wt61Sample;
  assertEquals(extra.seq, 1);
  assertEquals(extra.angleDeg, undefined);
  // another version still parses — the link is what refuses it
  assertEquals(
    parseWt61Line(JSON.stringify({ ...JSON.parse(lines[0]), version: 2 }))
      ?.type,
    "hello",
  );
});

Deno.test("WT61_URL is tcp://host:port", () => {
  assertEquals(parseWt61Url("tcp://127.0.0.1:6699"), {
    hostname: "127.0.0.1",
    port: 6699,
  });
  assertEquals(parseWt61Url("tcp://wt61.local:7000/"), {
    hostname: "wt61.local",
    port: 7000,
  });
  assertEquals(parseWt61Url("tcp://[::1]:6699"), {
    hostname: "::1",
    port: 6699,
  });
  for (
    const bad of [
      "127.0.0.1:6699",
      "http://127.0.0.1:6699",
      "tcp://127.0.0.1",
      "tcp://127.0.0.1:0",
      "tcp://127.0.0.1:70000",
      "/dev/ttyUSB0",
    ]
  ) assertEquals(parseWt61Url(bad), null, bad);
});
