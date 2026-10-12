'use strict';

const { crc16 } = require('./crc16');
const { cobsEncode, cobsDecode } = require('./cobs');
const { SensorFrameError } = require('./errors');
const { FORMATS, fmtCode } = require('./formats');
const {
  VERSION, HEADER_SIZE, CRC_SIZE, MIN_PACKET, MAX_PACKET, MSG_TYPE, RESERVED_TAGS,
} = require('./constants');

const MSG_TYPE_NAME = Object.fromEntries(Object.entries(MSG_TYPE).map(([k, v]) => [v, k]));

/**
 * @typedef {object} TagDef
 * @property {string} name     key used in `values`
 * @property {string|number} fmt  'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' |
 *                                 'bool' | 'bytes' | 'u64' | 'i64' | 'f64' (or its code)
 * @property {number} [scale]  value = raw * scale (e.g. 0.1 for temperature x10)
 * @property {string} [unit]   informational, copied to decoded records
 */

/**
 * Create an encoder/decoder bound to a tag table.
 *
 * @example
 * const codec = createCodec({ tags: {
 *   1: { name: 'runSeconds', fmt: 'u32', unit: 's' },
 *   4: { name: 'temperature', fmt: 'i16', scale: 0.1, unit: '°C' },
 * }});
 * codec.decode(packet).values; // { runSeconds: 3600, temperature: 23.4 }
 *
 * @param {{ tags?: Record<number, TagDef>, maxPacketSize?: number }} [options]
 */
function createCodec(options = {}) {
  const maxPacketSize = options.maxPacketSize ?? MAX_PACKET;
  /** @type {Map<number, TagDef & {code:number}>} */
  const byTag = new Map();
  /** @type {Map<string, number>} */
  const byName = new Map();

  for (const [tagStr, def] of Object.entries({ ...RESERVED_TAGS, ...(options.tags || {}) })) {
    const tag = Number(tagStr);
    if (!Number.isInteger(tag) || tag < 1 || tag > 255) {
      throw new SensorFrameError('ENCODE', `tag ${tagStr}: must be an integer 1..255`);
    }
    const code = fmtCode(def.fmt);
    if (code === undefined) throw new SensorFrameError('ENCODE', `tag ${tag}: unknown fmt '${def.fmt}'`);
    if (byName.has(def.name) && byName.get(def.name) !== tag) {
      throw new SensorFrameError('ENCODE', `duplicate tag name '${def.name}'`);
    }
    byTag.set(tag, { ...def, code });
    byName.set(def.name, tag);
  }

  /**
   * Decode one raw packet (no COBS, no delimiter).
   * @param {Uint8Array} input
   */
  function decode(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (buf.length < MIN_PACKET) throw new SensorFrameError('TOO_SHORT', `packet is ${buf.length} B, minimum is ${MIN_PACKET} B`);
    const body = buf.length - CRC_SIZE;
    const expected = buf.readUInt16LE(body);
    const actual = crc16(buf.subarray(0, body));
    if (expected !== actual) {
      throw new SensorFrameError('CRC', `crc mismatch: got 0x${expected.toString(16)}, computed 0x${actual.toString(16)}`);
    }
    if (buf[0] !== VERSION) throw new SensorFrameError('VERSION', `unsupported version ${buf[0]}`);

    const msg = {
      version: buf[0],
      msgType: buf[1],
      msgTypeName: MSG_TYPE_NAME[buf[1]] ?? (buf[1] >= 128 ? 'APP' : 'UNKNOWN'),
      seq: buf.readUInt16LE(2),
      deviceId: buf.readUInt32LE(4),
      timestamp: buf.readUInt32LE(8),
      values: {},
      records: [],
    };

    let pos = HEADER_SIZE;
    while (pos < body) {
      if (pos + 2 > body) throw new SensorFrameError('TRUNCATED', `record header at offset ${pos} runs past the end`);
      const tag = buf[pos];
      const code = buf[pos + 1];
      const f = FORMATS[code];
      if (!f) throw new SensorFrameError('FORMAT', `unknown fmt ${code} at offset ${pos + 1}`);
      pos += 2;

      let raw;
      if (f.size === 0) {
        if (pos + 1 > body) throw new SensorFrameError('TRUNCATED', `bytes length at offset ${pos} runs past the end`);
        const len = buf[pos];
        if (pos + 1 + len > body) throw new SensorFrameError('TRUNCATED', `bytes value at offset ${pos} runs past the end`);
        raw = Buffer.from(buf.subarray(pos + 1, pos + 1 + len));
        pos += 1 + len;
      } else {
        if (pos + f.size > body) throw new SensorFrameError('TRUNCATED', `value at offset ${pos} runs past the end`);
        raw = f.read(buf, pos);
        pos += f.size;
      }

      const def = byTag.get(tag);
      const name = def ? def.name : `tag_${tag}`;
      let value = raw;
      if (def && def.scale !== undefined && typeof raw !== 'boolean' && !Buffer.isBuffer(raw)) {
        value = round(Number(raw) * def.scale, def.scale);
      }
      const record = { tag, name, fmt: f.name, raw, value };
      if (def && def.unit) record.unit = def.unit;
      msg.records.push(record);
      msg.values[name] = value;  // duplicate tags: last one wins in `values`
    }
    return msg;
  }

  /**
   * Encode a message into a raw packet (header + records + CRC).
   * `values` keys must exist in the tag table; use `records` for ad-hoc tags.
   * @param {object} msg
   * @returns {Buffer}
   */
  function encode(msg) {
    const records = [];
    for (const [name, value] of Object.entries(msg.values || {})) {
      const tag = byName.get(name);
      if (tag === undefined) throw new SensorFrameError('ENCODE', `no tag defined for value '${name}'`);
      const def = byTag.get(tag);
      records.push({ tag, code: def.code, value, scale: def.scale });
    }
    for (const r of msg.records || []) {
      const code = fmtCode(r.fmt);
      if (code === undefined) throw new SensorFrameError('ENCODE', `record tag ${r.tag}: unknown fmt '${r.fmt}'`);
      records.push({ tag: r.tag, code, value: r.value, scale: r.scale });
    }

    const chunks = [header(msg)];
    for (const r of records) chunks.push(encodeRecord(r));
    const body = Buffer.concat(chunks);
    if (body.length + CRC_SIZE > maxPacketSize) {
      throw new SensorFrameError('TOO_LARGE', `packet would be ${body.length + CRC_SIZE} B, limit is ${maxPacketSize} B`);
    }
    const out = Buffer.alloc(body.length + CRC_SIZE);
    body.copy(out);
    out.writeUInt16LE(crc16(body), body.length);
    return out;
  }

  /**
   * Encode and COBS-frame a message for byte streams (UART, RS485, TCP).
   * @param {object} msg
   * @returns {Buffer} COBS bytes followed by 0x00
   */
  function frame(msg) {
    return frameBytes(encode(msg));
  }

  /**
   * Decode one COBS frame (with or without the trailing 0x00).
   * @param {Uint8Array} input
   */
  function decodeFrame(input) {
    let end = input.length;
    if (end > 0 && input[end - 1] === 0) end--;
    const packet = cobsDecode(input.subarray(0, end));
    if (!packet || packet.length === 0) throw new SensorFrameError('COBS', 'invalid COBS frame');
    return decode(packet);
  }

  return { decode, encode, frame, decodeFrame, maxPacketSize, tags: byTag };
}

function header(msg) {
  const h = Buffer.alloc(HEADER_SIZE);
  h.writeUInt8(VERSION, 0);
  h.writeUInt8(checkInt(msg.msgType ?? MSG_TYPE.TELEMETRY, 0, 0xff, 'msgType'), 1);
  h.writeUInt16LE(checkInt(msg.seq ?? 0, 0, 0xffff, 'seq'), 2);
  h.writeUInt32LE(checkInt(msg.deviceId ?? 0, 0, 0xffffffff, 'deviceId'), 4);
  h.writeUInt32LE(checkInt(msg.timestamp ?? 0, 0, 0xffffffff, 'timestamp'), 8);
  return h;
}

function encodeRecord({ tag, code, value, scale }) {
  checkInt(tag, 1, 255, 'tag');
  const f = FORMATS[code];
  if (f.size === 0) {
    const data = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
    if (data.length > 255) throw new SensorFrameError('ENCODE', `tag ${tag}: bytes value is ${data.length} B, max 255`);
    return Buffer.concat([Buffer.from([tag, code, data.length]), data]);
  }
  let raw = value;
  if (scale !== undefined && f.name !== 'bool') {
    raw = Math.round(Number(value) / scale);
    if (f.big) raw = BigInt(raw);
  }
  if (f.big) {
    raw = BigInt(raw);
    if (raw < f.min || raw > f.max) throw new SensorFrameError('ENCODE', `tag ${tag}: ${raw} out of ${f.name} range`);
  } else if (f.min !== undefined) {
    if (!Number.isInteger(raw)) throw new SensorFrameError('ENCODE', `tag ${tag}: ${f.name} needs an integer, got ${value}`);
    checkInt(raw, f.min, f.max, `tag ${tag} (${f.name})`);
  }
  const out = Buffer.alloc(2 + f.size);
  out[0] = tag;
  out[1] = code;
  f.write(out, 2, raw);
  return out;
}

function checkInt(v, min, max, what) {
  if (!Number.isInteger(v) || v < min || v > max) {
    throw new SensorFrameError('ENCODE', `${what}: ${v} out of range ${min}..${max}`);
  }
  return v;
}

/** COBS-encode a raw packet and append the 0x00 delimiter. */
function frameBytes(packet) {
  const enc = cobsEncode(packet);
  const out = Buffer.alloc(enc.length + 1);
  enc.copy(out);
  return out;
}

// Trim float noise from scaling (234 * 0.1 = 23.400000000000002 -> 23.4).
function round(v, scale) {
  const decimals = Math.max(0, Math.ceil(-Math.log10(Math.abs(scale))) + 2);
  return Number(v.toFixed(Math.min(decimals, 15)));
}

module.exports = { createCodec, frameBytes };
