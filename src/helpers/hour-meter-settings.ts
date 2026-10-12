/**
 * Device settings over `hour-meter:command` (contract:
 * FMS-Backend/docs/ecosystem/integrations/hm-to-geofencer.md § Commands).
 * Everything here is pure: what a setting may be, whether a requested change
 * is acceptable, and what a `get=2` ACK says. The device validates again —
 * this is so a bad request never costs a COMMAND, and so the reason a request
 * was refused can be told in words.
 */

import { HM_HIDDEN_SETTINGS, HM_READ_ONLY_SETTINGS } from "consts";
import { type DecodedMessage, SETTINGS, tags } from "hour-meter";
import type { HourMeterCommand, HourMeterSettingSchema } from "types";

const ACTIONS = new Set<HourMeterCommand["action"]>([
  "getSettings",
  "setSettings",
]);

function typeOf(tag: number): HourMeterSettingSchema["type"] {
  const fmt = tags[tag]?.fmt;
  if (fmt === "bool") return "boolean";
  if (fmt === "f32") return "number";
  return "integer";
}

let schema: Record<string, HourMeterSettingSchema> | undefined;

/** Every setting this firmware has, except the hidden ones, as a UI needs it. */
export function settingsSchema(): Record<string, HourMeterSettingSchema> {
  if (schema) return schema;
  schema = {};
  for (const [name, spec] of Object.entries(SETTINGS)) {
    if (HM_HIDDEN_SETTINGS.includes(name)) continue;
    const entry: HourMeterSettingSchema = {
      type: typeOf(spec.tag),
      min: spec.min,
      max: spec.max,
      help: spec.help,
      writable: !HM_READ_ONLY_SETTINGS.includes(name),
    };
    if (spec.values) entry.values = [...spec.values];
    if (spec.options) entry.options = { ...spec.options };
    if (spec.unit) entry.unit = spec.unit;
    schema[name] = entry;
  }
  return schema;
}

export type SettingsCheck =
  | { ok: true; values: Record<string, number | boolean> }
  | { ok: false; setting?: string; message: string };

/**
 * Whether `input` is a change this service will send: a non-empty object of
 * known, writable settings, each of the right type and in range. All or
 * nothing, like the device.
 */
export function validateSettings(input: unknown): SettingsCheck {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "settings must be an object of name → value" };
  }
  const entries = Object.entries(input);
  if (entries.length === 0) {
    return { ok: false, message: "no settings to change" };
  }

  const values: Record<string, number | boolean> = {};
  for (const [name, value] of entries) {
    const spec = SETTINGS[name];
    if (spec === undefined || HM_HIDDEN_SETTINGS.includes(name)) {
      return { ok: false, setting: name, message: `unknown setting '${name}'` };
    }
    if (HM_READ_ONLY_SETTINGS.includes(name)) {
      return {
        ok: false,
        setting: name,
        message:
          `${name} cannot be changed remotely: it can cut the device's link ` +
          `or open it to others — change it on site with the configurator`,
      };
    }
    const type = typeOf(spec.tag);
    const unit = spec.unit ? ` ${spec.unit}` : "";
    if (type === "boolean") {
      if (typeof value !== "boolean") {
        return {
          ok: false,
          setting: name,
          message: `${name} must be true or false`,
        };
      }
    } else if (
      typeof value !== "number" ||
      !(type === "integer" ? Number.isInteger(value) : Number.isFinite(value))
    ) {
      return {
        ok: false,
        setting: name,
        message: `${name} must be ${
          type === "integer" ? "an integer" : "a number"
        }`,
      };
    } else if (spec.values && !spec.values.includes(value)) {
      return {
        ok: false,
        setting: name,
        message: `${name} must be one of ${spec.values.join(", ")}${unit}`,
      };
    } else if (value < spec.min || value > spec.max) {
      return {
        ok: false,
        setting: name,
        message: `${name} must be between ${spec.min} and ${spec.max}${unit}`,
      };
    }
    values[name] = value as number | boolean;
  }
  return { ok: true, values };
}

/**
 * The settings in a `get=2` ACK, by name, `btPin` left out. `f32` settings
 * come back as float32 (0.0005 reads 0.0005000000237487257); seven
 * significant digits is all float32 holds.
 */
export function readSettings(
  ack: DecodedMessage,
): Record<string, number | boolean> {
  const settings: Record<string, number | boolean> = {};
  for (const [name, spec] of Object.entries(SETTINGS)) {
    if (HM_HIDDEN_SETTINGS.includes(name)) continue;
    const value = ack.values[name];
    if (typeof value === "boolean") settings[name] = value;
    else if (typeof value === "number") {
      settings[name] = typeOf(spec.tag) === "number"
        ? Number(value.toPrecision(7))
        : value;
    }
  }
  return settings;
}

/** A parsed `hour-meter:command`; `settings` is checked later, by action. */
export interface ParsedCommand {
  requestId: string;
  action: HourMeterCommand["action"];
  settings?: unknown;
}

/**
 * `hour-meter:command` text → a command, `{ requestId, error }` when it can be
 * answered but not run, or null when there is nobody to answer (no
 * `requestId`). Never throws: it runs on a subscription callback.
 */
export function parseCommand(
  message: string,
): ParsedCommand | { requestId: string; error: string } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(message);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const { requestId, action, settings } = raw as Record<string, unknown>;
  if (typeof requestId !== "string" || requestId === "") return null;
  if (!ACTIONS.has(action as HourMeterCommand["action"])) {
    return {
      requestId,
      error: `unknown action '${String(action)}' (getSettings, setSettings)`,
    };
  }
  return {
    requestId,
    action: action as HourMeterCommand["action"],
    settings,
  };
}
