import { assert, assertEquals, assertMatch } from "@std/assert";
import { HM_CHANNELS, HM_STATE_KEY } from "consts";
import { HourMeterHandler } from "handlers";
import type { HourMeterPublisher } from "types";
import { collectRejections, decodeCatalog, sleep } from "./_helpers.ts";

/**
 * The Redis surface is a contract with geofencer
 * (FMS-Backend/docs/ecosystem/integrations/hm-to-geofencer.md). These tests
 * record what would be written instead of talking to Redis.
 */

type Call =
  | { op: "publish"; channel: string; message: string }
  | {
    op: "replaceHash" | "mergeHash";
    key: string;
    fields: Record<string, string>;
  };

/** Records every call; `failWith` makes them reject, like a dead Redis. */
function recordingPublisher() {
  const calls: Call[] = [];
  const state: { failWith: Error | null } = { failWith: null };
  const settle = () =>
    state.failWith ? Promise.reject(state.failWith) : Promise.resolve(1);
  const publisher: HourMeterPublisher = {
    publish: (channel, message) => {
      calls.push({ op: "publish", channel, message });
      return settle();
    },
    replaceHash: (key, fields) => {
      calls.push({ op: "replaceHash", key, fields });
      return settle();
    },
    mergeHash: (key, fields) => {
      calls.push({ op: "mergeHash", key, fields });
      return settle();
    },
  };
  return { publisher, calls, state };
}

const published = (calls: Call[], channel: string) =>
  calls.flatMap((c) =>
    c.op === "publish" && c.channel === channel ? [JSON.parse(c.message)] : []
  );

Deno.test("TELEMETRY writes the state hash, then publishes the update", async () => {
  const { publisher, calls } = recordingPublisher();

  await new HourMeterHandler(publisher).handle(decodeCatalog("telemetry"));

  assertEquals(calls.map((c) => c.op), ["replaceHash", "publish"]);
  const [hash, pub] = calls;
  assertEquals(hash.op === "replaceHash" && hash.key, HM_STATE_KEY);
  assertEquals(pub.op === "publish" && pub.channel, HM_CHANNELS.update);
});

Deno.test("every contracted field survives the publish", async () => {
  /**
   * Asserted as a whole set, not a sample: a field silently dropped between
   * the mapping and the publish is exactly how microservice.gps shipped
   * without `uuid` for months (ECO-01).
   */
  const { publisher, calls } = recordingPublisher();
  await new HourMeterHandler(publisher).handle(decodeCatalog("telemetry"));

  const [update] = published(calls, HM_CHANNELS.update);
  assertEquals(Object.keys(update).sort(), [
    "deviceId",
    "engineRunning",
    "headingDeg",
    "hourMeterH",
    "hourMeterS",
    "measuredAt",
    "pitchDeg",
    "receivedAt",
    "rollDeg",
    "statusFlagNames",
    "statusFlags",
    "timeValid",
    "totalizerPulses",
    "totalizerUnits",
    "uuid",
    "vibPeakMg",
    "vibRmsMg",
  ]);
});

Deno.test("every message carries its own v4 uuid", async () => {
  const { publisher, calls } = recordingPublisher();
  const handler = new HourMeterHandler(publisher);

  await handler.handle(decodeCatalog("telemetry"));
  await handler.handle(decodeCatalog("telemetry"));

  const uuids = published(calls, HM_CHANNELS.update).map((u) => u.uuid);
  assertEquals(uuids.length, 2);
  for (const uuid of uuids) {
    assertMatch(
      uuid,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  }
  assert(uuids[0] !== uuids[1], "a uuid is per message, not per device");
});

Deno.test("the state hash carries the latest reading as strings", async () => {
  const { publisher, calls } = recordingPublisher();
  await new HourMeterHandler(publisher).handle(decodeCatalog("telemetry"));

  const hash = calls[0].op === "replaceHash" ? calls[0].fields : {};
  assertEquals(hash.hourMeterS, "4500000");
  assertEquals(hash.engineRunning, "true");
  assertEquals(hash.bootCount, "0");
});

Deno.test("a boot EVENT is published and its facts stay in the hash", async () => {
  const { publisher, calls } = recordingPublisher();
  const handler = new HourMeterHandler(publisher);

  await handler.handle(decodeCatalog("event-boot"), { bootCount: 1 });
  await handler.handle(decodeCatalog("telemetry"));

  const [event] = published(calls, HM_CHANNELS.event);
  assertEquals(event.kind, "boot");
  assertEquals(event.bootCount, 1);

  const merge = calls.find((c) => c.op === "mergeHash");
  assertEquals(merge?.op === "mergeHash" && merge.fields.fwVersion, "2.4.0");

  // the next replace keeps them: a replace must not erase the boot facts
  const replace = calls.findLast((c) => c.op === "replaceHash");
  const fields = replace?.op === "replaceHash" ? replace.fields : {};
  assertEquals(fields.fwVersion, "2.4.0");
  assertEquals(fields.bootCount, "1");
  assertEquals(fields.lastBootCause, "none");
});

Deno.test("the IMU stream and ACKs are not forwarded", async () => {
  const { publisher, calls } = recordingPublisher();
  const handler = new HourMeterHandler(publisher);

  await handler.handle(decodeCatalog("imu-filtered"));
  await handler.handle(decodeCatalog("ack-ok"));

  assertEquals(calls, []);
});

Deno.test("a dead Redis is swallowed, and nothing is published past a failed write", async () => {
  const rejections = collectRejections();
  const { publisher, calls, state } = recordingPublisher();
  state.failWith = new Error("The client is closed");

  try {
    await new HourMeterHandler(publisher).handle(decodeCatalog("telemetry"));
    await sleep(10);

    assertEquals(rejections.seen, []);
    // rule 13: no publish when the write it describes did not happen
    assertEquals(calls.map((c) => c.op), ["replaceHash"]);
  } finally {
    rejections.stop();
  }
});
