/** Vectors are in the board frame or, after the mount remap, the vehicle
 * frame: x forward, y left, z up (right-handed). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** What the wire says about which way the unit travels. */
export type TravelDirection =
  /** confirmed standstill (creep below ~1–2 km/h reads stopped) */
  | "stopped"
  | "forward"
  | "reversing"
  /** moving, direction not decided (or retracted) */
  | "moving"
  /** no usable input: no IMU stream and no fresh GPS */
  | "unknown";

/** The board axis that points to the front of the vehicle. */
export type ForwardAxis = "+x" | "-x" | "+y" | "-y";

/** What contributes to the per-segment evidence (positive = forward). */
export type EvidenceSource =
  | "launch"
  | "turn"
  | "gpsHeading"
  | "compass"
  | "fastTravel";

/** Why a state changed: evidence sources plus the stop/start detectors. */
export type Basis =
  | EvidenceSource
  | "gpsSpeed"
  | "imuStill"
  /** sustained rotation: already moving when first heard */
  | "imuMotion"
  | "shuttle";

/** One IMU stream frame, board frame. */
export interface ImuSample {
  accelG: Vec3;
  gyroDps: Vec3;
  /** stream frames lost before this one (from the device seq) */
  missedFrames: number;
}

/** One microservice.gps fix, as used here. */
export interface GpsFix {
  speedKmh: number;
  /** course over ground, degrees true; absent before the first RMC/VTG */
  trackDeg?: number;
  fix: "2D" | "3D";
  /** the receiver's time: one epoch is counted once */
  time: string;
}

/** What TELEMETRY tells the estimator, once a second. */
export interface DeviceStatus {
  engineRunning: boolean;
  statusFlagNames: string[];
  /** the board x axis from magnetic north, when the device has a heading */
  headingDeg?: number;
}

export interface DirectionChange {
  travelDirection: TravelDirection;
  previousTravelDirection: TravelDirection;
  changedAtMs: number;
  basis: Basis[];
  /** forward ↔ reversing without a stop: an earlier decision was wrong */
  correction: boolean;
}

/** What the estimator says at any moment. */
export interface DirectionSnapshot {
  travelDirection: TravelDirection;
  changedAtMs: number;
  /** board heading + mount offset (+ trusted compass offset) */
  headingOffsetDeg: number;
}

/** Calibration trace: every decision input worth recording. */
export interface DirectionTrace {
  tMs: number;
  kind: "evidence" | "transition" | "turnWindow" | "launch" | "anchor";
  data: Record<string, unknown>;
}
