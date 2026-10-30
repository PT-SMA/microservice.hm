import { assert, assertEquals } from "@std/assert";
import { WT61_EVENTS } from "consts";
import { EventEmitter } from "node:events";
import { Wt61Link } from "sensors";
import type { Wt61Sample } from "types";
import { sleep } from "./_helpers.ts";

/**
 * The TCP link against a fake wt61-driver on 127.0.0.1 (the hermetic suite's
 * only network permission). What the driver sends is the fixture's shape.
 */

const FIXTURE = Deno.readTextFileSync(
  new URL("./fixtures/wt61/stream-v1.ndjson", import.meta.url),
).split("\n").filter((l) => l !== "");
const HELLO = FIXTURE[0];
const STATUS_OPEN = FIXTURE[1];
const sampleLine = (seq: number) =>
  JSON.stringify({ ...JSON.parse(FIXTURE[2]), seq });
const statusLine = (serial: "open" | "closed", error?: string) =>
  JSON.stringify({
    ...JSON.parse(STATUS_OPEN),
    serial,
    ...(error ? { error } : {}),
  });

/** A fake driver: every connection runs `script(conn)`. */
function fakeDriver(script: (conn: Deno.Conn, n: number) => Promise<void>) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const conns: Deno.Conn[] = [];
  let n = 0;
  const done = (async () => {
    for await (const conn of listener) {
      conns.push(conn);
      void script(conn, ++n).catch(() => {});
    }
  })();
  return {
    url: `tcp://127.0.0.1:${(listener.addr as Deno.NetAddr).port}`,
    connections: () => n,
    close: async () => {
      listener.close();
      for (const c of conns) {
        try {
          c.close();
        } catch { /* closed */ }
      }
      await done.catch(() => {});
    },
  };
}

const send = (conn: Deno.Conn, ...lines: string[]) =>
  conn.write(new TextEncoder().encode(lines.map((l) => l + "\n").join("")));

function watch(emitter: EventEmitter) {
  const samples: { seq: number; missedFrames: number }[] = [];
  const link: [boolean, string | undefined][] = [];
  emitter.on(
    WT61_EVENTS.sample,
    (s: Wt61Sample, ctx: { missedFrames: number }) =>
      samples.push({ seq: s.seq, missedFrames: ctx.missedFrames }),
  );
  emitter.on(
    WT61_EVENTS.link,
    (usable: boolean, reason?: string) => link.push([usable, reason]),
  );
  return { samples, link };
}

async function until(done: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(10);
  }
}

Deno.test("hello, then samples: events carry the cycles the driver lost", async () => {
  const driver = fakeDriver(async (conn) => {
    await send(conn, HELLO, STATUS_OPEN);
    // split mid-line: lines are reassembled
    const text = [1, 2, 4, 5, 9].map(sampleLine).join("\n") + "\n";
    await conn.write(new TextEncoder().encode(text.slice(0, 50)));
    await sleep(20);
    await conn.write(new TextEncoder().encode(text.slice(50)));
  });
  const emitter = new EventEmitter();
  const seen = watch(emitter);
  const link = new Wt61Link(emitter, { url: driver.url, reconnectDelayMs: 50 });
  try {
    link.start();
    await until(() => seen.samples.length === 5);
    assertEquals(seen.samples, [
      { seq: 1, missedFrames: 0 },
      { seq: 2, missedFrames: 0 },
      { seq: 4, missedFrames: 1 },
      { seq: 5, missedFrames: 0 },
      { seq: 9, missedFrames: 3 },
    ]);
    assertEquals(seen.link, [[true, undefined]]);
    const h = link.health();
    assertEquals(
      [h.state, h.usable, h.serial, h.samples, h.missedFrames],
      ["open", true, "open", 5, 4],
    );
    assertEquals(h.driver, "wt61-driver 0.1.0");
  } finally {
    await link.stop();
    await driver.close();
  }
});

Deno.test("the driver going away: unusable, reconnect, usable again", async () => {
  const driver = fakeDriver(async (conn, n) => {
    await send(conn, HELLO, STATUS_OPEN, sampleLine(n * 10));
    if (n === 1) {
      await sleep(30);
      conn.close();
    }
  });
  const emitter = new EventEmitter();
  const seen = watch(emitter);
  const link = new Wt61Link(emitter, { url: driver.url, reconnectDelayMs: 30 });
  try {
    link.start();
    await until(() => seen.samples.length === 2);
    assertEquals(seen.link.map(([u]) => u), [true, false, true]);
    assertEquals(driver.connections(), 2);
    // a new connection does not count the jump from 10 to 20 as lost cycles
    assertEquals(seen.samples.map((s) => s.missedFrames), [0, 0]);
    assertEquals(link.health().connects, 2);
  } finally {
    await link.stop();
    await driver.close();
  }
});

Deno.test("the module's serial port closing makes the link unusable while TCP stays up", async () => {
  const driver = fakeDriver(async (conn) => {
    await send(conn, HELLO, STATUS_OPEN);
    await sleep(30);
    await send(conn, statusLine("closed", "No such file or directory"));
    await sleep(30);
    await send(conn, statusLine("open"), sampleLine(7));
  });
  const emitter = new EventEmitter();
  const seen = watch(emitter);
  const link = new Wt61Link(emitter, { url: driver.url });
  try {
    link.start();
    await until(() => seen.link.length >= 2);
    assertEquals(link.health().serialError, "No such file or directory");
    assertEquals(link.health().state, "open");
    await until(() => seen.samples.length === 1);
    assertEquals(seen.link.map(([u]) => u), [true, false, true]);
    assertEquals(driver.connections(), 1);
  } finally {
    await link.stop();
    await driver.close();
  }
});

Deno.test("anything but a v1 hello first is refused, and retried", async () => {
  for (
    const first of [
      JSON.stringify({ ...JSON.parse(HELLO), version: 2 }),
      sampleLine(1),
      "HTTP/1.1 400 Bad Request",
    ]
  ) {
    const driver = fakeDriver(async (conn) => {
      await send(conn, first, sampleLine(2), sampleLine(3));
    });
    const emitter = new EventEmitter();
    const seen = watch(emitter);
    const link = new Wt61Link(emitter, {
      url: driver.url,
      reconnectDelayMs: 20,
    });
    try {
      link.start();
      await until(() => driver.connections() >= 2);
      assertEquals(seen.samples, [], first);
      assertEquals(seen.link, [], first);
      assert(link.health().lastError !== null, first);
    } finally {
      await link.stop();
      await driver.close();
    }
  }
});

Deno.test("an endless line is not wt61-driver: dropped", async () => {
  const driver = fakeDriver(async (conn) => {
    await send(conn, HELLO);
    await conn.write(new Uint8Array(10_000).fill(0x41));
  });
  const emitter = new EventEmitter();
  const link = new Wt61Link(emitter, { url: driver.url, reconnectDelayMs: 20 });
  try {
    link.start();
    await until(() => driver.connections() >= 2);
    assert(link.health().lastError?.includes("longer than"));
  } finally {
    await link.stop();
    await driver.close();
  }
});

Deno.test("a driver gone silent is reconnected; unknown lines are ignored", async () => {
  const driver = fakeDriver(async (conn) => {
    await send(conn, HELLO, '{"type":"telemetry","x":1}', "garbage");
    // then nothing — not even status lines
  });
  const emitter = new EventEmitter();
  const link = new Wt61Link(emitter, {
    url: driver.url,
    staleMs: 100,
    reconnectDelayMs: 20,
  });
  try {
    link.start();
    await until(() => driver.connections() >= 2);
    assert(link.health().ignoredLines >= 2, "two per connection");
    assert(link.health().lastError?.startsWith("no line for 100 ms"));
  } finally {
    await link.stop();
    await driver.close();
  }
});

Deno.test("nothing listening: closed, retried, and stop() ends it", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  const link = new Wt61Link(new EventEmitter(), {
    url: `tcp://127.0.0.1:${port}`,
    reconnectDelayMs: 20,
  });
  link.start();
  await sleep(80);
  assertEquals(link.health().usable, false);
  assert(link.health().lastError !== null);
  await link.stop();
  assertEquals(link.health().state, "closed");
});
