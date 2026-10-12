'use strict';

const { Transform } = require('stream');
const { createCodec } = require('./codec');
const { SensorFrameError } = require('./errors');

/**
 * Transform stream: raw bytes in (serial port, TCP socket, stdin...) ->
 * decoded messages out. Splits on 0x00, COBS-decodes, checks CRC.
 *
 * Bad frames never break the pipe: they are reported with a `frameError`
 * event `(err, frameBytes)` and skipped.
 *
 * @example
 * port.pipe(new FrameStream({ codec })).on('data', (msg) => console.log(msg.values));
 */
class FrameStream extends Transform {
  /**
   * @param {{ codec?: ReturnType<typeof createCodec>, tags?: object, maxPacketSize?: number }} [options]
   */
  constructor(options = {}) {
    super({ readableObjectMode: true });
    this.codec = options.codec || createCodec({ tags: options.tags, maxPacketSize: options.maxPacketSize });
    const max = this.codec.maxPacketSize;
    this._maxFrame = max + Math.floor(max / 254) + 1;
    this._pending = Buffer.alloc(0);
    this._discarding = false;
  }

  _transform(chunk, _enc, done) {
    let data = this._pending.length ? Buffer.concat([this._pending, chunk]) : chunk;
    let start = 0;
    let zero;
    while ((zero = data.indexOf(0, start)) !== -1) {
      const frame = data.subarray(start, zero);
      start = zero + 1;
      if (this._discarding) {
        this._discarding = false;
        continue;
      }
      if (frame.length === 0) continue;  // idle delimiters between frames
      try {
        this.push(this.codec.decodeFrame(frame));
      } catch (err) {
        this.emit('frameError', err, Buffer.from(frame));
      }
    }
    data = data.subarray(start);
    if (data.length > this._maxFrame) {
      // No delimiter in sight: drop bytes until the next 0x00 resynchronises us.
      if (!this._discarding) {
        this.emit('frameError', new SensorFrameError('OVERFLOW', `frame exceeds ${this._maxFrame} B without delimiter`), Buffer.from(data));
      }
      this._discarding = true;
      data = Buffer.alloc(0);
    }
    this._pending = Buffer.from(data);
    done();
  }
}

module.exports = { FrameStream };
