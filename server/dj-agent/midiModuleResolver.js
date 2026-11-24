"use strict";

const ALLOWED_MIDI_MODULE_NAMES = ["@julusian/midi", "midi"];
const DEFAULT_MIDI_MODULE_NAME = "@julusian/midi";

/**
 * Map caller input to exactly one allowlisted module name or null. Blank
 * input selects the explicit default; anything outside the allowlist,
 * including builtin and relative specifiers, resolves to null so no dynamic
 * require can ever observe caller-controlled text.
 */
function normalizeMidiModuleName(value) {
  if (value === undefined || value === null) {
    return DEFAULT_MIDI_MODULE_NAME;
  }
  if (typeof value !== "string") {
    return null;
  }
  const name = value.trim();
  if (!name) {
    return DEFAULT_MIDI_MODULE_NAME;
  }
  return ALLOWED_MIDI_MODULE_NAMES.includes(name) ? name : null;
}

/**
 * Resolve exactly the requested allowlisted MIDI transport or fail closed.
 * There is deliberately no fallback between "@julusian/midi" and "midi":
 * setup probing and runtime sending must observe the same native
 * implementation, because port indexes are only comparable within one.
 */
function resolveMidiModule(moduleName = DEFAULT_MIDI_MODULE_NAME) {
  const candidate = normalizeMidiModuleName(moduleName);
  if (!candidate) {
    return null;
  }
  try {
    // Keep the supported optional packages as literal requires so pkg can
    // discover and include their Windows native prebuilds. Never widen this
    // to a computed require: it would break packaging isolation and allow
    // caller input to reach module resolution.
    if (candidate === "@julusian/midi") {
      return require("@julusian/midi");
    }
    if (candidate === "midi") {
      return require("midi");
    }
  } catch {
    // Optional transports are best-effort; the caller receives null rather
    // than a silently substituted module.
  }
  return null;
}

module.exports = {
  ALLOWED_MIDI_MODULE_NAMES,
  DEFAULT_MIDI_MODULE_NAME,
  normalizeMidiModuleName,
  resolveMidiModule,
};
