import type { DirectionTuning } from "./tuning.ts";
import type { Vec3 } from "./types.ts";
import {
  add,
  cross,
  DEG,
  dot,
  G,
  norm,
  normalize,
  scale,
  sub,
  vec,
} from "./vec.ts";

/**
 * Where "up" is, in the vehicle frame, without trusting the firmware's
 * roll/pitch (its Kalman follows the accelerometer within a second, so it
 * already contains the acceleration we want to measure).
 *
 * Propagated with the bias-corrected gyro (du/dt = −ω × u); reset to the
 * gravity measured at standstill; nudged towards the accelerometer only where
 * the accelerometer is not lying: roll while not turning, pitch only while
 * the speed is known to be steady (stopped, or GPS steady). Braking reads as
 * "steady" to the accelerometer's magnitude — pulled towards it, the pitch
 * tilts and an integrated velocity overshoots zero at the stop.
 */
export class Attitude {
  /** unit up vector, vehicle frame */
  up: Vec3 = vec(0, 0, 1);
  /** |gravity| as this accelerometer reads it, g */
  gravityG = 1;
  #known = false;
  #anchored = false;

  constructor(private readonly tuning: DirectionTuning["attitude"]) {}

  get known(): boolean {
    return this.#known;
  }

  /** Set from a standstill at least once — only then is "up" worth comparing against. */
  get anchored(): boolean {
    return this.#anchored;
  }

  /** Standstill: gravity is the specific force. */
  reset(g0: Vec3): void {
    this.up = normalize(g0);
    this.gravityG = norm(g0);
    this.#known = true;
    this.#anchored = true;
  }

  propagate(
    gyroDps: Vec3,
    accelG: Vec3,
    dtS: number,
    longitudinalSteady = false,
  ): void {
    const omega = scale(gyroDps, DEG);
    this.up = normalize(sub(this.up, scale(cross(omega, this.up), dtS)));

    const yawDps = Math.abs(dot(gyroDps, this.up));
    const steady = yawDps <= this.tuning.correctionMaxYawDps &&
      Math.abs(norm(accelG) - this.gravityG) <=
        this.tuning.correctionNormToleranceG;
    if (steady) {
      const k = Math.min(1, dtS / this.tuning.correctionTauS);
      const pull = sub(normalize(accelG), this.up);
      if (!longitudinalSteady) pull.x = 0; // pitch: not while accelerating
      this.up = normalize(add(this.up, scale(pull, k)));
      if (!this.#known) {
        this.up = normalize(accelG);
        this.gravityG = norm(accelG);
        this.#known = true;
      }
    }
  }

  /** Acceleration with gravity removed, vehicle frame, m/s². */
  linear(accelG: Vec3): Vec3 {
    return scale(sub(accelG, scale(this.up, this.gravityG)), G);
  }

  /** Rotation rate about up, °/s, counter-clockwise (left turn) positive. */
  yawDps(gyroDps: Vec3): number {
    return dot(gyroDps, this.up);
  }
}
