'use strict';

/**
 * Error thrown (or emitted as `frameError`) for any invalid frame or value.
 * `code` is one of: TOO_SHORT, CRC, VERSION, FORMAT, TRUNCATED, COBS,
 * OVERFLOW, TOO_LARGE, ENCODE.
 */
class SensorFrameError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'SensorFrameError';
    this.code = code;
  }
}

module.exports = { SensorFrameError };
