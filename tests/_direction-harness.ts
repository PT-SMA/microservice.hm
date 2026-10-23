import {
  type DirectionTrace,
  type ForwardAxis,
  type TravelDirection,
  TravelDirectionEstimator,
} from "direction";
import { parseGpsFix } from "helpers";
import type { SimRun } from "./_vehicle-sim.ts";

export interface Transition {
  tMs: number;
  from: TravelDirection;
  to: TravelDirection;
  basis: string[];
  correction: boolean;
}

export interface HarnessOptions {
  forwardAxis?: ForwardAxis;
  reverseMaxKmh?: number;
  /** collect the estimator's calibration trace */
  trace?: boolean;
  /** drop the GPS / IMU events, as if that input were absent */
  gps?: boolean;
  imu?: boolean;
}

/** Feed a simulated run through a fresh estimator, ticking once a second. */
export function runDirection(run: SimRun, options: HarnessOptions = {}) {
  const transcript: Transition[] = [];
  const traces: DirectionTrace[] = [];
  const estimator = new TravelDirectionEstimator({
    onTrace: options.trace ? (t) => traces.push(t) : undefined,
    forwardAxis: options.forwardAxis ?? "+x",
    reverseMaxKmh: options.reverseMaxKmh ?? 20,
    onChange: (c) =>
      transcript.push({
        tMs: c.changedAtMs,
        from: c.previousTravelDirection,
        to: c.travelDirection,
        basis: c.basis,
        correction: c.correction,
      }),
  });
  const useGps = options.gps ?? true, useImu = options.imu ?? true;
  let nextTick = (run.events[0]?.tMs ?? 0) + 1000;
  for (const e of run.events) {
    while (e.tMs >= nextTick) {
      estimator.tick(nextTick);
      nextTick += 1000;
    }
    if (e.kind === "imu" && useImu) estimator.onImu(e.sample, e.tMs);
    else if (e.kind === "status") estimator.onDeviceStatus(e.status, e.tMs);
    else if (e.kind === "reset") estimator.onReset(e.reason, e.tMs);
    else if (e.kind === "gps" && useGps) {
      const fix = parseGpsFix(e.raw);
      if (fix) estimator.onGps(fix, e.tMs);
    }
  }
  while (nextTick <= run.endMs + 1000) {
    estimator.tick(nextTick);
    nextTick += 1000;
  }
  return { transcript, estimator, traces, endMs: run.endMs };
}

/** The value published at `tMs`. */
export function stateAt(
  transcript: Transition[],
  tMs: number,
): TravelDirection {
  let state: TravelDirection = "unknown";
  for (const t of transcript) {
    if (t.tMs > tMs) break;
    state = t.to;
  }
  return state;
}

/** The first change to `value` at or after `fromMs`. */
export function firstChange(
  transcript: Transition[],
  value: TravelDirection,
  fromMs = 0,
): Transition | undefined {
  return transcript.find((t) => t.to === value && t.tMs >= fromMs);
}

/** Was `value` ever published within [fromMs, toMs]? (Including a value still in force at fromMs.) */
export function everPublished(
  transcript: Transition[],
  value: TravelDirection,
  fromMs = 0,
  toMs = Infinity,
): boolean {
  if (stateAt(transcript, fromMs) === value) return true;
  return transcript.some((t) =>
    t.to === value && t.tMs >= fromMs && t.tMs <= toMs
  );
}

export function show(transcript: Transition[], originMs = 0): string {
  return transcript
    .map((t) =>
      `${((t.tMs - originMs) / 1000).toFixed(1)}s ${t.from}→${t.to}` +
      (t.basis.length ? ` [${t.basis.join(",")}]` : "") +
      (t.correction ? " corrected" : "")
    )
    .join("\n");
}
