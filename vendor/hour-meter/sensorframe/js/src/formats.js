'use strict';

const { FMT } = require('./constants');

/**
 * Per-format reader/writer. `size` 0 means variable length (bytes).
 * Integer formats carry [min, max] for range checks on encode.
 */
const FORMATS = {
  [FMT.u8]: { name: 'u8', size: 1, min: 0, max: 0xff, read: (b, o) => b.readUInt8(o), write: (b, o, v) => b.writeUInt8(v, o) },
  [FMT.i8]: { name: 'i8', size: 1, min: -0x80, max: 0x7f, read: (b, o) => b.readInt8(o), write: (b, o, v) => b.writeInt8(v, o) },
  [FMT.u16]: { name: 'u16', size: 2, min: 0, max: 0xffff, read: (b, o) => b.readUInt16LE(o), write: (b, o, v) => b.writeUInt16LE(v, o) },
  [FMT.i16]: { name: 'i16', size: 2, min: -0x8000, max: 0x7fff, read: (b, o) => b.readInt16LE(o), write: (b, o, v) => b.writeInt16LE(v, o) },
  [FMT.u32]: { name: 'u32', size: 4, min: 0, max: 0xffffffff, read: (b, o) => b.readUInt32LE(o), write: (b, o, v) => b.writeUInt32LE(v, o) },
  [FMT.i32]: { name: 'i32', size: 4, min: -0x80000000, max: 0x7fffffff, read: (b, o) => b.readInt32LE(o), write: (b, o, v) => b.writeInt32LE(v, o) },
  [FMT.f32]: { name: 'f32', size: 4, read: (b, o) => b.readFloatLE(o), write: (b, o, v) => b.writeFloatLE(v, o) },
  [FMT.bool]: { name: 'bool', size: 1, read: (b, o) => b[o] !== 0, write: (b, o, v) => b.writeUInt8(v ? 1 : 0, o) },
  [FMT.bytes]: { name: 'bytes', size: 0 },
  [FMT.u64]: { name: 'u64', size: 8, big: true, min: 0n, max: 0xffffffffffffffffn, read: (b, o) => b.readBigUInt64LE(o), write: (b, o, v) => b.writeBigUInt64LE(v, o) },
  [FMT.i64]: { name: 'i64', size: 8, big: true, min: -0x8000000000000000n, max: 0x7fffffffffffffffn, read: (b, o) => b.readBigInt64LE(o), write: (b, o, v) => b.writeBigInt64LE(v, o) },
  [FMT.f64]: { name: 'f64', size: 8, read: (b, o) => b.readDoubleLE(o), write: (b, o, v) => b.writeDoubleLE(v, o) },
};

/**
 * Resolve a fmt given as a name ('u16') or code (3).
 * @param {string|number} fmt
 * @returns {number|undefined} code
 */
function fmtCode(fmt) {
  if (typeof fmt === 'number') return FORMATS[fmt] ? fmt : undefined;
  return FMT[fmt];
}

module.exports = { FORMATS, fmtCode };
