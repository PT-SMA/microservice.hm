/**
 * Every threshold of the travel-direction estimator, in one place.
 *
 * NOT field-calibrated. The values come from vehicle physics and a design
 * review, and are pinned by the synthetic scenarios in tests/direction.test.ts.
 * Calibrate them from recordings of real machines (HOUR_METER_DIRECTION_RECORD,
 * scripts/replay-direction.ts; BACKLOG HM-08) — edit this file only.
 */
export const DIRECTION_TUNING = {
  stream: {
    /** frames over which the stream rate is measured (bursty arrival needs many) */
    historyFrames: 512,
    /** a gap is longer than both of these */
    gapMinMs: 250,
    gapPeriods: 3,
    /** bit-identical accel+gyro frames: the firmware resends a dead IMU's last output */
    frozenFrames: 5,
    /** below this the stream aliases engine vibration: degraded mode */
    degradedBelowHz: 25,
  },
  bias: {
    tauS: 20,
    minStoppedS: 2,
    learnedAfterS: 5,
    sigmaUnlearnedDps: 0.5,
    sigmaLearnedDps: 0.05,
  },
  stillness: {
    blockS: 0.2,
    blockSDegraded: 0.5,
    windowS: 1.5,
    windowSDegraded: 2.5,
    gyroMaxDps: 0.5,
    gyroStdUnlearnedDps: 0.3,
    deviationMinMg: 6,
    deviationIdleFactor: 4,
    deviationDegradedMg: 15,
    normToleranceG: 0.05,
    /**
     * The averaged specific force must point along gravity, not only match its
     * size: a smooth launch at low speed has no rotation and a near-constant
     * force — still in every other respect.
     */
    gravityToleranceG: 0.03,
    /**
     * …unless everything else has been still this long: after a long drive
     * without GPS the pitch cannot be corrected, and a drifted "up" must not
     * hide a real stop forever.
     */
    gravityBypassS: 3,
    gravityBypassSDegraded: 4,
    idleFloorTauS: 30,
    idleLearnAfterStoppedS: 5,
    /** idle wander above this at a slow stream: warn */
    idleWanderWarnMg: 10,
  },
  attitude: {
    /** gravity-direction correction, only while not turning and not accelerating */
    correctionTauS: 20,
    correctionMaxYawDps: 1,
    correctionNormToleranceG: 0.03,
  },
  launch: {
    preTriggerS: 1,
    g0SettleS: 1.5,
    g0ExcludeBeforeOnsetS: 1,
    shortStopS: 2.5,
    maxS: 6,
    onsetSpeedMps: 0.3,
    onsetDistanceM: 0.3,
    decideSpeedMps: 0.5,
    decideDistanceM: 0.5,
    decideSpeedMpsDegraded: 0.8,
    decideDistanceMDegraded: 1.0,
    holdS: 0.5,
    /** grade at or above which the downhill side needs more evidence */
    gradePct: 3,
    downhillFactor: 1.6,
    /** a sign change after this speed restarts the integration (rollback) */
    zeroCrossMinMps: 0.15,
    saturationG: 3.95,
    saturationDps: 495,
    /** an IMU-only start against fresh GPS < 1 km/h must be confirmed within */
    gpsConfirmS: 3,
  },
  turn: {
    blockS: 0.25,
    windowS: 4,
    windowSDegraded: 6,
    everyS: 1,
    minGapS: 3,
    minMaxYawDps: 6,
    minStdYawDps: 2.5,
    maxResidualMps2: 0.25,
    minSpeedMps: 1,
    gpsRatioMin: 0.4,
    gpsRatioMax: 2.5,
    zWeak: 2.5,
    zStrong: 4,
    /** GPS-confirmed windows that fix the lever arm */
    leverLearnWindows: 5,
    leverLearnMinKmh: 8,
  },
  heading: {
    anchorMinKmh: 8,
    anchorMaxYawDps: 3,
    anchorMinSupport: 4,
    anchorMinSources: 2,
    maxSigmaDeg: 30,
    anchorSigmaDeg: 5,
    sigmaPerRotation: 0.03,
    gapSigmaDegPerS: 30,
    invalidateGapS: 1,
    ambiguousEpochs: 3,
    refDelayMs: 500,
    historyMs: 3000,
  },
  gps: {
    freshMs: 2500,
    minCourseKmh: 4,
    minPrevCourseKmh: 3,
    strongKmh: 8,
    maxMeanYawDps: 6,
    yawWindowS: 2,
    frozenTrackEpochs: 3,
    frozenTrackMinYawDeg: 5,
    forwardMaxDeg: 60,
    reverseMinDeg: 120,
    startKmh: 2,
    startStrongKmh: 4,
    stopKmh: 1,
    boundaryKmh: 1.5,
    holdKmh: 3,
  },
  compass: {
    minKmh: 15,
    maxYawDps: 3,
    minQuadrants: 3,
    minPerQuadrant: 10,
    maxQuadrantSpreadDeg: 30,
    maxStdDeg: 20,
    windowMs: 30 * 60_000,
    freshMs: 1500,
    /** samples before the offset alone hints at a wrong mount */
    hintSamples: 30,
  },
  evidence: {
    launch: 3,
    launchDegraded: 2,
    launchShortStop: 2,
    launchCap: 3,
    turnWeak: 1.5,
    turnStrong: 2.5,
    turnCap: 3,
    gpsHeadingStrong: 1.5,
    gpsHeadingWeak: 1,
    gpsHeadingCap: 4,
    compass: 1,
    compassCap: 3,
    fastTravel: 0.5,
    fastTravelCap: 3,
    decide: 3,
    retract: 1,
    shuttle: 2,
  },
  state: {
    undecidedPublishS: 1.5,
    boundaryHoldS: 2,
    stillStopS: 1,
    stillStopSImuOnly: 1.5,
    stillStopSDegraded: 2.5,
    boundaryStillS: 0.5,
    unknownAfterS: 3,
    minChangeIntervalMs: 500,
    shuttleDvMps: 1.5,
    shuttleWindowS: 3,
    /**
     * Braking to a stop looks like a shuttle for a few seconds; a shuttle is
     * only taken if the unit is still moving this long after it.
     */
    shuttleConfirmS: 5,
  },
  /**
   * A short-horizon velocity: anchored to steady GPS speed (or a launch, or a
   * standstill) and integrated through braking, a brief stop and what comes
   * next — so a reverse right after a stop too short for the stillness
   * window is still seen as the zero-crossing it is. Dropped when its anchor
   * is old: an integrated accelerometer drifts.
   */
  velocity: {
    maxAgeGpsS: 10,
    maxAgeImuS: 6,
    /** GPS speed change per epoch below which it counts as steady, km/h */
    steadyKmh: 0.7,
    minAnchorKmh: 1.5,
    reverseMps: 0.5,
    reverseDistanceM: 0.5,
    holdS: 0.5,
  },
  /**
   * From unknown: this much rotation, sustained, means it is moving. Before
   * the gyro bias is learned (a unit joined mid-drive, which never stopped),
   * a higher bar no plausible bias reaches.
   */
  motionFromUnknown: { gyroDps: 2, gyroDpsUnlearned: 4, forS: 2 },
  mount: {
    minSegments: 5,
    majority: 0.8,
    swapMinEpochs: 60,
    swapMinDvMps: 0.3,
    swapMinCorr: 0.5,
  },
};

export type DirectionTuning = typeof DIRECTION_TUNING;

/**
 * A WT61 through wt61-driver (WT61_URL) instead of the hour meter's stream.
 * Only what differs: the module zeroes its gyro below a static threshold
 * (0.122 °/s by default), so at rest accel + gyro can repeat bit for bit for
 * a few frames by chance. A dead stream is called after half a second of it
 * at 100 Hz. The module low-pass filters at 10 Hz (default bandwidth) before
 * its 100 Hz output, so nothing aliases and no other threshold moves.
 */
export const WT61_TUNING: DirectionTuning = {
  ...DIRECTION_TUNING,
  stream: { ...DIRECTION_TUNING.stream, frozenFrames: 50 },
};
