/** The wt61-driver line protocol this build speaks (its hello's `version`). */
export const WT61_PROTOCOL_VERSION = 1;

/** On the app's emitter, next to HM_EVENTS. */
export const WT61_EVENTS = Object.freeze({
  /** a sample, with `{ missedFrames }` */
  sample: "wt61:sample",
  /** `(usable, reason?)`: TCP up and the driver's serial port open, or not */
  link: "wt61:link",
});

/** Far beyond any v1 line (~300 bytes): the stream is not wt61-driver's. */
export const WT61_MAX_LINE_BYTES = 4096;
