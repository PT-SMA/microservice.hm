import type { DirectionTuning } from "./tuning.ts";
import type { EvidenceSource } from "./types.ts";

const SOURCES: readonly EvidenceSource[] = [
  "launch",
  "turn",
  "gpsHeading",
  "compass",
  "fastTravel",
];

/**
 * Evidence for one movement segment (positive = forward). A vehicle can only
 * change direction through zero speed, so evidence never decays — it resets
 * at every stop or segment boundary. Each source is capped, so no single
 * signal can outvote all the others.
 */
export class Evidence {
  #sums: Record<EvidenceSource, number> = {
    launch: 0,
    turn: 0,
    gpsHeading: 0,
    compass: 0,
    fastTravel: 0,
  };
  #caps: Record<EvidenceSource, number>;

  constructor(tuning: DirectionTuning["evidence"]) {
    this.#caps = {
      launch: tuning.launchCap,
      turn: tuning.turnCap,
      gpsHeading: tuning.gpsHeadingCap,
      compass: tuning.compassCap,
      fastTravel: tuning.fastTravelCap,
    };
  }

  add(source: EvidenceSource, value: number): void {
    const cap = this.#caps[source];
    this.#sums[source] = Math.max(
      -cap,
      Math.min(cap, this.#sums[source] + value),
    );
  }

  get total(): number {
    return SOURCES.reduce((sum, s) => sum + this.#sums[s], 0);
  }

  sum(source: EvidenceSource): number {
    return this.#sums[source];
  }

  /** Points and sources agreeing with `sign`, leaving `excluding` out. */
  support(
    sign: 1 | -1,
    excluding: EvidenceSource[] = [],
  ): { points: number; sources: number } {
    let points = 0, sources = 0;
    for (const s of SOURCES) {
      if (excluding.includes(s)) continue;
      const v = this.#sums[s] * sign;
      if (v > 0) {
        points += v;
        sources += 1;
      }
    }
    return { points, sources };
  }

  /** The sources agreeing with `sign`, for the change's basis. */
  agreeing(sign: 1 | -1): EvidenceSource[] {
    return SOURCES.filter((s) => this.#sums[s] * sign > 0);
  }

  snapshot(): Record<EvidenceSource, number> {
    return { ...this.#sums };
  }

  reset(): void {
    for (const s of SOURCES) this.#sums[s] = 0;
  }
}
