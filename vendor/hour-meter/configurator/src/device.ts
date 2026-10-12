// device.ts: DeviceClient, talk to the hour meter over any byte link.
//
//   const dev = await DeviceClient.open('/dev/ttyUSB0');
//   const ack = await dev.request({ get: 1 });   // resolves with the ACK message
//   dev.on('frame', (msg) => ...);                // every TELEMETRY / IMU / EVENT frame
//
// request() implements the protocol rules: unique seq per command, wait for
// the ACK whose ackSeq matches, retry with the SAME seq on timeout.
// Events: 'frame' (msg), 'frameError' (err), 'timeSynced' (epoch), 'timeSyncError' (err).
import { EventEmitter } from 'node:events';

import { type Link, openLink } from './links.ts';
import { codec, type DecodedMessage, FrameSplitter } from './sensorframe.ts';
import { ACK_STATUS, MSG, tags } from './tags.ts';

const TIME_INVALID_BIT = 1 << 2; // statusFlags bit 2 (see tags.ts STATUS_FLAGS)

export type CommandValues = Record<string, number | boolean>;

/** An error ACK: `ack` carries ackStatus and rejectedTag. */
export class AckError extends Error {
  constructor(message: string, readonly ack: DecodedMessage) {
    super(message);
  }
}

export interface OpenOptions {
  baudRate?: number;
  readyTimeoutMs?: number;
  pin?: string | number;
}

export class DeviceClient extends EventEmitter {
  private seq = Math.floor(Math.random() * 0xffff);
  private readonly pending = new Map<number, (ack: DecodedMessage) => void>();

  /** @param link any byte link: serial port, TCP socket, in-memory pair (tests, --demo) */
  constructor(private readonly link: Link) {
    super();
    const splitter = new FrameSplitter((msg) => this.onFrame(msg), (err) => this.emit('frameError', err));
    void this.pump(splitter);
  }

  /**
   * Open a port and wait until the device talks (ESP32 boards reboot when the port opens).
   * `spec` is a serial port (USB, a USB-TTL adapter on the UART pins, /dev/rfcomm0 for
   * Bluetooth) or tcp://host:port. Pass `pin` for Bluetooth: the session is locked until
   * unlocked with the device PIN.
   */
  static async open(spec: string, options: OpenOptions = {}): Promise<DeviceClient> {
    return await DeviceClient.connect(await openLink(spec, options.baudRate), options);
  }

  /** Wrap an already open link (e.g. the --demo device) and wait for it like open() does. */
  static async connect(link: Link, { readyTimeoutMs = 4000, pin }: OpenOptions = {}): Promise<DeviceClient> {
    const dev = new DeviceClient(link);
    if (pin !== undefined) await dev.unlock(pin); // a locked Bluetooth session sends nothing until then
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, readyTimeoutMs); // silent device (output=uart): just go on
      dev.once('frame', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return dev;
  }

  /**
   * Send one COMMAND and resolve with its ACK. Rejects with AckError if the device
   * answers with a non-Ok ackStatus, or with an Error if it never answers.
   */
  async request(values: CommandValues, { timeoutMs = 1500, retries = 2 } = {}): Promise<DecodedMessage> {
    const seq = this.seq = (this.seq + 1) & 0xffff;
    const bytes = codec.frame({ msgType: MSG.COMMAND, seq, values });
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ack = await this.sendAndWait(seq, bytes, timeoutMs);
      if (!ack) continue; // timeout: resend the same seq (device answers duplicates again)
      const status = Number(ack.values.ackStatus);
      if (status !== 0) {
        const tag = Number(ack.values.rejectedTag);
        const rejected = tag ? ` (tag ${tag}: ${tags[tag]?.name ?? '?'})` : '';
        throw new AckError(`device answered ${ACK_STATUS[status] ?? status}${rejected}`, ack);
      }
      return ack;
    }
    throw new Error(`no ACK after ${retries + 1} attempts`);
  }

  /** Write raw bytes (no frame, no ACK): the panic signal. */
  async sendRaw(bytes: Uint8Array): Promise<void> {
    await this.link.write(bytes);
  }

  /** Unlock a Bluetooth session (harmless on USB/UART). Rejects with BadPin / Locked. */
  unlock(pin: string | number): Promise<DecodedMessage> {
    return this.request({ unlock: Number(pin) });
  }

  /** Resolve with the next EVENT of a kind (e.g. 2 = calibration finished). */
  waitForEvent(kind: number, timeoutMs: number): Promise<DecodedMessage> {
    return new Promise((resolve, reject) => {
      const onFrame = (msg: DecodedMessage) => {
        if (msg.msgType !== MSG.EVENT || msg.values.eventKind !== kind) return;
        clearTimeout(timer);
        this.off('frame', onFrame);
        resolve(msg);
      };
      const timer = setTimeout(() => {
        this.off('frame', onFrame);
        reject(new Error('timeout waiting for event'));
      }, timeoutMs);
      this.on('frame', onFrame);
    });
  }

  /**
   * Keep the device clock set: whenever a frame says the time is unknown
   * (timeValid=false, e.g. the RTC has no backup battery and power was cut),
   * send the PC clock as UTC. Rate-limited so a silent failure cannot flood the link.
   * Emits 'timeSynced' (epoch) or 'timeSyncError' (Error).
   */
  enableAutoTimeSync({ minIntervalMs = 30000, now = () => Date.now() } = {}): this {
    let lastAttempt = -Infinity;
    let busy = false;
    this.on('frame', async (msg: DecodedMessage) => {
      const flags = msg.values.statusFlags;
      const timeUnknown = msg.values.timeValid === false ||
        (flags !== undefined && (Number(flags) & TIME_INVALID_BIT) !== 0);
      if (!timeUnknown || busy || now() - lastAttempt < minIntervalMs) return;
      busy = true;
      lastAttempt = now();
      const epoch = Math.floor(now() / 1000);
      try {
        await this.request({ setTime: epoch });
        this.emit('timeSynced', epoch);
      } catch (err) {
        this.emit('timeSyncError', err);
      } finally {
        busy = false;
      }
    });
    return this;
  }

  /** Close the link. Requests still waiting for an ACK time out on their own. */
  close(): void {
    this.link.close();
  }

  private sendAndWait(seq: number, bytes: Uint8Array, timeoutMs: number): Promise<DecodedMessage | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        resolve(null);
      }, timeoutMs);
      this.pending.set(seq, (ack) => {
        clearTimeout(timer);
        this.pending.delete(seq);
        resolve(ack);
      });
      this.link.write(bytes).catch((err) => this.emit('frameError', err));
    });
  }

  private onFrame(msg: DecodedMessage): void {
    const ackSeq = Number(msg.values.ackSeq);
    if (msg.msgType === MSG.ACK && this.pending.has(ackSeq)) {
      this.pending.get(ackSeq)?.(msg);
      return;
    }
    this.emit('frame', msg);
  }

  private async pump(splitter: FrameSplitter): Promise<void> {
    try {
      for await (const bytes of this.link.readable) splitter.push(bytes);
    } catch {
      // link closed underneath us
    }
    this.emit('close');
  }
}
