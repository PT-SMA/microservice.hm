import type { Vec3 } from "direction";

/**
 * wt61-driver's lines, protocol version 1. The contract:
 * FMS-Backend/docs/ecosystem/integrations/wt61-driver-to-hm.md, pinned by
 * tests/fixtures/wt61/stream-v1.ndjson (the driver's own copy is checked by
 * `deno task wt61:verify`).
 */
export type Wt61SerialState = "open" | "closed";

/** The first line of every connection. */
export interface Wt61Hello {
  type: "hello";
  version: number;
  driver: string;
  driverVersion: string;
  device: string;
  baudRate: number;
  serial: Wt61SerialState;
  /** changes when the driver restarts — and its `seq` starts again */
  startedAt: string;
}

/** One acceleration + angular velocity + angle cycle, ~100 Hz. */
export interface Wt61Sample {
  type: "sample";
  /** a gap of n means n − 1 cycles lost on the serial side */
  seq: number;
  readAt: string;
  /** module frame: x right, y up the board, z out of it (+1 g flat at rest) */
  accelG: Vec3;
  gyroDps: Vec3;
  /**
   * The module's Kalman attitude (x roll, y pitch, z yaw). Its roll and pitch
   * follow the accelerometer, so they contain the acceleration: never used
   * here.
   */
  angleDeg?: Vec3;
  temperatureC?: number;
}

/** Every second, and at once when the driver's serial port opens or closes. */
export interface Wt61Status {
  type: "status";
  at: string;
  serial: Wt61SerialState;
  error?: string;
  samples: number;
  checksumErrors: number;
  incompleteCycles: number;
  droppedBytes: number;
}

export type Wt61Message = Wt61Hello | Wt61Sample | Wt61Status;

export interface Wt61Health {
  url: string;
  /** TCP: connecting, open (hello received), closed */
  state: "connecting" | "open" | "closed";
  /** open and the driver's serial port open: samples can flow */
  usable: boolean;
  driver: string | null;
  device: string | null;
  baudRate: number | null;
  serial: Wt61SerialState | null;
  serialError: string | null;
  driverStartedAt: string | null;
  lastSampleAt: string | null;
  sampleAgeMs: number | null;
  samples: number;
  /** cycles the driver lost on serial, from `seq` gaps */
  missedFrames: number;
  /** lines that were not a v1 message (ignored) */
  ignoredLines: number;
  connects: number;
  /** why the last connection ended (kept after a reconnect) */
  lastError: string | null;
  /** the driver's own counters, from its last status line */
  driverCounters: {
    checksumErrors: number;
    incompleteCycles: number;
    droppedBytes: number;
  } | null;
}
