import { assert, assertEquals } from "@std/assert";
import { type AppDeps, MainApp } from "app";
import { type Link, linkPair } from "hour-meter";
import type { HourMeterPublisher } from "types";
import { catalogFrame, sleep } from "./_helpers.ts";

/**
 * `GET /health` answers "is the hour meter alive?" with a status code a
 * container healthcheck can use. Healthy means TELEMETRY seen recently — not
 * "the port is open", not "status RUNNING" (microservice.gps's lesson: its
 * reader said RUNNING while it had never received a byte).
 */

const silentPublisher: HourMeterPublisher = {
  publish: () => Promise.resolve(1),
  replaceHash: () => Promise.resolve(1),
  mergeHash: () => Promise.resolve(1),
};

/** An app on an in-memory link, with Redis stubbed as connected. */
function appWithDevice() {
  let device: Link | undefined;
  const deps: AppDeps = {
    publisher: silentPublisher,
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
      target: "tcp://127.0.0.1:5555",
      timeSync: false,
      staleMs: 60_000,
      open: () => {
        const [host, dev] = linkPair();
        device = dev;
        return Promise.resolve(host);
      },
    },
  };
  const app = new MainApp(deps);
  return { app, device: () => device };
}

const get = async (app: MainApp, path: string) => {
  const res = await app.fetch(new Request(`http://localhost${path}`));
  return { status: res.status, body: await res.json() };
};

Deno.test("no telemetry yet: 503, with the resolved target and Redis state", async () => {
  const { app } = appWithDevice();
  try {
    await sleep(20);
    const { status, body } = await get(app, "/health");
    assertEquals(status, 503);
    assertEquals(body.healthy, false);
    assertEquals(
      body.status,
      "RUNNING",
      "the link is open — still not healthy",
    );
    assertEquals(body.target, "tcp://127.0.0.1:5555");
    assertEquals(body.redis, {
      connected: true,
      pubConnected: true,
      subConnected: true,
    });
  } finally {
    await app.stop();
  }
});

Deno.test("after a TELEMETRY frame: 200", async () => {
  const { app, device } = appWithDevice();
  try {
    await sleep(20);
    await device()!.write(catalogFrame("telemetry"));
    await sleep(20);

    const { status, body } = await get(app, "/health");
    assertEquals(status, 200);
    assertEquals(body.healthy, true);
    assertEquals(body.deviceId, "1a2b3c4d");
    assertEquals(body.frames.telemetry, 1);
    assert(body.telemetryAgeMs >= 0);
  } finally {
    await app.stop();
  }
});

Deno.test("GET / names the service and its version; unknown routes are JSON 404s", async () => {
  const { app } = appWithDevice();
  try {
    const index = await get(app, "/");
    assertEquals(index.status, 200);
    assertEquals(index.body.app, "microservice.hm");
    assertEquals(typeof index.body.version, "string");

    const missing = await get(app, "/nope");
    assertEquals(missing.status, 404);
    assertEquals(missing.body.errors.length, 1);
  } finally {
    await app.stop();
  }
});
