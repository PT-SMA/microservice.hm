/**
 * Replay a travel-direction recording (HOUR_METER_DIRECTION_RECORD) through
 * the estimator and print the transcript — every change, with its basis.
 * Run it after editing src/direction/tuning.ts to see what the change does to
 * real drives; a recording plus its expected transcript is a regression test.
 *
 *   deno run --allow-read --allow-env scripts/replay-direction.ts rec/direction-20261015T07.ndjson [more…]
 *   … --axis=+y --reverse-max=0   override what the recording's config line says
 *   … --heading-axis=+x            the compass board's axis (a WT61 recording)
 *   … --trace                      also print evidence, launches, turn fits
 */

import {
  DIRECTION_TUNING,
  isForwardAxis,
  TravelDirectionEstimator,
  WT61_TUNING,
} from "../src/direction/index.ts";
import { parseGpsFix } from "../src/helpers/gps-fix.ts";

const files = Deno.args.filter((a) => !a.startsWith("--"));
const flag = (name: string) =>
  Deno.args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const showTrace = Deno.args.includes("--trace");
if (files.length === 0) {
  console.error(
    "usage: replay-direction.ts <recording.ndjson>… [--axis=+x] [--reverse-max=20] [--trace]",
  );
  Deno.exit(2);
}

type Line = { t: number; kind: string; [key: string]: unknown };
const lines: Line[] = [];
for (const file of files) {
  for (const text of (await Deno.readTextFile(file)).split("\n")) {
    if (text.trim() === "") continue;
    try {
      lines.push(JSON.parse(text));
    } catch {
      console.error(`skipping a line that is not JSON in ${file}`);
    }
  }
}
lines.sort((a, b) => a.t - b.t);

const config = lines.find((l) => l.kind === "config") ?? {};
const axis = flag("axis") ?? (config as Line).forwardAxis ?? "+x";
if (typeof axis !== "string" || !isForwardAxis(axis)) {
  console.error(`invalid forward axis ${axis}`);
  Deno.exit(2);
}
const headingAxis = flag("heading-axis") ?? (config as Line).headingAxis ??
  axis;
if (typeof headingAxis !== "string" || !isForwardAxis(headingAxis)) {
  console.error(`invalid heading axis ${headingAxis}`);
  Deno.exit(2);
}
const reverseMaxKmh = Number(
  flag("reverse-max") ?? (config as Line).reverseMaxKmh ?? 20,
);
const imuSource = (config as Line).imuSource === "wt61" ? "wt61" : "hour-meter";

const origin = lines[0]?.t ?? 0;
const at = (t: number) => `${((t - origin) / 1000).toFixed(1).padStart(8)}s`;
const estimator = new TravelDirectionEstimator({
  forwardAxis: axis,
  headingAxis,
  imuSource,
  tuning: imuSource === "wt61" ? WT61_TUNING : DIRECTION_TUNING,
  reverseMaxKmh,
  onChange: (c) =>
    console.log(
      `${
        at(c.changedAtMs)
      }  ${c.previousTravelDirection} → ${c.travelDirection}` +
        (c.basis.length ? `  [${c.basis.join(", ")}]` : "") +
        (c.correction ? "  corrected" : ""),
    ),
  onTrace: showTrace
    ? (t) => {
      if (t.kind !== "transition") {
        console.log(`${at(t.tMs)}    ${t.kind} ${JSON.stringify(t.data)}`);
      }
    }
    : undefined,
});

console.log(
  `replaying ${lines.length} records, IMU ${imuSource}, forward axis ${axis}` +
    (headingAxis !== axis ? ` (compass ${headingAxis})` : "") +
    `, reverse max ${reverseMaxKmh} km/h`,
);
let nextTick = origin + 1000;
for (const line of lines) {
  while (line.t >= nextTick) {
    estimator.tick(nextTick);
    nextTick += 1000;
  }
  switch (line.kind) {
    case "imu":
      estimator.onImu(line as never, line.t);
      break;
    case "status":
      estimator.onDeviceStatus(line as never, line.t);
      break;
    case "reset":
      estimator.onReset(line.reason === "link" ? "link" : "boot", line.t);
      break;
    case "gps": {
      const fix = typeof line.raw === "string" ? parseGpsFix(line.raw) : null;
      if (fix) estimator.onGps(fix, line.t);
      break;
    }
  }
}
const last = lines.at(-1)?.t ?? origin;
console.log(JSON.stringify(estimator.health(last), null, 2));
