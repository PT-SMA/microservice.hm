import { assert, assertEquals, assertRejects } from "@std/assert";
import { MainApp } from "app";
import { GPS_CHANNEL, HM_CHANNELS } from "consts";
import type { ImuSource } from "direction";
import { HourMeterCommandHandler, type ImuSourceControl } from "handlers";
import { parseCommand } from "helpers";
import { linkPair } from "hour-meter";
import type { HourMeterImuSourceState, HourMeterReply } from "types";
import { sleep } from "./_helpers.ts";

/**
 * The IMU switched at runtime (`setImuSource` on `hour-meter:command`, from
 * geofencer's dev console): the travel direction, `hour-meter:imu` and
 * roll/pitch move to the other IMU, and the choice is kept in
 * `hour-meter:imu-source` across a restart until it is cleared.
 */

// a closed port: the WT61 link only has to exist, not to deliver
const NO_DRIVER = "tcp://127.0.0.1:1";

function app(
  imuSource: string,
  options: {
    stored?: string | null;
    direction?: boolean;
    failWrite?: boolean;
  } = {},
) {
  const [host] = linkPair();
  const published: Array<[string, string]> = [];
  const listeners = new Map<string, (message: string) => unknown>();
  const store = { value: options.stored ?? null as string | null };
  const main = new MainApp({
    publisher: {
      publish: (channel, message) => {
        published.push([channel, message]);
        return Promise.resolve(1);
      },
      replaceHash: () => Promise.resolve(1),
      mergeHash: () => Promise.resolve(1),
    },
    redis: {
      connect: () => Promise.resolve(),
      subscribe: (channel, listener) => {
        listeners.set(channel, listener);
        return Promise.resolve();
      },
      status: () => ({
        connected: true,
        pubConnected: true,
        subConnected: true,
      }),
      readImuSource: () => Promise.resolve(store.value),
      writeImuSource: (value) => {
        if (options.failWrite) return Promise.reject(new Error("Redis down"));
        store.value = value;
        return Promise.resolve();
      },
    },
    sensor: {
      target: "tcp://fake:1",
      open: () => Promise.resolve(host),
      timeSync: false,
      staleMs: 60_000,
    },
    direction: {
      enabled: options.direction ?? true,
      forwardAxis: "+x",
      tickMs: null,
    },
    imuSource,
    wt61: { url: NO_DRIVER },
    imuHz: 10,
  });
  /** One `hour-meter:command`, answered on `hour-meter:reply`. */
  const command = async (body: Record<string, unknown>) => {
    const requestId = crypto.randomUUID();
    await listeners.get(HM_CHANNELS.command)!(
      JSON.stringify({ requestId, ...body }),
    );
    const reply = published.find(([c, m]) =>
      c === HM_CHANNELS.reply && JSON.parse(m).requestId === requestId
    );
    return JSON.parse(reply![1]) as HourMeterReply;
  };
  const health = async () =>
    await (await main.fetch(new Request("http://x/health"))).json();
  return { main, store, listeners, command, health };
}

Deno.test("the IMU actions parse, with their imuSource", () => {
  assertEquals(
    parseCommand(
      JSON.stringify({
        requestId: "r",
        action: "setImuSource",
        imuSource: "wit",
      }),
    ),
    {
      requestId: "r",
      action: "setImuSource",
      settings: undefined,
      imuSource: "wit",
    },
  );
  const unknown = parseCommand(
    JSON.stringify({ requestId: "r", action: "reboot" }),
  );
  assert(unknown !== null && "error" in unknown);
  assert(unknown.error.includes("getImuSource, setImuSource"));
});

Deno.test("the command handler reads and switches the IMU, and refuses what is not hm, wit or null", async () => {
  const replies: HourMeterReply[] = [];
  const asked: Array<ImuSource | null> = [];
  let state: HourMeterImuSourceState = {
    source: "hour-meter",
    configured: "hour-meter",
    override: null,
  };
  const control: ImuSourceControl = {
    get: () => state,
    set: (source) => {
      asked.push(source);
      if (source === "hour-meter") return Promise.reject(new Error("boom"));
      state = { ...state, source: source ?? "hour-meter", override: source };
      return Promise.resolve(state);
    },
  };
  const device = {
    command: () => Promise.reject(new Error("no device here")),
    currentDeviceId: () => null,
  };
  const publisher = {
    publish: (_: string, message: string) => {
      replies.push(JSON.parse(message));
      return Promise.resolve(1);
    },
  };
  const handler = new HourMeterCommandHandler(device, publisher, control);
  const send = (body: Record<string, unknown>) =>
    handler.handle(
      JSON.stringify({ requestId: `r${replies.length}`, ...body }),
    );

  await send({ action: "getImuSource" });
  await send({ action: "setImuSource", imuSource: "wit" });
  await send({ action: "setImuSource", imuSource: null });
  await send({ action: "setImuSource", imuSource: "both" });
  await send({ action: "setImuSource" });
  await send({ action: "setImuSource", imuSource: "hm" });

  assertEquals(replies.map((r) => r.status), [
    "ok",
    "ok",
    "ok",
    "invalid",
    "invalid",
    "error",
  ]);
  assertEquals(replies[0].imu?.source, "hour-meter");
  assertEquals(replies[1].imu, {
    source: "wt61",
    configured: "hour-meter",
    override: "wt61",
  });
  assertEquals(asked, ["wt61", null, "hour-meter"]);
  assertEquals(replies[5].message, "boom");

  // a handler that was given no control says so
  const bare = new HourMeterCommandHandler(device, publisher);
  await bare.handle(JSON.stringify({ requestId: "x", action: "getImuSource" }));
  assertEquals(replies.at(-1)?.status, "invalid");
});

Deno.test("setImuSource over hour-meter:command: switched, kept, and cleared back to the env", async () => {
  const { main, store, command, health } = app("hm");
  try {
    await sleep(30);
    assertEquals(main.imuSource, "hour-meter");

    const toWit = await command({ action: "setImuSource", imuSource: "wit" });
    assertEquals(toWit.status, "ok");
    assertEquals(toWit.imu, {
      source: "wt61",
      configured: "hour-meter",
      override: "wt61",
    });
    assertEquals(store.value, "wit");
    assertEquals(main.imu?.source, "wt61");
    assertEquals(
      main.direction?.imuSource,
      "wt61",
      "direction starts over on it",
    );
    assert(main.wt61 !== undefined, "the WT61 is read");
    assertEquals((await health()).imuSourceOverride, "wt61");

    const read = await command({ action: "getImuSource" });
    assertEquals(read.imu?.source, "wt61");

    const back = await command({ action: "setImuSource", imuSource: null });
    assertEquals(back.imu, {
      source: "hour-meter",
      configured: "hour-meter",
      override: null,
    });
    assertEquals(store.value, null);
    assertEquals(main.wt61, undefined, "the WT61 link is closed");
    assertEquals(main.direction?.imuSource, "hour-meter");
    assert(!("imuSourceOverride" in await health()));
  } finally {
    await main.stop();
  }
});

Deno.test("a choice kept before a restart wins over the env once Redis connects; a bad one is ignored", async () => {
  const kept = app("hm", { stored: "wit" });
  const garbage = app("hm", { stored: "gyro" });
  try {
    await sleep(50);
    assertEquals(kept.main.imuSource, "wt61");
    assertEquals(kept.main.imuOverride, "wt61");
    assertEquals(garbage.main.imuSource, "hour-meter");
    assertEquals(garbage.main.imuOverride, null);
  } finally {
    await Promise.all([kept.main.stop(), garbage.main.stop()]);
  }
});

Deno.test("an IMU that could not be stored is not switched to", async () => {
  const { main } = app("hm", { failWrite: true });
  try {
    await sleep(30);
    await assertRejects(() => main.setImuSource("wt61"), Error, "Redis down");
    assertEquals(main.imuSource, "hour-meter");
    assertEquals(main.wt61, undefined);
  } finally {
    await main.stop();
  }
});

Deno.test("switching from no IMU to one starts the travel direction, and its GPS feed", async () => {
  const { main, listeners } = app("both");
  try {
    await sleep(30);
    assertEquals(main.direction, undefined);
    assert(!listeners.has(GPS_CHANNEL));
    await main.setImuSource("hour-meter");
    assertEquals(main.direction?.imuSource, "hour-meter");
    assert(listeners.has(GPS_CHANNEL), "subscribed once there is a direction");
  } finally {
    await main.stop();
  }
});
