'use strict';

/**
 * COBS-encode a packet. The result contains no 0x00 bytes and does NOT include
 * the trailing 0x00 delimiter.
 * @param {Uint8Array} input
 * @returns {Buffer}
 */
function cobsEncode(input) {
  const out = Buffer.allocUnsafe(input.length + Math.floor(input.length / 254) + 1);
  let write = 1;
  let codePos = 0;
  let code = 1;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === 0) {
      out[codePos] = code;
      codePos = write++;
      code = 1;
    } else {
      out[write++] = input[i];
      if (++code === 0xff) {
        out[codePos] = code;
        codePos = write++;
        code = 1;
      }
    }
  }
  out[codePos] = code;
  return out.subarray(0, write);
}

/**
 * Decode COBS bytes (delimiter already removed).
 * @param {Uint8Array} input
 * @returns {Buffer|null} decoded bytes, or null if the input is malformed
 */
function cobsDecode(input) {
  const out = Buffer.allocUnsafe(input.length);
  let read = 0;
  let write = 0;
  while (read < input.length) {
    const code = input[read];
    if (code === 0 || read + code > input.length) return null;
    read++;
    for (let i = 1; i < code; i++) {
      if (input[read] === 0) return null;
      out[write++] = input[read++];
    }
    if (code !== 0xff && read < input.length) out[write++] = 0;
  }
  return out.subarray(0, write);
}

module.exports = { cobsEncode, cobsDecode };
