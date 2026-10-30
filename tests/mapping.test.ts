import { assert, assertEquals } from "@std/assert";
import {
  formatDeviceId,
  formatFwVersion,
  toHourMeterEvent,
  toHourMeterUpdate,
  toStateHash,
} from "helpers";
import type { HourMeterUpdate } from "types";
import { decodeBuilt, decodeCatalog, TELEMETRY_VALUES } from "./_helpers.ts";

/**
 * The frame → wire mapping is the contract with geofencer
 * (FMS-Backend/docs/ecosystem/integrations/hm-to-geofencer.md). The inputs are
 * the firmware's own frames from `esp32/docs/FRAME-CATALOG.md`, which the
 * simulator proves byte-identical to what the device sends.
 */

const UUID = "f1f0a3d6-0000-4000-8000-000000000001";
const NOW = Date.parse("2026-10-12T06:00:00.000Z");
const ctx = { uuid: UUID, now: NOW };

const IMU_FIELDS = [
  "rollDeg",
  "pitchDeg",
  "imuSource",
  "headingDeg",
  "vibRmsMg",
  "vibPeakMg",
] as const;

function assertNoNulls(payload: object) {
  for (const [key, value] of Object.entries(payload)) {
    assert(value !== null, `${key} is null — optional fields are omitted`);
  }
}

Deno.test("the catalog TELEMETRY frame maps to the exact contract payload", () => {
  const update = toHourMeterUpdate(decodeCatalog("telemetry"), ctx);

  assertEquals(
    update,
    {
      uuid: UUID,
      deviceId: "1a2b3c4d",
      receivedAt: "2026-10-12T06:00:00.000Z",
      measuredAt: "2026-10-07T12:34:56.000Z",
      timeValid: true,
      hourMeterS: 4_500_000,
      hourMeterH: 1250,
      totalizerPulses: 15_000,
      totalizerUnits: 15_000,
      engineRunning: true,
      statusFlags: 0,
      statusFlagNames: [],
      rollDeg: 2.5,
      pitchDeg: -0.48,
      imuSource: "hour-meter",
      headingDeg: 33.5,
      vibRmsMg: 37,
      vibPeakMg: 103,
    } satisfies HourMeterUpdate,
  );
});

Deno.test("without an IMU the orientation fields are absent, not null", () => {
  const update = toHourMeterUpdate(decodeCatalog("telemetry-no-imu"), ctx)!;

  for (const field of IMU_FIELDS) {
    assert(!(field in update), `${field} must be omitted`);
  }
  assertEquals(update.statusFlags, 24);
  assertEquals(update.statusFlagNames, ["imuMissing", "magMissing"]);
  assertNoNulls(update);
});

Deno.test("an uptime timestamp becomes deviceUptimeS, never measuredAt", () => {
  // timeValid=false: the RTC lost the time, the header carries uptime
  const update = toHourMeterUpdate(
    decodeBuilt({ ...TELEMETRY_VALUES, timeValid: false, statusFlags: 4 }, {
      timestamp: 3600,
    }),
    ctx,
  )!;

  assertEquals(update.deviceUptimeS, 3600);
  assert(!("measuredAt" in update));
  assertEquals(update.timeValid, false);
  assertEquals(update.statusFlagNames, ["timeInvalid"]);
});

Deno.test("a tag this firmware does not know never reaches the wire", () => {
  const update = toHourMeterUpdate(
    decodeBuilt(TELEMETRY_VALUES, {}, [{ tag: 99, fmt: "u16", value: 7 }]),
    ctx,
  )!;

  assertEquals(
    Object.keys(update).filter((key) => key.startsWith("tag_")),
    [],
  );
});

Deno.test("scaled values carry no float noise", () => {
  // the codec computes 57 × 0.01 = 0.5700000000000001
  const update = toHourMeterUpdate(
    decodeBuilt({ ...TELEMETRY_VALUES, runHours: 0.57, roll: 0.57 }),
    ctx,
  )!;
  assertEquals(update.hourMeterH, 0.57);
  assertEquals(update.rollDeg, 0.57);
});

Deno.test("TELEMETRY without the counters is dropped, not half-published", () => {
  const { runSeconds: _, ...noHourMeter } = TELEMETRY_VALUES;
  assertEquals(toHourMeterUpdate(decodeBuilt(noHourMeter), ctx), null);
});

Deno.test("only TELEMETRY maps to an update, only EVENT to an event", () => {
  for (const id of ["imu-filtered", "ack-ok", "event-boot"]) {
    assertEquals(toHourMeterUpdate(decodeCatalog(id), ctx), null, id);
  }
  for (const id of ["imu-filtered", "ack-ok", "telemetry"]) {
    assertEquals(
      toHourMeterEvent(decodeCatalog(id), { ...ctx, bootCount: 0 }),
      null,
      id,
    );
  }
});

Deno.test("the boot EVENT names its cause, firmware and modules", () => {
  const event = toHourMeterEvent(decodeCatalog("event-boot"), {
    ...ctx,
    bootCount: 1,
  })!;

  assertEquals(event.kind, "boot");
  assertEquals(event.eventKind, 1);
  assertEquals(event.bootCount, 1);
  assertEquals(event.fwVersion, "2.4.0");
  assertEquals(event.resetReason, 1);
  assertEquals(event.lastCause, "none");
  assertEquals(event.lastStage, "unknown");
  assertEquals(event.devices, {
    eeprom: true,
    rtc: true,
    imu: true,
    mag: true,
  });
  assertEquals(event.safeMode, false);
  // the boot EVENT restates the counters restored from EEPROM
  assertEquals(event.hourMeterS, 4_500_000);
  assertEquals(event.totalizerUnits, 15_000);
  assertEquals(event.measuredAt, "2026-10-07T12:34:56.000Z");
  assertEquals(event.values.rtcTemp, 29.25);
  assertEquals(event.values.journalSeq, 812);
  assertNoNulls(event);
});

Deno.test("a modules-changed EVENT says which module went away", () => {
  const event = toHourMeterEvent(decodeCatalog("event-devices-changed"), {
    ...ctx,
    bootCount: 0,
  })!;

  assertEquals(event.kind, "devicesChanged");
  assertEquals(event.devices, {
    eeprom: true,
    rtc: true,
    imu: false,
    mag: false,
  });
  assertEquals(event.statusFlagNames, ["imuMissing", "magMissing"]);
  assert(!("hourMeterS" in event), "this EVENT carries no counters");
});

Deno.test("a calibration EVENT without tag 50 takes timeValid from the header", () => {
  const event = toHourMeterEvent(decodeCatalog("event-calibration"), {
    ...ctx,
    bootCount: 0,
  })!;
  assertEquals(event.kind, "calibrationDone");
  assertEquals(event.timeValid, true);
});

Deno.test("identity and version formatting", () => {
  assertEquals(formatDeviceId(0x1a2b3c4d), "1a2b3c4d");
  assertEquals(formatDeviceId(0xff), "000000ff");
  assertEquals(formatDeviceId(0xffffffff), "ffffffff");
  assertEquals(formatFwVersion(0x00020400), "2.4.0");
  assertEquals(formatFwVersion(0x000a0b0c), "10.11.12");
});

Deno.test("the state hash is flat strings and keeps boot facts", () => {
  const update = toHourMeterUpdate(decodeCatalog("telemetry-no-imu"), ctx)!;
  const hash = toStateHash(update, {
    bootCount: 2,
    fwVersion: "2.4.0",
    lastBootAt: "2026-10-12T05:00:00.000Z",
  });

  assertEquals(hash.hourMeterS, "4500000");
  assertEquals(hash.engineRunning, "true");
  assertEquals(hash.statusFlagNames, "imuMissing,magMissing");
  assertEquals(hash.bootCount, "2");
  assertEquals(hash.fwVersion, "2.4.0");
  assert(!("rollDeg" in hash));
  assert(!("lastBootCause" in hash), "undefined boot facts are omitted");
  for (const value of Object.values(hash)) assertEquals(typeof value, "string");
});
