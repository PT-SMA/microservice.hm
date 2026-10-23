import {
  HM_EVENTS,
  HOUR_METER_BAUD,
  HOUR_METER_BT_PIN,
  HOUR_METER_PORT,
  HOUR_METER_RECONNECT_DELAY_MS,
  HOUR_METER_STALE_MS,
  HOUR_METER_TIME_SYNC,
  LOGGING,
  MIN_PLAUSIBLE_HOST_TIME_MS,
} from "consts";
import { formatDeviceId, formatFwVersion } from "helpers";
import {
  ACK_STATUS,
  AckError,
  type DecodedMessage,
  decodeStatusFlags,
  DeviceClient,
  GET,
  LAST_CAUSE,
  LAST_STAGE,
  type Link,
  MSG,
  openLink,
} from "hour-meter";
import type { EventEmitter } from "node:events";
import { Sensor, type SensorStatus } from "./sensor.ts";

export interface HourMeterSensorOptions {
  /** Serial path or `tcp://host:port`. Default `HOUR_METER_PORT`. */
  target?: string;
  baud?: number;
  /** Bluetooth session PIN. */
  pin?: string;
  staleMs?: number;
  reconnectDelayMs?: number;
  timeSync?: boolean;
  watchdogIntervalMs?: number;
  probeTimeoutMs?: number;
  /** Tests pass one end of `linkPair()`. */
  open?: (target: string, baud: number) => Promise<Link>;
  now?: () => number;
}

/** `GET /health`. Not the wire contract — nulls mean "not seen yet". */
export interface HourMeterHealth {
  /** TELEMETRY seen within `staleMs` on an open link. Freshness, not status. */
  healthy: boolean;
  link: "serial" | "tcp";
  target: string;
  status: SensorStatus;
  lastFrameAt: string | null;
  frameAgeMs: number | null;
  lastTelemetryAt: string | null;
  telemetryAgeMs: number | null;
  deviceId: string | null;
  fwVersion: string | null;
  timeValid: boolean | null;
  statusFlags: string[];
  bootCount: number;
  lastBootAt: string | null;
  lastBootCause: string | null;
  frames: Record<"telemetry" | "event" | "imu" | "ack" | "other", number>;
  frameErrors: number;
  /** Tags newer firmware sent that this build ignores. */
  unknownTags: number[];
  /** Why a connected device is silent, when it answered the probe. */
  silentReason: string | null;
  /** Times the link was lost or could not be opened. */
  reconnects: number;
  lastError: string | null;
}

/** `command()` while no link is open: nothing was sent. */
export class DeviceUnavailableError extends Error {
  constructor(message = "no device link is open") {
    super(message);
    this.name = "DeviceUnavailableError";
  }
}

const SEQ_SPAN = 0x10000;
const ACK_LOCKED = ACK_STATUS.indexOf("Locked");

const describe = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const iso = (ms: number | null) =>
  ms === null ? null : new Date(ms).toISOString();

/**
 * Reads the hour meter over its serial link (or a `tcp://` bridge) and emits
 * each decoded frame on the app emitter: `HM_EVENTS.telemetry` (msg),
 * `HM_EVENTS.event` (msg, { bootCount }) and `HM_EVENTS.imu` (msg,
 * { missedFrames }) for the IMU stream, which only the travel-direction
 * estimator reads — it is never published. ACKs are counted.
 *
 * The link loop reopens the port when it closes or fails. It does **not**
 * reopen it just because the device went quiet: opening a USB port toggles
 * DTR, which reboots the ESP32, and the device saves its counters at most
 * every `persistIntervalS` (60 s) while the engine runs — every needless
 * reopen can cost up to a minute of hour meter. So the stale watchdog first
 * sends `get=3`. An answer means the device is alive but sending its
 * telemetry elsewhere (`output` = UART pins only) or is locked; that is
 * reported in `silentReason`, and the port stays open. Only no answer at all
 * reopens it.
 */
export class HourMeterSensor extends Sensor {
  name = "HourMeter";
  override status: SensorStatus = "STOP";

  readonly target: string;
  private readonly baud: number;
  private readonly pin?: string;
  private readonly staleMs: number;
  private readonly reconnectDelayMs: number;
  private readonly timeSync: boolean;
  private readonly watchdogIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly open: (target: string, baud: number) => Promise<Link>;
  private readonly now: () => number;

  private stopped = true;
  private loop?: Promise<void>;
  private device?: DeviceClient;
  private endSession?: (reason: string) => void;
  private watchdog?: ReturnType<typeof setInterval>;
  private probe?: Promise<void>;
  private pauseTimer?: ReturnType<typeof setTimeout>;
  private wake?: () => void;

  // per link session
  private linkFrameAt = 0;
  private lastSeq: number | null = null;
  /** the IMU stream's own continuity: seq counts every frame, of every type */
  private lastImuSeq: number | null = null;
  private nonImuSinceImu = 0;
  private sessionHeard = false;
  private timeSyncOn = false;

  // since start
  private lastFrameAt: number | null = null;
  private lastTelemetryAt: number | null = null;
  private deviceId: number | null = null;
  private fwVersion: string | null = null;
  private timeValid: boolean | null = null;
  private statusFlags: number | null = null;
  private bootCount = 0;
  private lastBootAt: number | null = null;
  private lastBootCause: string | null = null;
  private frames = { telemetry: 0, event: 0, imu: 0, ack: 0, other: 0 };
  private frameErrors = 0;
  private unknownTags = new Set<number>();
  private silentReason: string | null = null;
  private reconnects = 0;
  private lastError: string | null = null;
  private clockWarned = false;

  constructor(
    private readonly emitter: EventEmitter,
    options: HourMeterSensorOptions = {},
  ) {
    super();
    this.target = options.target ?? HOUR_METER_PORT;
    this.baud = options.baud ?? HOUR_METER_BAUD;
    this.pin = options.pin ?? HOUR_METER_BT_PIN;
    this.staleMs = options.staleMs ?? HOUR_METER_STALE_MS;
    this.reconnectDelayMs = options.reconnectDelayMs ??
      HOUR_METER_RECONNECT_DELAY_MS;
    this.timeSync = options.timeSync ?? HOUR_METER_TIME_SYNC;
    this.watchdogIntervalMs = options.watchdogIntervalMs ?? 1000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 1500;
    this.open = options.open ?? openLink;
    this.now = options.now ?? Date.now;
  }

  /** Start the link loop. Returns at once; the loop never rejects. */
  start(): void {
    if (this.loop) return;
    this.stopped = false;
    this.init();
    this.loop = this.read().catch((err) =>
      console.error("hour meter: reader stopped unexpectedly:", err)
    );
  }

  protected init(): void {
    this.status = "ERROR"; // not connected yet
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.status = "STOP";
    this.stopWatchdog();
    clearTimeout(this.pauseTimer);
    this.wake?.();
    this.device?.close();
    this.endSession?.("stopped");
    await this.probe; // its request timer must settle before we return
    await this.loop;
    this.loop = undefined;
  }

  /**
   * Send one COMMAND on the open link and resolve with its ACK — the
   * vendored client's rules: a fresh seq, the same bytes on retry, and an
   * `AckError` when the device refuses. Rejects with `DeviceUnavailableError`
   * when no link is open (nothing is queued for later).
   */
  command(
    values: Record<string, number | boolean>,
    options: { timeoutMs?: number; retries?: number } = {},
  ): Promise<DecodedMessage> {
    const device = this.device;
    if (device === undefined || this.status !== "RUNNING") {
      return Promise.reject(
        new DeviceUnavailableError(
          `no link to the hour meter (${this.target})`,
        ),
      );
    }
    return device.request(values, options);
  }

  /** The device last heard from, `"1a2b3c4d"`. */
  currentDeviceId(): string | null {
    return this.deviceId === null ? null : formatDeviceId(this.deviceId);
  }

  health(): HourMeterHealth {
    const now = this.now();
    const age = (at: number | null) => at === null ? null : now - at;
    const telemetryAgeMs = age(this.lastTelemetryAt);
    return {
      healthy: this.status === "RUNNING" && telemetryAgeMs !== null &&
        telemetryAgeMs <= this.staleMs,
      link: this.target.startsWith("tcp://") ? "tcp" : "serial",
      target: this.target,
      status: this.status,
      lastFrameAt: iso(this.lastFrameAt),
      frameAgeMs: age(this.lastFrameAt),
      lastTelemetryAt: iso(this.lastTelemetryAt),
      telemetryAgeMs,
      deviceId: this.deviceId === null ? null : formatDeviceId(this.deviceId),
      fwVersion: this.fwVersion,
      timeValid: this.timeValid,
      statusFlags: this.statusFlags === null
        ? []
        : decodeStatusFlags(this.statusFlags),
      bootCount: this.bootCount,
      lastBootAt: iso(this.lastBootAt),
      lastBootCause: this.lastBootCause,
      frames: { ...this.frames },
      frameErrors: this.frameErrors,
      unknownTags: [...this.unknownTags].sort((a, b) => a - b),
      silentReason: this.silentReason,
      reconnects: this.reconnects,
      lastError: this.lastError,
    };
  }

  protected async read(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.session();
      } catch (err) {
        const message = describe(err);
        // once per distinct failure: an unplugged device fails every 5 s
        if (message !== this.lastError) {
          console.error(`hour meter: ${this.target}: ${message}`);
        }
        this.lastError = message;
      }
      if (this.stopped) break;
      this.status = "ERROR";
      this.reconnects += 1;
      await this.pause(this.reconnectDelayMs);
    }
    this.status = "STOP";
  }

  /** One open link, from open to close. Resolves when it ends. */
  private async session(): Promise<void> {
    const link = await this.open(this.target, this.baud);
    if (this.stopped) return link.close();

    const device = new DeviceClient(link);
    this.device = device;
    this.linkFrameAt = this.now();
    this.lastSeq = null; // seq continuity only means something within a link
    this.lastImuSeq = null;
    this.nonImuSinceImu = 0;
    this.sessionHeard = false;
    this.timeSyncOn = false;
    this.silentReason = null;

    const ended = new Promise<string>((resolve) => {
      device.once("close", () => resolve("link closed"));
      this.endSession = resolve;
    });
    device.on("frame", (msg: DecodedMessage) => this.onFrame(device, msg));
    device.on("frameError", (err: Error) => {
      this.frameErrors += 1;
      if (LOGGING) console.debug(`hour meter: bad frame: ${describe(err)}`);
    });
    device.on("timeSynced", (epoch: number) =>
      console.log(
        `hour meter: device clock set to ${
          new Date(epoch * 1000).toISOString()
        }`,
      ));
    device.on(
      "timeSyncError",
      (err: unknown) =>
        console.warn(
          `hour meter: could not set the device clock: ${describe(err)}`,
        ),
    );

    try {
      // a locked Bluetooth session sends nothing until unlocked
      if (this.pin !== undefined) await device.unlock(this.pin);
      this.status = "RUNNING";
      this.lastError = null;
      console.log(`hour meter: opened ${this.target}`);
      this.watchdog = setInterval(
        () => void this.checkStale(device),
        this.watchdogIntervalMs,
      );

      const reason = await ended;
      if (!this.stopped) {
        console.warn(
          `hour meter: ${reason}; reopening in ${this.reconnectDelayMs} ms`,
        );
      }
    } finally {
      this.stopWatchdog();
      await this.probe;
      this.endSession = undefined;
      this.device = undefined;
      device.removeAllListeners();
      device.close();
    }
  }

  /** Synchronous: a throw here would end up in DeviceClient's read pump. */
  private onFrame(device: DeviceClient, msg: DecodedMessage): void {
    if (this.device !== device) return;
    const now = this.now();
    this.linkFrameAt = now;
    this.lastFrameAt = now;
    if (this.silentReason !== null) {
      console.log("hour meter: frames are flowing again");
      this.silentReason = null;
    }
    if (!this.sessionHeard) {
      this.sessionHeard = true;
      console.log(
        `hour meter: receiving from device ${formatDeviceId(msg.deviceId)}`,
      );
    }
    this.deviceId = msg.deviceId;
    this.noteUnknownTags(msg);
    // before noteBoot moves lastSeq on
    const missedFrames = this.missedImuFrames(msg);
    this.noteBoot(msg, now);

    try {
      switch (msg.msgType) {
        case MSG.TELEMETRY:
          this.frames.telemetry += 1;
          this.lastTelemetryAt = now;
          if (typeof msg.values.timeValid === "boolean") {
            this.timeValid = msg.values.timeValid;
          }
          this.noteStatusFlags(msg);
          this.maybeEnableTimeSync(device);
          this.emitter.emit(HM_EVENTS.telemetry, msg);
          break;
        case MSG.EVENT:
          this.frames.event += 1;
          if (typeof msg.values.fwVersion === "number") {
            this.fwVersion = formatFwVersion(msg.values.fwVersion);
          }
          this.emitter.emit(HM_EVENTS.event, msg, {
            bootCount: this.bootCount,
          });
          break;
        case MSG.IMU:
          this.frames.imu += 1;
          this.emitter.emit(HM_EVENTS.imu, msg, { missedFrames });
          break;
        case MSG.ACK:
          this.frames.ack += 1;
          break;
        default:
          this.frames.other += 1;
      }
    } catch (err) {
      console.error(`hour meter: a frame listener threw: ${describe(err)}`);
    }
  }

  /**
   * IMU stream frames lost before this one. The device's `seq` counts every
   * frame it sends — TELEMETRY, EVENTs, ACKs too — so the jump since the last
   * IMU frame, less the other frames received meanwhile, is what was lost
   * (a frame the device could not send still used up its seq). A restart
   * (seq backwards) is not a loss: the stream simply begins again.
   */
  private missedImuFrames(msg: DecodedMessage): number {
    if (msg.msgType !== MSG.IMU) {
      this.nonImuSinceImu += 1;
      return 0;
    }
    let missed = 0;
    if (this.lastImuSeq !== null) {
      const jump = (msg.seq - this.lastImuSeq + SEQ_SPAN) % SEQ_SPAN;
      if (jump > 0 && jump < SEQ_SPAN / 2) {
        missed = Math.max(0, jump - 1 - this.nonImuSinceImu);
      }
    }
    this.lastImuSeq = msg.seq;
    this.nonImuSinceImu = 0;
    return missed;
  }

  /**
   * A boot EVENT, or `seq` going backwards (not a 65535 → 0 wrap), means the
   * device restarted. Both land on the same frame — the boot EVENT is the
   * first one after a restart, with seq 0 — so a restart counts once; the seq
   * check only catches a boot EVENT lost to noise. Gaps are normal: a frame
   * the device could not send still used up its seq.
   */
  private noteBoot(msg: DecodedMessage, now: number): void {
    const bootEvent = msg.msgType === MSG.EVENT && msg.values.eventKind === 1;
    const regressed = this.lastSeq !== null &&
      (msg.seq - this.lastSeq + SEQ_SPAN) % SEQ_SPAN >= SEQ_SPAN / 2;
    const from = this.lastSeq;
    this.lastSeq = msg.seq;
    if (!bootEvent && !regressed) return;

    this.bootCount += 1;
    this.lastBootAt = now;
    const id = formatDeviceId(msg.deviceId);
    if (!bootEvent) {
      this.lastBootCause = null;
      console.warn(
        `hour meter: device ${id} restarted (seq ${from} → ${msg.seq}; its boot EVENT was not received)`,
      );
      return;
    }
    const { resetReason, lastCause, lastStage } = msg.values;
    this.lastBootCause = typeof lastCause === "number"
      ? (LAST_CAUSE[lastCause] ?? `unknown(${lastCause})`)
      : null;
    const stage = typeof lastStage === "number"
      ? (LAST_STAGE[lastStage] ?? `unknown(${lastStage})`)
      : "?";
    console.log(
      `hour meter: device ${id} booted (resetReason ${resetReason}, ` +
        `lastCause ${this.lastBootCause ?? "?"}, lastStage ${stage})`,
    );
  }

  /** Log the status flags when they change: several need a person (§9 rule 8). */
  private noteStatusFlags(msg: DecodedMessage): void {
    const flags = msg.values.statusFlags;
    if (typeof flags !== "number" || flags === this.statusFlags) return;
    this.statusFlags = flags;
    const names = decodeStatusFlags(flags);
    console.log(
      `hour meter: status flags ${names.length ? names.join(", ") : "clear"}`,
    );
  }

  private noteUnknownTags(msg: DecodedMessage): void {
    for (const name of Object.keys(msg.values)) {
      if (!name.startsWith("tag_")) continue;
      const tag = Number(name.slice(4));
      if (this.unknownTags.has(tag)) continue;
      this.unknownTags.add(tag);
      console.warn(
        `hour meter: device sent tag ${tag}, unknown to this build — ignored (newer firmware?)`,
      );
    }
  }

  /**
   * The device asks for the time whenever its RTC lost it (INTEGRATION-GUIDE
   * §9.2); the vendored client answers with `setTime`, rate-limited. Never
   * with a host clock that is itself unset — that would replace a good RTC
   * with 1970. Enabled lazily so a clock that NTP fixes later still counts.
   */
  private maybeEnableTimeSync(device: DeviceClient): void {
    if (!this.timeSync || this.timeSyncOn) return;
    if (this.now() < MIN_PLAUSIBLE_HOST_TIME_MS) {
      if (!this.clockWarned) {
        console.warn(
          `hour meter: host clock reads ${
            iso(this.now())
          } — not sending it to the device`,
        );
        this.clockWarned = true;
      }
      return;
    }
    device.enableAutoTimeSync({ now: this.now });
    this.timeSyncOn = true;
  }

  private checkStale(device: DeviceClient): void {
    if (this.probe || this.device !== device) return;
    const silentMs = this.now() - this.linkFrameAt;
    if (silentMs <= this.staleMs) return;
    this.probe = this.probeDevice(device, silentMs).finally(() => {
      this.probe = undefined;
    });
  }

  private async probeDevice(
    device: DeviceClient,
    silentMs: number,
  ): Promise<void> {
    try {
      const ack = await device.request({ get: GET.status }, {
        timeoutMs: this.probeTimeoutMs,
        retries: 0,
      });
      if (this.device !== device) return;
      if (typeof ack.values.fwVersion === "number") {
        this.fwVersion = formatFwVersion(ack.values.fwVersion);
      }
      this.markSilent(
        "the device answers but sends no telemetry on this port — its `output` " +
          "setting may route it elsewhere (2 = UART pins only); check it with the configurator",
      );
    } catch (err) {
      if (this.device !== device) return;
      if (err instanceof AckError) {
        this.markSilent(
          Number(err.ack.values.ackStatus) === ACK_LOCKED
            ? "the Bluetooth session is locked — set HOUR_METER_BT_PIN"
            : `the device answers (${err.message}) but sends no telemetry`,
        );
        return;
      }
      const reason = `no frames for ${
        Math.round(silentMs / 1000)
      } s and no answer to a status request`;
      device.close();
      this.endSession?.(reason);
    }
  }

  /** The device is alive: keep the port open and probe again later. */
  private markSilent(reason: string): void {
    if (this.silentReason !== reason) console.warn(`hour meter: ${reason}`);
    this.silentReason = reason;
    this.linkFrameAt = this.now();
  }

  private stopWatchdog(): void {
    clearInterval(this.watchdog);
    this.watchdog = undefined;
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.pauseTimer = setTimeout(resolve, ms);
    });
  }
}
