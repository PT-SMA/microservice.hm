import { assert, assertEquals } from "@std/assert";
import { MainApp } from "app";
import { HM_CHANNELS, HM_EVENTS, WT61_EVENTS } from "consts";
import { ImuPublishHandler } from "handlers";
import {
  addSample,
  closeWindow,
  imuReadingFromFrame,
  imuReadingFromWt61,
  imuWindow,
} from "helpers";
import { linkPair } from "hour-meter";
import { EventEmitter } from "node:events";
import type { HourMeterImu, Wt61Sample } from "types";
import { decodeCatalog, sleep } from "./_helpers.ts";

/**
 * `hour-meter:imu`: the travel direction's IMU, decimated for geofencer's dev
 * console (FMS-Backend/docs/ecosystem/integrations/hm-to-geofencer.md). Each
 * window is one message: mean accel and gyro, the latest attitude.
 */

const wt61 = (
  seq: number,
  gyroZ: number,
  extra: Partial<Wt61Sample> = {},
): Wt61Sample => ({
  type: "sample",
  seq,
  readAt: "2026-10-29T06:00:00.000Z",
  accelG: { x: 0, y: 0, z: 1 },
  gyroDps: { x: 0, y: 0, z: gyroZ },
  ...extra,
});

function recording(fail = false) {
  const sent: Array<{ channel: string; message: HourMeterImu }> = [];
  return {
    sent,
    publisher: {
      publish: (channel: string, message: string) => {
        sent.push({ channel, message: JSON.parse(message) });
        return fail ? Promise.reject(new Error("down")) : Promise.resolve(1);
      },
    },
  };
}

Deno.test("a window is its mean accel and gyro, its latest attitude, and what it held and lost", () => {
  let w = imuWindow();
  w = addSample(w, imuReadingFromWt61(wt61(1, 10, { temperatureC: 30 })), 0);
  w = addSample(
    w,
    imuReadingFromWt61(
      wt61(2, 20, { angleDeg: { x: 1, y: -2, z: 90 }, temperatureC: 31 }),
      2,
    ),
    50,
  );
  const message = closeWindow(w, 100, { source: "wt61", forwardAxis: "+y" });
  assertEquals(message, {
    source: "wt61",
    forwardAxis: "+y",
    at: new Date(100).toISOString(),
    windowMs: 100,
    samples: 2,
    missedFrames: 2,
    accelG: { x: 0, y: 0, z: 1 },
    gyroDps: { x: 0, y: 0, z: 15 },
    angleDeg: { x: 1, y: -2, z: 90 },
    temperatureC: 31,
  });
  assertEquals(
    closeWindow(imuWindow(), 100, { source: "wt61", forwardAxis: "+x" }),
    null,
  );
});

Deno.test("an hour-meter IMU frame carries its roll, pitch and heading", () => {
  const reading = imuReadingFromFrame(decodeCatalog("imu-filtered"));
  assertEquals(reading?.angleDeg, { x: 2.5, y: -0.48, z: 33.5 });
  assertEquals(reading?.gyroDps, { x: 0.1, y: -0.1, z: 0 });
  // raw tags only: accel and gyro, no attitude
  const raw = imuReadingFromFrame(decodeCatalog("imu-raw"));
  assert(raw !== null);
  assertEquals(raw.angleDeg, undefined);
});

Deno.test("WT61 samples at 100 Hz go out at 10 Hz, one window each", () => {
  let now = 0;
  const { sent, publisher } = recording();
  const handler = new ImuPublishHandler({
    source: "wt61",
    forwardAxis: "+x",
    hz: 10,
    publisher,
    now: () => now,
  });
  const emitter = new EventEmitter();
  handler.attach(emitter);
  for (let i = 0; i < 100; i++) {
    emitter.emit(WT61_EVENTS.sample, wt61(i + 1, i < 50 ? 0 : 30), {
      missedFrames: 0,
    });
    now += 10;
  }
  // and the hour meter's own stream is not this source
  emitter.emit(HM_EVENTS.imu, decodeCatalog("imu-filtered"), {
    missedFrames: 0,
  });
  assertEquals(sent.length, 9);
  assert(sent.every((s) => s.channel === HM_CHANNELS.imu));
  assertEquals(sent[0].message.samples, 11);
  assertEquals(sent[0].message.windowMs, 100);
  assertEquals(sent[0].message.gyroDps.z, 0);
  assertEquals(sent.at(-1)!.message.gyroDps.z, 30);
  assertEquals(sent[0].message.deviceId, undefined);
});

Deno.test("the hour meter's stream names its device; 0 Hz publishes nothing", () => {
  let now = 0;
  const { sent, publisher } = recording();
  const on = new ImuPublishHandler({
    source: "hour-meter",
    forwardAxis: "-y",
    hz: 10,
    publisher,
    now: () => now,
  });
  const off = new ImuPublishHandler({
    source: "hour-meter",
    forwardAxis: "-y",
    hz: 0,
    publisher,
    now: () => now,
  });
  const emitter = new EventEmitter();
  on.attach(emitter);
  off.attach(emitter);
  for (let i = 0; i < 3; i++) {
    emitter.emit(HM_EVENTS.imu, decodeCatalog("imu-filtered"), {
      missedFrames: 1,
    });
    now += 100;
  }
  assertEquals(sent.length, 1);
  assertEquals(sent[0].message.deviceId, "1a2b3c4d");
  assertEquals(sent[0].message.source, "hour-meter");
  assertEquals(sent[0].message.forwardAxis, "-y");
  assertEquals(sent[0].message.missedFrames, 2);
  assertEquals(sent[0].message.angleDeg, { x: 2.5, y: -0.48, z: 33.5 });
});

Deno.test("a publish that fails is dropped, and publishing goes on", async () => {
  let now = 0;
  const { sent, publisher } = recording(true);
  const handler = new ImuPublishHandler({
    source: "wt61",
    forwardAxis: "+x",
    hz: 10,
    publisher,
    now: () => now,
  });
  for (let i = 0; i < 30; i++) {
    handler.onWt61Sample(wt61(i + 1, 1));
    now += 10;
  }
  await sleep(0);
  assertEquals(sent.length, 2);
  // a frame it cannot read is ignored, not thrown
  handler.onWt61Sample({ type: "sample" } as unknown as Wt61Sample);
});

Deno.test("the app publishes the travel direction's IMU, at HOUR_METER_IMU_HZ", async () => {
  const sent: Array<string> = [];
  const app = new MainApp({
    publisher: {
      publish: (channel) => {
        sent.push(channel);
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
      open: () => Promise.resolve(linkPair()[0]),
      timeSync: false,
      staleMs: 60_000,
    },
    direction: { enabled: true, forwardAxis: "+x", tickMs: null },
    imuSource: "hm",
    imuHz: 5,
  });
  try {
    await sleep(20);
    assertEquals(app.imu?.source, "hour-meter");
    assertEquals(app.imu?.hz, 5);
    app.imu!.onImu(decodeCatalog("imu-filtered"));
    await sleep(210);
    app.imu!.onImu(decodeCatalog("imu-filtered"));
    assert(sent.includes(HM_CHANNELS.imu));
  } finally {
    await app.stop();
  }
});
