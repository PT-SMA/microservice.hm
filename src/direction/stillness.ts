import type { DirectionTuning } from "./tuning.ts";
import type { Vec3 } from "./types.ts";
import { add, mean, norm, scale, std, sub, vec } from "./vec.ts";

export interface StillnessContext {
  biasDps: Vec3;
  biasLearned: boolean;
  degraded: boolean;
  /** gravity as the attitude tracker expects it, g; null before it is known */
  gravityG: Vec3 | null;
}

export interface Block {
  tMs: number;
  durS: number;
  accelG: Vec3;
  gyroDps: Vec3;
}

/** Averages samples into fixed-length blocks; returns each block as it closes. */
export class BlockAverager {
  #sumA = vec();
  #sumW = vec();
  #n = 0;
  #durS = 0;

  constructor(public blockS: number) {}

  push(accelG: Vec3, gyroDps: Vec3, dtS: number, tMs: number): Block | null {
    this.#sumA = add(this.#sumA, accelG);
    this.#sumW = add(this.#sumW, gyroDps);
    this.#n += 1;
    this.#durS += dtS;
    if (this.#durS + 1e-9 < this.blockS) return null;
    const block = {
      tMs,
      durS: this.#durS,
      accelG: scale(this.#sumA, 1 / this.#n),
      gyroDps: scale(this.#sumW, 1 / this.#n),
    };
    this.reset();
    return block;
  }

  reset(): void {
    this.#sumA = vec();
    this.#sumW = vec();
    this.#n = 0;
    this.#durS = 0;
  }
}

/**
 * Standstill from the IMU: over a window of block means the gyro is quiet,
 * the specific force does not move beyond the engine's own idle floor, and
 * its size is gravity. The gyro carries most of it — an idling diesel shakes
 * the accelerometer far more than it rotates the cab.
 */
export class Stillness {
  #blocks: Block[] = [];
  #averager: BlockAverager;
  #stillSinceMs: number | null = null;
  /** still in every respect but gravity's direction, since */
  #quietSinceMs: number | null = null;
  /** max block deviation while known-stopped with the engine running, mg */
  idleFloorMg = 0;
  #idleLearned = false;
  /** last window's max block deviation, mg */
  deviationMg = 0;

  constructor(
    private readonly tuning: DirectionTuning["stillness"],
    degraded: boolean,
  ) {
    this.#averager = new BlockAverager(this.blockS(degraded));
  }

  private blockS(degraded: boolean): number {
    return degraded ? this.tuning.blockSDegraded : this.tuning.blockS;
  }

  setDegraded(degraded: boolean): void {
    const blockS = this.blockS(degraded);
    if (blockS !== this.#averager.blockS) {
      this.#averager = new BlockAverager(blockS);
      this.#blocks = [];
      this.#stillSinceMs = null;
    }
  }

  /** Feed one sample; returns the closed block, if any. */
  push(
    accelG: Vec3,
    gyroDps: Vec3,
    dtS: number,
    tMs: number,
    ctx: StillnessContext,
  ): Block | null {
    const block = this.#averager.push(accelG, gyroDps, dtS, tMs);
    if (block === null) return null;
    const windowS = ctx.degraded
      ? this.tuning.windowSDegraded
      : this.tuning.windowS;
    this.#blocks.push(block);
    while (
      this.#blocks.length > 1 &&
      (block.tMs - this.#blocks[0].tMs) / 1000 > windowS - block.durS / 2
    ) this.#blocks.shift();

    const still = this.evaluate(ctx, block.tMs);
    if (still) this.#stillSinceMs ??= this.#blocks[0].tMs;
    else this.#stillSinceMs = null;
    return block;
  }

  private evaluate(ctx: StillnessContext, tMs: number): boolean {
    const blocks = this.#blocks;
    const windowS = ctx.degraded
      ? this.tuning.windowSDegraded
      : this.tuning.windowS;
    const spanS = blocks.length * (blocks[0]?.durS ?? 0);
    if (spanS + 1e-6 < windowS * 0.9) {
      this.#quietSinceMs = null;
      return false;
    }

    const m = vec(
      mean(blocks.map((b) => b.accelG.x)),
      mean(blocks.map((b) => b.accelG.y)),
      mean(blocks.map((b) => b.accelG.z)),
    );
    this.deviationMg = Math.max(...blocks.map((b) => norm(sub(b.accelG, m)))) *
      1000;

    if (ctx.biasLearned) {
      for (const b of blocks) {
        if (norm(sub(b.gyroDps, ctx.biasDps)) > this.tuning.gyroMaxDps) {
          this.#quietSinceMs = null;
          return false;
        }
      }
    } else {
      for (const axis of ["x", "y", "z"] as const) {
        if (
          std(blocks.map((b) => b.gyroDps[axis])) >
            this.tuning.gyroStdUnlearnedDps
        ) {
          this.#quietSinceMs = null;
          return false;
        }
      }
    }

    const limit = ctx.degraded ? this.tuning.deviationDegradedMg : Math.max(
      this.tuning.deviationMinMg,
      this.tuning.deviationIdleFactor * this.idleFloorMg,
    );
    if (
      this.deviationMg > limit ||
      Math.abs(norm(m) - 1) > this.tuning.normToleranceG
    ) {
      this.#quietSinceMs = null;
      return false;
    }
    if (
      ctx.gravityG === null ||
      norm(sub(m, ctx.gravityG)) <= this.tuning.gravityToleranceG
    ) {
      return true;
    }
    this.#quietSinceMs ??= tMs;
    const bypassS = ctx.degraded
      ? this.tuning.gravityBypassSDegraded
      : this.tuning.gravityBypassS;
    return (tMs - this.#quietSinceMs) / 1000 >= bypassS;
  }

  /** How long the IMU has been still, s; 0 when it is not. */
  stillForS(nowMs: number): number {
    return this.#stillSinceMs === null
      ? 0
      : (nowMs - this.#stillSinceMs) / 1000;
  }

  get still(): boolean {
    return this.#stillSinceMs !== null;
  }

  /** Learn the idle floor while another source says the unit is stopped. */
  learnIdle(blockS: number): void {
    const k = this.#idleLearned
      ? Math.min(1, blockS / this.tuning.idleFloorTauS)
      : 1;
    this.idleFloorMg += (this.deviationMg - this.idleFloorMg) * k;
    this.#idleLearned = true;
  }

  get idleLearned(): boolean {
    return this.#idleLearned;
  }

  reset(): void {
    this.#blocks = [];
    this.#stillSinceMs = null;
    this.#averager.reset();
  }
}
