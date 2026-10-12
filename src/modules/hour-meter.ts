/**
 * The ONLY bridge to `vendor/hour-meter/` — the device repo's codec and serial
 * reader, mirrored byte-identical (see `vendor/hour-meter/README.md`). Nothing
 * else in `src/` may import from `vendor/`, so a protocol change upstream has
 * exactly one seam to cross here.
 */

export {
  codec,
  type DecodedMessage,
  FrameSplitter,
  type SensorFrameError,
  type Value,
} from "../../vendor/hour-meter/configurator/src/sensorframe.ts";
export {
  type Link,
  linkPair,
  openLink,
} from "../../vendor/hour-meter/configurator/src/links.ts";
export {
  AckError,
  DeviceClient,
} from "../../vendor/hour-meter/configurator/src/device.ts";
export {
  ACK_STATUS,
  decodeStatusFlags,
  EVENT_KIND,
  GET,
  LAST_CAUSE,
  LAST_STAGE,
  MSG,
  SETTINGS,
  type SettingSpec,
  STATUS_FLAGS,
  tags,
} from "../../vendor/hour-meter/configurator/src/tags.ts";
