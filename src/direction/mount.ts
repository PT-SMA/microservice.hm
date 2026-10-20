import type { ForwardAxis, Vec3 } from "./types.ts";

export const FORWARD_AXES: readonly ForwardAxis[] = ["+x", "-x", "+y", "-y"];

export function isForwardAxis(value: string): value is ForwardAxis {
  return (FORWARD_AXES as readonly string[]).includes(value);
}

export interface Mount {
  axis: ForwardAxis;
  /** board → vehicle frame (x forward, y left, z up) */
  toVehicle(board: Vec3): Vec3;
  /** vehicle → board frame */
  toBoard(vehicle: Vec3): Vec3;
  /**
   * Added to the board heading (the firmware's heading of its x axis) to get
   * the heading of the vehicle's front.
   */
  headingOffsetDeg: number;
}

/**
 * The board lies flat (z up); which of its in-plane axes points forward is
 * `HOUR_METER_FORWARD_AXIS`. Left follows from right-handedness:
 * forward +y ⇒ left −x, forward −y ⇒ left +x.
 */
export function mountOf(axis: ForwardAxis): Mount {
  switch (axis) {
    case "+x":
      return {
        axis,
        toVehicle: (b) => ({ x: b.x, y: b.y, z: b.z }),
        toBoard: (v) => ({ x: v.x, y: v.y, z: v.z }),
        headingOffsetDeg: 0,
      };
    case "-x":
      return {
        axis,
        toVehicle: (b) => ({ x: -b.x, y: -b.y, z: b.z }),
        toBoard: (v) => ({ x: -v.x, y: -v.y, z: v.z }),
        headingOffsetDeg: 180,
      };
    case "+y":
      return {
        axis,
        toVehicle: (b) => ({ x: b.y, y: -b.x, z: b.z }),
        toBoard: (v) => ({ x: -v.y, y: v.x, z: v.z }),
        headingOffsetDeg: -90,
      };
    case "-y":
      return {
        axis,
        toVehicle: (b) => ({ x: -b.y, y: b.x, z: b.z }),
        toBoard: (v) => ({ x: v.y, y: -v.x, z: v.z }),
        headingOffsetDeg: 90,
      };
  }
}
