/// <reference types="node" />
import { Transform } from 'stream';

export type FmtName =
  | 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32'
  | 'bool' | 'bytes' | 'u64' | 'i64' | 'f64';

/** Value in a decoded record: number, boolean, bigint (u64/i64 without scale) or Buffer (bytes). */
export type FrameValue = number | boolean | bigint | Buffer;

export interface TagDef {
  /** Key used in `values`. */
  name: string;
  /** Wire encoding: name ('u16') or code (3). */
  fmt: FmtName | number;
  /** value = raw * scale on decode, raw = round(value / scale) on encode. */
  scale?: number;
  /** Informational; copied to decoded records. */
  unit?: string;
}

export interface CodecOptions {
  /** Tag table keyed by tag number (1..239 app, 240..255 reserved). */
  tags?: Record<number, TagDef>;
  /** Largest packet accepted/produced. Default 250. */
  maxPacketSize?: number;
}

export interface DecodedRecord {
  tag: number;
  /** Tag name from the table, or `tag_<n>` if unknown. */
  name: string;
  fmt: FmtName;
  /** Value exactly as on the wire (before scale). */
  raw: FrameValue;
  /** Value after scale. */
  value: FrameValue;
  unit?: string;
}

export interface DecodedMessage {
  version: number;
  msgType: number;
  /** 'TELEMETRY' | 'EVENT' | 'COMMAND' | 'ACK' | 'HEARTBEAT' | 'APP' | 'UNKNOWN' */
  msgTypeName: string;
  seq: number;
  deviceId: number;
  timestamp: number;
  /** name -> value. Duplicate tags: the last one wins (all are kept in `records`). */
  values: Record<string, FrameValue>;
  records: DecodedRecord[];
}

export interface EncodeRecord {
  tag: number;
  fmt: FmtName | number;
  value: number | boolean | bigint | string | Uint8Array;
  scale?: number;
}

export interface MessageInput {
  /** Default 1 (TELEMETRY). */
  msgType?: number;
  seq?: number;
  deviceId?: number;
  timestamp?: number;
  /** Values keyed by tag name; every name must exist in the tag table. */
  values?: Record<string, number | boolean | bigint | string | Uint8Array>;
  /** Extra records with explicit tag/fmt (no tag table needed). */
  records?: EncodeRecord[];
}

export interface Codec {
  /** Decode a raw packet (no COBS). Throws SensorFrameError. */
  decode(packet: Uint8Array): DecodedMessage;
  /** Encode a raw packet (header + records + CRC). Throws SensorFrameError. */
  encode(msg: MessageInput): Buffer;
  /** encode() + COBS + trailing 0x00, ready to write to a serial port. */
  frame(msg: MessageInput): Buffer;
  /** Decode one COBS frame (trailing 0x00 optional). */
  decodeFrame(frame: Uint8Array): DecodedMessage;
  readonly maxPacketSize: number;
  readonly tags: ReadonlyMap<number, TagDef & { code: number }>;
}

export function createCodec(options?: CodecOptions): Codec;

export interface FrameStreamOptions extends CodecOptions {
  /** Reuse an existing codec (otherwise one is built from `tags`). */
  codec?: Codec;
}

/** Bytes in -> DecodedMessage objects out. Bad frames emit `frameError` and are skipped. */
export class FrameStream extends Transform {
  constructor(options?: FrameStreamOptions);
  readonly codec: Codec;
  on(event: 'data', listener: (msg: DecodedMessage) => void): this;
  on(event: 'frameError', listener: (err: SensorFrameError, frame: Buffer) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}

export type SensorFrameErrorCode =
  | 'TOO_SHORT' | 'CRC' | 'VERSION' | 'FORMAT' | 'TRUNCATED'
  | 'COBS' | 'OVERFLOW' | 'TOO_LARGE' | 'ENCODE';

export class SensorFrameError extends Error {
  code: SensorFrameErrorCode;
}

export function crc16(data: Uint8Array, crc?: number): number;
export function cobsEncode(data: Uint8Array): Buffer;
export function cobsDecode(data: Uint8Array): Buffer | null;
/** COBS-encode a raw packet and append 0x00. */
export function frameBytes(packet: Uint8Array): Buffer;

export const VERSION: 1;
export const HEADER_SIZE: 12;
export const CRC_SIZE: 2;
export const MIN_PACKET: 14;
export const MAX_PACKET: 250;
export const FMT: Readonly<Record<FmtName, number>>;
export const MSG_TYPE: Readonly<{ TELEMETRY: 1; EVENT: 2; COMMAND: 3; ACK: 4; HEARTBEAT: 5 }>;
export const RESERVED_TAGS: Readonly<Record<number, TagDef>>;
