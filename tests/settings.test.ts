import { assert, assertEquals } from "@std/assert";
import { HM_READ_ONLY_SETTINGS } from "consts";
import {
  parseCommand,
  readSettings,
  settingsSchema,
  validateSettings,
} from "helpers";
import { decodeCatalog } from "./_helpers.ts";

/**
 * What geofencer may read and change on the device, decided before anything
 * reaches it. The ACK is the firmware's own `get=2` answer from
 * esp32/docs/FRAME-CATALOG.md.
 */

Deno.test("settings are read by name, btPin never, f32 without float32 noise", () => {
  const settings = readSettings(decodeCatalog("ack-get-settings"));

  assertEquals(settings.telemetryIntervalMs, 1000);
  assertEquals(settings.pulsesPerUnit, 1);
  assertEquals(settings.altActiveHigh, false);
  assertEquals(settings.output, 1, "read-only, but readable");
  assertEquals(settings.kalmanQAccel, 0.0005, "not 0.0005000000237487257");
  assertEquals(settings.kalmanQGyro, 0.01);
  assert(!("btPin" in settings), "the Bluetooth PIN never leaves the box");
  assert(!("ackSeq" in settings) && !("ackStatus" in settings));
  assertEquals(Object.keys(settings).length, 18, "19 settings minus btPin");
});

Deno.test("the schema says how each setting may be set", () => {
  const schema = settingsSchema();

  assertEquals(schema.telemetryIntervalMs, {
    type: "integer",
    min: 100,
    max: 60000,
    unit: "ms",
    help: "TELEMETRY period",
    writable: true,
  });
  assertEquals(schema.altActiveHigh.type, "boolean");
  assertEquals(schema.kalmanQAccel.type, "number");
  assertEquals(schema.streamMode.options, {
    off: 0,
    raw: 1,
    filtered: 2,
    both: 3,
  });
  for (const name of ["output", "uartBaud", "bluetooth"]) {
    assertEquals(schema[name].writable, false, name);
  }
  assert(!("btPin" in schema));
});

Deno.test("a valid change passes whole", () => {
  assertEquals(
    validateSettings({
      telemetryIntervalMs: 2000,
      pulsesPerUnit: 100,
      altActiveHigh: true,
      kalmanQAccel: 0.001,
    }),
    {
      ok: true,
      values: {
        telemetryIntervalMs: 2000,
        pulsesPerUnit: 100,
        altActiveHigh: true,
        kalmanQAccel: 0.001,
      },
    },
  );
});

Deno.test("settings that can cut the link are refused, by name", () => {
  for (const name of HM_READ_ONLY_SETTINGS.filter((n) => n !== "btPin")) {
    const check = validateSettings({ [name]: name === "bluetooth" ? true : 2 });
    assert(!check.ok);
    assertEquals(check.setting, name);
    assert(check.message.includes("configurator"), check.message);
  }
  // btPin does not even admit to existing
  const pin = validateSettings({ btPin: 1 });
  assert(!pin.ok);
  assertEquals(pin.message, "unknown setting 'btPin'");
});

Deno.test("every bad value is refused with the reason, and nothing passes", () => {
  const cases: Array<[unknown, string, string]> = [
    [{ nope: 1 }, "nope", "unknown setting 'nope'"],
    [
      { telemetryIntervalMs: 50 },
      "telemetryIntervalMs",
      "between 100 and 60000 ms",
    ],
    [{ telemetryIntervalMs: 1500.5 }, "telemetryIntervalMs", "an integer"],
    [{ telemetryIntervalMs: "2000" }, "telemetryIntervalMs", "an integer"],
    [{ altActiveHigh: 1 }, "altActiveHigh", "true or false"],
    [{ kalmanQGyro: Infinity }, "kalmanQGyro", "a number"],
    [{ kalmanQGyro: 20 }, "kalmanQGyro", "between"],
    // all or nothing: the good one is not applied either
    [{ pulsesPerUnit: 10, output: 3 }, "output", "cannot be changed remotely"],
  ];
  for (const [input, setting, fragment] of cases) {
    const check = validateSettings(input);
    assert(!check.ok, JSON.stringify(input));
    assertEquals(check.setting, setting);
    assert(check.message.includes(fragment), `${check.message} ∌ ${fragment}`);
  }
  for (const input of [null, [], "x", {}]) {
    assert(!validateSettings(input).ok, JSON.stringify(input));
  }
});

Deno.test("a command parses; without a requestId there is nobody to answer", () => {
  assertEquals(parseCommand('{"requestId":"r1","action":"getSettings"}'), {
    requestId: "r1",
    action: "getSettings",
    settings: undefined,
    imuSource: undefined,
  });
  assertEquals(parseCommand('{"requestId":"r2","action":"reboot"}'), {
    requestId: "r2",
    error:
      "unknown action 'reboot' (getSettings, setSettings, getImuSource, setImuSource)",
  });
  for (
    const message of ["", "nope", "[]", "null", '{"action":"getSettings"}']
  ) {
    assertEquals(parseCommand(message), null, message);
  }
});
