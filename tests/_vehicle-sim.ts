/**
 * A deterministic vehicle that can reverse — what the device's IMU stream,
 * its TELEMETRY and microservice.gps would send for a scripted drive. The
 * device repo's own simulator cannot reverse (its speed is clamped at 0), so
 * the travel-direction tests drive this instead.
 *
 * Truth is integrated at 100 Hz (the firmware's imuSampleHz):
 * - signed speed s (m/s, + forward), heading ψ (° clockwise from true north),
 *   yaw rate r (rad/s, counter-clockwise +), road grade and crossfall;
 * - body pitch = grade + 0.6°·ṡ (squat, τ 0.3 s) + cab rock; body roll =
 *   crossfall + 1.2°·(s·r) (outward lean, τ 0.35 s);
 * - body rates from the Euler angles (yaw r about the world vertical, then
 *   pitch θ nose-up, then roll φ left-up): ω = (φ̇ + r·sinθ,
 *   −θ̇·cosφ + r·cosθ·sinφ, θ̇·sinφ + r·cosθ·cosφ) — a body rolled in a turn
 *   also turns about its own pitch axis, and a real gyro says so;
 * - the board sits at p from the axle point that does not slide sideways:
 *   a_P = (ṡ, s·r, 0) + ω̇×p + ω×(ω×p);
 * - specific force f = a_P/g + (sinθ, cosθ·sinφ, cosθ·cosφ).
 * Then engine tone, road and sensor noise, gyro bias, the true mount (which
 * may differ from the configured one), the firmware's per-axis Kalman filter,
 * snapshot decimation to the stream rate, quantisation and bursty arrival.
 */

import type { DeviceStatus, ForwardAxis, ImuSample, Vec3 } from "direction";
import { mountOf } from "direction";

const G = 9.80665;
const DEG = Math.PI / 180;
const SAMPLE_HZ = 100;
const DT = 1 / SAMPLE_HZ;

export type Step =
  /** hold the current speed (and everything else) for seconds */
  | { hold: number; mark?: string }
  /** change speed to `to` (m/s, signed) at |accel| m/s² */
  | { ramp: { to: number; accel: number }; mark?: string }
  /** raised-cosine yaw rate peaking at yawDps (CCW +) over durS, at the current speed */
  | { turn: { yawDps: number; durS: number }; mark?: string }
  /** road grade, percent (+ = the vehicle's nose up); applies from now */
  | { grade: number; mark?: string }
  /** crossfall, percent (+ = left side up); applies from now */
  | { crossfall: number; mark?: string }
  /** no IMU frames for seconds (the drive goes on at the current speed) */
  | { gap: number; mark?: string }
  /** a device boot: boot EVENT, then 2.5 s without IMU frames */
  | { reboot: true; mark?: string }
  /** an extra forward acceleration on the board, g, for the next durS */
  | { fault: { forwardG: number; durS: number }; mark?: string }
  /** a bucket load: a vertical jolt and a static pitch change */
  | { loading: true; mark?: string }
  | { engine: boolean; mark?: string }
  /** the IMU repeats its last output for seconds (a dead I2C bus); the drive goes on */
  | { freeze: number; mark?: string }
  /** GPS keeps reporting its last course for seconds, as a receiver does when it drops the field */
  | { freezeTrack: number; mark?: string };

export interface SimOptions {
  seed?: number;
  streamHz?: number;
  /** how the board is really mounted */
  trueMount?: ForwardAxis;
  /**
   * how the compass's board is mounted, when it is not the IMU's (a WT61 next
   * to the hour meter); default trueMount
   */
  compassMount?: ForwardAxis;
  engineToneHz?: number;
  engineToneMg?: number;
  accelNoiseMg?: number;
  gyroBiasDps?: Vec3;
  gyroNoiseDps?: number;
  /** board position from the non-sliding axle point, m (x forward, y left, z up) */
  leverArm?: Vec3;
  gps?: false | { lagEpochs?: number };
  startHeadingDeg?: number;
  compass?: {
    offsetDeg?: number;
    ampDeg?: number;
    phaseDeg?: number;
    calibrated?: boolean;
  };
  /** firmware streaming the mean since the last frame instead of a snapshot */
  decimation?: "snapshot" | "average";
}

export type SimEvent =
  | { tMs: number; kind: "imu"; sample: ImuSample }
  | { tMs: number; kind: "status"; status: DeviceStatus }
  | { tMs: number; kind: "gps"; raw: string }
  | { tMs: number; kind: "reset"; reason: "boot" };

export interface SimRun {
  events: SimEvent[];
  /** device time of each `mark` */
  marks: Record<string, number>;
  /** true signed speed every 100 ms */
  truth: Array<{ tMs: number; speed: number }>;
  endMs: number;
}

export const START_MS = Date.UTC(2026, 9, 15, 0, 0, 0);

/** mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = Math.max(uniform(), 1e-12), v = uniform();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { uniform, normal };
}

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const add = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});

class Kalman1D {
  x: number | null = null;
  p = 1;
  constructor(private q: number, private r: number) {}
  update(z: number): number {
    if (this.x === null) {
      this.x = z;
      return z;
    }
    this.p += this.q;
    const k = this.p / (this.p + this.r);
    this.x += k * (z - this.x);
    this.p *= 1 - k;
    return this.x;
  }
}

export function simulate(steps: Step[], options: SimOptions = {}): SimRun {
  const o = {
    seed: 1,
    streamHz: 100,
    trueMount: "+x" as ForwardAxis,
    engineToneHz: 35,
    engineToneMg: 30,
    accelNoiseMg: 4,
    gyroBiasDps: { x: 0.2, y: -0.1, z: 0.3 },
    gyroNoiseDps: 0.05,
    leverArm: { x: 4, y: 0, z: 2.5 },
    startHeadingDeg: 0,
    decimation: "snapshot" as const,
    ...options,
  };
  const gpsOpts = options.gps === false
    ? null
    : { lagEpochs: 0, ...(options.gps ?? {}) };
  const compass = {
    offsetDeg: 0,
    ampDeg: 0,
    phaseDeg: 0,
    calibrated: true,
    ...(options.compass ?? {}),
  };
  const rand = rng(o.seed);
  const mount = mountOf(o.trueMount);
  const compassMount = mountOf(options.compassMount ?? o.trueMount);
  const every = Math.max(1, Math.round(SAMPLE_HZ / o.streamHz));
  const kfA = [
    new Kalman1D(5e-4, 4e-4),
    new Kalman1D(5e-4, 4e-4),
    new Kalman1D(5e-4, 4e-4),
  ];
  const kfW = [
    new Kalman1D(0.01, 0.01),
    new Kalman1D(0.01, 0.01),
    new Kalman1D(0.01, 0.01),
  ];

  const events: SimEvent[] = [];
  const marks: Record<string, number> = {};
  const truth: SimRun["truth"] = [];

  // truth
  let n = 0;
  let s = 0, sdot = 0, psi = o.startHeadingDeg, r = 0;
  let grade = 0, crossfall = 0;
  let pitch = 0, roll = 0;
  let prevOmega: Vec3 = { x: 0, y: 0, z: 0 };
  let prevPitchTotal = 0, prevRoll = 0;
  let engine = true;
  let imuOff = 0; // samples left without IMU frames
  let frozen = 0; // samples left repeating the last IMU frame
  let frozenSample: ImuSample | null = null;
  let trackFrozen = 0; // samples left with the GPS course held
  let fault = { g: 0, left: 0 };
  let jolt = 0; // vertical jolt left, g
  let settle = 0; // static pitch from loading, rad
  // decimation
  let acc: { a: Vec3; w: Vec3; n: number } = {
    a: { x: 0, y: 0, z: 0 },
    w: { x: 0, y: 0, z: 0 },
    n: 0,
  };
  let missed = 0;
  let lastArrival = START_MS;
  // gps
  const gpsHistory: Array<{ speed: number; track?: number }> = [];
  let lastTrack: number | undefined;
  let processed = 0;

  const tMs = () => START_MS + n * 10;

  const tick = () => {
    n += 1;
    const t = n * DT;
    psi = ((psi - (r / DEG) * DT) % 360 + 360) % 360;

    // body attitude with suspension lags
    const pitchTarget = Math.atan(grade / 100) + settle + 0.6 * DEG * sdot;
    const rollTarget = Math.atan(crossfall / 100) + 1.2 * DEG * (s * r);
    pitch += (pitchTarget - pitch) * (DT / 0.3);
    roll += (rollTarget - roll) * (DT / 0.35);
    const rock = 0.05 * DEG * Math.abs(s) * Math.sin(2 * Math.PI * 1.5 * t);
    const pitchTotal = pitch + rock;

    const rollRate = (roll - prevRoll) / DT;
    const pitchRate = (pitchTotal - prevPitchTotal) / DT;
    const omega: Vec3 = {
      x: rollRate + r * Math.sin(pitchTotal),
      y: -pitchRate * Math.cos(roll) +
        r * Math.cos(pitchTotal) * Math.sin(roll),
      z: pitchRate * Math.sin(roll) + r * Math.cos(pitchTotal) * Math.cos(roll),
    };
    const omegaDot: Vec3 = {
      x: (omega.x - prevOmega.x) / DT,
      y: (omega.y - prevOmega.y) / DT,
      z: (omega.z - prevOmega.z) / DT,
    };
    prevOmega = omega;
    prevPitchTotal = pitchTotal;
    prevRoll = roll;

    const p = o.leverArm;
    const aP = add(
      add({ x: sdot, y: s * r, z: 0 }, cross(omegaDot, p)),
      cross(omega, cross(omega, p)),
    );
    const fVehicle: Vec3 = {
      x: aP.x / G + Math.sin(pitchTotal) + fault.g,
      y: aP.y / G + Math.cos(pitchTotal) * Math.sin(roll),
      z: aP.z / G + Math.cos(pitchTotal) * Math.cos(roll) + jolt,
    };
    if (fault.left > 0 && --fault.left === 0) fault.g = 0;
    jolt *= 0.8;

    // noise and vibration (vehicle frame), g and °/s
    const roadMg = Math.abs(s) > 0.05 ? 10 + 8 * Math.abs(s) : 0;
    const toneMg = engine ? o.engineToneMg : 0;
    const tone = (phase: number) =>
      (toneMg / 1000) * Math.sin(2 * Math.PI * o.engineToneHz * t + phase);
    const noise = () =>
      rand.normal() * (o.accelNoiseMg / 1000) + rand.normal() * (roadMg / 1000);
    const aNoisy: Vec3 = {
      x: fVehicle.x + tone(0) + noise(),
      y: fVehicle.y + tone(1) + noise(),
      z: fVehicle.z + tone(2) + noise(),
    };
    const gyroVib = 0.004 * (toneMg + roadMg);
    const wTrue: Vec3 = {
      x: omega.x / DEG,
      y: omega.y / DEG,
      z: omega.z / DEG,
    };
    const wNoisy: Vec3 = {
      x: wTrue.x + rand.normal() * o.gyroNoiseDps +
        gyroVib * Math.sin(2 * Math.PI * o.engineToneHz * t + 0.5),
      y: wTrue.y + rand.normal() * o.gyroNoiseDps +
        gyroVib * Math.sin(2 * Math.PI * o.engineToneHz * t + 1.5),
      z: wTrue.z + rand.normal() * o.gyroNoiseDps +
        gyroVib * Math.sin(2 * Math.PI * o.engineToneHz * t + 2.5),
    };

    // board frame, bias, firmware filter
    const aBoard = mount.toBoard(aNoisy);
    const wBoard = add(mount.toBoard(wNoisy), o.gyroBiasDps);
    const aF: Vec3 = {
      x: kfA[0].update(aBoard.x),
      y: kfA[1].update(aBoard.y),
      z: kfA[2].update(aBoard.z),
    };
    const wF: Vec3 = {
      x: kfW[0].update(wBoard.x),
      y: kfW[1].update(wBoard.y),
      z: kfW[2].update(wBoard.z),
    };
    acc = { a: add(acc.a, aF), w: add(acc.w, wF), n: acc.n + 1 };

    if (n % every === 0) {
      const a = o.decimation === "average"
        ? { x: acc.a.x / acc.n, y: acc.a.y / acc.n, z: acc.a.z / acc.n }
        : aF;
      const w = o.decimation === "average"
        ? { x: acc.w.x / acc.n, y: acc.w.y / acc.n, z: acc.w.z / acc.n }
        : wF;
      acc = { a: { x: 0, y: 0, z: 0 }, w: { x: 0, y: 0, z: 0 }, n: 0 };
      if (imuOff > 0) {
        missed += 1;
      } else {
        const q = (v: number, step: number) => Math.round(v / step) * step;
        const arrival = Math.max(lastArrival, tMs() + rand.uniform() * 16);
        lastArrival = arrival;
        const sample: ImuSample = frozen > 0 && frozenSample
          ? { ...frozenSample, missedFrames: missed }
          : {
            accelG: { x: q(a.x, 0.001), y: q(a.y, 0.001), z: q(a.z, 0.001) },
            gyroDps: { x: q(w.x, 0.1), y: q(w.y, 0.1), z: q(w.z, 0.1) },
            missedFrames: missed,
          };
        if (frozen <= 0) frozenSample = sample;
        events.push({ tMs: arrival, kind: "imu", sample });
        missed = 0;
      }
    }
    if (imuOff > 0) imuOff -= 1;
    if (frozen > 0) frozen -= 1;
    if (trackFrozen > 0) trackFrozen -= 1;

    // TELEMETRY each second
    if (n % SAMPLE_HZ === 0) {
      const boardHeading = psi - compassMount.headingOffsetDeg +
        compass.offsetDeg +
        compass.ampDeg * Math.sin((psi - compass.phaseDeg) * DEG);
      events.push({
        tMs: tMs() + 5,
        kind: "status",
        status: {
          engineRunning: engine,
          statusFlagNames: compass.calibrated ? [] : ["magNotCalibrated"],
          headingDeg: ((boardHeading % 360) + 360) % 360,
        },
      });
    }

    // GPS each second, 300 ms into the second
    if (gpsOpts && n % SAMPLE_HZ === 30) {
      const speed = Math.max(0, 3.6 * Math.abs(s) + rand.normal() * 0.36);
      let track = lastTrack;
      if (Math.abs(s) >= 0.4 && trackFrozen <= 0) {
        track = ((psi + (s < 0 ? 180 : 0) +
              rand.normal() * (0.1 / Math.abs(s)) / DEG) % 360 + 360) % 360;
      }
      lastTrack = track;
      gpsHistory.push({ speed, track });
      const shown =
        gpsHistory[Math.max(0, gpsHistory.length - 1 - gpsOpts.lagEpochs)];
      processed += 1;
      events.push({
        tMs: tMs() + 20,
        kind: "gps",
        raw: JSON.stringify({
          lat: -3.0019,
          lon: 121.8117,
          alt: 412,
          errors: 0,
          processed,
          heading: null,
          ...(shown.track === undefined
            ? {}
            : { track: Math.round(shown.track * 100) / 100 }),
          fix: "3D",
          speed: Math.round(shown.speed * 100) / 100,
          time: new Date(tMs()).toISOString(),
          trueNorth: false,
          uuid: `gps-${processed}`,
        }),
      });
    }

    if (n % 10 === 0) truth.push({ tMs: tMs(), speed: s });
  };

  const run = (seconds: number, each: () => void = () => {}) => {
    const count = Math.round(seconds * SAMPLE_HZ);
    for (let i = 0; i < count; i++) {
      each();
      tick();
    }
  };

  for (const step of steps) {
    if (step.mark) marks[step.mark] = tMs();
    if ("hold" in step) {
      sdot = 0;
      run(step.hold);
    } else if ("ramp" in step) {
      const { to, accel } = step.ramp;
      const dir = Math.sign(to - s);
      sdot = dir * Math.abs(accel);
      const seconds = Math.abs(to - s) / Math.abs(accel);
      run(seconds, () => {
        s += sdot * DT;
        if ((dir > 0 && s > to) || (dir < 0 && s < to)) s = to;
      });
      s = to;
      sdot = 0;
    } else if ("turn" in step) {
      const { yawDps, durS } = step.turn;
      let k = 0;
      const count = Math.round(durS * SAMPLE_HZ);
      sdot = 0;
      run(durS, () => {
        r = yawDps * DEG * 0.5 * (1 - Math.cos((2 * Math.PI * k) / count));
        k += 1;
      });
      r = 0;
    } else if ("grade" in step) {
      grade = step.grade;
    } else if ("crossfall" in step) {
      crossfall = step.crossfall;
    } else if ("gap" in step) {
      imuOff = Math.round(step.gap * SAMPLE_HZ);
      run(step.gap);
    } else if ("reboot" in step) {
      events.push({ tMs: tMs(), kind: "reset", reason: "boot" });
      imuOff = Math.round(2.5 * SAMPLE_HZ);
      run(2.5);
    } else if ("fault" in step) {
      fault = {
        g: step.fault.forwardG,
        left: Math.round(step.fault.durS * SAMPLE_HZ),
      };
    } else if ("loading" in step) {
      jolt = 0.25;
      settle += 0.8 * DEG;
    } else if ("engine" in step) {
      engine = step.engine;
    } else if ("freeze" in step) {
      frozen = Math.round(step.freeze * SAMPLE_HZ);
    } else if ("freezeTrack" in step) {
      trackFrozen = Math.round(step.freezeTrack * SAMPLE_HZ);
    }
  }

  events.sort((a, b) => a.tMs - b.tMs);
  return { events, marks, truth, endMs: tMs() };
}
