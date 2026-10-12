import { assert, assertEquals } from "@std/assert";
import { HM_CHANNELS } from "consts";
import { type DeviceCommander, HourMeterCommandHandler } from "handlers";
import {
  AckError,
  codec,
  type DecodedMessage,
  FrameSplitter,
  linkPair,
  MSG,
} from "hour-meter";
import { EventEmitter } from "node:events";
import { DeviceUnavailableError, HourMeterSensor } from "sensors";
import type { HourMeterReply } from "types";
import { decodeCatalog, DEVICE_EPOCH, DEVICE_ID, sleep } from "./_helpers.ts";

/**
 * `hour-meter:command` → the device → `hour-meter:reply`. First against a
 * scripted device, for every way a command can end; then through the real
 * reader and the vendored client, against a fake device that keeps settings
 * the way the firmware does.
 */

const SETTINGS_ACK = decodeCatalog("ack-get-settings");

/** An ACK the device would send, decoded. */
function ack(values: Record<string, number | boolean>): DecodedMessage {
  return codec.decodeFrame(codec.frame({
    msgType: MSG.ACK,
    seq: 1,
    deviceId: DEVICE_ID,
    timestamp: DEVICE_EPOCH,
    values: { ackSeq: 1, ackStatus: 0, ...values },
  }));
}

/** A device whose answers the test scripts; records every COMMAND. */
function scriptedDevice(
  answer: (values: Record<string, number | boolean>) => Promise<DecodedMessage>,
) {
  const commands: Array<Record<string, number | boolean>> = [];
  const device: DeviceCommander = {
    command: (values) => {
      commands.push(values);
      return answer(values);
    },
    currentDeviceId: () => "1a2b3c4d",
  };
  return { device, commands };
}

function rig(
  answer: (values: Record<string, number | boolean>) => Promise<DecodedMessage>,
) {
  const { device, commands } = scriptedDevice(answer);
  const replies: HourMeterReply[] = [];
  const handler = new HourMeterCommandHandler(device, {
    publish: (channel, message) => {
      assertEquals(channel, HM_CHANNELS.reply);
      replies.push(JSON.parse(message));
      return Promise.resolve(1);
    },
  });
  return { handler, commands, replies };
}

const command = (body: Record<string, unknown>) => JSON.stringify(body);
const answersSettings = () => Promise.resolve(SETTINGS_ACK);

Deno.test("getSettings answers the device's settings and their schema", async () => {
  const { handler, commands, replies } = rig(answersSettings);

  await handler.handle(command({ requestId: "r1", action: "getSettings" }));

  assertEquals(commands, [{ get: 2 }]);
  const [reply] = replies;
  assertEquals(reply.requestId, "r1");
  assertEquals(reply.status, "ok");
  assertEquals(reply.deviceId, "1a2b3c4d");
  assertEquals(reply.settings?.telemetryIntervalMs, 1000);
  assert(!("btPin" in reply.settings!));
  assertEquals(reply.schema?.output.writable, false);
});

Deno.test("setSettings sends one COMMAND, then reads back what the device holds", async () => {
  const { handler, commands, replies } = rig(answersSettings);

  await handler.handle(command({
    requestId: "r2",
    action: "setSettings",
    settings: { telemetryIntervalMs: 2000, pulsesPerUnit: 100 },
  }));

  assertEquals(commands, [
    { telemetryIntervalMs: 2000, pulsesPerUnit: 100 },
    { get: 2 },
  ]);
  assertEquals(replies[0].status, "ok");
  assert(replies[0].settings !== undefined);
});

Deno.test("an invalid change never reaches the device", async () => {
  const { handler, commands, replies } = rig(answersSettings);

  await handler.handle(command({
    requestId: "r3",
    action: "setSettings",
    settings: { pulsesPerUnit: 10, output: 2 },
  }));
  await handler.handle(command({ requestId: "r4", action: "setSettings" }));
  await handler.handle(command({ requestId: "r5", action: "reboot" }));

  assertEquals(commands, []);
  assertEquals(replies.map((r) => [r.requestId, r.status, r.setting]), [
    ["r3", "invalid", "output"],
    ["r4", "invalid", undefined],
    ["r5", "invalid", undefined],
  ]);
});

Deno.test("a refusal from the device names its reason and the setting", async () => {
  const refusal = ack({ ackStatus: 2, rejectedTag: 112 }); // InvalidValue, imuStreamHz
  const { handler, replies } = rig(() =>
    Promise.reject(new AckError("device answered InvalidValue", refusal))
  );

  await handler.handle(command({
    requestId: "r6",
    action: "setSettings",
    settings: { imuStreamHz: 100, imuSampleHz: 50 },
  }));

  assertEquals(replies[0].status, "rejected");
  assertEquals(replies[0].ackStatus, "InvalidValue");
  assertEquals(replies[0].setting, "imuStreamHz");
});

Deno.test("no link, no answer, and a lost read-back each say so", async () => {
  const unavailable = rig(() =>
    Promise.reject(new DeviceUnavailableError("no link to the hour meter"))
  );
  await unavailable.handler.handle(
    command({ requestId: "r7", action: "getSettings" }),
  );
  assertEquals(unavailable.replies[0].status, "unavailable");

  const silent = rig(() =>
    Promise.reject(new Error("no ACK after 3 attempts"))
  );
  await silent.handler.handle(
    command({ requestId: "r8", action: "getSettings" }),
  );
  assertEquals(silent.replies[0].status, "timeout");

  // the change was applied; failing to read it back must not report failure
  let calls = 0;
  const readBackLost = rig(() =>
    ++calls === 1
      ? Promise.resolve(ack({}))
      : Promise.reject(new Error("no ACK after 3 attempts"))
  );
  await readBackLost.handler.handle(command({
    requestId: "r9",
    action: "setSettings",
    settings: { pulsesPerUnit: 4 },
  }));
  assertEquals(readBackLost.replies[0].status, "ok");
  assert(
    readBackLost.replies[0].message?.includes("reading the settings back"),
  );
  assert(!("settings" in readBackLost.replies[0]));
});

Deno.test("commands run one at a time: a change and its read-back stay together", async () => {
  const { handler, commands } = rig(async () => {
    await sleep(5);
    return SETTINGS_ACK;
  });

  await Promise.all([
    handler.handle(command({
      requestId: "a",
      action: "setSettings",
      settings: { pulsesPerUnit: 2 },
    })),
    handler.handle(command({
      requestId: "b",
      action: "setSettings",
      settings: { pulsesPerUnit: 3 },
    })),
  ]);

  assertEquals(commands, [
    { pulsesPerUnit: 2 },
    { get: 2 },
    { pulsesPerUnit: 3 },
    { get: 2 },
  ]);
});

Deno.test("garbage gets no reply; a failed reply does not throw", async () => {
  const { handler, replies } = rig(answersSettings);
  await handler.handle("not json");
  await handler.handle(command({ action: "getSettings" }));
  assertEquals(replies, []);

  const broken = new HourMeterCommandHandler(
    scriptedDevice(answersSettings).device,
    {
      publish: () => Promise.reject(new Error("The client is closed")),
    },
  );
  await broken.handle(command({ requestId: "r10", action: "getSettings" }));
});

/**
 * The device end of a link that keeps settings like the firmware: `get=2`
 * answers them all, a change is applied all or nothing, and imuStreamHz above
 * imuSampleHz is refused with InvalidValue on tag 112.
 */
function settingsDevice() {
  const [host, link] = linkPair();
  const settings: Record<string, number | boolean> = Object.fromEntries(
    Object.entries(SETTINGS_ACK.values).filter(([k]) =>
      !k.startsWith("ack")
    ) as Array<[string, number | boolean]>,
  );
  const send = (values: Record<string, number | boolean>) =>
    void link.write(codec.frame({
      msgType: MSG.ACK,
      seq: 9,
      deviceId: DEVICE_ID,
      timestamp: DEVICE_EPOCH,
      values,
    }));
  const splitter = new FrameSplitter((msg) => {
    const ackSeq = msg.seq;
    const values = msg.values as Record<string, number | boolean>;
    if (values.get === 2) return send({ ackSeq, ackStatus: 0, ...settings });
    const next = { ...settings, ...values };
    if (Number(next.imuStreamHz) > Number(next.imuSampleHz)) {
      return send({ ackSeq, ackStatus: 2, rejectedTag: 112 });
    }
    Object.assign(settings, values);
    send({ ackSeq, ackStatus: 0 });
  }, () => {});
  void (async () => {
    try {
      for await (const chunk of link.readable) splitter.push(chunk);
    } catch {
      // closed
    }
  })();
  return { host, settings };
}

Deno.test("through the real reader: read, change, refuse, read back", async () => {
  const device = settingsDevice();
  const sensor = new HourMeterSensor(new EventEmitter(), {
    target: "tcp://fake:1",
    timeSync: false,
    staleMs: 60_000,
    open: () => Promise.resolve(device.host),
  });
  const replies: HourMeterReply[] = [];
  const handler = new HourMeterCommandHandler(sensor, {
    publish: (_channel, message) => {
      replies.push(JSON.parse(message));
      return Promise.resolve(1);
    },
  });

  // before any link: unavailable, nothing queued for later
  await handler.handle(command({ requestId: "early", action: "getSettings" }));
  assertEquals(replies.at(-1)?.status, "unavailable");

  sensor.start();
  try {
    await sleep(20);
    await handler.handle(command({
      requestId: "set",
      action: "setSettings",
      settings: { telemetryIntervalMs: 2000, pulsesPerUnit: 100 },
    }));
    const set = replies.at(-1)!;
    assertEquals(set.status, "ok");
    assertEquals(set.settings?.telemetryIntervalMs, 2000);
    assertEquals(set.settings?.pulsesPerUnit, 100);
    assertEquals(device.settings.telemetryIntervalMs, 2000, "on the device");

    await handler.handle(command({
      requestId: "refused",
      action: "setSettings",
      settings: { imuStreamHz: 100, imuSampleHz: 50 },
    }));
    const refused = replies.at(-1)!;
    assertEquals(refused.status, "rejected");
    assertEquals(refused.ackStatus, "InvalidValue");
    assertEquals(refused.setting, "imuStreamHz");
    assertEquals(device.settings.imuSampleHz, 100, "nothing applied");
  } finally {
    await sensor.stop();
  }
});
