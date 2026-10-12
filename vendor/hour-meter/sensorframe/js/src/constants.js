'use strict';

/** Protocol version (header byte 0). */
const VERSION = 1;
const HEADER_SIZE = 12;
const CRC_SIZE = 2;
const MIN_PACKET = HEADER_SIZE + CRC_SIZE;
/** Largest packet allowed by the spec (fits one ESP-NOW payload). */
const MAX_PACKET = 250;

/** Value encoding codes (record byte 1). */
const FMT = Object.freeze({
  u8: 1, i8: 2, u16: 3, i16: 4, u32: 5, i32: 6, f32: 7,
  bool: 8, bytes: 9, u64: 10, i64: 11, f64: 12,
});

/** Message types (header byte 1). 128..255 are application-defined. */
const MSG_TYPE = Object.freeze({
  TELEMETRY: 1, EVENT: 2, COMMAND: 3, ACK: 4, HEARTBEAT: 5,
});

/** Reserved tags 240..255. Application tags are 1..239. */
const RESERVED_TAGS = Object.freeze({
  240: { name: 'errorCode', fmt: 'u16' },
  241: { name: 'fwVersion', fmt: 'u32' },
  242: { name: 'ackSeq', fmt: 'u16' },
  243: { name: 'ackStatus', fmt: 'u8' },
});

module.exports = { VERSION, HEADER_SIZE, CRC_SIZE, MIN_PACKET, MAX_PACKET, FMT, MSG_TYPE, RESERVED_TAGS };
