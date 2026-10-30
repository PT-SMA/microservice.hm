import { assert, assertEquals } from "@std/assert";
import { type AppDeps, MainApp } from "app";
import {
  GPS_CHANNEL,
  HM_CHANNELS,
  HM_EVENTS,
  HM_STATE_KEY,
  WT61_EVENTS,
} from "consts";
import { mountOf } from "direction";
import { HourMeterHandler, TravelDirectionHandler } from "handlers";
import { parseGpsFix, toHourMeterUpdate, toImuSample } from "helpers";
import { codec, linkPair, MSG } from "hour-meter";
import { DirectionRecorder } from "modules";
import { EventEmitter } from "node:events";
import { HourMeterSensor } from "sensors";
import type { HourMeterPublisher, Wt61Sample } from "types";
import {
  buildFrame,
  decodeCatalog,
  sleep,
  TELEMETRY_VALUES,
} from "./_helpers.ts";
import { simulate } from "./_vehicle-sim.ts";

/**
 * The plumbing around the travel-direction estimator: what it reads (IMU
 * stream, microservice.gps), what it writes (the update fields, the hash,
 * travel-direction:update) and how the app wires it.
 */

Deno.test("IMU stream frames become samples: filtered first, raw otherwise", () => {
  const filtered = toImuSample(decodeCatalog("imu-filtered"))!;
  assertEquals(filtered.accelG, { x: 0.008, y: -0.004, z: 0.998 });
  assertEquals(filtered.gyroDps, { x: 0.1, y: -0.1, z: 0 });
  assert(toImuSample(decodeCatalog("imu-raw")) !== null, "raw-only stream");
  assertEquals(toImuSample(decodeCatalog("imu-both"))!.accelG, filtered.accelG);
  assertEquals(toImuSample(decodeCatalog("imu-filtered"), 3)!.missedFrames, 3);
  assertEquals(toImuSample(decodeCatalog("telemetry")), null);
});

Deno.test("a microservice.gps fix is read for speed, course and time; garbage is dropped", () => {
  const fix = JSON.stringify({
    lat: 1,
    lon: 2,
    speed: 12.5,
    track: 365,
    fix: "3D",
    time: "2026-10-15T00:00:01.000Z",
  });
  assertEquals(parseGpsFix(fix), {
    speedKmh: 12.5,
    trackDeg: 5,
    fix: "3D",
    time: "2026-10-15T00:00:01.000Z",
  });
  // before the first RMC/VTG: no track yet
  assertEquals(
    parseGpsFix(JSON.stringify({ speed: 0, fix: "2D", time: "t" }))?.trackDeg,
    undefined,
  );
  for (
    const bad of [
      "nope",
      "null",
      JSON.stringify({ speed: null, fix: "3D", time: "t" }),
      JSON.stringify({ speed: -1, fix: "3D", time: "t" }),
      JSON.stringify({ speed: "5", fix: "3D", time: "t" }),
      JSON.stringify({ speed: 5, fix: null, time: "t" }),
      JSON.stringify({ speed: 5, fix: "3D" }),
    ]
  ) assertEquals(parseGpsFix(bad), null, bad);
});

Deno.test("mounts map board ↔ vehicle both ways, and offset the heading", () => {
  const v = { x: 1, y: 2, z: 3 };
  for (const axis of ["+x", "-x", "+y", "-y"] as const) {
    const m = mountOf(axis);
    assertEquals(m.toBoard(m.toVehicle(v)), v, axis);
  }
  // forward = board +y: the vehicle's front is the board's y axis
  assertEquals(mountOf("+y").toVehicle({ x: 0, y: 1, z: 0 }), {
    x: 1,
    y: -0,
    z: 0,
  });
  assertEquals(mountOf("+y").headingOffsetDeg, -90);
});

Deno.test("the sensor forwards IMU frames, counting only IMU frames as lost", async () => {
  const [host, device] = linkPair();
  const emitter = new EventEmitter();
  const seen: number[] = [];
  emitter.on(HM_EVENTS.imu, (_msg, ctx) => seen.push(ctx.missedFrames));
  const sensor = new HourMeterSensor(emitter, {
    target: "tcp://fake:1",
    timeSync: false,
    staleMs: 60_000,
    open: () => Promise.resolve(host),
  });
  sensor.start();
  const imu = (seq: number) =>
    buildFrame({
      accelX: 0,
      accelY: 0,
      accelZ: 1,
      gyroX: 0,
      gyroY: 0,
      gyroZ: 0,
    }, { msgType: MSG.IMU, seq });
  try {
    await sleep(10);
    await device.write(imu(10));
    await device.write(imu(11)); // consecutive: none lost
    await device.write(buildFrame(TELEMETRY_VALUES, { seq: 12 }));
    await device.write(imu(13)); // a TELEMETRY in between: still none lost
    await device.write(imu(17)); // 14, 15, 16 never arrived
    await sleep(20);
    assertEquals(seen, [0, 0, 0, 3]);
  } finally {
    await sensor.stop();
  }
});

Deno.test("an update carries the direction and the mount-corrected heading only when it is on", () => {
  const msg = decodeCatalog("telemetry"); // headingDeg 33.5
  const ctx = { uuid: "u", now: Date.parse("2026-10-15T00:00:10Z") };
  const off = toHourMeterUpdate(msg, ctx)!;
  assert(!("travelDirection" in off) && !("forwardHeadingDeg" in off));

  const on = toHourMeterUpdate(msg, {
    ...ctx,
    direction: {
      travelDirection: "reversing",
      changedAtMs: Date.parse("2026-10-15T00:00:07Z"),
      headingOffsetDeg: -90,
    },
  })!;
  assertEquals(on.travelDirection, "reversing");
  assertEquals(on.travelDirectionChangedAt, "2026-10-15T00:00:07.000Z");
  assertEquals(on.forwardHeadingDeg, 303.5); // 33.5 − 90, wrapped
});

function recorder() {
  const calls: Array<
    { op: string; key?: string; channel?: string; payload: unknown }
  > = [];
  const publisher: HourMeterPublisher = {
    publish: async (channel, message) => {
      await sleep(1);
      calls.push({ op: "publish", channel, payload: JSON.parse(message) });
      return 1;
    },
    replaceHash: async (key, fields) => {
      await sleep(5); // slow: a merge queued after it must still land after it
      calls.push({ op: "replace", key, payload: fields });
      return 1;
    },
    mergeHash: (key, fields) => {
      calls.push({ op: "merge", key, payload: fields });
      return Promise.resolve(1);
    },
  };
  return { publisher, calls };
}

Deno.test("a direction change merges into the hash, then announces — after any write already queued", async () => {
  const { publisher, calls } = recorder();
  const handler = new HourMeterHandler(publisher);
  const telemetry = handler.handle(decodeCatalog("telemetry"));
  const change = handler.publishDirectionChange({
    travelDirection: "reversing",
    previousTravelDirection: "stopped",
    changedAtMs: Date.parse("2026-10-15T00:00:07Z"),
    basis: ["launch"],
    correction: false,
  }, "1a2b3c4d");
  await Promise.all([telemetry, change]);

  assertEquals(calls.map((c) => `${c.op}:${c.key ?? c.channel}`), [
    `replace:${HM_STATE_KEY}`,
    `publish:${HM_CHANNELS.update}`,
    `merge:${HM_STATE_KEY}`,
    `publish:${HM_CHANNELS.travelDirection}`,
  ]);
  assertEquals(calls[2].payload, {
    travelDirection: "reversing",
    travelDirectionChangedAt: "2026-10-15T00:00:07.000Z",
  });
  const announced = calls[3].payload as Record<string, unknown>;
  assertEquals(announced.travelDirection, "reversing");
  assertEquals(announced.previousTravelDirection, "stopped");
  assertEquals(announced.deviceId, "1a2b3c4d");
  assertEquals(announced.basis, ["launch"]);
  assertEquals(announced.correction, false);
  assertEquals(typeof announced.uuid, "string");
});

Deno.test("the direction handler never lets an error out, and says unknown when it gives up", () => {
  const changes: string[] = [];
  const handler = new TravelDirectionHandler({
    forwardAxis: "+x",
    reverseMaxKmh: 20,
    tickMs: null,
    publisher: {
      publishDirectionChange: (c) => {
        changes.push(c.travelDirection);
        return Promise.resolve();
      },
    },
  });
  handler.onGpsMessage("not json");
  handler.onGpsMessage(JSON.stringify({ speed: "fast" }));
  handler.onImu(decodeCatalog("telemetry")); // not an IMU frame: ignored

  handler.estimator.onImu = () => {
    throw new Error("boom");
  };
  handler.onImu(decodeCatalog("imu-filtered"));
  assertEquals(changes, ["unknown"]);
  assertEquals(handler.health().disabled, "boom");
  handler.onImu(decodeCatalog("imu-filtered")); // switched off: nothing more
  assertEquals(changes, ["unknown"]);
});

function appWith(
  direction: AppDeps["direction"],
  wt61?: AppDeps["wt61"],
  imuSource = "hm",
) {
  const subscribed: string[] = [];
  const app = new MainApp({
    publisher: {
      publish: () => Promise.resolve(1),
      replaceHash: () => Promise.resolve(1),
      mergeHash: () => Promise.resolve(1),
    },
    redis: {
      connect: () => Promise.resolve(),
      subscribe: (channel) => {
        subscribed.push(channel);
        return Promise.resolve();
      },
      status: () => ({
        connected: true,
        pubConnected: true,
        subConnected: true,
      }),
    },
    sensor: {
      target: "tcp://fake:1",
      open: () => Promise.resolve(linkPair()[0]),
      timeSync: false,
      staleMs: 60_000,
    },
    direction: { tickMs: null, ...direction },
    imuSource,
    wt61: wt61 ?? {},
  });
  return { app, subscribed };
}

Deno.test("the app listens to microservice.gps and reports direction only when it is on", async () => {
  const on = appWith({ enabled: true, forwardAxis: "-y" });
  const off = appWith({ enabled: false });
  const invalid = appWith({ enabled: true, forwardAxis: "sideways" });
  try {
    await sleep(20);
    assert(on.subscribed.includes(GPS_CHANNEL));
    assert(on.subscribed.includes(HM_CHANNELS.command));
    assert(!off.subscribed.includes(GPS_CHANNEL));
    assert(
      !invalid.subscribed.includes(GPS_CHANNEL),
      "an invalid axis switches it off, not the service",
    );

    const body = await (await on.app.fetch(new Request("http://x/health")))
      .json();
    assertEquals(body.direction.forwardAxis, "-y");
    assertEquals(body.direction.imu.status, "absent");
    const offBody = await (await off.app.fetch(new Request("http://x/health")))
      .json();
    assert(!("direction" in offBody));
  } finally {
    await Promise.all([on.app.stop(), off.app.stop(), invalid.app.stop()]);
  }
});

Deno.test("a recording replays to the same transcript", async () => {
  const dir = await Deno.makeTempDir({ prefix: "hm-direction-" });
  try {
    const t0 = Date.parse("2026-10-15T00:00:00Z");
    let now = t0;
    const rec = new DirectionRecorder(dir, () => now);
    const live: string[] = [];
    const handler = new TravelDirectionHandler({
      forwardAxis: "+x",
      reverseMaxKmh: 20,
      tickMs: null,
      recorder: rec,
      now: () => now,
      publisher: {
        publishDirectionChange: (c) => {
          live.push(c.travelDirection);
          return Promise.resolve();
        },
      },
    });
    // two seconds of a parked board, GPS saying 0 km/h
    for (let i = 0; i < 200; i++) {
      now = t0 + i * 10;
      const frame = codec.decodeFrame(buildFrame(
        { accelX: 0, accelY: 0, accelZ: 1, gyroX: 0, gyroY: 0, gyroZ: 0 },
        { msgType: MSG.IMU, seq: i },
      ));
      handler.onImu(frame, { missedFrames: 0 });
      if (i % 100 === 50) {
        handler.onGpsMessage(
          JSON.stringify({
            speed: 0,
            fix: "3D",
            time: new Date(now).toISOString(),
          }),
        );
      }
    }
    handler.stop(); // flushes
    const files = [...Deno.readDirSync(dir)].map((e) => `${dir}/${e.name}`);
    assertEquals(files.length, 1);
    const kinds = new Set(
      Deno.readTextFileSync(files[0]).trim().split("\n").map((l) =>
        JSON.parse(l).kind
      ),
    );
    for (const kind of ["config", "imu", "gps"]) assert(kinds.has(kind), kind);

    const replay = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        "scripts/replay-direction.ts",
        files[0],
      ],
      stdout: "piped",
      stderr: "piped",
    });
    const out = new TextDecoder().decode((await replay.output()).stdout);
    for (const state of live) {
      assert(out.includes(`→ ${state}`), `${state} missing from:\n${out}`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ------------------------------------------------------------------ the WT61

const wt61Sample = (
  seq: number,
  accelG = { x: 0, y: 0, z: 1 },
  gyroDps = { x: 0, y: 0, z: 0 },
): Wt61Sample => ({
  type: "sample",
  seq,
  readAt: "2026-10-29T06:00:00.000Z",
  accelG,
  gyroDps,
});

function wt61Handler(now: () => number, changes: string[] = []) {
  const handler = new TravelDirectionHandler({
    forwardAxis: "+x",
    imuSource: "wt61",
    headingAxis: "+x",
    reverseMaxKmh: 20,
    tickMs: null,
    now,
    publisher: {
      publishDirectionChange: (c) => {
        changes.push(c.travelDirection);
        return Promise.resolve();
      },
    },
  });
  const emitter = new EventEmitter();
  handler.attach(emitter);
  return { handler, emitter, changes };
}

Deno.test("with a WT61, its samples feed the estimator and the hour meter's IMU frames do not", () => {
  let now = 1_000;
  const { handler, emitter } = wt61Handler(() => now);
  for (let i = 0; i < 50; i++) {
    now += 10;
    emitter.emit(HM_EVENTS.imu, decodeCatalog("imu-filtered"), {
      missedFrames: 0,
    });
  }
  assertEquals(handler.health().imu.status, "absent");
  for (let i = 0; i < 50; i++) {
    now += 10;
    // a live module: the last bit moves
    const accelG = { x: 0, y: 0, z: 1 + (i % 2) / 2048 };
    emitter.emit(WT61_EVENTS.sample, wt61Sample(i + 1, accelG), {
      missedFrames: 0,
    });
  }
  const health = handler.health();
  assertEquals(health.imu.status, "ok");
  assertEquals(health.imuSource, "wt61");
});

Deno.test("a launch through the WT61 path is decided forward", () => {
  // the generator's IMU stands in for the module: same axes, g and °/s
  const run = simulate([
    { hold: 12 },
    { ramp: { to: 5, accel: 0.5 } },
    { turn: { yawDps: 10, durS: 6 } },
    { hold: 6 },
  ]);
  let now = run.events[0]?.tMs ?? 0;
  const { handler, emitter, changes } = wt61Handler(() => now);
  let seq = 0, nextTick = now + 1000;
  for (const e of run.events) {
    now = e.tMs;
    while (now >= nextTick) handler.estimator.tick(nextTick += 1000);
    if (e.kind === "imu") {
      emitter.emit(
        WT61_EVENTS.sample,
        wt61Sample(++seq, e.sample.accelG, e.sample.gyroDps),
        { missedFrames: 0 },
      );
    } else if (e.kind === "gps") handler.onGpsMessage(e.raw);
  }
  assert(changes.includes("forward"), changes.join(" → "));
  assert(!changes.includes("reversing"), changes.join(" → "));
});

Deno.test("the WT61 link coming back resets the estimator; an hour-meter boot does not", () => {
  const resets: string[] = [];
  const { handler, emitter } = wt61Handler(() => 0);
  handler.estimator.onReset = (reason) => void resets.push(reason);
  emitter.emit(WT61_EVENTS.link, true); // the first time: nothing to void
  emitter.emit(HM_EVENTS.event, decodeCatalog("event-boot"));
  assertEquals(resets, []);
  emitter.emit(WT61_EVENTS.link, false, "wt61-driver link closed");
  emitter.emit(WT61_EVENTS.link, true);
  assertEquals(resets, ["link"]);

  // the hour meter's own IMU: its boot does reset
  const own = new TravelDirectionHandler({
    forwardAxis: "+x",
    reverseMaxKmh: 20,
    tickMs: null,
    publisher: { publishDirectionChange: () => Promise.resolve() },
  });
  const ownResets: string[] = [];
  own.estimator.onReset = (reason) => void ownResets.push(reason);
  own.onEvent(decodeCatalog("event-boot"));
  assertEquals(ownResets, ["boot"]);
});

Deno.test("the app reads the IMU from wt61-driver when HOUR_METER_IMU_SOURCE=wit", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const url = `tcp://127.0.0.1:${(listener.addr as Deno.NetAddr).port}`;
  const served = (async () => {
    for await (const conn of listener) {
      const hello = Deno.readTextFileSync(
        new URL("./fixtures/wt61/stream-v1.ndjson", import.meta.url),
      ).split("\n").slice(0, 2).join("\n") + "\n";
      await conn.write(new TextEncoder().encode(hello)).catch(() => {});
    }
  })();
  const on = appWith({ enabled: true, forwardAxis: "+x" }, {
    url,
    forwardAxis: "-y",
  }, "wit");
  const badAxis = appWith({ enabled: true }, { url, forwardAxis: "up" }, "wit");
  const badUrl = appWith({ enabled: true }, { url: "127.0.0.1:6699" }, "wit");
  try {
    await sleep(100);
    const body = await (await on.app.fetch(new Request("http://x/health")))
      .json();
    assertEquals(body.direction.imuSource, "wt61");
    assertEquals(body.direction.forwardAxis, "-y");
    assertEquals(body.direction.headingAxis, "+x");
    assertEquals(body.wt61.url, url);
    assertEquals(body.wt61.usable, true);
    assertEquals(body.wt61.driver, "wt61-driver 0.1.0");
    assert(body.healthy !== undefined);
    for (const off of [badAxis, badUrl]) {
      const b = await (await off.app.fetch(new Request("http://x/health")))
        .json();
      assert(!("direction" in b), "a bad WT61 setting switches direction off");
      assert(!("wt61" in b));
      assert(!off.subscribed.includes(GPS_CHANNEL));
    }
  } finally {
    await Promise.all([on.app.stop(), badAxis.app.stop(), badUrl.app.stop()]);
    listener.close();
    await served.catch(() => {});
  }
});
