import type { DirectionTuning } from "./tuning.ts";
import type { ForwardAxis, Vec3 } from "./types.ts";
import { correlation } from "./vec.ts";

export interface MountVerdict {
  status: "ok" | "suspectReversed" | "suspectSwapped" | "inconclusive";
  /** the board axis the evidence says points forward */
  suggestedAxis: ForwardAxis | null;
  /** fast segments whose IMU evidence said forward / reversing */
  segments: { forward: number; reversing: number };
  swapEpochs: number;
  correlation: { x: number; y: number } | null;
}

const opposite = (axis: ForwardAxis): ForwardAxis =>
  (axis[0] === "+" ? "-" : "+") + axis[1] as ForwardAxis;

/**
 * Does `HOUR_METER_FORWARD_AXIS` match how the board is really mounted? The
 * only evidence that does not itself depend on the setting is "fast travel is
 * forward" (trucks never reverse at 20 km/h; graders do — the prior is off
 * for them). A wrong setting makes launch, turn and compass all agree on the
 * wrong answer, so this only warns; it never flips the setting.
 */
export class MountCheck {
  #segments: number[] = [];
  #pairs: Array<{ dv: number; x: number; y: number }> = [];

  constructor(private readonly tuning: DirectionTuning["mount"]) {}

  /** A segment that reached fast travel, and what its IMU evidence said. */
  recordSegment(imuSign: number): void {
    if (imuSign === 0) return;
    this.#segments.push(Math.sign(imuSign));
    if (this.#segments.length > 50) this.#segments.shift();
  }

  /** One fast GPS epoch: its speed change against the board-frame ∫a. */
  recordEpoch(dvMps: number, boardIntegral: Vec3): void {
    if (Math.abs(dvMps) < this.tuning.swapMinDvMps) return;
    this.#pairs.push({ dv: dvMps, x: boardIntegral.x, y: boardIntegral.y });
    if (this.#pairs.length > 600) this.#pairs.shift();
  }

  verdict(
    configured: ForwardAxis,
    compassHint: "reversed" | "swapped" | null,
  ): MountVerdict {
    const forward = this.#segments.filter((s) => s > 0).length;
    const reversing = this.#segments.length - forward;
    const base = {
      segments: { forward, reversing },
      swapEpochs: this.#pairs.length,
      correlation: null as { x: number; y: number } | null,
    };

    if (this.#pairs.length >= this.tuning.swapMinEpochs) {
      const dv = this.#pairs.map((p) => p.dv);
      const cx = correlation(dv, this.#pairs.map((p) => p.x));
      const cy = correlation(dv, this.#pairs.map((p) => p.y));
      base.correlation = { x: cx, y: cy };
      const best = Math.abs(cx) >= Math.abs(cy)
        ? { axis: "x", c: cx }
        : { axis: "y", c: cy };
      if (Math.abs(best.c) >= this.tuning.swapMinCorr) {
        const axis = `${best.c > 0 ? "+" : "-"}${best.axis}` as ForwardAxis;
        if (axis === configured) {
          return { ...base, status: "ok", suggestedAxis: axis };
        }
        return {
          ...base,
          status: axis[1] === configured[1]
            ? "suspectReversed"
            : "suspectSwapped",
          suggestedAxis: axis,
        };
      }
    }

    const n = this.#segments.length;
    if (n >= this.tuning.minSegments) {
      if (reversing / n >= this.tuning.majority) {
        return {
          ...base,
          status: "suspectReversed",
          suggestedAxis: opposite(configured),
        };
      }
      if (forward / n >= this.tuning.majority) {
        return { ...base, status: "ok", suggestedAxis: configured };
      }
    }
    if (compassHint === "reversed") {
      return {
        ...base,
        status: "suspectReversed",
        suggestedAxis: opposite(configured),
      };
    }
    if (compassHint === "swapped") {
      return { ...base, status: "suspectSwapped", suggestedAxis: null };
    }
    return { ...base, status: "inconclusive", suggestedAxis: null };
  }
}
