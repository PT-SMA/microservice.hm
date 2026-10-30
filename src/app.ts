import { Hono } from "hono";
import { EventEmitter } from "node:events";
import {
  GPS_CHANNEL,
  HM_CHANNELS,
  HM_EVENTS,
  HM_IMU_SOURCE_KEY,
  HOUR_METER_DIRECTION,
  HOUR_METER_DIRECTION_RECORD,
  HOUR_METER_FORWARD_AXIS,
  HOUR_METER_IMU_HZ,
  HOUR_METER_IMU_SOURCE,
  HOUR_METER_REVERSE_MAX_KMH,
  WT61_FORWARD_AXIS,
  WT61_URL,
  WT61_URL_SET,
} from "consts";
import { type ForwardAxis, type ImuSource, isForwardAxis } from "direction";
import {
  AppErrorHandler,
  HourMeterCommandHandler,
  HourMeterHandler,
  ImuPublishHandler,
  TravelDirectionHandler,
} from "handlers";
import { type MessageContext, parseImuSource } from "helpers";
import {
  DirectionRecorder,
  redisClient,
  redisPubClient,
  redisPublisher,
  redisSubscriberClient,
} from "modules";
import {
  HourMeterSensor,
  type HourMeterSensorOptions,
  Wt61Link,
  type Wt61LinkOptions,
} from "sensors";
import type { HourMeterImuSourceState, HourMeterPublisher } from "types";
/**
 * The version comes from `package.json`, the only place it lives: changesets
 * writes it, and it is strict JSON. `deno.json` is JSONC, and importing it
 * with `{ type: "json" }` once kept microservice.gps from starting at all.
 */
import config from "../package.json" with { type: "json" };

/** The Redis connection, as far as the app needs to know it. */
export interface RedisLink {
  connect(): Promise<void>;
  /** On the subscriber connection, which does nothing else. */
  subscribe(
    channel: string,
    listener: (message: string) => unknown,
  ): Promise<void>;
  status(): {
    connected: boolean;
    pubConnected: boolean;
    subConnected: boolean;
  };
  /**
   * `hour-meter:imu-source`, the IMU chosen at runtime. Without these the
   * choice is not kept across a restart.
   */
  readImuSource?(): Promise<string | null>;
  writeImuSource?(value: string | null): Promise<void>;
}

const redisLink: RedisLink = {
  async connect() {
    if (!redisClient.isOpen) await redisClient.connect();
    if (!redisPubClient.isOpen) await redisPubClient.connect();
    if (!redisSubscriberClient.isOpen) await redisSubscriberClient.connect();
  },
  subscribe: (channel, listener) =>
    redisSubscriberClient.subscribe(channel, (message) => {
      void listener(message);
    }),
  readImuSource: () => redisClient.get(HM_IMU_SOURCE_KEY),
  async writeImuSource(value) {
    if (value === null) await redisClient.del(HM_IMU_SOURCE_KEY);
    else await redisClient.set(HM_IMU_SOURCE_KEY, value);
  },
  status: () => ({
    connected: redisClient.isReady,
    pubConnected: redisPubClient.isReady,
    subConnected: redisSubscriberClient.isReady,
  }),
};

/** Everything the app talks to, replaceable in tests. */
export interface AppDeps {
  sensor?: HourMeterSensorOptions;
  publisher?: HourMeterPublisher;
  redis?: RedisLink;
  /** travel direction; defaults to the HOUR_METER_DIRECTION* env */
  direction?: {
    enabled?: boolean;
    forwardAxis?: string;
    reverseMaxKmh?: number;
    /** null: no staleness timer (tests call tick) */
    tickMs?: number | null;
    recordDir?: string;
  };
  /** `hm` or `wit`; defaults to HOUR_METER_IMU_SOURCE */
  imuSource?: string;
  /** wt61-driver, read with `imuSource` `wit`; defaults to the WT61_* env */
  wt61?: Partial<Omit<Wt61LinkOptions, "url">> & {
    url?: string;
    forwardAxis?: string;
  };
  /** `hour-meter:imu` messages per second; defaults to HOUR_METER_IMU_HZ */
  imuHz?: number;
}

export class MainApp {
  readonly name = "microservice.hm";
  readonly version: string = config.version;
  sensor?: HourMeterSensor;

  private app = new Hono();
  private emitter = new EventEmitter({ captureRejections: true });
  private errorHandler = new AppErrorHandler();
  private handler: HourMeterHandler;
  private commandHandler?: HourMeterCommandHandler;
  /** the travel-direction estimator's feed, when the feature is on */
  direction?: TravelDirectionHandler;
  /** the IMU HOUR_METER_IMU_SOURCE selects; undefined when it is invalid */
  imuSource?: ImuSource;
  /** wt61-driver, with HOUR_METER_IMU_SOURCE=wit */
  wt61?: Wt61Link;
  /** the selected IMU on `hour-meter:imu` */
  imu?: ImuPublishHandler;
  /** the runtime choice (`setImuSource`), overriding HOUR_METER_IMU_SOURCE */
  imuOverride: ImuSource | null = null;
  /** IMU switches, one at a time */
  private imuQueue: Promise<unknown> = Promise.resolve();
  private imuRestored = false;
  private redisUp = false;
  private subscribed = new Set<string>();
  private redis: RedisLink;
  private redisRetry?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private deps: AppDeps = {}) {
    // the version before anything else can fail
    console.log(`${this.name} v${this.version} starting`);
    this.handler = new HourMeterHandler(deps.publisher, {
      direction: () => this.direction?.snapshot() ?? null,
      imu: () => this.imuContext(),
    });
    this.redis = deps.redis ?? redisLink;
    // the travel direction is rebuilt when the IMU is switched; the GPS
    // subscription is made once, so it goes through this
    this.onGps = this.onGps.bind(this);

    /**
     * `init` cannot be awaited here, so its rejection would have nowhere to
     * go — and an unhandled rejection terminates Deno. A cab box powers up
     * with the whole stack cold; Redis being late must not stop the reader.
     */
    this.init().catch((err) =>
      console.error(`${this.name} initialization failed:`, err)
    );
  }

  fetch = (req: Request): Response | Promise<Response> => this.app.fetch(req);

  /**
   * Order matters (microservice.gps learned it the hard way): routes first,
   * because `main.ts` serves as soon as the constructor returns; then the
   * reader, which needs no Redis — readings it cannot publish are dropped,
   * but reading, health and the device clock sync go on; then Redis.
   */
  private async init() {
    this.initRoutes();
    this.initEvents();
    this.initSensor();
    await this.connectRedis(0);
  }

  private initRoutes() {
    this.app.get("/", (c) =>
      c.json({
        app: this.name,
        description:
          "Reads the hour meter / totalizer over serial and publishes it on the vehicle's Redis",
        version: this.version,
      }));

    /**
     * "Is the hour meter alive?" — 503 unless TELEMETRY arrived within
     * HOUR_METER_STALE_MS, so a container healthcheck can use the status code.
     * `redis` is reported but does not make it unhealthy: restarting this
     * service cannot fix Redis, and reopening a USB port reboots the device.
     */
    this.app.get("/health", (c) => {
      if (this.sensor === undefined) {
        return c.json({ healthy: false, status: "STARTING" }, 503);
      }
      const health = {
        ...this.sensor.health(),
        redis: this.redis.status(),
        ...(this.imuSource ? { imuSource: this.imuSource } : {}),
        ...(this.imuOverride ? { imuSourceOverride: this.imuOverride } : {}),
        ...(this.direction ? { direction: this.direction.health() } : {}),
        ...(this.wt61 ? { wt61: this.wt61.health() } : {}),
      };
      return c.json(health, health.healthy ? 200 : 503);
    });

    this.app.onError(this.errorHandler.handle);
    this.app.notFound(this.errorHandler.handle404);
  }

  private initEvents() {
    /**
     * `captureRejections: true` turns a rejected async listener into an
     * `'error'` event, and an `'error'` with no listener is thrown — killing
     * the process. The handler never rejects; this is the second line.
     */
    this.emitter.on(
      "error",
      (err: unknown) =>
        console.error(
          "hour-meter emitter error (the reader keeps running):",
          err,
        ),
    );
    this.emitter.on(HM_EVENTS.telemetry, this.handler.handle);
    this.emitter.on(HM_EVENTS.event, this.handler.handle);
    this.startImu(this.configuredImu());
  }

  /** HOUR_METER_IMU_SOURCE, as given. */
  private configuredImu(): string {
    return this.deps.imuSource ?? HOUR_METER_IMU_SOURCE;
  }

  /** The IMU `raw` names, and the travel direction on it. */
  private startImu(raw: string) {
    const imu = this.initImu(raw);
    this.initDirection(imu);
    // after every listener is on: its first link event must reach them
    this.wt61?.start();
  }

  /** Everything `startImu` made, unhooked and closed. */
  private async stopImu() {
    this.imu?.detach(this.emitter);
    this.direction?.detach(this.emitter);
    this.direction?.stop();
    await this.wt61?.stop();
    this.imu = undefined;
    this.direction = undefined;
    this.wt61 = undefined;
    this.imuSource = undefined;
  }

  private onGps(message: string) {
    this.direction?.onGpsMessage(message);
  }

  /** Which IMU is in use, what the env says, and the runtime choice. */
  imuState(): HourMeterImuSourceState {
    return {
      source: this.imuSource ?? null,
      configured: parseImuSource(this.configuredImu()),
      override: this.imuOverride,
    };
  }

  /**
   * Switch to `source` and keep it in `hour-meter:imu-source`, so a restart
   * comes back to it; null deletes it and goes back to HOUR_METER_IMU_SOURCE.
   * The travel direction starts over on the new IMU. Kept first: when it
   * cannot be stored nothing changes (and it throws).
   */
  setImuSource(source: ImuSource | null): Promise<HourMeterImuSourceState> {
    const run = this.imuQueue.then(async () => {
      if (this.redis.writeImuSource) {
        await this.redis.writeImuSource(
          source === null ? null : source === "wt61" ? "wit" : "hm",
        );
      }
      this.imuOverride = source;
      await this.switchImu(source === null ? this.configuredImu() : source);
      return this.imuState();
    });
    this.imuQueue = run.catch(() => {});
    return run;
  }

  /** Rebuild on the IMU `raw` names, unless it is the one in use. */
  private async switchImu(raw: string) {
    const wanted = parseImuSource(raw);
    if (wanted !== null && wanted === this.imuSource) return;
    await this.stopImu();
    this.startImu(raw);
    console.log(`IMU switched: now ${this.imuSource ?? "none"}`);
    if (this.direction && this.redisUp) {
      await this.subscribeOnce(GPS_CHANNEL, this.onGps).catch((err) =>
        console.error(
          `could not subscribe to ${GPS_CHANNEL}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      );
    }
  }

  /**
   * At the first Redis connection: a runtime choice stored before a restart
   * replaces HOUR_METER_IMU_SOURCE. One that cannot be read, or is neither hm
   * nor wit, is logged and ignored.
   */
  private async restoreImuSource() {
    if (this.imuRestored || !this.redis.readImuSource) return;
    this.imuRestored = true;
    try {
      const stored = await this.redis.readImuSource();
      if (stored === null) return;
      const source = parseImuSource(stored);
      if (source === null) {
        console.warn(
          `${HM_IMU_SOURCE_KEY}=${stored} is not hm or wit: ignored`,
        );
        return;
      }
      console.log(
        `IMU: ${stored} from ${HM_IMU_SOURCE_KEY}, over HOUR_METER_IMU_SOURCE=${this.configuredImu()}`,
      );
      await (this.imuQueue = this.imuQueue.then(async () => {
        this.imuOverride = source;
        await this.switchImu(source);
      }).catch(() => {}));
    } catch (err) {
      console.error(
        `could not read ${HM_IMU_SOURCE_KEY}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private initSensor() {
    this.sensor = new HourMeterSensor(this.emitter, this.deps.sensor);
    this.commandHandler = new HourMeterCommandHandler(
      this.sensor,
      this.deps.publisher,
      { get: () => this.imuState(), set: (s) => this.setImuSource(s) },
    );
    this.sensor.start();
  }

  /** 1 s, 2 s, 4 s … 30 s: a box that boots before its Redis must end up connected. */
  private async connectRedis(attempt: number): Promise<void> {
    if (this.stopped) return;
    try {
      await this.redis.connect();
      // each once — node-redis re-subscribes by itself after a reconnect
      if (this.commandHandler) {
        await this.subscribeOnce(
          HM_CHANNELS.command,
          this.commandHandler.handle,
        );
      }
      if (this.direction) {
        await this.subscribeOnce(GPS_CHANNEL, this.onGps);
      }
      this.redisUp = true;
      await this.restoreImuSource();
      if (attempt > 0) console.log("Redis connected after retry");
    } catch (err) {
      const delay = Math.min(1000 * 2 ** attempt, 30_000);
      console.error(
        `Redis connect failed, retrying in ${delay}ms: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.redisRetry = setTimeout(
        () => void this.connectRedis(attempt + 1),
        delay,
      );
    }
  }

  private async subscribeOnce(
    channel: string,
    listener: (message: string) => unknown,
  ): Promise<void> {
    if (this.subscribed.has(channel)) return;
    await this.redis.subscribe(channel, listener);
    this.subscribed.add(channel);
  }

  /**
   * The IMU `raw` names (HOUR_METER_IMU_SOURCE, or the runtime choice that
   * overrides it — `setImuSource`), for everything that uses one: the
   * travel direction, `hour-meter:imu` (whether or not travel direction is
   * on), and `rollDeg`/`pitchDeg` on `hour-meter:update`. `wit` reads
   * wt61-driver (its mount: WT61_FORWARD_AXIS); `hm` the hour meter's own
   * stream (HOUR_METER_FORWARD_AXIS). A bad setting is logged and leaves no
   * IMU (null) — the hour meter itself keeps going.
   */
  private initImu(
    raw: string,
  ): { source: ImuSource; forwardAxis: ForwardAxis } | null {
    const source = parseImuSource(raw);
    if (source === null) {
      console.error(
        `HOUR_METER_IMU_SOURCE=${raw} is not hm or wit: no IMU, and travel direction is off`,
      );
      return null;
    }
    const imu = source === "wt61" ? this.initWt61() : this.hourMeterImu();
    if (imu === null) return null;
    this.imuSource = imu.source;
    this.imu = new ImuPublishHandler({
      source: imu.source,
      forwardAxis: imu.forwardAxis,
      hz: this.deps.imuHz ?? HOUR_METER_IMU_HZ,
      publisher: this.deps.publisher ?? redisPublisher,
    });
    this.imu.attach(this.emitter);
    return imu;
  }

  private hourMeterImu():
    | { source: ImuSource; forwardAxis: ForwardAxis }
    | null {
    const axis = this.deps.direction?.forwardAxis ?? HOUR_METER_FORWARD_AXIS;
    if (!isForwardAxis(axis)) {
      console.error(
        `HOUR_METER_FORWARD_AXIS=${axis} is not one of +x, -x, +y, -y: no IMU, and travel direction is off`,
      );
      return null;
    }
    const url = this.deps.wt61?.url ?? (WT61_URL_SET ? WT61_URL : undefined);
    if (url !== undefined) {
      console.warn(
        `WT61_URL=${url} is set, but HOUR_METER_IMU_SOURCE=hm: the WT61 is not read (wit reads it)`,
      );
    }
    console.log(`IMU: the hour meter's own (HOUR_METER_FORWARD_AXIS=${axis})`);
    return { source: "hour-meter", forwardAxis: axis };
  }

  /** wt61-driver: a bad URL or axis is logged and leaves no IMU (null). */
  private initWt61(): { source: ImuSource; forwardAxis: ForwardAxis } | null {
    const w = this.deps.wt61 ?? {};
    const url = w.url ?? WT61_URL;
    const axis = w.forwardAxis ?? WT61_FORWARD_AXIS;
    if (!isForwardAxis(axis)) {
      console.error(
        `WT61_FORWARD_AXIS=${axis} is not one of +x, -x, +y, -y: no IMU, and travel direction is off`,
      );
      return null;
    }
    try {
      this.wt61 = new Wt61Link(this.emitter, { ...w, url });
    } catch (err) {
      console.error(
        `${
          err instanceof Error ? err.message : err
        }: no IMU, and travel direction is off`,
      );
      return null;
    }
    console.log(
      `IMU: a WT61 through wt61-driver at ${url} (WT61_FORWARD_AXIS=${axis})`,
    );
    return { source: "wt61", forwardAxis: axis };
  }

  /** What `hour-meter:update` takes from the selected IMU. */
  private imuContext(): MessageContext["imu"] {
    if (this.imuSource === "wt61") {
      return { source: "wt61", wt61Attitude: this.wt61?.attitude() ?? null };
    }
    return this.imuSource ? { source: this.imuSource } : undefined;
  }

  /**
   * Travel direction (forward / reversing / stopped) from the selected IMU
   * and microservice.gps. Off with HOUR_METER_DIRECTION=false (excavators) or
   * without an IMU setting that works; an invalid HOUR_METER_FORWARD_AXIS (the
   * compass's, even with a WT61) is logged and switches it off — it must not
   * stop the hour meter.
   */
  private initDirection(
    imu: { source: ImuSource; forwardAxis: ForwardAxis } | null,
  ) {
    const d = this.deps.direction ?? {};
    if (!(d.enabled ?? HOUR_METER_DIRECTION) || imu === null) return;
    const axis = d.forwardAxis ?? HOUR_METER_FORWARD_AXIS;
    if (!isForwardAxis(axis)) {
      console.error(
        `HOUR_METER_FORWARD_AXIS=${axis} is not one of +x, -x, +y, -y: travel direction is off`,
      );
      return;
    }
    const recordDir = d.recordDir ?? HOUR_METER_DIRECTION_RECORD;
    this.direction = new TravelDirectionHandler({
      forwardAxis: imu.forwardAxis,
      imuSource: imu.source,
      headingAxis: axis,
      reverseMaxKmh: d.reverseMaxKmh ?? HOUR_METER_REVERSE_MAX_KMH,
      publisher: this.handler,
      recorder: recordDir ? new DirectionRecorder(recordDir) : null,
      tickMs: d.tickMs === undefined ? 1000 : d.tickMs,
    });
    this.direction.attach(this.emitter);
    this.direction.start();
  }

  /** Close the device link cleanly (SIGTERM, tests). */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.redisRetry);
    this.direction?.stop();
    await this.wt61?.stop();
    await this.sensor?.stop();
  }
}
