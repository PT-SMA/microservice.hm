import { Evidence } from "./evidence.ts";
import { GyroBias } from "./gyro-bias.ts";
import {
  CompassCheck,
  type CompassVerdict,
  HeadingReference,
} from "./heading-reference.ts";
import { Launch } from "./launch.ts";
import { type Mount, mountOf } from "./mount.ts";
import { MountCheck, type MountVerdict } from "./self-check.ts";
import { DirectionStateMachine } from "./state-machine.ts";
import { type Block, Stillness } from "./stillness.ts";
import { StreamClock } from "./stream-clock.ts";
import { Attitude } from "./tilt.ts";
import { DIRECTION_TUNING, type DirectionTuning } from "./tuning.ts";
import { TurnWindow } from "./turn.ts";
import type {
  Basis,
  DeviceStatus,
  DirectionChange,
  DirectionSnapshot,
  DirectionTrace,
  EvidenceSource,
  ForwardAxis,
  GpsFix,
  ImuSample,
  Vec3,
} from "./types.ts";
import { add, angleDiff, DEG, mean, scale, sub, vec, wrap360 } from "./vec.ts";

export interface EstimatorOptions {
  forwardAxis: ForwardAxis;
  /** above this GPS speed the unit is assumed forward; 0 = never assume */
  reverseMaxKmh: number;
  tuning?: DirectionTuning;
  onChange?: (change: DirectionChange) => void;
  onTrace?: (trace: DirectionTrace) => void;
}

export interface DirectionHealth {
  travelDirection: string;
  changedAt: string | null;
  forwardAxis: ForwardAxis;
  imu: {
    status: "ok" | "absent" | "frozen" | "gap";
    hz: number | null;
    degraded: boolean;
    reason: string | null;
  };
  gpsAgeMs: number | null;
  gyroBiasLearned: boolean;
  idleWanderMg: number | null;
  anchorSigmaDeg: number | null;
  compass: CompassVerdict;
  mountCheck: MountVerdict;
  leverArmM: number | null;
  evidence: Record<EvidenceSource, number>;
  flips: number;
  lastFlipAt: string | null;
  warnings: string[];
}

interface Sample {
  tMs: number;
  dtS: number;
  accel: Vec3;
  gyro: Vec3;
}

const iso = (
  ms: number | null,
) => (ms === null ? null : new Date(ms).toISOString());

/**
 * Which way the unit travels: stopped, forward, reversing, moving (direction
 * not decided) or unknown. Pure — every input carries its time; nothing reads
 * a clock, so a recording replays to the same transcript.
 *
 * Direction is decided per movement segment (a vehicle can only change it
 * through zero speed): at launch from the sign of the gravity-free forward
 * acceleration, in turns from lateral acceleration vs yaw rate, on straights
 * from the GPS course against a gyro heading anchored to GPS, and from the
 * compass once it has proven itself. See tuning.ts for every threshold.
 */
export class TravelDirectionEstimator {
  readonly forwardAxis: ForwardAxis;
  readonly #t: DirectionTuning;
  readonly #mount: Mount;
  readonly #reverseMaxKmh: number;
  readonly #onTrace?: (trace: DirectionTrace) => void;

  readonly #clock: StreamClock;
  readonly #bias: GyroBias;
  readonly #attitude: Attitude;
  readonly #stillness: Stillness;
  readonly #turn: TurnWindow;
  readonly #heading: HeadingReference;
  readonly #compass: CompassCheck;
  readonly #evidence: Evidence;
  readonly #mountCheck: MountCheck;
  readonly #sm: DirectionStateMachine;

  // IMU
  #imuStatus: "absent" | "ok" | "frozen" | "gap" = "absent";
  #lastImuMs: number | null = null;
  #pre: Sample[] = [];
  #yawHistory: Array<{ tMs: number; yawDps: number }> = [];
  #launch: Launch | null = null;
  #launchArmed = false;
  #pendingImuStartMs: number | null = null;
  #stillBlocks: Array<{ tMs: number; accel: Vec3 }> = [];
  #stoppedSinceMs: number | null = null;
  #wasStillThisStop = false;
  #boundaryOnStill = false;
  #shuttle: Array<{ tMs: number; dv: number }> = [];
  #shuttleCandidate: { tMs: number; sign: 1 | -1; dv: number } | null = null;
  #shuttleSum = 0;
  #shuttleN = 0;
  #shuttleDur = 0;
  #epochIntegral = vec();
  /** short-horizon signed velocity, see DIRECTION_TUNING.velocity */
  #vel: {
    v: number;
    sign: 1 | -1;
    ageS: number;
    maxAgeS: number;
    crossedS: number;
    holdSinceMs: number | null;
  } | null = null;
  #rotatingSinceMs: number | null = null;
  /** the last few GPS speeds, km/h: did the unit pass through zero? */
  #recentGpsKmh: number[] = [];

  // GPS
  #lastGpsMs: number | null = null;
  #lastGpsTime: string | null = null;
  #gpsSpeed: number | null = null;
  #prevGpsSpeed: number | null = null;
  #lowEpochs = 0;
  #highEpochs = 0;
  #gpsStoppedSinceMs: number | null = null;
  #lastTrack: number | null = null;
  #sameTrackEpochs = 0;
  #yawSinceTrackDeg = 0;
  #trackFrozen = false;

  // device status
  #status: DeviceStatus & { tMs: number } | null = null;

  // segment
  #segmentReachedFast = false;
  #warnedRetract = false;

  constructor(options: EstimatorOptions) {
    this.forwardAxis = options.forwardAxis;
    this.#t = options.tuning ?? DIRECTION_TUNING;
    this.#mount = mountOf(options.forwardAxis);
    this.#reverseMaxKmh = options.reverseMaxKmh;
    this.#onTrace = options.onTrace;
    const t = this.#t;
    this.#clock = new StreamClock(t.stream);
    this.#bias = new GyroBias(t.bias);
    this.#attitude = new Attitude(t.attitude);
    this.#stillness = new Stillness(t.stillness, false);
    this.#turn = new TurnWindow(t.turn);
    this.#heading = new HeadingReference(t.heading);
    this.#compass = new CompassCheck(t.compass);
    this.#evidence = new Evidence(t.evidence);
    this.#mountCheck = new MountCheck(t.mount);
    this.#sm = new DirectionStateMachine(t.state, t.evidence, (change) => {
      this.trace(change.changedAtMs, "transition", { ...change });
      options.onChange?.(change);
    });
  }

  // ------------------------------------------------------------------ inputs

  onImu(sample: ImuSample, tMs: number): void {
    const tick = this.#clock.push(sample, tMs);
    if (tick.frozen) {
      this.#imuStatus = "frozen";
      return;
    }
    if (tick.gap) this.onImuGap(tick.gapMs, tMs);
    this.#imuStatus = "ok";
    this.#lastImuMs = tMs;

    const degraded = this.#clock.degraded;
    this.#stillness.setDegraded(degraded);
    const accel = this.#mount.toVehicle(sample.accelG);
    const rawGyro = this.#mount.toVehicle(sample.gyroDps);
    const gyro = sub(rawGyro, this.#bias.value);
    const dtS = tick.dtS;

    this.#attitude.propagate(gyro, accel, dtS, this.longitudinalSteady(tMs));
    const yawDps = this.#attitude.yawDps(gyro);
    this.#yawHistory.push({ tMs, yawDps });
    const yawKeepMs = this.#t.gps.yawWindowS * 1000;
    while (
      this.#yawHistory.length && tMs - this.#yawHistory[0].tMs > yawKeepMs
    ) {
      this.#yawHistory.shift();
    }
    this.#yawSinceTrackDeg += yawDps * dtS;
    this.#heading.propagate(yawDps, dtS, tMs, this.#bias.sigmaDps);
    const linear = this.#attitude.linear(accel);
    this.#epochIntegral = add(
      this.#epochIntegral,
      scale(this.#mount.toBoard(linear), dtS),
    );

    this.#pre.push({ tMs, dtS, accel, gyro });
    const preKeepMs = this.#t.launch.preTriggerS * 1000;
    while (this.#pre.length && tMs - this.#pre[0].tMs > preKeepMs) {
      this.#pre.shift();
    }

    const block = this.#stillness.push(accel, rawGyro, dtS, tMs, {
      biasDps: this.#bias.value,
      biasLearned: this.#bias.learned,
      degraded,
      gravityG: this.#attitude.anchored
        ? scale(this.#attitude.up, this.#attitude.gravityG)
        : null,
    });
    if (block) this.onBlock(block, tMs);

    this.trackVelocity(linear.x, dtS, tMs);

    if (this.#sm.phase === "moving") {
      this.#turn.push(linear.y, yawDps * DEG, dtS, tMs);
      this.pushShuttle(linear.x, dtS, tMs);
      if (this.#turn.due(tMs)) this.evaluateTurn(tMs, degraded);
    }

    if (this.#launch) {
      this.#launch.push(accel, gyro, dtS, tMs);
      this.onLaunchProgress(tMs);
    }
    this.#sm.tick(tMs);
  }

  onGps(fix: GpsFix, tMs: number): void {
    this.#lastGpsMs = tMs;
    if (fix.time === this.#lastGpsTime) return; // one epoch counts once
    this.#lastGpsTime = fix.time;
    const g = this.#t.gps;
    const speed = fix.speedKmh;
    this.#prevGpsSpeed = this.#gpsSpeed;
    this.#gpsSpeed = speed;
    this.#recentGpsKmh.push(speed);
    if (this.#recentGpsKmh.length > 3) this.#recentGpsKmh.shift();
    this.#lowEpochs = speed < g.stopKmh ? this.#lowEpochs + 1 : 0;
    this.#highEpochs = speed >= g.startKmh ? this.#highEpochs + 1 : 0;
    if (speed < g.stopKmh) this.#gpsStoppedSinceMs ??= tMs;
    else this.#gpsStoppedSinceMs = null;

    // mount swap check: at fast travel the unit is forward
    if (
      this.#reverseMaxKmh > 0 && speed >= this.#reverseMaxKmh &&
      this.#prevGpsSpeed !== null &&
      this.#prevGpsSpeed >= this.#reverseMaxKmh &&
      this.#imuStatus === "ok"
    ) {
      this.#mountCheck.recordEpoch(
        (speed - this.#prevGpsSpeed) / 3.6,
        this.#epochIntegral,
      );
    }
    this.#epochIntegral = vec();

    const phase = this.#sm.phase;
    // a GPS speed spike at standstill: a healthy IMU that says still vetoes it
    const imuStill = this.#imuStatus === "ok" && !this.#clock.degraded &&
      this.#stillness.still;
    const started = (this.#highEpochs >= 2 || speed >= g.startStrongKmh) &&
      !imuStill;
    if (phase !== "moving") {
      if (started) {
        this.startMoving(tMs, ["gpsSpeed"]);
        if (!this.#launch) this.armLaunch(tMs, true);
      } else if (this.#lowEpochs >= 2 && phase === "unknown") {
        this.stopMoving(tMs, ["gpsSpeed"]);
      }
    } else {
      if (this.#lowEpochs >= 2) {
        this.stopMoving(tMs, ["gpsSpeed"]);
      } else if (speed < g.boundaryKmh) {
        this.segmentBoundary(tMs, ["gpsSpeed"]);
      }
    }
    if (this.#pendingImuStartMs !== null && speed >= g.startKmh) {
      this.#pendingImuStartMs = null;
      this.startMoving(tMs, ["launch", "gpsSpeed"]);
    }

    this.updateTrack(fix, speed);
    if (this.#sm.phase === "moving") this.gpsEvidence(fix, speed, tMs);
    this.#sm.tick(tMs);
  }

  onDeviceStatus(status: DeviceStatus, tMs: number): void {
    this.#status = { ...status, tMs };
  }

  onReset(reason: "boot" | "link", tMs: number): void {
    this.trace(tMs, "launch", { reset: reason });
    this.#launch = null;
    this.#launchArmed = false;
    this.#stillBlocks = [];
    this.#pre = [];
    this.#stillness.reset();
    this.#turn.reset();
    this.#heading.invalidate(
      reason === "boot" ? "device boot" : "link reopened",
    );
    this.#vel = null;
    if (this.#sm.phase === "moving" && !this.gpsHolds(tMs)) {
      this.segmentBoundary(tMs, []);
    }
  }

  /** Once a second: staleness and the published value's timers. */
  tick(tMs: number): void {
    const t = this.#t.state;
    const imuAlive = this.#lastImuMs !== null &&
      tMs - this.#lastImuMs <= t.unknownAfterS * 1000 &&
      this.#imuStatus !== "frozen";
    const gpsFresh = this.gpsFresh(tMs);
    if (!imuAlive && !gpsFresh) {
      const last = Math.max(
        this.#lastImuMs ?? -Infinity,
        this.#lastGpsMs ?? -Infinity,
      );
      if (!Number.isFinite(last) || tMs - last >= t.unknownAfterS * 1000) {
        if (this.#sm.phase !== "unknown") this.endSegment();
        this.#sm.toUnknown(tMs);
      }
    }
    if (
      this.#pendingImuStartMs !== null &&
      (tMs - this.#pendingImuStartMs) / 1000 > this.#t.launch.gpsConfirmS
    ) {
      // fresh GPS said < 1 km/h and never confirmed: a jolt, not a start
      this.#pendingImuStartMs = null;
      this.#launch = null;
    }
    if (
      this.#imuStatus === "ok" && this.#lastImuMs !== null &&
      tMs - this.#lastImuMs > 1000
    ) {
      this.#imuStatus = "gap";
    }
    this.#sm.tick(tMs);
  }

  // ----------------------------------------------------------------- outputs

  snapshot(): DirectionSnapshot {
    const compass = this.#compass.verdict(this.#sm.changedAtMs);
    return {
      travelDirection: this.#sm.published,
      changedAtMs: this.#sm.changedAtMs,
      headingOffsetDeg: this.#mount.headingOffsetDeg +
        (compass.status === "trusted" && compass.offsetDeg !== null
          ? compass.offsetDeg
          : 0),
    };
  }

  health(tMs: number): DirectionHealth {
    const compass = this.#compass.verdict(tMs);
    const mountCheck = this.#mountCheck.verdict(this.forwardAxis, compass.hint);
    const hz = this.#clock.hz;
    const degraded = this.#clock.degraded;
    const warnings: string[] = [];
    const imuStatus = this.#lastImuMs === null ? "absent" : this.#imuStatus;
    if (imuStatus !== "ok") {
      warnings.push(
        `IMU stream ${imuStatus}: direction from GPS only (needs streamMode ≠ 0, imuStreamHz > 0, an IMU fitted)`,
      );
    } else if (degraded) {
      warnings.push(
        `IMU stream ${hz} Hz: launch and stop detection degraded — set imuStreamHz to 100 (50 over Bluetooth)`,
      );
    }
    if (
      degraded && this.#stillness.idleLearned &&
      this.#stillness.idleFloorMg > this.#t.stillness.idleWanderWarnMg
    ) {
      warnings.push(
        `idle vibration wanders ${
          this.#stillness.idleFloorMg.toFixed(0)
        } mg at ${hz} Hz: raise imuStreamHz`,
      );
    }
    if (
      mountCheck.status === "suspectReversed" ||
      mountCheck.status === "suspectSwapped"
    ) {
      warnings.push(
        `HOUR_METER_FORWARD_AXIS=${this.forwardAxis} looks wrong (${mountCheck.status})` +
          (mountCheck.suggestedAxis ? `: try ${mountCheck.suggestedAxis}` : ""),
      );
    }
    return {
      travelDirection: this.#sm.published,
      changedAt: iso(this.#sm.changedAtMs || null),
      forwardAxis: this.forwardAxis,
      imu: {
        status: imuStatus,
        hz,
        degraded,
        reason: degraded
          ? `stream ${hz} Hz < ${this.#t.stream.degradedBelowHz} Hz`
          : null,
      },
      gpsAgeMs: this.#lastGpsMs === null ? null : tMs - this.#lastGpsMs,
      gyroBiasLearned: this.#bias.learned,
      idleWanderMg: this.#stillness.idleLearned
        ? Math.round(this.#stillness.idleFloorMg * 10) / 10
        : null,
      anchorSigmaDeg: this.#heading.valid
        ? Math.round(this.#heading.sigmaDeg * 10) / 10
        : null,
      compass,
      mountCheck,
      leverArmM: this.#turn.leverArmM,
      evidence: this.#evidence.snapshot(),
      flips: this.#sm.flips,
      lastFlipAt: iso(this.#sm.lastFlipAtMs),
      warnings,
    };
  }

  // ---------------------------------------------------------------- internals

  private trace(
    tMs: number,
    kind: DirectionTrace["kind"],
    data: Record<string, unknown>,
  ): void {
    this.#onTrace?.({ tMs, kind, data });
  }

  private gpsFresh(tMs: number): boolean {
    return this.#lastGpsMs !== null &&
      tMs - this.#lastGpsMs <= this.#t.gps.freshMs;
  }

  /** Is the speed known not to be changing (for the attitude's pitch)? */
  private longitudinalSteady(tMs: number): boolean {
    if (this.#sm.phase !== "moving") return true;
    return this.gpsFresh(tMs) && this.#gpsSpeed !== null &&
      this.#prevGpsSpeed !== null &&
      Math.abs(this.#gpsSpeed - this.#prevGpsSpeed) <=
        this.#t.velocity.steadyKmh;
  }

  /** GPS stayed fresh and fast: a short IMU gap does not end the segment. */
  private gpsHolds(tMs: number): boolean {
    return this.gpsFresh(tMs) && (this.#gpsSpeed ?? 0) >= this.#t.gps.holdKmh;
  }

  private onImuGap(gapMs: number, tMs: number): void {
    const gapS = gapMs / 1000;
    this.#heading.gap(gapS);
    this.#launch = null;
    this.#launchArmed = false;
    this.#pre = [];
    this.#stillness.reset();
    this.#turn.reset();
    this.#imuStatus = "gap";
    if (this.#sm.phase === "moving" && !this.gpsHolds(tMs)) {
      this.segmentBoundary(tMs, []);
    }
  }

  private onBlock(block: Block, tMs: number): void {
    const still = this.#stillness.still;
    const phase = this.#sm.phase;
    const gpsFresh = this.gpsFresh(tMs);

    // a standstill is a velocity anchor too
    if (still && this.#vel) {
      this.#vel.v = 0;
      this.#vel.ageS = 0;
      this.#vel.maxAgeS = this.#t.velocity.maxAgeImuS;
      this.#vel.crossedS = 0;
    }

    // back from unknown while already moving: sustained rotation proves it
    const m = this.#t.motionFromUnknown;
    const rotating =
      Math.hypot(...Object.values(sub(block.gyroDps, this.#bias.value))) >=
        (this.#bias.learned ? m.gyroDps : m.gyroDpsUnlearned);
    if (rotating) this.#rotatingSinceMs ??= tMs;
    else this.#rotatingSinceMs = null;
    if (
      phase === "unknown" && this.#rotatingSinceMs !== null &&
      (tMs - this.#rotatingSinceMs) / 1000 >= this.#t.motionFromUnknown.forS
    ) {
      this.startMoving(tMs, ["imuMotion"]);
    }

    // the idle floor: what this engine shakes while GPS says stopped
    if (
      this.#gpsStoppedSinceMs !== null && gpsFresh &&
      (tMs - this.#gpsStoppedSinceMs) / 1000 >=
        this.#t.stillness.idleLearnAfterStoppedS &&
      (this.#status?.engineRunning ?? true)
    ) {
      this.#stillness.learnIdle(block.durS);
    }

    if (phase !== "moving") {
      if (still) {
        this.#wasStillThisStop = true;
        this.#stoppedSinceMs ??= tMs;
        const stoppedS = (tMs - this.#stoppedSinceMs) / 1000;
        this.#bias.learn(block.gyroDps, block.durS, stoppedS);
        this.#stillBlocks.push({ tMs: block.tMs, accel: block.accelG });
        while (
          this.#stillBlocks.length && tMs - this.#stillBlocks[0].tMs > 60_000
        ) {
          this.#stillBlocks.shift();
        }
        this.#attitude.reset(this.recentGravity(tMs));
        this.#launchArmed = true;
        if (
          phase === "unknown" &&
          !(gpsFresh && (this.#gpsSpeed ?? 0) >= this.#t.gps.holdKmh)
        ) {
          this.stopMoving(tMs, ["imuStill"]);
        }
      } else if (this.#launchArmed && !this.#launch) {
        this.armLaunch(tMs, false);
      }
      return;
    }

    // moving: IMU stillness ends the segment, or the movement
    const stillS = this.#stillness.stillForS(tMs);
    if (stillS <= 0) {
      this.#boundaryOnStill = false;
      return;
    }
    const gpsSlow = !gpsFresh || (this.#gpsSpeed ?? 0) < this.#t.gps.holdKmh;
    if (!gpsSlow) return;
    const s = this.#t.state;
    const imuOnly = !gpsFresh;
    const stopAfter = this.#clock.degraded
      ? s.stillStopSDegraded
      : imuOnly
      ? s.stillStopSImuOnly
      : s.stillStopS;
    if (stillS >= stopAfter) {
      this.stopMoving(tMs, ["imuStill"]);
    } else if (stillS >= s.boundaryStillS && !this.#boundaryOnStill) {
      this.#boundaryOnStill = true;
      this.segmentBoundary(tMs, ["imuStill"]);
    }
  }

  private recentGravity(tMs: number): Vec3 {
    const recent = this.#stillBlocks.filter((b) => tMs - b.tMs <= 1000);
    const use = recent.length ? recent : this.#stillBlocks.slice(-1);
    return vec(
      mean(use.map((b) => b.accel.x)),
      mean(use.map((b) => b.accel.y)),
      mean(use.map((b) => b.accel.z)),
    );
  }

  /** Start integrating a launch from the pre-trigger buffer. */
  private armLaunch(tMs: number, fromGps: boolean, whileMoving = false): void {
    const L = this.#t.launch;
    const since = this.#stoppedSinceMs ?? tMs;
    const onsetMs = this.#pre[0]?.tMs ?? tMs;
    const settled = this.#stillBlocks.filter((b) =>
      // settled after the stop, and before the pre-trigger second
      b.tMs >= since + L.g0SettleS * 1000 && b.tMs <= onsetMs
    );
    const pool = settled.length
      ? settled
      : this.#stillBlocks.filter((b) => b.tMs <= onsetMs);
    const stillS = pool.length * this.#t.stillness.blockS;
    const g0 = pool.length
      ? vec(
        mean(pool.map((b) => b.accel.x)),
        mean(pool.map((b) => b.accel.y)),
        mean(pool.map((b) => b.accel.z)),
      )
      : scale(this.#attitude.up, this.#attitude.gravityG);
    const launch = new Launch(L, {
      full: this.#t.evidence.launch,
      degraded: this.#t.evidence.launchDegraded,
      shortStop: this.#t.evidence.launchShortStop,
    }, {
      g0,
      degraded: this.#clock.degraded,
      shortStop: fromGps || !settled.length || stillS < L.shortStopS,
      startMs: onsetMs,
      requireZeroCross: whileMoving,
    });
    for (const p of this.#pre) launch.push(p.accel, p.gyro, p.dtS, p.tMs);
    this.#launch = launch;
    this.#launchArmed = false;
    this.trace(tMs, "launch", {
      armed: true,
      fromGps,
      gradePct: launch.gradePct,
      shortStop: launch.ctx.shortStop,
    });
    this.onLaunchProgress(tMs);
  }

  private onLaunchProgress(tMs: number): void {
    const launch = this.#launch;
    if (!launch) return;
    if (launch.aborted || (launch.expired(tMs) && !launch.decision)) {
      this.trace(tMs, "launch", {
        ended: launch.aborted ? "saturated" : "expired",
        v: launch.v,
        s: launch.s,
      });
      this.#launch = null;
      return;
    }
    if (
      launch.onsetAtMs !== null && this.#sm.phase !== "moving" &&
      this.#pendingImuStartMs === null
    ) {
      const gpsVeto = this.gpsFresh(tMs) &&
        (this.#gpsSpeed ?? 0) < this.#t.gps.stopKmh;
      if (gpsVeto) this.#pendingImuStartMs = tMs;
      else this.startMoving(tMs, ["launch"]);
    }
    if (launch.decision && this.#sm.phase === "moving") {
      const { sign, weight } = launch.decision;
      this.trace(tMs, "launch", {
        decided: sign,
        v: launch.v,
        s: launch.s,
        weight,
        gradePct: launch.gradePct,
      });
      this.#launch = null;
      this.anchorVelocity(launch.v, sign, this.#t.velocity.maxAgeImuS);
      this.addEvidence("launch", sign * weight, tMs);
    }
  }

  private startMoving(tMs: number, basis: Basis[]): void {
    if (this.#sm.phase === "moving") return;
    this.newSegment();
    this.#stoppedSinceMs = null;
    this.#wasStillThisStop = false;
    this.#sm.toMoving(tMs, basis);
  }

  private stopMoving(tMs: number, basis: Basis[]): void {
    if (this.#sm.phase === "moving") this.endSegment();
    this.#shuttleCandidate = null;
    this.#launch = null;
    this.#pendingImuStartMs = null;
    this.#stoppedSinceMs ??= tMs;
    this.#sm.toStopped(tMs, basis);
  }

  private segmentBoundary(tMs: number, basis: Basis[]): void {
    this.endSegment();
    this.newSegment();
    this.#sm.boundary(tMs, basis);
    // a stop-and-go without a full stop: a new launch from where we are
    if (this.#imuStatus === "ok" && !this.#launch) {
      this.armLaunch(tMs, true, true);
    }
  }

  private newSegment(): void {
    this.#shuttleCandidate = null;
    this.#evidence.reset();
    this.#segmentReachedFast = false;
    this.#warnedRetract = false;
    this.#shuttle = [];
  }

  private endSegment(): void {
    if (this.#segmentReachedFast) {
      this.#mountCheck.recordSegment(
        this.#evidence.sum("launch") + this.#evidence.sum("turn"),
      );
    }
  }

  private addEvidence(
    source: EvidenceSource,
    value: number,
    tMs: number,
    detail: Record<string, unknown> = {},
  ): void {
    if (value === 0) return;
    this.#evidence.add(source, value);
    const total = this.#evidence.total;
    this.trace(tMs, "evidence", { source, value, total, ...detail });
    const before = this.#sm.decided;
    this.#sm.applyEvidence(total, tMs, (sign) => this.#evidence.agreeing(sign));
    if (before !== null && this.#sm.decided === null && !this.#warnedRetract) {
      this.#warnedRetract = true;
      this.trace(tMs, "evidence", { retracted: before, total });
    }
  }

  private evaluateTurn(tMs: number, degraded: boolean): void {
    const fit = this.#turn.fit(tMs, degraded);
    if (fit === null) return;
    const gpsFresh = this.gpsFresh(tMs);
    const gpsMps = (this.#gpsSpeed ?? 0) / 3.6;
    let rejected = fit.rejected;
    if (!rejected && gpsFresh && gpsMps > 0.5) {
      const ratio = Math.abs(fit.speedMps) / gpsMps;
      if (
        ratio < this.#t.turn.gpsRatioMin || ratio > this.#t.turn.gpsRatioMax
      ) {
        rejected = `speed ${fit.speedMps.toFixed(1)} m/s disagrees with GPS ${
          gpsMps.toFixed(1)
        }`;
      }
    }
    this.trace(tMs, "turnWindow", { ...fit, rejected: rejected ?? null });
    if (
      !fit.rejected && this.#turn.leverArmM === null && fit.leverArmM !== null
    ) {
      this.#turn.recordLeverArm(fit.leverArmM);
    }

    // a window GPS confirms teaches the lever arm
    if (
      this.#turn.leverArmM === null && gpsFresh &&
      (this.#gpsSpeed ?? 0) >= this.#t.turn.leverLearnMinKmh &&
      this.#sm.decided !== null &&
      fit.maxYawDps >= this.#t.turn.minMaxYawDps
    ) {
      const sign = this.#sm.decided === "forward" ? 1 : -1;
      this.#turn.learnLeverArm(tMs, degraded, sign * gpsMps);
    }
    if (rejected) return;
    const az = Math.abs(fit.z);
    if (az < this.#t.turn.zWeak) return;
    const weight = az >= this.#t.turn.zStrong
      ? this.#t.evidence.turnStrong
      : this.#t.evidence.turnWeak;
    this.#turn.markEvidence(tMs);
    this.addEvidence("turn", Math.sign(fit.speedMps) * weight, tMs, {
      speedMps: fit.speedMps,
      z: fit.z,
    });
  }

  private pushShuttle(forwardAccel: number, dtS: number, tMs: number): void {
    const s = this.#t.state;
    this.#shuttleSum += forwardAccel;
    this.#shuttleN += 1;
    this.#shuttleDur += dtS;
    if (this.#shuttleDur < 0.25) return;
    this.#shuttle.push({
      tMs,
      dv: (this.#shuttleSum / this.#shuttleN) * this.#shuttleDur,
    });
    this.#shuttleSum = this.#shuttleN = this.#shuttleDur = 0;
    while (
      this.#shuttle.length &&
      tMs - this.#shuttle[0].tMs > s.shuttleWindowS * 1000
    ) {
      this.#shuttle.shift();
    }
    // a candidate is confirmed only if the unit is still moving well after it
    const candidate = this.#shuttleCandidate;
    if (candidate) {
      if ((tMs - candidate.tMs) / 1000 < s.shuttleConfirmS) return;
      this.#shuttleCandidate = null;
      const gpsMoving = !this.gpsFresh(tMs) ||
        (this.#gpsSpeed ?? 0) >= this.#t.gps.boundaryKmh;
      if (this.#stillness.still || !gpsMoving) return;
      this.segmentBoundary(tMs, ["shuttle"]);
      this.#launch = null; // the shuttle itself is this segment's launch
      this.addEvidence(
        "launch",
        candidate.sign * this.#t.evidence.shuttle,
        tMs,
        {
          shuttleDvMps: candidate.dv,
        },
      );
      return;
    }
    const decided = this.#sm.decided;
    if (decided === null) return;
    // Without GPS a hard slowdown that carries on forward (a corner) and a
    // pass through zero look the same; only "Δv exceeds the speed it had"
    // tells them apart, and only GPS knows that speed. IMU-only, the
    // short-horizon velocity tracker covers it instead.
    if (!this.gpsFresh(tMs)) return;
    const dv = this.#shuttle.reduce((sum, b) => sum + b.dv, 0);
    const against = decided === "forward" ? -dv : dv;
    const gpsMps = (this.#gpsSpeed ?? 0) / 3.6;
    if (against >= s.shuttleDvMps && against >= gpsMps + 0.5) {
      this.#shuttleCandidate = {
        tMs,
        sign: decided === "forward" ? -1 : 1,
        dv,
      };
    }
  }

  private anchorVelocity(v: number, sign: 1 | -1, maxAgeS: number): void {
    this.#vel = { v, sign, ageS: 0, maxAgeS, crossedS: 0, holdSinceMs: null };
  }

  /**
   * Integrate the anchored velocity; when it has crossed zero and run the
   * other way far enough, the unit reversed (or pulled forward again) —
   * evidence as strong as a launch, and a new segment.
   */
  private trackVelocity(forwardAccel: number, dtS: number, tMs: number): void {
    const vel = this.#vel;
    if (!vel) return;
    vel.ageS += dtS;
    if (vel.ageS > vel.maxAgeS) {
      this.#vel = null;
      return;
    }
    vel.v += forwardAccel * dtS;
    const against = -vel.sign * vel.v; // > 0 once it runs the other way
    if (against <= 0) {
      vel.crossedS = 0;
      vel.holdSinceMs = null;
      return;
    }
    vel.crossedS += against * dtS;
    const t = this.#t.velocity;
    if (against < t.reverseMps || vel.crossedS < t.reverseDistanceM) {
      vel.holdSinceMs = null;
      return;
    }
    // GPS still says standing: an integration overshoot at a stop, not a move
    const gpsFresh = this.gpsFresh(tMs);
    if (gpsFresh && (this.#gpsSpeed ?? 0) < this.#t.gps.stopKmh) {
      vel.holdSinceMs = null;
      return;
    }
    vel.holdSinceMs ??= tMs;
    if ((tMs - vel.holdSinceMs) / 1000 < t.holdS) return;

    const newSign = (-vel.sign) as 1 | -1;
    this.#launch = null;
    this.anchorVelocity(vel.v, newSign, this.#t.velocity.maxAgeImuS);
    // A real change of direction passes through zero speed. If GPS never saw
    // the unit slow down, the earlier decision was wrong: correct it in place.
    const neverSlowed = gpsFresh && this.#recentGpsKmh.length > 0 &&
      Math.min(...this.#recentGpsKmh) >= this.#t.gps.holdKmh;
    this.trace(tMs, "launch", {
      reversal: newSign,
      v: vel.v,
      ageS: vel.ageS,
      correction: neverSlowed,
    });
    if (this.#sm.phase === "moving" && neverSlowed) {
      this.addEvidence(
        "launch",
        newSign * 2 * this.#t.evidence.launchCap,
        tMs,
        { reversal: true },
      );
      return;
    }
    if (this.#sm.phase === "moving") this.segmentBoundary(tMs, ["launch"]);
    else this.startMoving(tMs, ["launch"]);
    this.#launch = null;
    this.addEvidence("launch", newSign * this.#t.evidence.launch, tMs, {
      reversal: true,
    });
  }

  private meanAbsYawDps(): number {
    return this.#yawHistory.length
      ? mean(this.#yawHistory.map((h) => Math.abs(h.yawDps)))
      : 0;
  }

  private updateTrack(fix: GpsFix, speed: number): void {
    const g = this.#t.gps;
    if (fix.trackDeg === undefined || speed < g.minCourseKmh) {
      this.#sameTrackEpochs = 0;
      this.#yawSinceTrackDeg = 0;
      return;
    }
    if (this.#lastTrack !== null && fix.trackDeg === this.#lastTrack) {
      this.#sameTrackEpochs += 1;
      if (
        this.#sameTrackEpochs >= g.frozenTrackEpochs &&
        Math.abs(this.#yawSinceTrackDeg) > g.frozenTrackMinYawDeg
      ) this.#trackFrozen = true;
    } else {
      this.#sameTrackEpochs = 0;
      this.#yawSinceTrackDeg = 0;
      this.#trackFrozen = false;
    }
    this.#lastTrack = fix.trackDeg;
  }

  private gpsEvidence(fix: GpsFix, speed: number, tMs: number): void {
    const g = this.#t.gps;
    if (this.#reverseMaxKmh > 0 && speed >= this.#reverseMaxKmh) {
      this.#segmentReachedFast = true;
      this.addEvidence("fastTravel", this.#t.evidence.fastTravel, tMs, {
        speedKmh: speed,
      });
    }
    const track = fix.trackDeg;
    const trackValid = track !== undefined && !this.#trackFrozen &&
      speed >= g.minCourseKmh &&
      (this.#prevGpsSpeed ?? 0) >= g.minPrevCourseKmh;
    const meanYaw = this.meanAbsYawDps();
    if (!trackValid || meanYaw > g.maxMeanYawDps) return;

    const weight = speed >= g.strongKmh
      ? this.#t.evidence.gpsHeadingStrong
      : this.#t.evidence.gpsHeadingWeak;
    const ref = this.#heading.at(tMs - this.#t.heading.refDelayMs);
    if (ref && ref.sigma <= this.#t.heading.maxSigmaDeg) {
      const delta = Math.abs(angleDiff(track, ref.psi));
      if (delta <= g.forwardMaxDeg) {
        this.#heading.ambiguousEpochs = 0;
        this.addEvidence("gpsHeading", weight, tMs, {
          deltaDeg: delta,
          speedKmh: speed,
        });
      } else if (delta >= g.reverseMinDeg) {
        this.#heading.ambiguousEpochs = 0;
        this.addEvidence("gpsHeading", -weight, tMs, {
          deltaDeg: delta,
          speedKmh: speed,
        });
      } else if (
        ++this.#heading.ambiguousEpochs >= this.#t.heading.ambiguousEpochs
      ) {
        this.#heading.invalidate("course and heading disagree");
      }
    }

    const status = this.#status;
    const compass = this.#compass.verdict(tMs);
    const headingFresh = status?.headingDeg !== undefined &&
      tMs - status.tMs <= this.#t.compass.freshMs &&
      !status.statusFlagNames.includes("magNotCalibrated");
    if (
      headingFresh && compass.status === "trusted" && compass.offsetDeg !== null
    ) {
      const forward = wrap360(
        status!.headingDeg! + this.#mount.headingOffsetDeg + compass.offsetDeg,
      );
      const delta = Math.abs(angleDiff(track, forward));
      if (delta <= g.forwardMaxDeg) {
        this.addEvidence("compass", this.#t.evidence.compass, tMs, {
          deltaDeg: delta,
        });
      } else if (delta >= g.reverseMinDeg) {
        this.addEvidence("compass", -this.#t.evidence.compass, tMs, {
          deltaDeg: delta,
        });
      }
    }

    const decided = this.#sm.decided;
    if (decided === null) return;
    const sign: 1 | -1 = decided === "forward" ? 1 : -1;
    const vt = this.#t.velocity;
    if (
      speed >= vt.minAnchorKmh && this.#prevGpsSpeed !== null &&
      Math.abs(speed - this.#prevGpsSpeed) <= vt.steadyKmh
    ) {
      this.anchorVelocity((sign * speed) / 3.6, sign, vt.maxAgeGpsS);
    }
    const h = this.#t.heading;
    const support = this.#evidence.support(sign, ["gpsHeading"]);
    if (
      speed >= h.anchorMinKmh && meanYaw <= h.anchorMaxYawDps &&
      support.points >= h.anchorMinSupport &&
      support.sources >= h.anchorMinSources
    ) {
      this.#heading.anchor(track, decided === "reversing", tMs);
      this.trace(tMs, "anchor", {
        trackDeg: track,
        reversing: decided === "reversing",
        support,
      });
    }
    const compassSupport = this.#evidence.support(sign, ["compass"]);
    if (
      headingFresh && speed >= this.#t.compass.minKmh &&
      meanYaw <= this.#t.compass.maxYawDps &&
      compassSupport.points >= this.#t.evidence.decide
    ) {
      const course = wrap360(track + (decided === "reversing" ? 180 : 0));
      this.#compass.add(
        tMs,
        course,
        wrap360(status!.headingDeg! + this.#mount.headingOffsetDeg),
      );
    }
  }
}
