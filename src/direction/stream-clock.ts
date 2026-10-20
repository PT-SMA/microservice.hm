import type { DirectionTuning } from "./tuning.ts";
import type { ImuSample } from "./types.ts";

export interface ClockTick {
  /** seconds this sample stands for (nominal period × (1 + missed)) */
  dtS: number;
  /** the stream stopped for a while before this sample */
  gap: boolean;
  gapMs: number;
  /** the same accel+gyro bits several frames running: a dead IMU */
  frozen: boolean;
}

/**
 * The IMU stream's own clock. Frames arrive in bursts (USB bridge, read
 * pump), so dt comes from the measured nominal rate, not from arrival times;
 * arrival times only detect gaps. The header timestamp is whole seconds and
 * useless here.
 */
export class StreamClock {
  /** (arrival, frames counted so far incl. missed) — the rate is frames ÷ time */
  #history: Array<{ tMs: number; frames: number }> = [];
  #frames = 0;
  #lastMs: number | null = null;
  #lastBits = "";
  #sameBits = 0;
  #hz: number | null = null;

  constructor(private readonly tuning: DirectionTuning["stream"]) {}

  /** The measured stream rate, whole Hz; null until a few frames arrived. */
  get hz(): number | null {
    return this.#hz;
  }

  get degraded(): boolean {
    return this.#hz !== null && this.#hz < this.tuning.degradedBelowHz;
  }

  push(sample: ImuSample, tMs: number): ClockTick {
    const missed = Math.max(0, sample.missedFrames);
    let gapMs = 0;
    if (this.#lastMs !== null) gapMs = tMs - this.#lastMs;
    this.#lastMs = tMs;
    this.#frames += 1 + missed;
    this.#history.push({ tMs, frames: this.#frames });
    if (this.#history.length > this.tuning.historyFrames) this.#history.shift();
    // frames over time, not inter-arrival times: robust to bursty delivery
    if (this.#history.length >= 8) {
      const first = this.#history[0], last = this.#history.at(-1)!;
      const spanMs = last.tMs - first.tMs;
      if (spanMs > 0) {
        this.#hz = Math.max(
          1,
          Math.round(((last.frames - first.frames) * 1000) / spanMs),
        );
      }
    }

    const periodMs = this.#hz ? 1000 / this.#hz : 100;
    const gap = gapMs > 0 &&
      (gapMs >
          Math.max(
            this.tuning.gapPeriods * periodMs * (1 + missed),
            this.tuning.gapMinMs,
          ) ||
        missed * periodMs > this.tuning.gapMinMs);

    const { accelG: a, gyroDps: w } = sample;
    const bits = `${a.x},${a.y},${a.z},${w.x},${w.y},${w.z}`;
    this.#sameBits = bits === this.#lastBits ? this.#sameBits + 1 : 0;
    this.#lastBits = bits;

    return {
      dtS: gap ? periodMs / 1000 : (periodMs * (1 + missed)) / 1000,
      gap,
      gapMs: gap ? gapMs : 0,
      frozen: this.#sameBits + 1 >= this.tuning.frozenFrames,
    };
  }
}
