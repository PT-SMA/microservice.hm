import { assert, assertEquals } from "@std/assert";
import { MainApp } from "app";
import { HM_CHANNELS } from "consts";
import { parseImuSource, toHourMeterUpdate } from "helpers";
import { linkPair } from "hour-meter";
import { EventEmitter } from "node:events";
import { Wt61Link } from "sensors";
import { catalogFrame, decodeCatalog, sleep } from "./_helpers.ts";

/**
 * HOUR_METER_IMU_SOURCE: one IMU — the hour meter's (`hm`) or a WT61 through
 * wt61-driver (`wit`) — for the travel direction, `hour-meter:imu`, and
 * `rollDeg`/`pitchDeg` on `hour-meter:update`. Heading and vibration stay the
 * hour meter's: the WT61 has no compass and filters vibration out.
 */

const ctx = { uuid: "u", now: Date.parse("2026-10-29T08:00:00Z") };
const FIXTURE = Deno.readTextFileSync(
  new URL("./fixtures/wt61/stream-v1.ndjson", import.meta.url),
).split("\n").filter((l) => l !== "");
const HELLO_AND_STATUS = FIXTURE.slice(0, 2).join("\n") + "\n";
const sample = (seq: number, roll: number, pitch: number) =>
  JSON.stringify({
    ...JSON.parse(FIXTURE[2]),
    seq,
    angleDeg: { x: roll, y: pitch, z: 40 },
  }) + "\n";

Deno.test("HOUR_METER_IMU_SOURCE is hm or wit (or the wire's own names)", () => {
  assertEquals(parseImuSource("hm"), "hour-meter");
  assertEquals(parseImuSource(" WIT "), "wt61");
  assertEquals(parseImuSource("hour-meter"), "hour-meter");
  assertEquals(parseImuSource("wt61"), "wt61");
  for (const bad of ["", "both", "imu", "wit61"]) {
    assertEquals(parseImuSource(bad), null, bad);
  }
});

Deno.test("with wit, roll and pitch are the WT61's; heading and vibration stay the hour meter's", () => {
  const update = toHourMeterUpdate(decodeCatalog("telemetry"), {
    ...ctx,
    imu: {
      source: "wt61",
      wt61Attitude: { rollDeg: 1.2345, pitchDeg: -0.004 },
    },
  })!;
  assertEquals(
    [update.rollDeg, update.pitchDeg, update.imuSource],
    [1.23, 0, "wt61"],
  );
  assertEquals(
    [update.headingDeg, update.vibRmsMg, update.vibPeakMg],
    [33.5, 37, 103],
  );
});

Deno.test("with wit and no fresh WT61 sample, roll and pitch are left out — never the hour meter's", () => {
  const update = toHourMeterUpdate(decodeCatalog("telemetry"), {
    ...ctx,
    imu: { source: "wt61", wt61Attitude: null },
  })!;
  for (const field of ["rollDeg", "pitchDeg", "imuSource"]) {
    assert(!(field in update), field);
  }
  assertEquals(update.headingDeg, 33.5);
});

Deno.test("with hm (the default), roll and pitch are TELEMETRY's, named as such", () => {
  for (const imu of [undefined, { source: "hour-meter" as const }]) {
    const update = toHourMeterUpdate(decodeCatalog("telemetry"), {
      ...ctx,
      imu,
    })!;
    assertEquals(
      [update.rollDeg, update.pitchDeg, update.imuSource],
      [2.5, -0.48, "hour-meter"],
    );
  }
  const noImu = toHourMeterUpdate(decodeCatalog("telemetry-no-imu"), ctx)!;
  assert(!("imuSource" in noImu), "no roll or pitch, no imuSource");
});

/** A wt61-driver that greets, then streams `samples` 10 ms apart. */
function fakeDriver(samples: string[]) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const conns: Deno.Conn[] = [];
  const served = (async () => {
    for await (const conn of listener) {
      conns.push(conn);
      void (async () => {
        const enc = new TextEncoder();
        await conn.write(enc.encode(HELLO_AND_STATUS));
        for (const line of samples) {
          await conn.write(enc.encode(line));
          await sleep(10);
        }
      })().catch(() => {});
    }
  })();
  return {
    url: `tcp://127.0.0.1:${(listener.addr as Deno.NetAddr).port}`,
    close: async () => {
      listener.close();
      for (const c of conns) {
        try {
          c.close();
        } catch { /* closed */ }
      }
      await served.catch(() => {});
    },
  };
}

async function until(done: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(10);
  }
}

Deno.test("the WT61's attitude is offered only while it is fresh", async () => {
  const driver = fakeDriver([sample(1, 3, -4)]);
  let skew = 0;
  const link = new Wt61Link(new EventEmitter(), {
    url: driver.url,
    now: () => Date.now() + skew,
  });
  try {
    assertEquals(link.attitude(), null);
    link.start();
    await until(() => link.attitude() !== null);
    assertEquals(link.attitude(), { rollDeg: 3, pitchDeg: -4 });
    skew = 1500;
    assertEquals(link.attitude(), null, "1.5 s old");
    assertEquals(link.attitude(2000), { rollDeg: 3, pitchDeg: -4 });
  } finally {
    await link.stop();
    await driver.close();
  }
});

function app(
  imuSource: string,
  options: { url?: string; direction?: boolean } = {},
) {
  const [host, device] = linkPair();
  const published: Array<[string, string]> = [];
  const main = new MainApp({
    publisher: {
      publish: (channel, message) => {
        published.push([channel, message]);
        return Promise.resolve(1);
      },
      replaceHash: () => Promise.resolve(1),
      mergeHash: () => Promise.resolve(1),
    },
    redis: {
      connect: () => Promise.resolve(),
      subscribe: () => Promise.resolve(),
      status: () => ({
        connected: true,
        pubConnected: true,
        subConnected: true,
      }),
    },
    sensor: {
      target: "tcp://fake:1",
      open: () => Promise.resolve(host),
      timeSync: false,
      staleMs: 60_000,
    },
    direction: {
      enabled: options.direction ?? false,
      forwardAxis: "+x",
      tickMs: null,
    },
    imuSource,
    wt61: options.url ? { url: options.url } : {},
    imuHz: 10,
  });
  const health = async () =>
    await (await main.fetch(new Request("http://x/health"))).json();
  return { main, device, published, health };
}

Deno.test("wit: the WT61 is read and broadcast even with travel direction off, and its roll/pitch reach hour-meter:update", async () => {
  const lines = Array.from(
    { length: 150 },
    (_, i) => sample(i + 1, 1.25, -2.5),
  );
  const driver = fakeDriver(lines);
  const { main, device, published, health } = app("wit", {
    url: driver.url,
  });
  try {
    await until(() => (main.wt61?.health().samples ?? 0) > 20);
    await device.write(catalogFrame("telemetry"));
    await until(() => published.some(([c]) => c === HM_CHANNELS.update));
    const [, raw] = published.find(([c]) => c === HM_CHANNELS.update)!;
    const update = JSON.parse(raw);
    assertEquals(
      [update.rollDeg, update.pitchDeg, update.imuSource],
      [1.25, -2.5, "wt61"],
    );
    assertEquals(update.headingDeg, 33.5, "the hour meter's compass");

    await until(() => published.some(([c]) => c === HM_CHANNELS.imu));
    const imu = JSON.parse(published.find(([c]) => c === HM_CHANNELS.imu)![1]);
    assertEquals(imu.source, "wt61");

    const body = await health();
    assertEquals(body.imuSource, "wt61");
    assert(!("direction" in body), "travel direction stays off");
    assertEquals(body.wt61.usable, true);
  } finally {
    await main.stop();
    await driver.close();
  }
});

Deno.test("hm: the hour meter's IMU is broadcast, and a WT61_URL is not read", async () => {
  const driver = fakeDriver([]);
  const { main, health } = app("hm", { url: driver.url, direction: true });
  try {
    await sleep(30);
    assertEquals(main.wt61, undefined);
    assertEquals(main.imu?.source, "hour-meter");
    const body = await health();
    assertEquals(body.imuSource, "hour-meter");
    assertEquals(body.direction.imuSource, "hour-meter");
    assert(!("wt61" in body));
  } finally {
    await main.stop();
    await driver.close();
  }
});

Deno.test("a value that is neither leaves no IMU and no travel direction; the hour meter goes on", async () => {
  const { main, device, published, health } = app("both", { direction: true });
  try {
    await sleep(30);
    assertEquals([main.imu, main.direction, main.wt61], [
      undefined,
      undefined,
      undefined,
    ]);
    const body = await health();
    assert(!("imuSource" in body) && !("direction" in body));
    await device.write(catalogFrame("telemetry"));
    await until(() => published.some(([c]) => c === HM_CHANNELS.update));
    const update = JSON.parse(
      published.find(([c]) => c === HM_CHANNELS.update)![1],
    );
    assertEquals(update.rollDeg, 2.5, "TELEMETRY's, as without the switch");
  } finally {
    await main.stop();
  }
});
