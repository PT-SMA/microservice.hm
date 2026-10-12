import { Hono } from "hono";
import { EventEmitter } from "node:events";
import { HM_CHANNELS, HM_EVENTS } from "consts";
import {
  AppErrorHandler,
  HourMeterCommandHandler,
  HourMeterHandler,
} from "handlers";
import { redisClient, redisPubClient, redisSubscriberClient } from "modules";
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
  private subscribed = false;
  private redis: RedisLink;
  private redisRetry?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private deps: AppDeps = {}) {
    // the version before anything else can fail
    console.log(`${this.name} v${this.version} starting`);
    this.handler = new HourMeterHandler(deps.publisher);
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
      const health = { ...this.sensor.health(), redis: this.redis.status() };
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
      // geofencer's settings commands; once — node-redis re-subscribes itself
      if (!this.subscribed && this.commandHandler) {
        await this.redis.subscribe(
          HM_CHANNELS.command,
          this.commandHandler.handle,
        );
        this.subscribed = true;
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

  /** Close the device link cleanly (SIGTERM, tests). */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.redisRetry);
    await this.sensor?.stop();
  }
}
