'use strict';

/**
 * CRC16-CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0.
 * Check value: crc16(Buffer.from('123456789')) === 0x29B1.
 * @param {Uint8Array} data
 * @param {number} [crc=0xFFFF] running value, for incremental use
 * @returns {number}
 */
function crc16(data, crc = 0xffff) {
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

module.exports = { crc16 };
