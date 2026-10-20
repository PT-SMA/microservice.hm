import type { DirectionTuning } from "./tuning.ts";
import type { Vec3 } from "./types.ts";
import { add, scale, sub, vec } from "./vec.ts";

/**
 * The gyro zero-rate offset, learned on the host at every standstill. The
 * device only removes its bench calibration, and the MPU-9250 offset drifts
 * with cab temperature; integrated attitude and heading need it.
 */
export class GyroBias {
  value: Vec3 = vec();
  #stillS = 0;

  constructor(private readonly tuning: DirectionTuning["bias"]) {}

  get learned(): boolean {
    return this.#stillS >= this.tuning.learnedAfterS;
  }

  get sigmaDps(): number {
    return this.learned
      ? this.tuning.sigmaLearnedDps
      : this.tuning.sigmaUnlearnedDps;
  }

  /** A still block mean (raw gyro), while stopped for `stoppedS`. */
  learn(blockMeanDps: Vec3, blockS: number, stoppedS: number): void {
    if (stoppedS < this.tuning.minStoppedS) return;
    // a running mean until τ worth of stillness, then an EMA: the first noisy
    // block must not set the bias for the next twenty seconds
    const k = Math.min(
      1,
      Math.max(blockS / this.tuning.tauS, blockS / (this.#stillS + blockS)),
    );
    this.value = add(this.value, scale(sub(blockMeanDps, this.value), k));
    this.#stillS += blockS;
  }
}
