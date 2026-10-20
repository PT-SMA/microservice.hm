import type { DirectionTuning } from "./tuning.ts";
import { angleDiff, circularStats, wrap360 } from "./vec.ts";

/**
 * The heading of the vehicle's front, true north: the gyro integrated, and
 * re-anchored to the GPS course whenever the direction of travel is already
 * known from other evidence. It survives stops — which is what lets a
 * reverse after a stop be told apart from the course: 180° from where the
 * front still points.
 */
export class HeadingReference {
  #psi: number | null = null;
  sigmaDeg = Infinity;
  #history: Array<{ tMs: number; psi: number; sigma: number }> = [];
  ambiguousEpochs = 0;
  anchoredAtMs: number | null = null;
  invalidatedBecause: string | null = null;

  constructor(private readonly tuning: DirectionTuning["heading"]) {}

  get valid(): boolean {
    return this.#psi !== null && this.sigmaDeg <= this.tuning.maxSigmaDeg;
  }

  get headingDeg(): number | null {
    return this.#psi;
  }

  /** yawDps counter-clockwise positive; heading is clockwise from north. */
  propagate(
    yawDps: number,
    dtS: number,
    tMs: number,
    biasSigmaDps: number,
  ): void {
    if (this.#psi === null) return;
    const delta = -yawDps * dtS;
    this.#psi = wrap360(this.#psi + delta);
    this.sigmaDeg += biasSigmaDps * dtS +
      this.tuning.sigmaPerRotation * Math.abs(delta);
    this.#history.push({ tMs, psi: this.#psi, sigma: this.sigmaDeg });
    while (
      this.#history.length && tMs - this.#history[0].tMs > this.tuning.historyMs
    ) {
      this.#history.shift();
    }
  }

  gap(gapS: number): void {
    if (this.#psi === null) return;
    this.sigmaDeg += this.tuning.gapSigmaDegPerS * gapS;
    if (gapS > this.tuning.invalidateGapS) this.invalidate("stream gap");
  }

  anchor(courseDeg: number, reversing: boolean, tMs: number): void {
    this.#psi = wrap360(courseDeg + (reversing ? 180 : 0));
    this.sigmaDeg = this.tuning.anchorSigmaDeg;
    this.#history = [{ tMs, psi: this.#psi, sigma: this.sigmaDeg }];
    this.ambiguousEpochs = 0;
    this.anchoredAtMs = tMs;
    this.invalidatedBecause = null;
  }

  invalidate(reason: string): void {
    this.#psi = null;
    this.sigmaDeg = Infinity;
    this.#history = [];
    this.invalidatedBecause = reason;
  }

  /** The reference as it was at `tMs` (GPS course lags by up to an epoch). */
  at(tMs: number): { psi: number; sigma: number } | null {
    if (this.#psi === null) return null;
    let best = this.#history.at(-1);
    for (const h of this.#history) {
      if (Math.abs(h.tMs - tMs) < Math.abs((best?.tMs ?? Infinity) - tMs)) {
        best = h;
      }
    }
    return best ? { psi: best.psi, sigma: best.sigma } : null;
  }
}

export interface CompassVerdict {
  status: "unproven" | "trusted" | "untrusted";
  offsetDeg: number | null;
  spreadDeg: number | null;
  quadrants: number[];
  /** the learned offset alone says the mount setting is off */
  hint: "reversed" | "swapped" | null;
}

/**
 * Whether the board's magnetic heading can be trusted in this cab. A steel
 * truck distorts it by heading-dependent tens of degrees, and the device's
 * magnetometer calibration needs rotating the board in every direction —
 * rarely possible once installed. So it is checked against the GPS course at
 * speed, in at least three course quadrants, before it counts as evidence.
 * The learned offset absorbs declination and how the board is turned.
 */
export class CompassCheck {
  #samples: Array<{ tMs: number; quadrant: number; offsetDeg: number }> = [];

  constructor(private readonly tuning: DirectionTuning["compass"]) {}

  add(tMs: number, courseDeg: number, compassForwardDeg: number): void {
    this.#samples.push({
      tMs,
      quadrant: Math.floor(wrap360(courseDeg) / 90),
      offsetDeg: angleDiff(courseDeg, compassForwardDeg),
    });
  }

  verdict(tMs: number): CompassVerdict {
    this.#samples = this.#samples.filter((s) =>
      tMs - s.tMs <= this.tuning.windowMs
    );
    const counts = [0, 0, 0, 0];
    for (const s of this.#samples) counts[s.quadrant] += 1;
    const all = circularStats(this.#samples.map((s) => s.offsetDeg));
    const offsetDeg = this.#samples.length ? angleDiff(all.meanDeg, 0) : null;
    let hint: CompassVerdict["hint"] = null;
    if (
      offsetDeg !== null && this.#samples.length >= this.tuning.hintSamples &&
      all.stdDeg <= 45
    ) {
      if (Math.abs(offsetDeg) >= 135) hint = "reversed";
      else if (Math.abs(offsetDeg) >= 45) hint = "swapped";
    }

    const full = counts
      .map((n, q) => ({ n, q }))
      .filter(({ n }) => n >= this.tuning.minPerQuadrant);
    if (full.length < this.tuning.minQuadrants) {
      return {
        status: "unproven",
        offsetDeg,
        spreadDeg: null,
        quadrants: counts,
        hint,
      };
    }
    const means = full.map(({ q }) =>
      circularStats(
        this.#samples.filter((s) => s.quadrant === q).map((s) => s.offsetDeg),
      ).meanDeg
    );
    let spread = 0;
    for (const a of means) {
      for (const b of means) {
        spread = Math.max(spread, Math.abs(angleDiff(a, b)));
      }
    }
    const trusted = spread <= this.tuning.maxQuadrantSpreadDeg &&
      all.stdDeg <= this.tuning.maxStdDeg;
    return {
      status: trusted ? "trusted" : "untrusted",
      offsetDeg,
      spreadDeg: spread,
      quadrants: counts,
      hint,
    };
  }
}
