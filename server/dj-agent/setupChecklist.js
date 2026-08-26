"use strict";

// This module deliberately consumes readiness facts only.  It does not load
// configuration, inspect environment variables, or accept credentials.  The
// caller must perform any token-bearing connection setup elsewhere and pass
// only the resulting booleans/enums here.

const SETUP_GATE_NAMES = Object.freeze([
  "mapping",
  "pedal",
  "midi",
  "syndocal",
  "macro",
]);

const SYNDOCAL_ADAPTERS = Object.freeze([
  "syndocal-envelope-v3",
]);

const RELEASE_MACRO_SEQUENCES = Object.freeze([
  "parallel",
  "filter-then-fade",
]);

const SYNDOCAL_ADAPTER_SET = new Set(SYNDOCAL_ADAPTERS);
const RELEASE_MACRO_SEQUENCE_SET = new Set(RELEASE_MACRO_SEQUENCES);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function gateInput(input, names) {
  if (!isRecord(input)) {
    return {};
  }
  for (const name of names) {
    if (Object.hasOwn(input, name)) {
      return isRecord(input[name]) ? input[name] : null;
    }
  }
  return {};
}

function explicitlyDisabled(status) {
  return status !== null
    && status !== undefined
    && (status.enabled === false || status.disabled === true);
}

function explicitlyEnabled(status) {
  return status && status.enabled === true;
}

function readySignal(status) {
  if (!isRecord(status)) {
    return false;
  }
  if (status.available === false || status.valid === false) {
    return false;
  }
  if (status.ready === true) {
    return true;
  }
  if (status.ok === true && status.available !== false) {
    return true;
  }
  return status.configured === true && status.valid === true;
}

function makeGate(name, enabled, state, reason, extra = {}) {
  const allowed = state === "ready";
  return {
    name,
    enabled,
    state,
    allowed,
    reason,
    ...extra,
  };
}

function disabledGate(name, reason = "disabled") {
  return makeGate(name, false, "disabled", reason);
}

function blockedGate(name, reason, extra = {}) {
  return makeGate(name, true, "blocked", reason, extra);
}

function readyGate(name, extra = {}) {
  return makeGate(name, true, "ready", null, extra);
}

function evaluateMappingGate(status) {
  if (explicitlyDisabled(status)) {
    return disabledGate("mapping");
  }
  if (!isRecord(status)) {
    return blockedGate("mapping", "mapping-status-invalid");
  }
  if (readySignal(status)) {
    return readyGate("mapping");
  }
  return blockedGate(
    "mapping",
    status.valid === false ? "mapping-invalid" : "mapping-not-ready",
  );
}

function evaluatePedalGate(status) {
  if (explicitlyDisabled(status)) {
    return disabledGate("pedal");
  }
  if (!isRecord(status)) {
    return blockedGate("pedal", "pedal-status-invalid");
  }
  if (readySignal(status)) {
    return readyGate("pedal");
  }
  return blockedGate(
    "pedal",
    status.available === false ? "pedal-unavailable" : "pedal-not-ready",
  );
}

function evaluateMidiGate(status) {
  if (explicitlyDisabled(status)) {
    return disabledGate("midi");
  }
  if (!isRecord(status)) {
    return blockedGate("midi", "midi-status-invalid");
  }
  if (!readySignal(status)) {
    return blockedGate(
      "midi",
      status.available === false ? "midi-unavailable" : "midi-not-ready",
    );
  }

  // A port number alone is not a proof of identity.  The caller must report
  // that the explicit selection probe succeeded before MIDI actions are
  // allowed.
  if (status.selected === false || status.selectionValid === false) {
    return blockedGate("midi", "midi-selection-invalid");
  }
  const selected = status.selected === true
    || status.selectionValid === true
    || (status.probed === true && status.nameVerified === true);
  if (!selected || status.nameVerified !== true) {
    return blockedGate("midi", "midi-selection-required");
  }
  return readyGate("midi");
}

function evaluateSyndocalGate(status) {
  if (explicitlyDisabled(status)) {
    return disabledGate("syndocal");
  }
  if (!isRecord(status)) {
    return blockedGate("syndocal", "syndocal-status-invalid");
  }
  if (!SYNDOCAL_ADAPTER_SET.has(status.adapter)) {
    return blockedGate("syndocal", "syndocal-adapter-invalid");
  }
  const connected = status.connected === true
    || status.ready === true
    || (status.state === "connected" && status.available !== false);
  if (!connected || status.available === false || status.valid === false) {
    return blockedGate(
      "syndocal",
      status.available === false ? "syndocal-unavailable" : "syndocal-not-ready",
      { adapter: status.adapter },
    );
  }
  return readyGate("syndocal", { adapter: status.adapter });
}

function evaluateMacroGate(status) {
  // Release macros are opt-in.  An absent status is the same as an explicit
  // disabled macro; an explicitly enabled malformed macro is blocked.
  if (status === undefined) {
    return disabledGate("macro", "macro-disabled");
  }
  if (explicitlyDisabled(status)) {
    return disabledGate("macro");
  }
  if (!isRecord(status)) {
    return blockedGate("macro", "macro-status-invalid");
  }
  if (!explicitlyEnabled(status)) {
    return blockedGate("macro", "macro-enabled-flag-invalid");
  }
  if (!RELEASE_MACRO_SEQUENCE_SET.has(status.sequence)) {
    return blockedGate("macro", "macro-sequence-invalid");
  }
  if (!readySignal(status)) {
    return blockedGate("macro", "macro-not-ready", { sequence: status.sequence });
  }
  return readyGate("macro", { sequence: status.sequence });
}

function makeDisabledResult() {
  const gates = {};
  for (const name of SETUP_GATE_NAMES) {
    gates[name] = disabledGate(name, "root-disabled");
  }
  return gates;
}

/**
 * Evaluate setup readiness from non-secret boolean/enum status facts.
 *
 * Disabled integration gates are never treated as permission to perform that
 * integration.  They are excluded from the aggregate blocking set only
 * because a disabled integration has no requested work.  Every action-facing
 * gate remains `allowed: false` while disabled.
 */
function evaluateSetupReadiness(input = {}) {
  const rootEnabled = isRecord(input) && input.enabled === true;
  if (!rootEnabled) {
    const gates = makeDisabledResult();
    return {
      enabled: false,
      state: "disabled",
      ready: false,
      allowed: false,
      reason: "agent-disabled",
      gates,
      actions: {
        mapping: false,
        pedal: false,
        midi: false,
        syndocal: false,
        macro: false,
        localMidi: false,
        timeline: false,
        releaseMacro: false,
      },
    };
  }

  const macroSpecified = isRecord(input) && Object.hasOwn(input, "macro");
  const releaseMacroSpecified = isRecord(input) && Object.hasOwn(input, "releaseMacro");
  const macroGate = macroSpecified && releaseMacroSpecified
    ? blockedGate("macro", "macro-configuration-conflict")
    : evaluateMacroGate(
      macroSpecified
        ? input.macro
        : releaseMacroSpecified
          ? input.releaseMacro
          : undefined,
    );
  const gates = {
    mapping: evaluateMappingGate(gateInput(input, ["mapping", "mappingStatus"])),
    pedal: evaluatePedalGate(gateInput(input, ["pedal", "pedalStatus"])),
    midi: evaluateMidiGate(gateInput(input, ["midi", "midiStatus"])),
    syndocal: evaluateSyndocalGate(gateInput(input, ["syndocal", "syndocalStatus"])),
    macro: macroGate,
  };
  const blocked = Object.values(gates).filter((gate) => gate.state === "blocked");
  // Mapping is the common prerequisite for every action surface.  A disabled
  // mapping therefore leaves the aggregate setup blocked even though the
  // individual disabled gate is represented safely rather than as an error.
  const ready = gates.mapping.allowed && blocked.length === 0;
  const actions = {
    mapping: gates.mapping.allowed,
    pedal: gates.pedal.allowed,
    midi: gates.midi.allowed,
    syndocal: gates.syndocal.allowed,
    macro: gates.macro.allowed,
    localMidi: gates.mapping.allowed && gates.midi.allowed,
    timeline: gates.mapping.allowed && gates.syndocal.allowed,
    releaseMacro: gates.mapping.allowed && gates.midi.allowed && gates.macro.allowed,
  };
  return {
    enabled: true,
    state: ready ? "ready" : "blocked",
    ready,
    allowed: ready,
    reason: ready ? null : "setup-gates-blocked",
    gates,
    actions,
  };
}

function isSetupReady(input = {}) {
  return evaluateSetupReadiness(input).ready === true;
}

module.exports = {
  RELEASE_MACRO_SEQUENCES,
  SETUP_GATE_NAMES,
  SYNDOCAL_ADAPTERS,
  buildSetupChecklist: evaluateSetupReadiness,
  checkSetupReadiness: evaluateSetupReadiness,
  evaluateSetupReadiness,
  isSetupReady,
};
