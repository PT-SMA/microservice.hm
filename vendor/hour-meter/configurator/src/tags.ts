// tags.ts: the host-side protocol table, mirror of esp32/lib/App/src/Protocol.h and
// esp32/lib/App/src/SettingsSchema.cpp. `esp32/scripts/check-docs.ts` fails if this
// file and the firmware disagree. The simulator imports it too.
//
// Scales: value = raw * scale (the sensorframe codec applies them).

export interface TagDef {
  name: string;
  fmt: string;
  scale?: number;
  unit?: string;
}

export interface SettingSpec {
  tag: number;
  min: number;
  max: number;
  unit?: string;
  help: string;
  /** Named values for enum-like settings. */
  options?: Record<string, number>;
  /** The only accepted values (uartBaud). */
  values?: number[];
}

export const tags: Record<number, TagDef> = {
  // Hour meter
  1: { name: 'runSeconds', fmt: 'u32', unit: 's' },
  2: { name: 'totalCount', fmt: 'u32', unit: 'pulses' },
  3: { name: 'alternator', fmt: 'bool' },
  4: { name: 'runHours', fmt: 'u32', scale: 0.01, unit: 'h' },
  5: { name: 'totalUnits', fmt: 'u32', scale: 0.01, unit: 'unit' },
  6: { name: 'lastSavedEpoch', fmt: 'u32', unit: 's' },
  7: { name: 'journalSeq', fmt: 'u32' },
  8: { name: 'eventKind', fmt: 'u8' },
  9: { name: 'calibResult', fmt: 'u8' },
  // IMU raw
  20: { name: 'rawAccelX', fmt: 'i16', scale: 0.001, unit: 'g' },
  21: { name: 'rawAccelY', fmt: 'i16', scale: 0.001, unit: 'g' },
  22: { name: 'rawAccelZ', fmt: 'i16', scale: 0.001, unit: 'g' },
  23: { name: 'rawGyroX', fmt: 'i16', scale: 0.1, unit: 'deg/s' },
  24: { name: 'rawGyroY', fmt: 'i16', scale: 0.1, unit: 'deg/s' },
  25: { name: 'rawGyroZ', fmt: 'i16', scale: 0.1, unit: 'deg/s' },
  26: { name: 'rawMagX', fmt: 'i16', scale: 0.1, unit: 'uT' },
  27: { name: 'rawMagY', fmt: 'i16', scale: 0.1, unit: 'uT' },
  28: { name: 'rawMagZ', fmt: 'i16', scale: 0.1, unit: 'uT' },
  // IMU filtered
  30: { name: 'accelX', fmt: 'i16', scale: 0.001, unit: 'g' },
  31: { name: 'accelY', fmt: 'i16', scale: 0.001, unit: 'g' },
  32: { name: 'accelZ', fmt: 'i16', scale: 0.001, unit: 'g' },
  33: { name: 'gyroX', fmt: 'i16', scale: 0.1, unit: 'deg/s' },
  34: { name: 'gyroY', fmt: 'i16', scale: 0.1, unit: 'deg/s' },
  35: { name: 'gyroZ', fmt: 'i16', scale: 0.1, unit: 'deg/s' },
  36: { name: 'magX', fmt: 'i16', scale: 0.1, unit: 'uT' },
  37: { name: 'magY', fmt: 'i16', scale: 0.1, unit: 'uT' },
  38: { name: 'magZ', fmt: 'i16', scale: 0.1, unit: 'uT' },
  // Derived
  40: { name: 'roll', fmt: 'i16', scale: 0.01, unit: 'deg' },
  41: { name: 'pitch', fmt: 'i16', scale: 0.01, unit: 'deg' },
  42: { name: 'heading', fmt: 'u16', scale: 0.01, unit: 'deg' },
  43: { name: 'vibRms', fmt: 'u16', unit: 'mg' },
  44: { name: 'vibPeak', fmt: 'u16', unit: 'mg' },
  // Status
  50: { name: 'timeValid', fmt: 'bool' },
  51: { name: 'epoch', fmt: 'u32', unit: 's' },
  52: { name: 'uptime', fmt: 'u32', unit: 's' },
  53: { name: 'statusFlags', fmt: 'u32' },
  54: { name: 'rtcTemp', fmt: 'i16', scale: 0.25, unit: 'C' },
  55: { name: 'devices', fmt: 'u8' },
  56: { name: 'i2cErrors', fmt: 'u32' },
  57: { name: 'overruns', fmt: 'u32' },
  58: { name: 'resetReason', fmt: 'u8' },
  59: { name: 'rejectedTag', fmt: 'u8' },
  60: { name: 'settingsSource', fmt: 'u8' },
  61: { name: 'btState', fmt: 'u8' },
  62: { name: 'lastCause', fmt: 'u8' },
  63: { name: 'lastStage', fmt: 'u8' },
  // Commands (host -> device)
  100: { name: 'setTime', fmt: 'u32' },
  101: { name: 'get', fmt: 'u8' },
  102: { name: 'setRunSeconds', fmt: 'u32' },
  103: { name: 'setTotalCount', fmt: 'u32' },
  104: { name: 'resetCounters', fmt: 'u32' },
  105: { name: 'calibrate', fmt: 'u8' },
  106: { name: 'reboot', fmt: 'u8' },
  107: { name: 'unlock', fmt: 'u16' },
  // Settings (read with get=2, write by sending the tag in a COMMAND)
  110: { name: 'telemetryIntervalMs', fmt: 'u16' },
  111: { name: 'imuSampleHz', fmt: 'u16' },
  112: { name: 'imuStreamHz', fmt: 'u8' },
  113: { name: 'streamMode', fmt: 'u8' },
  114: { name: 'persistIntervalS', fmt: 'u16' },
  115: { name: 'vibrationWindowMs', fmt: 'u16' },
  116: { name: 'rtcSyncIntervalS', fmt: 'u16' },
  117: { name: 'output', fmt: 'u8' },
  118: { name: 'uartBaud', fmt: 'u32' },
  119: { name: 'altActiveHigh', fmt: 'bool' },
  120: { name: 'altDebounceMs', fmt: 'u16' },
  121: { name: 'pulseRisingEdge', fmt: 'bool' },
  122: { name: 'pulseMinIntervalUs', fmt: 'u16' },
  123: { name: 'pulsesPerUnit', fmt: 'u16' },
  124: { name: 'kalmanQAccel', fmt: 'f32' },
  125: { name: 'kalmanQGyro', fmt: 'f32' },
  126: { name: 'kalmanQMag', fmt: 'f32' },
  127: { name: 'bluetooth', fmt: 'bool' },
  128: { name: 'btPin', fmt: 'u16' },
  // Calibration (read-only)
  130: { name: 'calAccelBiasX', fmt: 'f32', unit: 'g' },
  131: { name: 'calAccelBiasY', fmt: 'f32', unit: 'g' },
  132: { name: 'calAccelBiasZ', fmt: 'f32', unit: 'g' },
  133: { name: 'calGyroBiasX', fmt: 'f32', unit: 'deg/s' },
  134: { name: 'calGyroBiasY', fmt: 'f32', unit: 'deg/s' },
  135: { name: 'calGyroBiasZ', fmt: 'f32', unit: 'deg/s' },
  136: { name: 'calAccelNoiseX', fmt: 'f32', unit: 'g^2' },
  137: { name: 'calAccelNoiseY', fmt: 'f32', unit: 'g^2' },
  138: { name: 'calAccelNoiseZ', fmt: 'f32', unit: 'g^2' },
  139: { name: 'calGyroNoiseX', fmt: 'f32', unit: '(deg/s)^2' },
  140: { name: 'calGyroNoiseY', fmt: 'f32', unit: '(deg/s)^2' },
  141: { name: 'calGyroNoiseZ', fmt: 'f32', unit: '(deg/s)^2' },
  142: { name: 'calMagOffsetX', fmt: 'f32', unit: 'uT' },
  143: { name: 'calMagOffsetY', fmt: 'f32', unit: 'uT' },
  144: { name: 'calMagOffsetZ', fmt: 'f32', unit: 'uT' },
  145: { name: 'calMagScaleX', fmt: 'f32' },
  146: { name: 'calMagScaleY', fmt: 'f32' },
  147: { name: 'calMagScaleZ', fmt: 'f32' },
  148: { name: 'calFlags', fmt: 'u8' },
  // 240..243 (errorCode, fwVersion, ackSeq, ackStatus) are built into sensorframe.
};

export const MSG = Object.freeze({ TELEMETRY: 1, EVENT: 2, COMMAND: 3, ACK: 4, IMU: 128 });

export const ACK_STATUS: readonly string[] = Object.freeze([
  'Ok',
  'UnknownTag',
  'InvalidValue',
  'StorageError',
  'DeviceMissing',
  'Busy',
  'BadMagic',
  'Unsupported',
  'Failed',
  'Locked',
  'BadPin',
]);

export const STATUS_FLAGS: readonly string[] = Object.freeze([
  'eepromMissing',
  'rtcMissing',
  'timeInvalid',
  'imuMissing',
  'magMissing',
  'imuNotCalibrated',
  'magNotCalibrated',
  'settingsDefaults',
  'journalEmpty',
  'storageError',
  'imuStuck',
  'imuSaturated',
  'i2cErrors',
  'eepromFormatted',
  'calibrating',
  'rtcBatteryLost',
  'timeNotBackedUp',
  'settingsNotSaved',
  'safeMode',
]);

export const GET: Readonly<Record<string, number>> = Object.freeze({ hour: 1, settings: 2, status: 3, calib: 4 });
export const CALIB: Readonly<Record<string, number>> = Object.freeze({ gyro: 1, imu: 1, mag: 2 });
export const EVENT_KIND: Readonly<Record<number, string>> = Object.freeze({
  1: 'boot',
  2: 'calibrationDone',
  3: 'devicesChanged',
});
export const OUTPUT: Readonly<Record<string, number>> = Object.freeze({ usb: 1, uart: 2, both: 3 });
export const STREAM_MODE: Readonly<Record<string, number>> = Object.freeze({ off: 0, raw: 1, filtered: 2, both: 3 });
export const RESET_MAGIC = 0x5245534e;

/** Settings ranges, mirror of esp32/lib/App/src/SettingsSchema.cpp (check-docs verifies). */
export const SETTINGS: Record<string, SettingSpec> = {
  telemetryIntervalMs: { tag: 110, min: 100, max: 60000, unit: 'ms', help: 'TELEMETRY period' },
  imuSampleHz: { tag: 111, min: 10, max: 500, unit: 'Hz', help: 'IMU read + filter rate' },
  imuStreamHz: { tag: 112, min: 0, max: 100, unit: 'Hz', help: 'IMU stream rate (0 = off, <= imuSampleHz)' },
  streamMode: { tag: 113, min: 0, max: 3, help: 'IMU stream content', options: STREAM_MODE },
  persistIntervalS: { tag: 114, min: 10, max: 3600, unit: 's', help: 'max time between EEPROM saves' },
  vibrationWindowMs: { tag: 115, min: 100, max: 10000, unit: 'ms', help: 'vibration RMS/peak window' },
  rtcSyncIntervalS: { tag: 116, min: 1, max: 3600, unit: 's', help: 'RTC re-read period' },
  output: { tag: 117, min: 1, max: 3, help: 'where periodic data goes (applied after ACK)', options: OUTPUT },
  uartBaud: {
    tag: 118,
    min: 9600,
    max: 921600,
    unit: 'baud',
    help: 'UART pins baud (USB stays 115200)',
    values: [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600],
  },
  altActiveHigh: { tag: 119, min: 0, max: 1, help: 'alternator running = HIGH? (817 module: false)' },
  altDebounceMs: { tag: 120, min: 0, max: 5000, unit: 'ms', help: 'alternator debounce' },
  pulseRisingEdge: { tag: 121, min: 0, max: 1, help: 'count rising (true) or falling (false) edges' },
  pulseMinIntervalUs: { tag: 122, min: 0, max: 65535, unit: 'us', help: 'pulse debounce' },
  pulsesPerUnit: { tag: 123, min: 1, max: 65535, help: 'pulses per unit (e.g. per litre)' },
  kalmanQAccel: { tag: 124, min: 1e-7, max: 1.0, help: 'accel filter responsiveness' },
  kalmanQGyro: { tag: 125, min: 1e-7, max: 10.0, help: 'gyro filter responsiveness' },
  kalmanQMag: { tag: 126, min: 1e-7, max: 10.0, help: 'mag filter responsiveness' },
  bluetooth: { tag: 127, min: 0, max: 1, help: 'Bluetooth SPP radio on/off (applied after ACK)' },
  btPin: { tag: 128, min: 0, max: 9999, help: 'PIN to unlock a Bluetooth session (change it!)' },
};

/** Why the device restarted last time (tag 62), mirror of Protocol.h LastCause. */
export const LAST_CAUSE: readonly string[] = Object.freeze([
  'none',
  'watchdog',
  'i2cStuck',
  'usbStalled',
  'panicSignal',
  'rebootCommand',
  'crash',
]);

/** What the device was doing when it restarted (tag 63), mirror of Protocol.h Stage. */
export const LAST_STAGE: readonly string[] = Object.freeze([
  'unknown',
  'boot',
  'opening USB',
  'starting I2C',
  'EEPROM',
  'opening UART',
  'RTC',
  'IMU',
  'serial / command',
  'inputs',
  'telemetry',
  'presence check',
]);

/** The panic signal: this many 0x00 bytes in a row on a wired port restart the device (no frame, no ACK). */
export const PANIC_ZERO_RUN = 64;

export const BT_STATE: readonly string[] = Object.freeze([
  'off',
  'on, no client',
  'client connected (locked)',
  'client connected (unlocked)',
]);

const U32_MAX = 0xffffffff;

/** Hour meter preset: hours (decimals allowed) -> the u32 seconds sent as setRunSeconds. */
export function hoursToSeconds(hours: string | number): number {
  const h = Number(hours);
  if (!Number.isFinite(h) || h < 0) throw new Error(`hours must be a number >= 0, got '${hours}'`);
  const s = Math.round(h * 3600);
  if (s > U32_MAX) throw new Error(`max ${Math.floor(U32_MAX / 3600)} hours`);
  return s;
}

/**
 * Totalizer preset: units (litres, metres...; decimals allowed) -> pulses for setTotalCount,
 * using the device's pulsesPerUnit setting. Rounds to the nearest whole pulse.
 */
export function unitsToPulses(units: string | number, pulsesPerUnit: string | number): number {
  const u = Number(units);
  const ppu = Number(pulsesPerUnit);
  if (!Number.isFinite(u) || u < 0) throw new Error(`units must be a number >= 0, got '${units}'`);
  if (!Number.isInteger(ppu) || ppu < 1) throw new Error(`pulsesPerUnit must be >= 1, got '${pulsesPerUnit}'`);
  const pulses = Math.round(u * ppu);
  if (pulses > U32_MAX) throw new Error(`max ${Math.floor(U32_MAX / ppu)} units at ${ppu} pulses/unit`);
  return pulses;
}

/** Names of the bits set in a statusFlags value. */
export function decodeStatusFlags(flags: number): string[] {
  return STATUS_FLAGS.filter((_, bit) => (flags >>> bit) & 1);
}
