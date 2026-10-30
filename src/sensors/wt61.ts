import {
  WT61_EVENTS,
  WT61_MAX_LINE_BYTES,
  WT61_PROTOCOL_VERSION,
  WT61_RECONNECT_DELAY_MS,
  WT61_STALE_MS,
} from "consts";
import { parseWt61Line, parseWt61Url } from "helpers";
import type { EventEmitter } from "node:events";
import type { Wt61Health, Wt61Hello, Wt61SerialState, Wt61Status } from "types";

export interface Wt61LinkOptions {
  /** `tcp://host:port` */
  url: string;
  staleMs?: number;
  reconnectDelayMs?: number;
  now?: () => number;
}

/** Why a connection was given up; logged once per distinct reason. */
class LinkError extends Error {}

const iso = (ms: number | null) =>
  ms === null ? null : new Date(ms).toISOString();

/**
 * The TCP link to wt61-driver: NDJSON lines, protocol v1
 * (FMS-Backend/docs/ecosystem/integrations/wt61-driver-to-hm.md).
 *
 * Emits on the app's emitter: `WT61_EVENTS.sample (sample, { missedFrames })`
 * and `WT61_EVENTS.link (usable, reason?)`. Usable means a v1 hello was
 * received and the driver's serial port is open.
 *
 * Reconnects after a close, an error, a refused hello, or `staleMs` without a
 * line. Reconnecting is harmless here — the driver keeps the module's serial
 * port open — unlike reopening the hour meter's USB port, which reboots it.
 */
export class Wt61Link {
  readonly name = "wt61";
  state: Wt61Health["state"] = "closed";

  private readonly target: { hostname: string; port: number };
  private readonly staleMs: number;
  private readonly reconnectDelayMs: number;
  private readonly now: () => number;

  private conn?: Deno.Conn;
  private stopped = false;
  private running?: Promise<void>;
  private wake?: () => void;
  private staleTimer?: ReturnType<typeof setInterval>;
  /** the stale timer closed the connection */
  private stale = false;

  private hello: Wt61Hello | null = null;
  private serial: Wt61SerialState | null = null;
  private serialError: string | null = null;
  private lastStatus: Wt61Status | null = null;
  private usable = false;
  private lastSeq: number | null = null;
  private lastLineAt: number | null = null;
  private lastSampleAt: number | null = null;
  /** the latest sample's attitude, and when it arrived */
  private lastAngle: { rollDeg: number; pitchDeg: number; at: number } | null =
    null;
  private samples = 0;
  private missedFrames = 0;
  private ignoredLines = 0;
  private connects = 0;
  private lastError: string | null = null;
  private loggedError: string | null = null;

  constructor(
    private readonly emitter: EventEmitter,
    private readonly options: Wt61LinkOptions,
  ) {
    const target = parseWt61Url(options.url);
    if (target === null) {
      throw new Error(`WT61_URL=${options.url} is not tcp://host:port`);
    }
    this.target = target;
    this.staleMs = options.staleMs ?? WT61_STALE_MS;
    this.reconnectDelayMs = options.reconnectDelayMs ?? WT61_RECONNECT_DELAY_MS;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.running) return;
    this.stopped = false;
    this.running = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    this.closeConn();
    await this.running;
    this.running = undefined;
  }

  /**
   * The module's latest roll and pitch (its x and y angles), for
   * `hour-meter:update`; null when none arrived within `maxAgeMs`.
   */
  attitude(maxAgeMs = 1000): { rollDeg: number; pitchDeg: number } | null {
    const a = this.lastAngle;
    if (a === null || this.now() - a.at > maxAgeMs) return null;
    return { rollDeg: a.rollDeg, pitchDeg: a.pitchDeg };
  }

  health(): Wt61Health {
    const now = this.now();
    return {
      url: this.options.url,
      state: this.state,
      usable: this.usable,
      driver: this.hello
        ? `${this.hello.driver} ${this.hello.driverVersion}`.trim()
        : null,
      device: this.hello?.device ?? null,
      baudRate: this.hello?.baudRate ?? null,
      serial: this.serial,
      serialError: this.serialError,
      driverStartedAt: this.hello?.startedAt ?? null,
      lastSampleAt: iso(this.lastSampleAt),
      sampleAgeMs: this.lastSampleAt === null ? null : now - this.lastSampleAt,
      samples: this.samples,
      missedFrames: this.missedFrames,
      ignoredLines: this.ignoredLines,
      connects: this.connects,
      lastError: this.lastError,
      driverCounters: this.lastStatus
        ? {
          checksumErrors: this.lastStatus.checksumErrors,
          incompleteCycles: this.lastStatus.incompleteCycles,
          droppedBytes: this.lastStatus.droppedBytes,
        }
        : null,
    };
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      let reason: string;
      try {
        this.state = "connecting";
        this.conn = await Deno.connect({ ...this.target, transport: "tcp" });
        if (this.stopped) break;
        this.connects++;
        reason = await this.read(this.conn);
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      } finally {
        this.closeConn();
        this.state = "closed";
        this.hello = null;
        this.lastSeq = null;
        this.setUsable(false, "wt61-driver link closed");
      }
      if (this.stopped) break;
      this.lastError = reason;
      if (reason !== this.loggedError) {
        console.warn(
          `wt61: ${this.options.url}: ${reason} — retrying every ${this.reconnectDelayMs} ms`,
        );
        this.loggedError = reason;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.reconnectDelayMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = undefined;
    }
    this.state = "closed";
  }

  /** Until the connection ends; returns why. */
  private async read(conn: Deno.Conn): Promise<string> {
    this.lastLineAt = this.now();
    this.staleTimer = setInterval(() => {
      if (this.now() - (this.lastLineAt ?? 0) > this.staleMs) {
        this.stale = true;
        this.closeConn();
      }
    }, Math.max(50, Math.floor(this.staleMs / 4)));
    this.stale = false;
    const decoder = new TextDecoder();
    const buf = new Uint8Array(16 * 1024);
    let pending = "";
    try {
      while (true) {
        let n: number | null;
        try {
          n = await conn.read(buf);
        } catch (err) {
          if (this.stale) return `no line for ${this.staleMs} ms`;
          throw err;
        }
        if (n === null) {
          return this.stale
            ? `no line for ${this.staleMs} ms`
            : "wt61-driver closed the connection";
        }
        pending += decoder.decode(buf.subarray(0, n), { stream: true });
        let at: number;
        while ((at = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, at);
          pending = pending.slice(at + 1);
          this.onLine(line);
        }
        if (pending.length > WT61_MAX_LINE_BYTES) {
          throw new LinkError(
            `a line longer than ${WT61_MAX_LINE_BYTES} bytes: not wt61-driver`,
          );
        }
      }
    } finally {
      clearInterval(this.staleTimer);
    }
  }

  private onLine(line: string): void {
    this.lastLineAt = this.now();
    if (line.trim() === "") return;
    const msg = parseWt61Line(line);
    if (this.hello === null) {
      if (msg?.type !== "hello") {
        throw new LinkError("the first line was not a wt61-driver hello");
      }
      if (msg.version !== WT61_PROTOCOL_VERSION) {
        throw new LinkError(
          `wt61-driver speaks protocol ${msg.version}, this build ${WT61_PROTOCOL_VERSION}`,
        );
      }
      this.hello = msg;
      this.state = "open";
      this.lastSeq = null;
      if (this.loggedError !== null || this.connects === 1) {
        console.log(
          `wt61: connected to ${msg.driver} ${msg.driverVersion} (${msg.device} @ ${msg.baudRate})`,
        );
      }
      this.loggedError = null;
      this.onSerial(msg.serial, undefined);
      return;
    }
    if (msg === null) {
      this.ignoredLines++;
      return;
    }
    switch (msg.type) {
      case "sample": {
        const missed = this.lastSeq !== null && msg.seq > this.lastSeq
          ? msg.seq - this.lastSeq - 1
          : 0;
        this.lastSeq = msg.seq;
        this.samples++;
        this.missedFrames += missed;
        this.lastSampleAt = this.now();
        if (msg.angleDeg) {
          this.lastAngle = {
            rollDeg: msg.angleDeg.x,
            pitchDeg: msg.angleDeg.y,
            at: this.lastSampleAt,
          };
        }
        this.emitter.emit(WT61_EVENTS.sample, msg, { missedFrames: missed });
        return;
      }
      case "status":
        this.lastStatus = msg;
        this.onSerial(msg.serial, msg.error);
        return;
      case "hello":
        // the driver never sends a second one; nothing to do if it did
        return;
    }
  }

  private onSerial(serial: Wt61SerialState, error: string | undefined): void {
    if (serial === "closed" && this.serial !== "closed") {
      console.warn(
        `wt61: the driver's serial port is closed${error ? `: ${error}` : ""}`,
      );
    }
    this.serial = serial;
    this.serialError = serial === "closed" ? error ?? null : null;
    this.setUsable(
      serial === "open",
      serial === "open" ? undefined : "the WT61's serial port is closed",
    );
  }

  private setUsable(usable: boolean, reason?: string): void {
    if (usable === this.usable) return;
    this.usable = usable;
    this.emitter.emit(WT61_EVENTS.link, usable, reason);
  }

  private closeConn(): void {
    try {
      this.conn?.close();
    } catch {
      // already closed
    }
    this.conn = undefined;
  }
}
