'use strict';

const { createCodec, frameBytes } = require('./src/codec');
const { FrameStream } = require('./src/stream');
const { crc16 } = require('./src/crc16');
const { cobsEncode, cobsDecode } = require('./src/cobs');
const { SensorFrameError } = require('./src/errors');
const constants = require('./src/constants');

module.exports = {
  createCodec,
  FrameStream,
  SensorFrameError,
  crc16,
  cobsEncode,
  cobsDecode,
  frameBytes,
  ...constants,
};
