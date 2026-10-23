import type { DirectionTuning } from "./tuning.ts";
import type { Vec3 } from "./types.ts";
import { cross, DEG, G, norm, normalize, sub, vec } from "./vec.ts";

export interface LaunchContext {
  /** specific force at the standstill before it, vehicle frame, g */
  g0: Vec3;
  degraded: boolean;
  /** g0 learned from < 2.5 s of stillness (or none): weaker evidence */
  shortStop: boolean;
  startMs: number;
  /**
   * Armed while already moving (a segment boundary): the starting speed is
   * unknown — braking to a stop would read as a launch the other way — so it
   * may decide only after its velocity has crossed zero.
   */
  requireZeroCross?: boolean;
}

/**
 * Which way the vehicle starts to move: integrate the forward acceleration
 * from the last standstill, with gravity removed against the attitude the
 * gyro has turned since (suspension squat, a cab settling after loading).
 *
 * A rollback when the brakes release is real backward motion, so on a grade
 * the downhill side needs 1.6× the evidence, and a sign change after
 * 0.15 m/s restarts the integration at the zero-crossing: the roll back is
 * its own micro-segment, the drive away the next one.
 */
export class Launch {
  v = 0;
  s = 0;
  readonly gradePct: number;
  onsetAtMs: number | null = null;
  decision: { sign: 1 | -1; atMs: number; weight: number } | null = null;
  aborted = false;
  zeroCrossings = 0;

  #u0: Vec3;
  #gMag: number;
  #theta = vec();
  #peak = 0;
  #holdSign: 0 | 1 | -1 = 0;
  #holdSinceMs = 0;

  constructor(
    private readonly tuning: DirectionTuning["launch"],
    private readonly weights: {
      full: number;
      degraded: number;
      shortStop: number;
    },
    readonly ctx: LaunchContext,
  ) {
    this.#u0 = normalize(ctx.g0);
    this.#gMag = norm(ctx.g0);
    // nose up (+x component of gravity) = facing uphill
    const sinPitch = Math.max(-1, Math.min(1, this.#u0.x));
    this.gradePct = Math.tan(Math.asin(sinPitch)) * 100;
  }

  expired(tMs: number): boolean {
    return (tMs - this.ctx.startMs) / 1000 > this.tuning.maxS;
  }

  /** a, ω in the vehicle frame; ω with the gyro bias removed. */
  push(accelG: Vec3, gyroDps: Vec3, dtS: number, tMs: number): void {
    if (this.aborted || this.decision) return;
    const t = this.tuning;
    if (
      Math.max(Math.abs(accelG.x), Math.abs(accelG.y), Math.abs(accelG.z)) >=
        t.saturationG ||
      Math.max(Math.abs(gyroDps.x), Math.abs(gyroDps.y), Math.abs(gyroDps.z)) >=
        t.saturationDps
    ) {
      this.aborted = true;
      return;
    }

    this.#theta = {
      x: this.#theta.x + gyroDps.x * DEG * dtS,
      y: this.#theta.y + gyroDps.y * DEG * dtS,
      z: this.#theta.z + gyroDps.z * DEG * dtS,
    };
    const up = normalize(sub(this.#u0, cross(this.#theta, this.#u0)));
    const forwardAccel = (accelG.x - this.#gMag * up.x) * G;

    const before = this.v;
    this.v += forwardAccel * dtS;
    this.s += this.v * dtS;
    if (
      this.#peak >= t.zeroCrossMinMps && before !== 0 &&
      Math.sign(this.v) !== Math.sign(before)
    ) {
      this.v = 0;
      this.s = 0;
      this.#peak = 0;
      this.#holdSign = 0;
      this.zeroCrossings += 1;
      return;
    }
    this.#peak = Math.max(this.#peak, Math.abs(this.v));

    const sign = Math.sign(this.v) as 0 | 1 | -1;
    if (
      this.onsetAtMs === null && sign !== 0 &&
      Math.abs(this.v) >= t.onsetSpeedMps &&
      Math.abs(this.s) >= t.onsetDistanceM
    ) {
      this.onsetAtMs = tMs;
    }

    // facing uphill, the downhill side is reversing; facing downhill, forward
    const steep = Math.abs(this.gradePct) >= t.gradePct;
    const downhillSign = this.gradePct > 0 ? -1 : 1;
    const factor = steep && sign === downhillSign ? t.downhillFactor : 1;
    const needV =
      (this.ctx.degraded ? t.decideSpeedMpsDegraded : t.decideSpeedMps) *
      factor;
    const needS =
      (this.ctx.degraded ? t.decideDistanceMDegraded : t.decideDistanceM) *
      factor;

    const mayDecide = !this.ctx.requireZeroCross || this.zeroCrossings > 0;
    if (
      mayDecide && sign !== 0 && Math.abs(this.v) >= needV &&
      Math.abs(this.s) >= needS
    ) {
      if (this.#holdSign !== sign) {
        this.#holdSign = sign;
        this.#holdSinceMs = tMs;
      } else if ((tMs - this.#holdSinceMs) / 1000 >= t.holdS) {
        this.decision = {
          sign,
          atMs: tMs,
          weight: this.ctx.degraded
            ? this.weights.degraded
            : this.ctx.shortStop
            ? this.weights.shortStop
            : this.weights.full,
        };
      }
    } else {
      this.#holdSign = 0;
    }
  }
}
