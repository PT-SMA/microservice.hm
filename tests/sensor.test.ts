import { assert, assertEquals } from "@std/assert";
import { HM_EVENTS } from "consts";
import {
  codec,
  type DecodedMessage,
  FrameSplitter,
  type Link,
  linkPair,
  MSG,
} from "hour-meter";
import { EventEmitter } from "node:events";
import { HourMeterSensor, type HourMeterSensorOptions } from "sensors";
import {
  buildFrame,
  catalogFrame,
  DEVICE_EPOCH,
  DEVICE_ID,
  sleep,
  TELEMETRY_VALUES,
} from "./_helpers.ts";

/**
 * The reader against a fake device on an in-memory link: the device's bytes
 * are the firmware's own frames, and it answers COMMANDs with ACKs the way
 * the firmware does. No serial port, no Redis.
 */

/** The device end of a link. */
class FakeDevice {
  readonly host: Link;
  readonly commands: DecodedMessage[] = [];
  /** null = never answer (a hung device or a dead link). */
  ackStatus: number | null = 0;
  #link: Link;

  constructor() {
    const [host, device] = linkPair();
    this.host = host;
    this.#link = device;
    void this.#listen();
  }

  send(bytes: Uint8Array): Promise<void> {
    return this.#link.write(bytes);
  }

  /** Unplug: the host's read side ends. */
  close() {
    this.#link.close();
  }

  async #listen() {
    const splitter = new FrameSplitter((msg) => this.#onCommand(msg), () => {});
    try {
      for await (const chunk of this.#link.readable) splitter.push(chunk);
    } catch {
      // closed by the host
    }
  }

  #onCommand(msg: DecodedMessage) {
    this.commands.push(msg);
    if (this.ackStatus === null) return;
    void this.send(codec.frame({
      msgType: MSG.ACK,
      seq: 7,
      deviceId: DEVICE_ID,
      timestamp: DEVICE_EPOCH,
      values: { ackSeq: msg.seq, ackStatus: this.ackStatus },
    }));
  }
}

/** A sensor whose every open() hands out a new FakeDevice. */
function rig(options: HourMeterSensorOptions = {}) {
  const emitter = new EventEmitter();
  const telemetry: DecodedMessage[] = [];
  const events: Array<{ msg: DecodedMessage; bootCount: number }> = [];
  emitter.on(HM_EVENTS.telemetry, (msg) => telemetry.push(msg));
  emitter.on(HM_EVENTS.event, (msg, ctx) => events.push({ msg, ...ctx }));

  const devices: FakeDevice[] = [];
  const sensor = new HourMeterSensor(emitter, {
    target: "tcp://fake:1",
    staleMs: 80,
    watchdogIntervalMs: 10,
    probeTimeoutMs: 40,
    reconnectDelayMs: 10,
    timeSync: false,
    open: () => {
      const device = new FakeDevice();
      devices.push(device);
      return Promise.resolve(device.host);
    },
    ...options,
  });
  return { sensor, devices, telemetry, events };
}

async function waitFor(condition: () => boolean, label: string, ms = 1000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting: ${label}`);
    await sleep(5);
  }
}

/** Start, wait for the link, run the body, always stop. */
async function withSensor(
  options: HourMeterSensorOptions,
  body: (r: ReturnType<typeof rig>) => Promise<void>,
) {
  const r = rig(options);
  r.sensor.start();
  try {
    await waitFor(() => r.devices.length === 1, "first open");
    await body(r);
  } finally {
    await r.sensor.stop();
  }
}

const telemetryFrame = (seq: number, values = TELEMETRY_VALUES) =>
  buildFrame(values, { seq });

Deno.test("frames split across reads, after noise and an empty frame, decode once", async () => {
  await withSensor({}, async ({ sensor, devices, telemetry }) => {
    const frame = catalogFrame("telemetry");
    const device = devices[0];
    await device.send(Uint8Array.of(0x13, 0x37, 0xbe, 0xef, 0x00)); // noise
    await device.send(Uint8Array.of(0x00)); // empty frame: ignored
    await device.send(frame.subarray(0, 10));
    await device.send(frame.subarray(10, 40));
    await device.send(frame.subarray(40));

    await waitFor(() => telemetry.length === 1, "one telemetry");
    assertEquals(telemetry[0].values.runSeconds, 4_500_000);
    assertEquals(sensor.health().frameErrors, 1, "the noise, nothing else");
  });
});

Deno.test("a corrupted frame is counted and the next one still decodes", async () => {
  await withSensor({}, async ({ sensor, devices, telemetry }) => {
    const bad = catalogFrame("telemetry");
    bad[20] ^= 0x55;
    await devices[0].send(bad);
    await devices[0].send(catalogFrame("telemetry"));

    await waitFor(() => telemetry.length === 1, "the good frame");
    assertEquals(sensor.health().frameErrors, 1);
  });
});

Deno.test("health is freshness: no telemetry, then fresh, then stale", async () => {
  await withSensor(
    { staleMs: 60_000 },
    async ({ sensor, devices, telemetry }) => {
      let health = sensor.health();
      assertEquals(health.status, "RUNNING");
      assertEquals(health.healthy, false, "an open link alone is not healthy");

      // IMU frames prove the link, not the hour meter
      await devices[0].send(catalogFrame("imu-filtered"));
      await waitFor(() => sensor.health().frames.imu === 1, "imu counted");
      assertEquals(sensor.health().healthy, false);

      await devices[0].send(catalogFrame("telemetry"));
      await waitFor(() => telemetry.length === 1, "telemetry");
      health = sensor.health();
      assertEquals(health.healthy, true);
      assertEquals(health.deviceId, "1a2b3c4d");
      assertEquals(health.target, "tcp://fake:1");
      assertEquals(health.link, "tcp");
    },
  );

  // same sensor shape, clock moved past staleMs
  let now = Date.now();
  await withSensor(
    { staleMs: 1000, now: () => now },
    async ({ sensor, devices, telemetry }) => {
      await devices[0].send(catalogFrame("telemetry"));
      await waitFor(() => telemetry.length === 1, "telemetry");
      assertEquals(sensor.health().healthy, true);
      now += 1001;
      assertEquals(sensor.health().healthy, false);
    },
  );
});

Deno.test("a silent device that answers the probe is NOT reopened", async () => {
  /**
   * Reopening a USB port reboots the ESP32 and can cost up to a minute of
   * hour meter. A device that answers `get=3` is alive — e.g. its telemetry
   * goes to the UART pins — so the port must stay open.
   */
  await withSensor({}, async ({ sensor, devices }) => {
    await waitFor(() => devices[0].commands.length >= 1, "a probe", 2000);
    await sleep(150); // several more stale periods

    const health = sensor.health();
    assertEquals(devices.length, 1, "opened once, never reopened");
    assertEquals(devices[0].commands[0].values.get, 3);
    assertEquals(health.reconnects, 0);
    assert(health.silentReason?.includes("output"), health.silentReason ?? "");
    assertEquals(health.healthy, false);
  });
});

Deno.test("a locked Bluetooth session says so instead of reconnecting", async () => {
  await withSensor({}, async ({ sensor, devices }) => {
    devices[0].ackStatus = 9; // Locked
    await waitFor(() => sensor.health().silentReason !== null, "silent");
    assert(sensor.health().silentReason?.includes("HOUR_METER_BT_PIN"));
    assertEquals(devices.length, 1);
  });
});

Deno.test("a silent device that does not answer is reopened", async () => {
  await withSensor({}, async ({ sensor, devices }) => {
    devices[0].ackStatus = null;
    await waitFor(() => devices.length === 2, "second open", 2000);
    assertEquals(sensor.health().reconnects, 1);
  });
});

Deno.test("frames clear the silent state", async () => {
  await withSensor({}, async ({ sensor, devices, telemetry }) => {
    await waitFor(() => sensor.health().silentReason !== null, "silent", 2000);
    await devices[0].send(catalogFrame("telemetry"));
    await waitFor(() => telemetry.length === 1, "telemetry");
    assertEquals(sensor.health().silentReason, null);
  });
});

Deno.test("a link the device closes is reopened", async () => {
  await withSensor({ staleMs: 60_000 }, async ({ sensor, devices }) => {
    devices[0].close(); // unplugged: our read side ends
    await waitFor(() => devices.length === 2, "reopen");
    assertEquals(sensor.health().reconnects, 1);
  });
});

Deno.test("a restart counts once: boot EVENT, or seq going backwards", async () => {
  await withSensor({}, async ({ sensor, devices, events, telemetry }) => {
    const device = devices[0];

    // boot EVENT (seq 0) — counted, and handed to the event listener
    await device.send(catalogFrame("event-boot"));
    await waitFor(() => events.length === 1, "boot event");
    assertEquals(events[0].bootCount, 1);
    assertEquals(sensor.health().lastBootCause, "none");
    assertEquals(sensor.health().fwVersion, "2.4.0");

    // seq runs forward (gaps are normal) and wraps 65535 → 0: not a restart
    for (const seq of [1, 30_000, 60_000, 65_535, 0, 1]) {
      await device.send(telemetryFrame(seq));
    }
    await waitFor(() => telemetry.length === 6, "six telemetry");
    assertEquals(sensor.health().bootCount, 1);

    // 300 → 5 goes backwards: a restart whose boot EVENT was lost
    await device.send(telemetryFrame(300));
    await device.send(telemetryFrame(5));
    await waitFor(() => telemetry.length === 8, "eight telemetry");
    assertEquals(sensor.health().bootCount, 2);
    assertEquals(sensor.health().lastBootCause, null);
  });
});

Deno.test("the device clock is set when it asks, and only then", async () => {
  const unknownTime = { ...TELEMETRY_VALUES, timeValid: false, statusFlags: 4 };
  const setTimes = (device: FakeDevice) =>
    device.commands.filter((c) => c.values.setTime !== undefined);

  // the device does not know the time: setTime (from the second frame on —
  // the sync is enabled by the first)
  await withSensor({ timeSync: true }, async ({ devices }) => {
    await devices[0].send(buildFrame(unknownTime, { seq: 1, timestamp: 60 }));
    await devices[0].send(buildFrame(unknownTime, { seq: 2, timestamp: 61 }));
    await waitFor(() => setTimes(devices[0]).length === 1, "setTime");
    const epoch = Number(setTimes(devices[0])[0].values.setTime);
    assert(Math.abs(epoch - Date.now() / 1000) < 5, "the host's UTC seconds");
  });

  // it knows the time: nothing is written to it
  await withSensor({ timeSync: true }, async ({ devices, telemetry }) => {
    await devices[0].send(telemetryFrame(1));
    await devices[0].send(telemetryFrame(2));
    await waitFor(() => telemetry.length === 2, "telemetry");
    await sleep(30);
    assertEquals(setTimes(devices[0]), []);
  });

  // the host clock is unset (1970): never sent, it would wreck a good RTC
  await withSensor(
    { timeSync: true, now: () => 86_400_000, staleMs: 1e12 },
    async ({ devices, telemetry }) => {
      await devices[0].send(buildFrame(unknownTime, { seq: 1, timestamp: 60 }));
      await devices[0].send(buildFrame(unknownTime, { seq: 2, timestamp: 61 }));
      await waitFor(() => telemetry.length === 2, "telemetry");
      await sleep(30);
      assertEquals(setTimes(devices[0]), []);
    },
  );
});

Deno.test("unknown tags are reported, not fatal", async () => {
  await withSensor({}, async ({ sensor, devices, telemetry }) => {
    await devices[0].send(
      buildFrame(TELEMETRY_VALUES, {}, [{ tag: 99, fmt: "u16", value: 1 }]),
    );
    await waitFor(() => telemetry.length === 1, "telemetry");
    assertEquals(sensor.health().unknownTags, [99]);
  });
});

Deno.test("an open that fails is retried, and stop() ends the loop", async () => {
  let attempts = 0;
  const sensor = new HourMeterSensor(new EventEmitter(), {
    target: "/dev/does-not-exist",
    reconnectDelayMs: 10,
    open: () => {
      attempts += 1;
      return Promise.reject(new Error("No such file or directory"));
    },
  });
  sensor.start();
  await waitFor(() => attempts >= 3, "three attempts");
  const health = sensor.health();
  assertEquals(health.status, "ERROR");
  assertEquals(health.link, "serial");
  assertEquals(health.lastError, "No such file or directory");

  await sensor.stop();
  const after = attempts;
  await sleep(40);
  assertEquals(attempts, after, "no attempt after stop()");
  assertEquals(sensor.status, "STOP");
});
