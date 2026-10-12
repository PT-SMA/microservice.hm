import { assert, assertEquals, assertMatch } from "@std/assert";
import { linkPair } from "hour-meter";
import { redisClient, redisPubClient, redisSubscriberClient } from "modules";
import { catalogFrame, collectRejections, sleep } from "./_helpers.ts";

/**
 * The reader must survive Redis.
 *
 * Deno terminates the process on an unhandled rejection, and on a vehicle the
 * whole stack powers up cold: Redis being late, or dropping out mid-shift, is
 * ordinary. These tests assert the process-level property directly — after
 * the failure, nothing escaped. On a regression they do not fail with a red
 * assertion; they kill the runner, which is exactly what would happen on a
 * truck. (microservice.gps's boot-resilience suite, same shape.)
 */

/** Make every client refuse to connect, the way a cold box does. */
function stubRedisDown() {
  // deno-lint-ignore no-explicit-any
  const clients = [redisClient, redisPubClient, redisSubscriberClient] as any[];
  const real = clients.map((c) => c.connect);
  for (const client of clients) {
    client.connect = () => Promise.reject(new Error("connect ECONNREFUSED"));
  }
  return () => clients.forEach((c, i) => (c.connect = real[i]));
}

Deno.test("the service module loads at all", async () => {
  // package.json, not deno.json (JSONC), is the version import
  const { MainApp } = await import("../src/app.ts");
  assert(typeof MainApp === "function");
});

Deno.test("booting with Redis down does not kill the service, and the reader runs", async () => {
  const rejections = collectRejections();
  const restore = stubRedisDown();
  const { MainApp } = await import("../src/app.ts");
  const app = new MainApp({
    // nothing listens on port 1: the reader fails to open and retries
    sensor: { target: "tcp://127.0.0.1:1", reconnectDelayMs: 20 },
  });

  try {
    await sleep(300);
    assertEquals(rejections.seen, [], "nothing escaped as a rejection");

    // the reader started anyway and keeps retrying the device
    const health = app.sensor!.health();
    assertMatch(health.lastError ?? "", /refused/i);
    assert(health.reconnects >= 2, `reconnects: ${health.reconnects}`);
  } finally {
    await app.stop(); // also cancels the Redis retry timer
    restore();
    rejections.stop();
  }
});

Deno.test("a frame arriving while Redis is unreachable does not kill the service", async () => {
  /**
   * The real Redis publisher, never connected: every publish rejects with
   * "The client is closed". The handler must swallow it — a rejection here
   * would travel through the captureRejections emitter.
   */
  const rejections = collectRejections();
  const restore = stubRedisDown();
  const { MainApp } = await import("../src/app.ts");
  const [host, device] = linkPair();
  const app = new MainApp({
    sensor: {
      target: "tcp://fake:1",
      timeSync: false,
      staleMs: 60_000,
      open: () => Promise.resolve(host),
    },
  });

  try {
    await sleep(20);
    await device.write(catalogFrame("event-boot"));
    await device.write(catalogFrame("telemetry"));
    await device.write(catalogFrame("telemetry"));
    await sleep(50);

    assertEquals(rejections.seen, []);
    assertEquals(app.sensor!.health().frames.telemetry, 2, "still reading");
  } finally {
    await app.stop();
    restore();
    rejections.stop();
  }
});
