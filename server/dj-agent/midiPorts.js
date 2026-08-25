"use strict";

const {
  DEFAULT_MIDI_MODULE_NAME,
  normalizeMidiModuleName,
  resolveMidiModule,
} = require("./midiModuleResolver");

function normalizePortIndex(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value;
  if (!/^(?:0|[1-9][0-9]*)$/.test(normalized)) {
    return null;
  }
  const number = Number(normalized);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function normalizePortName(value) {
  if (typeof value !== "string") {
    return null;
  }
  const name = value.trim();
  return name || null;
}

function resolveOutput({ midiModule = null, moduleName = "", outputFactory = null } = {}) {
  if (typeof outputFactory === "function") {
    return outputFactory();
  }
  const moduleObject = midiModule || resolveMidiModule(moduleName);
  if (!moduleObject || typeof moduleObject.Output !== "function") {
    return null;
  }
  return new moduleObject.Output();
}

function readPortCount(output) {
  if (!output || typeof output.getPortCount !== "function") {
    return null;
  }
  try {
    const count = Number(output.getPortCount());
    return Number.isInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

function readPortName(output, port) {
  if (!output || typeof output.getPortName !== "function") {
    return null;
  }
  try {
    return normalizePortName(output.getPortName(port));
  } catch {
    return null;
  }
}

function releaseOutput(output) {
  if (!output || typeof output.destroy !== "function") {
    return false;
  }
  try {
    output.destroy();
    return true;
  } catch {
    return false;
  }
}

function unreleasedProbeResult(output, result) {
  const destroyed = releaseOutput(output);
  return {
    ...result,
    destroyed,
    released: destroyed,
  };
}

/**
 * Enumerate output names without opening a MIDI port.
 *
 * The returned output object is intentionally not exposed. Enumeration does
 * not call openPort or closePort: an unowned output handle must not close a
 * port that another part of the process may have opened.
 */
function enumerateMidiOutputs(options = {}) {
  let output;
  try {
    output = resolveOutput(options);
  } catch {
    return {
      ok: false,
      available: false,
      ports: [],
      reason: "output-construction-failed",
      released: false,
    };
  }
  if (!output) {
    return { ok: false, available: false, ports: [], reason: "midi-unavailable", released: false };
  }

  let result = { ok: false, available: false, ports: [], reason: "port-enumeration-unavailable" };
  try {
    const count = readPortCount(output);
    if (count == null) {
      result = { ok: false, available: false, ports: [], reason: "port-enumeration-unavailable" };
    } else {
      const ports = [];
      for (let port = 0; port < count; port += 1) {
        ports.push({ port, name: readPortName(output, port) });
      }
      result = { ok: true, available: true, ports };
    }
  } finally {
    // Enumeration never opens a port.  destroy() is the safe native release;
    // closePort() on an unopen handle is intentionally not attempted.
    result.released = releaseOutput(output);
  }
  return result;
}

function selectionValues(options = {}) {
  const selection = options.selection && typeof options.selection === "object"
    ? options.selection
    : {};
  const selectedPort = options.selectedPort !== undefined
    ? options.selectedPort
    : options.port !== undefined
      ? options.port
      : selection.port ?? selection.index;
  const expectedName = options.expectedName !== undefined
    ? options.expectedName
    : options.device !== undefined
      ? options.device
      : selection.name ?? selection.device;
  return {
    selectedPort: normalizePortIndex(selectedPort),
    expectedName: normalizePortName(expectedName),
  };
}

/**
 * Probe one explicitly selected output. A matching selection is opened once
 * and closed once. A name mismatch is rejected before opening, so a wrong
 * device is never touched. Any open/close failure is fail-closed.
 */
function probeMidiOutputSelection(options = {}) {
  const { selectedPort, expectedName } = selectionValues(options);
  if (!expectedName) {
    return { ok: false, probed: false, nameVerified: false, reason: "expected-device-name-required" };
  }
  let output;
  try {
    output = resolveOutput(options);
  } catch {
    return {
      ok: false,
      probed: false,
      nameVerified: false,
      reason: "output-construction-failed",
    };
  }
  if (!output) {
    return { ok: false, probed: false, nameVerified: false, reason: "midi-unavailable" };
  }

  const count = readPortCount(output);
  if (count == null) {
    return unreleasedProbeResult(output, {
      ok: false,
      probed: false,
      nameVerified: false,
      reason: "port-enumeration-unavailable",
    });
  }
  if (selectedPort == null) {
    return unreleasedProbeResult(output, {
      ok: false,
      probed: false,
      nameVerified: false,
      reason: "explicit-selection-required",
    });
  }
  if (selectedPort >= count) {
    return unreleasedProbeResult(output, {
      ok: false,
      probed: false,
      nameVerified: false,
      reason: "selected-port-unavailable",
      port: selectedPort,
    });
  }

  // One exact, case-sensitive, trimmed device-name rule shared with runtime:
  // only the trimmed literal expected name matches, and it must match exactly
  // one enumerated port.
  const nameBeforeOpen = readPortName(output, selectedPort);
  if (nameBeforeOpen !== expectedName) {
    return unreleasedProbeResult(output, {
      ok: false,
      probed: false,
      nameVerified: false,
      reason: "selected-device-mismatch",
      port: selectedPort,
    });
  }
  for (let index = 0; index < count; index += 1) {
    if (index !== selectedPort && readPortName(output, index) === expectedName) {
      return unreleasedProbeResult(output, {
        ok: false,
        probed: false,
        nameVerified: false,
        reason: "duplicate-device-name",
        port: selectedPort,
      });
    }
  }
  if (typeof output.openPort !== "function" || typeof output.closePort !== "function") {
    return unreleasedProbeResult(output, {
      ok: false,
      probed: false,
      nameVerified: true,
      reason: "probe-lifecycle-unavailable",
      port: selectedPort,
    });
  }

  let openFailed = false;
  let closeFailed = false;
  let opened = false;
  let openThrew = false;
  let closed = false;
  let closeAttempted = false;
  let nameVerified = true;
  try {
    const openResult = output.openPort(selectedPort);
    if (openResult === false) {
      // An explicit refusal means no port was opened; skip the close attempt.
      openFailed = true;
    } else {
      opened = true;
      const nameAfterOpen = readPortName(output, selectedPort);
      if (nameAfterOpen !== expectedName) {
        openFailed = true;
        nameVerified = false;
      }
    }
  } catch {
    openFailed = true;
    openThrew = true;
  }

  // A thrown open can leave the port partially opened natively, so every
  // open attempt that was not explicitly refused gets exactly one
  // best-effort close before destroy.
  if (opened || openThrew) {
    closeAttempted = true;
    try {
      if (output.closePort() === false) {
        closeFailed = true;
      } else {
        closed = true;
      }
    } catch {
      closeFailed = true;
    }
  }
  const destroyed = releaseOutput(output);
  const released = Boolean(closed || destroyed);

  if (openFailed) {
    return {
      ok: false,
      probed: true,
      opened,
      closed,
      closeAttempted,
      destroyed,
      released,
      nameVerified,
      reason: "probe-open-failed",
      port: selectedPort,
    };
  }
  if (closeFailed) {
    return {
      ok: false,
      probed: true,
      opened: true,
      closed: false,
      closeAttempted: true,
      destroyed,
      released,
      nameVerified,
      reason: "probe-close-failed",
      port: selectedPort,
    };
  }
  return {
    ok: true,
    probed: true,
    opened: true,
    closed: true,
    closeAttempted: true,
    destroyed,
    released: true,
    nameVerified,
    port: selectedPort,
  };
}

module.exports = {
  DEFAULT_MODULE_NAME: DEFAULT_MIDI_MODULE_NAME,
  enumerateMidiOutputs,
  listMidiOutputs: enumerateMidiOutputs,
  normalizeMidiModuleName,
  normalizePortIndex,
  normalizePortName,
  probeMidiOutput: probeMidiOutputSelection,
  probeMidiOutputSelection,
  resolveMidiModule,
};
