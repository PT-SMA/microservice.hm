import type { DirectionTuning } from "./tuning.ts";
import { leastSquares, mean, std } from "./vec.ts";

interface TurnBlock {
  tMs: number;
  /** lateral acceleration, gravity removed, m/s², left positive */
  lateral: number;
  /** yaw rate, rad/s, counter-clockwise positive */
  yaw: number;
}

export interface TurnFit {
  /** signed speed along the vehicle's x axis, m/s (+ forward) */
  speedMps: number;
  z: number;
  residualRms: number;
  maxYawDps: number;
  stdYawDps: number;
  leverArmM: number | null;
  /** why it gives no evidence, if it does not */
  rejected?: string;
}

/**
 * In a turn, lateral acceleration = speed × yaw rate: its sign is the sign of
 * the speed. At the board, offset d ahead of the axle that does not slide
 * sideways, turning in or out adds d × yaw acceleration, as large as the
 * signal itself at spotting speed — so it is fitted:
 *
 *   lateral = v·r + d·ṙ + c0 + c1·t
 *
 * c0/c1 absorb camber and a drifting bias. Superelevation in the curve itself
 * is removed by the gyro-tracked attitude, not by c0.
 */
export class TurnWindow {
  #blocks: TurnBlock[] = [];
  #sumLat = 0;
  #sumYaw = 0;
  #n = 0;
  #durS = 0;
  #lastEvalMs = 0;
  #lastEventMs = -Infinity;
  /** once enough GPS-confirmed windows agree, the lever arm is fixed */
  leverArmM: number | null = null;
  #leverSamples: number[] = [];

  constructor(private readonly tuning: DirectionTuning["turn"]) {}

  push(lateral: number, yawRadS: number, dtS: number, tMs: number): void {
    this.#sumLat += lateral;
    this.#sumYaw += yawRadS;
    this.#n += 1;
    this.#durS += dtS;
    if (this.#durS + 1e-9 < this.tuning.blockS) return;
    this.#blocks.push({
      tMs,
      lateral: this.#sumLat / this.#n,
      yaw: this.#sumYaw / this.#n,
    });
    this.#sumLat =
      this.#sumYaw =
      this.#n =
      this.#durS =
        0;
    const keepMs = this.tuning.windowSDegraded * 1000 + 500;
    while (this.#blocks.length && tMs - this.#blocks[0].tMs > keepMs) {
      this.#blocks.shift();
    }
  }

  reset(): void {
    this.#blocks = [];
    this.#sumLat =
      this.#sumYaw =
      this.#n =
      this.#durS =
        0;
  }

  /** Evaluate at most once per `everyS`, and give evidence at most once per `minGapS`. */
  due(tMs: number): boolean {
    if ((tMs - this.#lastEvalMs) / 1000 < this.tuning.everyS) return false;
    this.#lastEvalMs = tMs;
    return (tMs - this.#lastEventMs) / 1000 >= this.tuning.minGapS;
  }

  markEvidence(tMs: number): void {
    this.#lastEventMs = tMs;
  }

  private window(tMs: number, degraded: boolean): TurnBlock[] {
    const spanMs =
      (degraded ? this.tuning.windowSDegraded : this.tuning.windowS) * 1000;
    return this.#blocks.filter((b) => tMs - b.tMs <= spanMs);
  }

  fit(tMs: number, degraded: boolean): TurnFit | null {
    const blocks = this.window(tMs, degraded);
    const windowS = degraded
      ? this.tuning.windowSDegraded
      : this.tuning.windowS;
    // by time span, not block count: at a slow stream a block runs long
    if (blocks.length < 6) return null;
    if (
      (blocks.at(-1)!.tMs - blocks[0].tMs) / 1000 <
        windowS * 0.85 - this.tuning.blockS
    ) {
      return null;
    }

    const yawDps = blocks.map((b) => (b.yaw * 180) / Math.PI);
    const maxYawDps = Math.max(...yawDps.map(Math.abs));
    const stdYawDps = std(yawDps);
    const base = {
      speedMps: 0,
      z: 0,
      residualRms: 0,
      maxYawDps,
      stdYawDps,
      leverArmM: this.leverArmM,
    };
    if (maxYawDps < this.tuning.minMaxYawDps) {
      return { ...base, rejected: "not turning" };
    }
    if (stdYawDps < this.tuning.minStdYawDps) {
      return {
        ...base,
        rejected: "steady turn: speed and lever arm inseparable",
      };
    }

    const t0 = mean(blocks.map((b) => b.tMs));
    const rows: number[][] = [];
    const ys: number[] = [];
    for (let i = 1; i < blocks.length - 1; i++) {
      const dt = (blocks[i + 1].tMs - blocks[i - 1].tMs) / 1000;
      if (dt <= 0) continue;
      const yawRate = (blocks[i + 1].yaw - blocks[i - 1].yaw) / dt;
      const tc = (blocks[i].tMs - t0) / 1000;
      if (this.leverArmM === null) {
        rows.push([blocks[i].yaw, yawRate, 1, tc]);
        ys.push(blocks[i].lateral);
      } else {
        rows.push([blocks[i].yaw, 1, tc]);
        ys.push(blocks[i].lateral - this.leverArmM * yawRate);
      }
    }
    const fit = leastSquares(rows, ys);
    if (fit === null) return { ...base, rejected: "ill-conditioned" };
    const speedMps = fit.beta[0];
    const sigma = fit.stdErr[0];
    const result: TurnFit = {
      ...base,
      speedMps,
      z: sigma > 0 ? speedMps / sigma : 0,
      residualRms: fit.residualRms,
      leverArmM: this.leverArmM ?? fit.beta[1],
    };
    if (fit.residualRms > this.tuning.maxResidualMps2) {
      return { ...result, rejected: "residual too large" };
    }
    if (Math.abs(speedMps) < this.tuning.minSpeedMps) {
      return { ...result, rejected: "too slow to tell" };
    }
    return result;
  }

  /**
   * A joint fit's own estimate of d. The lever arm does not depend on which
   * way the vehicle travels (the fit separates it from the speed's sign), so
   * any well-conditioned window teaches it — GPS or not.
   */
  recordLeverArm(estimateM: number): void {
    if (this.leverArmM !== null || !Number.isFinite(estimateM)) return;
    this.#leverSamples.push(estimateM);
    this.fixLeverArmIfReady();
  }

  private fixLeverArmIfReady(): void {
    if (this.#leverSamples.length >= this.tuning.leverLearnWindows) {
      const sorted = [...this.#leverSamples].sort((a, b) => a - b);
      this.leverArmM = sorted[Math.floor(sorted.length / 2)];
    }
  }

  /** A window GPS confirmed: fit d with the speed known. */
  learnLeverArm(tMs: number, degraded: boolean, speedMps: number): void {
    if (this.leverArmM !== null) return;
    const blocks = this.window(tMs, degraded);
    if (blocks.length < 6) return;
    const t0 = mean(blocks.map((b) => b.tMs));
    const rows: number[][] = [];
    const ys: number[] = [];
    for (let i = 1; i < blocks.length - 1; i++) {
      const dt = (blocks[i + 1].tMs - blocks[i - 1].tMs) / 1000;
      if (dt <= 0) continue;
      rows.push([
        (blocks[i + 1].yaw - blocks[i - 1].yaw) / dt,
        1,
        (blocks[i].tMs - t0) / 1000,
      ]);
      ys.push(blocks[i].lateral - speedMps * blocks[i].yaw);
    }
    const fit = leastSquares(rows, ys);
    if (fit === null || !Number.isFinite(fit.beta[0])) return;
    this.#leverSamples.push(fit.beta[0]);
    this.fixLeverArmIfReady();
  }
}
