import { Hono } from "hono";
import { EventEmitter } from "node:events";
import {
  GPS_CHANNEL,
  HM_CHANNELS,
  HM_EVENTS,
  HOUR_METER_DIRECTION,
  HOUR_METER_DIRECTION_RECORD,
  HOUR_METER_FORWARD_AXIS,
  HOUR_METER_REVERSE_MAX_KMH,
} from "consts";
import { isForwardAxis } from "direction";
import {
  AppErrorHandler,
  HourMeterCommandHandler,
  HourMeterHandler,
  TravelDirectionHandler,
} from "handlers";
import {
  DirectionRecorder,
  redisClient,
  redisPubClient,
  redisSubscriberClient,
} from "modules";
import { HourMeterSensor, type HourMeterSensorOptions } from "sensors";
import type { HourMeterPublisher } from "types";
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
  private subscribed = new Set<string>();
  private redis: RedisLink;
  private redisRetry?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private deps: AppDeps = {}) {
    // the version before anything else can fail
    console.log(`${this.name} v${this.version} starting`);
    this.handler = new HourMeterHandler(deps.publisher, {
      direction: () => this.direction?.snapshot() ?? null,
    });
    this.redis = deps.redis ?? redisLink;

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
        ...(this.direction ? { direction: this.direction.health() } : {}),
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
    this.initDirection();
  }

  private initSensor() {
    this.sensor = new HourMeterSensor(this.emitter, this.deps.sensor);
    this.commandHandler = new HourMeterCommandHandler(
      this.sensor,
      this.deps.publisher,
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
        await this.subscribeOnce(GPS_CHANNEL, this.direction.onGpsMessage);
      }
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
   * Travel direction (forward / reversing / stopped) from the IMU stream and
   * microservice.gps. Off with HOUR_METER_DIRECTION=false (excavators); an
   * invalid HOUR_METER_FORWARD_AXIS is logged and switches it off — it must
   * not stop the hour meter.
   */
  private initDirection() {
    const d = this.deps.direction ?? {};
    if (!(d.enabled ?? HOUR_METER_DIRECTION)) return;
    const axis = d.forwardAxis ?? HOUR_METER_FORWARD_AXIS;
    if (!isForwardAxis(axis)) {
      console.error(
        `HOUR_METER_FORWARD_AXIS=${axis} is not one of +x, -x, +y, -y: travel direction is off`,
      );
      return;
    }
    const recordDir = d.recordDir ?? HOUR_METER_DIRECTION_RECORD;
    this.direction = new TravelDirectionHandler({
      forwardAxis: axis,
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
    await this.sensor?.stop();
  }
}
