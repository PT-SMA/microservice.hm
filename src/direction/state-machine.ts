import type { DirectionTuning } from "./tuning.ts";
import type { Basis, DirectionChange, TravelDirection } from "./types.ts";

export type Phase = "unknown" | "stopped" | "moving";

/**
 * What is published, and when. Internally the unit is unknown, stopped, or
 * moving with a direction decided or not; the published value adds three
 * delays so a start does not flicker stopped → moving → reversing:
 *
 * - a fresh start keeps saying `stopped` until decided, or for 1.5 s;
 * - a segment boundary keeps the old direction for up to 2 s;
 * - at most one change per 500 ms (later ones coalesce).
 */
export class DirectionStateMachine {
  phase: Phase = "unknown";
  decided: "forward" | "reversing" | null = null;
  published: TravelDirection = "unknown";
  changedAtMs = 0;
  flips = 0;
  lastFlipAtMs: number | null = null;

  #movingSinceMs = 0;
  /** the first direction decided in this segment */
  #segmentDecided: "forward" | "reversing" | null = null;
  #holdUntilMs = 0;
  #lastEmitMs = -Infinity;
  #basis: Basis[] = [];
  #correction = false;

  constructor(
    private readonly tuning: DirectionTuning["state"],
    private readonly evidence: DirectionTuning["evidence"],
    private readonly onChange: (change: DirectionChange) => void,
  ) {}

  toUnknown(tMs: number): void {
    if (this.phase === "unknown") return;
    this.phase = "unknown";
    this.decided = null;
    this.#basis = [];
    this.update(tMs);
  }

  toStopped(tMs: number, basis: Basis[]): void {
    if (this.phase === "stopped") return;
    this.phase = "stopped";
    this.decided = null;
    this.#basis = basis;
    this.update(tMs);
  }

  toMoving(tMs: number, basis: Basis[]): void {
    if (this.phase === "moving") return;
    this.phase = "moving";
    this.decided = null;
    this.#segmentDecided = null;
    this.#movingSinceMs = tMs;
    this.#holdUntilMs = 0;
    this.#basis = basis;
    this.update(tMs);
  }

  /** A new segment without leaving `moving`: the old direction may not hold. */
  boundary(tMs: number, basis: Basis[]): void {
    if (this.phase !== "moving") return;
    this.decided = null;
    this.#segmentDecided = null;
    this.#holdUntilMs = tMs + this.tuning.boundaryHoldS * 1000;
    this.#basis = basis;
    this.update(tMs);
  }

  /** The segment's evidence changed. */
  applyEvidence(
    total: number,
    tMs: number,
    agreeing: (sign: 1 | -1) => Basis[],
  ): void {
    if (this.phase !== "moving") return;
    const decide = this.evidence.decide, retract = this.evidence.retract;
    if (this.decided === null) {
      if (total >= decide) this.decide("forward", tMs, agreeing(1), false);
      else if (total <= -decide) {
        this.decide("reversing", tMs, agreeing(-1), false);
      }
    } else if (this.decided === "forward") {
      if (total <= -decide) this.decide("reversing", tMs, agreeing(-1), true);
      else if (total < retract) this.decide(null, tMs, [], false);
    } else {
      if (total >= decide) this.decide("forward", tMs, agreeing(1), true);
      else if (total > -retract) this.decide(null, tMs, [], false);
    }
  }

  private decide(
    direction: "forward" | "reversing" | null,
    tMs: number,
    basis: Basis[],
    correction: boolean,
  ): void {
    this.decided = direction;
    this.#basis = basis;
    // retracted and then decided the other way: a correction all the same
    if (direction !== null) {
      if (this.#segmentDecided !== null && this.#segmentDecided !== direction) {
        correction = true;
      }
      this.#segmentDecided = direction;
    }
    if (correction) {
      this.#correction = true;
      this.flips += 1;
      this.lastFlipAtMs = tMs;
    }
    this.update(tMs);
  }

  tick(tMs: number): void {
    this.update(tMs);
  }

  private desired(tMs: number): TravelDirection {
    if (this.phase === "unknown") return "unknown";
    if (this.phase === "stopped") return "stopped";
    if (this.decided) return this.decided;
    if (
      this.published === "stopped" &&
      (tMs - this.#movingSinceMs) / 1000 < this.tuning.undecidedPublishS
    ) return "stopped";
    if (
      tMs < this.#holdUntilMs &&
      (this.published === "forward" || this.published === "reversing")
    ) return this.published;
    return "moving";
  }

  private update(tMs: number): void {
    const next = this.desired(tMs);
    if (next === this.published) {
      this.#correction = false;
      return;
    }
    if (tMs - this.#lastEmitMs < this.tuning.minChangeIntervalMs) return; // coalesce
    const previous = this.published;
    this.published = next;
    this.changedAtMs = tMs;
    this.#lastEmitMs = tMs;
    const correction = this.#correction &&
      (next === "forward" || next === "reversing");
    this.#correction = false;
    this.onChange({
      travelDirection: next,
      previousTravelDirection: previous,
      changedAtMs: tMs,
      basis: [...new Set(this.#basis)],
      correction,
    });
  }
}
