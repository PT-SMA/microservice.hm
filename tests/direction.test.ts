import { assert, assertEquals } from "@std/assert";
import { type SimOptions, simulate, type Step } from "./_vehicle-sim.ts";
import {
  everPublished,
  firstChange,
  runDirection,
  show,
  stateAt,
  type Transition,
} from "./_direction-harness.ts";

/**
 * Travel direction from scripted drives — the vehicle generator can reverse,
 * the device simulator cannot. Each scenario states what the estimator must
 * (and must never) publish. The thresholds behind it are not field-
 * calibrated (src/direction/tuning.ts); these pin the logic, not the truck.
 */

const settle: Step = { hold: 12 };
const stop: Step[] = [{ ramp: { to: 0, accel: 1 } }, { hold: 6 }];

function drive(
  steps: Step[],
  sim: SimOptions = {},
  harness: Parameters<typeof runDirection>[1] = {},
) {
  const run = simulate(steps, sim);
  return { run, ...runDirection(run, harness) };
}

function decidedWithin(
  transcript: Transition[],
  value: "forward" | "reversing",
  fromMs: number,
  withinS: number,
): void {
  const change = firstChange(transcript, value, fromMs);
  assert(
    change !== undefined && change.tMs - fromMs <= withinS * 1000,
    `expected ${value} within ${withinS}s of ${fromMs}:\n${
      show(transcript, fromMs)
    }`,
  );
}

function never(
  transcript: Transition[],
  value: "forward" | "reversing" | "moving" | "stopped" | "unknown",
  fromMs = 0,
  toMs = Infinity,
): void {
  assert(
    !everPublished(transcript, value, fromMs, toMs),
    `${value} must never be published here:\n${show(transcript, fromMs)}`,
  );
}

// ------------------------------------------------------------- launches

Deno.test("launch forward on flat ground, IMU only: forward within 2 s", () => {
  const { run, transcript } = drive(
    [settle, { ramp: { to: 4, accel: 0.5 }, mark: "go" }, { hold: 3 }, ...stop],
    {},
    { gps: false },
  );
  decidedWithin(transcript, "forward", run.marks.go, 2.0);
  never(transcript, "reversing");
});

Deno.test("launch in reverse, IMU only: reversing within 2.5 s", () => {
  const { run, transcript } = drive(
    [
      settle,
      { ramp: { to: -2, accel: 0.4 }, mark: "go" },
      { hold: 3 },
      ...stop,
    ],
    {},
    { gps: false },
  );
  decidedWithin(transcript, "reversing", run.marks.go, 2.5);
  never(transcript, "forward");
});

Deno.test("a loaded truck pulling away at 0.2 m/s²: forward within 3.5 s", () => {
  const { run, transcript } = drive(
    [settle, { ramp: { to: 3, accel: 0.2 }, mark: "go" }, ...stop],
    {},
    { gps: false },
  );
  decidedWithin(transcript, "forward", run.marks.go, 3.5);
  never(transcript, "reversing");
});

Deno.test("at a 10 Hz stream a launch alone decides nothing, and nothing wrong", () => {
  const { run, transcript } = drive(
    [
      settle,
      { ramp: { to: 5, accel: 0.5 }, mark: "go" },
      { hold: 4 },
      {
        turn: { yawDps: 10, durS: 6 },
        mark: "turn",
      },
      { hold: 4 },
      ...stop,
    ],
    { streamHz: 10 },
    { gps: false },
  );
  never(transcript, "reversing");
  assertEquals(
    stateAt(transcript, run.marks.turn - 100),
    "moving",
    show(transcript, run.marks.go),
  );
  decidedWithin(transcript, "forward", run.marks.turn, 8);
});

// ------------------------------------------------------------- turns, grades

Deno.test("reversing into a turn after a launch too gentle to decide: the turn says reversing", () => {
  const { run, transcript } = drive(
    [
      settle,
      { ramp: { to: -1.5, accel: 0.15 }, mark: "go" },
      { turn: { yawDps: 12, durS: 5 }, mark: "turn" },
      ...stop,
    ],
    {},
    { gps: false },
  );
  never(transcript, "forward");
  assert(
    firstChange(transcript, "reversing", run.marks.go) !== undefined,
    show(transcript, run.marks.go),
  );
  decidedWithin(transcript, "reversing", run.marks.go, 16);
});

Deno.test("rolling back on an 8 % grade before driving off forward: never reversing", () => {
  const { run, transcript } = drive(
    [
      { grade: 8 },
      settle,
      { ramp: { to: -0.36, accel: 0.6 }, mark: "rollback" },
      { ramp: { to: 0, accel: 0.4 }, mark: "crossing" },
      { ramp: { to: 3, accel: 0.4 } },
      { hold: 3 },
      ...stop,
    ],
    {},
    { gps: false },
  );
  never(transcript, "reversing");
  decidedWithin(transcript, "forward", run.marks.crossing, 3.5);
});

Deno.test("a genuine reverse down an 8 % grade: reversing within 3.5 s", () => {
  const { run, transcript } = drive(
    [{ grade: 8 }, settle, { ramp: { to: -2, accel: 0.4 }, mark: "go" }, {
      hold: 3,
    }, ...stop],
    {},
    { gps: false },
  );
  decidedWithin(transcript, "reversing", run.marks.go, 3.5);
  never(transcript, "forward");
});

Deno.test("a superelevated curve after a forward launch neither retracts nor flips", () => {
  const { run, transcript } = drive(
    [
      settle,
      { ramp: { to: 2.8, accel: 0.5 }, mark: "go" },
      { hold: 3 },
      { crossfall: -4 },
      { turn: { yawDps: 9, durS: 8 } },
      { crossfall: 0 },
      { hold: 3 },
      ...stop,
    ],
    {},
    { gps: false },
  );
  decidedWithin(transcript, "forward", run.marks.go, 2.5);
  const decided = firstChange(transcript, "forward", run.marks.go)!.tMs;
  never(transcript, "reversing");
  never(transcript, "moving", decided + 1, run.endMs - 7000);
});

// ------------------------------------------------------------- standing still

for (const streamHz of [50, 10]) {
  for (const gps of [true, false]) {
    Deno.test(`two minutes idling at ${streamHz} Hz${gps ? "" : " without GPS"}: only stopped`, () => {
      const { transcript } = drive([{ hold: 120 }], { streamHz }, { gps });
      never(transcript, "forward");
      never(transcript, "reversing");
      never(transcript, "moving");
      assertEquals(stateAt(transcript, Infinity), "stopped", show(transcript));
    });
  }
}

Deno.test("an engine tone that aliases to DC at 10 Hz: no direction, and a warning", () => {
  const { transcript, estimator, endMs } = drive(
    [{ hold: 90 }],
    { streamHz: 10, engineToneHz: 30.05, engineToneMg: 40 },
  );
  never(transcript, "forward");
  never(transcript, "reversing");
  const warnings = estimator.health(endMs).warnings.join("\n");
  assert(warnings.includes("10 Hz"), warnings);
});

Deno.test("buckets of ore dropped into a parked truck: stays stopped", () => {
  const loads: Step[] = [];
  for (let i = 0; i < 6; i++) loads.push({ loading: true }, { hold: 15 });
  const { transcript } = drive([settle, ...loads]);
  never(transcript, "forward");
  never(transcript, "reversing");
  never(transcript, "moving");
});

Deno.test("creeping at 0.6 km/h reads stopped (a documented limit)", () => {
  const { transcript, run } = drive([settle, {
    ramp: { to: 0.17, accel: 0.05 },
    mark: "go",
  }, { hold: 30 }]);
  never(transcript, "forward", run.marks.go + 6000);
  never(transcript, "reversing");
});

// ------------------------------------------------------------- full cycles

Deno.test("IMU only: stopped → forward → stopped → reversing → stopped", () => {
  const { transcript } = drive(
    [
      settle,
      { ramp: { to: 5, accel: 0.5 } },
      { turn: { yawDps: 10, durS: 6 } },
      { hold: 10 },
      { ramp: { to: 0, accel: 1 } },
      { hold: 10 },
      { ramp: { to: -1.5, accel: 0.4 } },
      { turn: { yawDps: 12, durS: 5 } },
      ...stop,
    ],
    {},
    { gps: false },
  );
  const sequence = transcript.map((t) => t.to).filter((v) => v !== "moving");
  assertEquals(sequence, [
    "stopped",
    "forward",
    "stopped",
    "reversing",
    "stopped",
  ], show(transcript));
});

Deno.test("spotting under the bucket: forward, a 1 s stop, reverse at 1.2 m/s — reversing, never forward", () => {
  const { run, transcript } = drive(
    [
      settle,
      { ramp: { to: 4, accel: 0.6 } },
      { turn: { yawDps: 10, durS: 6 } },
      { hold: 6 },
      { ramp: { to: 0, accel: 1 } },
      { hold: 1 },
      { ramp: { to: -1.2, accel: 0.6 }, mark: "reverse" },
      { hold: 4 },
      { ramp: { to: 0, accel: 1 } },
      { hold: 8 },
    ],
    { gps: { lagEpochs: 1 } },
  );
  // ~2.2 s here: the 1 s stop is shorter than either stop detector sees, and
  // with GPS one epoch late the "GPS still says standing" guard costs a second
  decidedWithin(transcript, "reversing", run.marks.reverse, 4);
  const decided = firstChange(transcript, "reversing", run.marks.reverse)!.tMs;
  never(transcript, "forward", decided + 1, run.endMs);
});

Deno.test("a shuttle through zero without stopping: reversing after the crossing", () => {
  const { run, transcript } = drive(
    [
      settle,
      { ramp: { to: 3, accel: 0.6 } },
      { turn: { yawDps: 10, durS: 6 } },
      { hold: 4 },
      { ramp: { to: 0, accel: 0.8 }, mark: "crossing" },
      { ramp: { to: -1.5, accel: 0.8 } },
      { hold: 8 },
      ...stop,
    ],
  );
  decidedWithin(transcript, "reversing", run.marks.crossing + 3750, 6);
});

Deno.test("IMU only: slowing hard for a corner and pulling away is not a shuttle", () => {
  // found against the device simulator's looping route: without GPS a big
  // slowdown that carries on forward looked like passing through zero
  const { run, transcript } = drive(
    [
      settle,
      { ramp: { to: 8, accel: 0.8 }, mark: "go" },
      { turn: { yawDps: 8, durS: 6 } },
      { ramp: { to: 2.5, accel: 1.2 } },
      { turn: { yawDps: -14, durS: 6 } },
      { ramp: { to: 8, accel: 0.8 } },
      { hold: 10 },
      ...stop,
    ],
    {},
    { gps: false },
  );
  decidedWithin(transcript, "forward", run.marks.go, 3);
  const decided = firstChange(transcript, "forward", run.marks.go)!.tMs;
  never(transcript, "moving", decided + 1, run.endMs - 8000);
  never(transcript, "reversing");
});

Deno.test("joined mid-drive, never a stop to learn from: still decided by the turns", () => {
  // the service (re)started while the truck was already driving: no standstill,
  // so no gyro bias learned and no launch to see
  const run = simulate([
    settle,
    { ramp: { to: 6, accel: 0.6 } },
    { hold: 5, mark: "join" },
    { turn: { yawDps: 10, durS: 6 } },
    { hold: 2 },
    { turn: { yawDps: -10, durS: 6 } },
    { hold: 2 },
    { turn: { yawDps: 10, durS: 6 } },
    { hold: 5 },
  ]);
  const joined = {
    ...run,
    events: run.events.filter((e) => e.tMs >= run.marks.join),
  };
  const { transcript } = runDirection(joined, { gps: false });
  never(transcript, "stopped");
  never(transcript, "reversing");
  assert(
    firstChange(transcript, "forward") !== undefined,
    show(transcript, run.marks.join),
  );
});

// ------------------------------------------------------------- mounting

function fastSegments(count: number): Step[] {
  const steps: Step[] = [settle];
  for (let i = 0; i < count; i++) {
    steps.push(
      { ramp: { to: 7, accel: 0.6 } },
      { ramp: { to: 9.5, accel: 0.5 } },
      { ramp: { to: 6.5, accel: 0.5 } },
      { ramp: { to: 9.5, accel: 0.5 } },
      { ramp: { to: 6.5, accel: 0.5 } },
      { turn: { yawDps: 8, durS: 6 } },
      { ramp: { to: 9.5, accel: 0.5 } },
      { ramp: { to: 0, accel: 1 } },
      { hold: 8 },
    );
  }
  return steps;
}

Deno.test("a board mounted backwards (true −x, set +x) is flagged, with the fix", () => {
  const { estimator, endMs } = drive(fastSegments(6), { trueMount: "-x" });
  const check = estimator.health(endMs).mountCheck;
  assertEquals(check.status, "suspectReversed", JSON.stringify(check));
  assertEquals(check.suggestedAxis, "-x");
});

Deno.test("a board turned sideways (true +y, set +x) is flagged, with the fix", () => {
  const { estimator, endMs } = drive(fastSegments(8), { trueMount: "+y" });
  const check = estimator.health(endMs).mountCheck;
  assertEquals(check.status, "suspectSwapped", JSON.stringify(check));
  assertEquals(check.suggestedAxis, "+y");
});

Deno.test("a correctly mounted board passes its own check", () => {
  const { estimator, endMs } = drive(fastSegments(6), { trueMount: "+y" }, {
    forwardAxis: "+y",
  });
  assertEquals(estimator.health(endMs).mountCheck.status, "ok");
});

// ------------------------------------------------------------- corrections & GPS

Deno.test("a launch misread as reversing is corrected by GPS at speed", () => {
  const { run, transcript, estimator, endMs } = drive([
    settle,
    { ramp: { to: 6, accel: 0.6 } },
    { turn: { yawDps: 10, durS: 6 } },
    { hold: 8 },
    ...stop,
    { hold: 4 },
    // a jolt on the board as it pulls away: the launch reads backwards
    { fault: { forwardG: -0.08, durS: 3 } },
    { ramp: { to: 7, accel: 0.4 }, mark: "go" },
    { hold: 20 },
    ...stop,
  ]);
  const wrong = firstChange(transcript, "reversing", run.marks.go);
  assert(
    wrong !== undefined,
    `the fault should mislead the launch:\n${show(transcript, run.marks.go)}`,
  );
  const fixed = firstChange(transcript, "forward", wrong.tMs);
  assert(
    fixed !== undefined && fixed.correction,
    show(transcript, run.marks.go),
  );
  assertEquals(estimator.health(endMs).flips, 1);
});

Deno.test("GPS only, no compass: moving below 20 km/h, forward once fast", () => {
  const { run, transcript } = drive(
    [
      settle,
      { ramp: { to: 4, accel: 0.5 }, mark: "slow" },
      { hold: 10 },
      {
        ramp: { to: 7, accel: 0.5 },
        mark: "fast",
      },
      { hold: 12 },
      ...stop,
    ],
    {},
    { imu: false },
  );
  assertEquals(
    stateAt(transcript, run.marks.fast - 100),
    "moving",
    show(transcript, run.marks.slow),
  );
  decidedWithin(transcript, "forward", run.marks.fast, 10);
  never(transcript, "reversing");
});

Deno.test("the compass is trusted only after agreeing with GPS in three quadrants", () => {
  // a square loop at 25 km/h, the board's compass 7° off
  const square: Step[] = [settle, { ramp: { to: 7, accel: 0.6 } }];
  for (let i = 0; i < 4; i++) {
    square.push({ hold: 16 }, { turn: { yawDps: -15, durS: 12 } });
  }
  square.push({ hold: 16 }, ...stop);
  const { estimator, endMs } = drive(square, { compass: { offsetDeg: -7 } });
  const compass = estimator.health(endMs).compass;
  assertEquals(compass.status, "trusted", JSON.stringify(compass));
  assert(Math.abs((compass.offsetDeg ?? 99) - 7) < 3, JSON.stringify(compass));
});

// ------------------------------------------------------------- gaps, reboots, faults

Deno.test("a 3 s IMU gap at 25 km/h: GPS holds the direction", () => {
  const { run, transcript } = drive([
    settle,
    { ramp: { to: 7, accel: 0.6 } },
    { turn: { yawDps: 10, durS: 6 } },
    { hold: 5, mark: "before" },
    { gap: 3 },
    { hold: 5 },
    ...stop,
  ]);
  assertEquals(
    stateAt(transcript, run.marks.before),
    "forward",
    show(transcript),
  );
  never(transcript, "moving", run.marks.before, run.marks.before + 9000);
  never(transcript, "unknown", run.marks.before, run.endMs);
});

Deno.test("a 5 s IMU gap without GPS: unknown, then decided again", () => {
  const { run, transcript } = drive(
    [
      settle,
      { ramp: { to: 5, accel: 0.5 } },
      { hold: 3, mark: "before" },
      { gap: 5 },
      // without GPS only turns can tell the direction of a vehicle already moving
      { turn: { yawDps: 10, durS: 6 } },
      { hold: 2 },
      { turn: { yawDps: -10, durS: 6 } },
      { hold: 2 },
      { turn: { yawDps: 10, durS: 6 } },
      { hold: 4 },
      ...stop,
    ],
    {},
    { gps: false },
  );
  assert(
    everPublished(transcript, "unknown", run.marks.before),
    show(transcript, run.marks.before),
  );
  const unknownAt = firstChange(transcript, "unknown", run.marks.before)!.tMs;
  assert(
    firstChange(transcript, "forward", unknownAt) !== undefined,
    show(transcript, run.marks.before),
  );
});

Deno.test("a gap while parked stays stopped", () => {
  const { transcript } = drive([settle, { gap: 2 }, { hold: 20 }]);
  never(transcript, "moving");
  never(transcript, "forward");
  never(transcript, "reversing");
});

Deno.test("a device reboot mid-drive with GPS: the direction holds", () => {
  const { run, transcript } = drive([
    settle,
    { ramp: { to: 7, accel: 0.6 } },
    { turn: { yawDps: 10, durS: 6 } },
    { hold: 3, mark: "before" },
    { reboot: true },
    { hold: 6 },
    ...stop,
  ]);
  assertEquals(stateAt(transcript, run.marks.before), "forward");
  never(transcript, "reversing");
  never(transcript, "moving", run.marks.before, run.marks.before + 8000);
});

Deno.test("a frozen IMU while driving is reported, and never reads as a stop", () => {
  const { run, transcript, estimator } = drive(
    [settle, { ramp: { to: 5, accel: 0.5 } }, { freeze: 8, mark: "frozen" }, {
      hold: 6,
    }],
    {},
    { gps: false },
  );
  never(transcript, "stopped", run.marks.frozen, run.marks.frozen + 6000);
  assertEquals(estimator.health(run.marks.frozen + 3000).imu.status, "frozen");
});

Deno.test("a GPS course frozen through a turn is not taken as a reversal", () => {
  const { run, transcript } = drive([
    settle,
    { ramp: { to: 6, accel: 0.6 } },
    { turn: { yawDps: 10, durS: 6 } },
    { hold: 4, mark: "freeze" },
    { freezeTrack: 20 },
    { turn: { yawDps: 15, durS: 12 } },
    { hold: 4 },
    ...stop,
  ]);
  never(transcript, "reversing", run.marks.freeze);
});

// ------------------------------------------------------------- invariance

const reference: Step[] = [
  settle,
  { ramp: { to: 5, accel: 0.5 } },
  { turn: { yawDps: 10, durS: 6 } },
  { hold: 6 },
  { ramp: { to: 0, accel: 1 } },
  { hold: 8 },
  { ramp: { to: -1.5, accel: 0.4 } },
  { turn: { yawDps: -12, durS: 5 } },
  ...stop,
];

const sequenceOf = (t: Transition[]) =>
  t.map((x) => x.to).filter((v) => v !== "moving");

Deno.test("every mount, set correctly, tells the same story", () => {
  const expected = sequenceOf(drive(reference).transcript);
  for (const axis of ["-x", "+y", "-y"] as const) {
    const { transcript } = drive(reference, { trueMount: axis }, {
      forwardAxis: axis,
    });
    assertEquals(
      sequenceOf(transcript),
      expected,
      `${axis}:\n${show(transcript)}`,
    );
  }
});

Deno.test("the story does not depend on which way the vehicle faces", () => {
  const expected = sequenceOf(drive(reference).transcript);
  for (const startHeadingDeg of [90, 180, 270, 359]) {
    const { transcript } = drive(reference, { startHeadingDeg });
    assertEquals(
      sequenceOf(transcript),
      expected,
      `${startHeadingDeg}°:\n${show(transcript)}`,
    );
  }
});

Deno.test("five noise seeds, same story", () => {
  for (const seed of [2, 3, 4, 5, 6]) {
    const { transcript } = drive(reference, { seed });
    assertEquals(
      sequenceOf(transcript),
      ["stopped", "forward", "stopped", "reversing", "stopped"],
      `seed ${seed}:\n${show(transcript)}`,
    );
  }
});

// ------------------------------------------------------------- the generator itself

Deno.test("the generator: +1 g up at rest, +x forward when accelerating, +y in a left turn", () => {
  // averaged over a window, as the estimator reads it: a single snapshot can
  // land on a cab-rock peak (±0.8 m/s² at a board 4 m from the pitch centre)
  const quiet = { engineToneMg: 0, accelNoiseMg: 0, gps: false as const };
  const meanOf = (
    run: ReturnType<typeof simulate>,
    from: number,
    to: number,
  ) => {
    const imu = run.events.filter((e) => e.kind === "imu").slice(from, to);
    const avg = (f: (e: (typeof imu)[number]) => number) =>
      imu.reduce((a, e) => a + f(e), 0) / imu.length;
    return {
      ax: avg((e) => e.kind === "imu" ? e.sample.accelG.x : 0),
      ay: avg((e) => e.kind === "imu" ? e.sample.accelG.y : 0),
      az: avg((e) => e.kind === "imu" ? e.sample.accelG.z : 0),
      gz: avg((e) => e.kind === "imu" ? e.sample.gyroDps.z : 0),
    };
  };

  const rest = meanOf(simulate([{ hold: 2 }], quiet), 100, 200);
  assert(
    Math.abs(rest.az - 1) < 0.005 && Math.abs(rest.ax) < 0.005,
    JSON.stringify(rest),
  );

  const launch = simulate([{ hold: 2 }, { ramp: { to: 3, accel: 1 } }], quiet);
  const pulling = meanOf(launch, -150, -50);
  assert(
    pulling.ax > 0.08 && pulling.ax < 0.14,
    `1 m/s² ≈ 0.10 g + squat: ${JSON.stringify(pulling)}`,
  );

  const left = simulate([{ hold: 2 }, { ramp: { to: 5, accel: 2 } }, {
    turn: { yawDps: 10, durS: 4 },
  }], quiet);
  const apex = meanOf(left, -250, -150);
  assert(
    apex.gz > 8 && apex.ay > 0.06,
    `left turn: +yaw, +lateral: ${JSON.stringify(apex)}`,
  );
});
