"use strict";

const {
  hasRekordboxLocalTestForbiddenEnv,
  loadRekordboxLocalTestConfig,
  REKORDBOX_LOCAL_TEST_CONFIG_PATH,
  REKORDBOX_LOCAL_TEST_SAFETY_LABEL,
} = require("../server/dj-agent/config");
const { enumerateMidiOutputs } = require("../server/dj-agent/midiPorts");
const { exactMidiPort } = require("../server/dj-agent/setupSelection");

const MIDI_DEVICE_NAME = "CustomMIDI1";

function verifyCurrentMidiSelection(config, enumerateOutputs = enumerateMidiOutputs) {
  if (typeof enumerateOutputs !== "function") {
    return { ok: false, reason: "MIDI output enumeration is unavailable" };
  }
  let result;
  try {
    result = enumerateOutputs({ moduleName: config?.midi?.moduleName || "@julusian/midi" });
  } catch (error) {
    return { ok: false, reason: `MIDI output enumeration failed (${error?.message || "exception"})` };
  }
  if (result?.ok !== true || result.available !== true || !Array.isArray(result.ports)) {
    return { ok: false, reason: `MIDI output enumeration failed (${result?.reason || "unavailable"})` };
  }
  const named = result.ports.filter((entry) => entry?.name === MIDI_DEVICE_NAME);
  if (named.length !== 1) {
    return { ok: false, reason: `exact ${MIDI_DEVICE_NAME} output must enumerate exactly once; found ${named.length}` };
  }
  const configured = exactMidiPort(result.ports, config?.midi?.port, config?.midi?.device);
  if (!configured || configured.name !== MIDI_DEVICE_NAME || configured.port !== named[0].port) {
    return { ok: false, reason: `configured ${MIDI_DEVICE_NAME} port ${config?.midi?.port} does not match the current unique enumeration` };
  }
  return { ok: true, port: configured.port };
}

function validateRekordboxLocalTestConfigPath({ env = process.env, enumerateOutputs = enumerateMidiOutputs } = {}) {
  if (hasRekordboxLocalTestForbiddenEnv(env)) {
    return { ok: false, reason: "forbidden environment override" };
  }
  const config = loadRekordboxLocalTestConfig({ env });
  if (!config.enabled) {
    return { ok: false, reason: "exact Rekordbox local test schema is not ready" };
  }
  const midiSelection = verifyCurrentMidiSelection(config, enumerateOutputs);
  if (!midiSelection.ok) {
    return { ok: false, reason: midiSelection.reason };
  }
  return {
    ok: true,
    config,
    path: REKORDBOX_LOCAL_TEST_CONFIG_PATH,
  };
}

function main() {
  if (process.argv.length !== 2) {
    console.error("[ERROR] validate-rekordbox-local-test-config accepts no arguments.");
    process.exitCode = 64;
    return;
  }
  if (process.platform !== "win32") {
    console.error("[ERROR] Rekordbox local test config validation is supported only on the controlled Windows DJ PC.");
    process.exitCode = 1;
    return;
  }

  const result = validateRekordboxLocalTestConfigPath();
  if (!result.ok) {
    console.error(`[ERROR] ${REKORDBOX_LOCAL_TEST_SAFETY_LABEL} config preflight failed: ${result.reason}.`);
    console.error("[ERROR] No production config, build, server, Rekordbox, hook, MIDI, or pedal action was started.");
    process.exitCode = 1;
    return;
  }
  console.log(`[rb-output] ${REKORDBOX_LOCAL_TEST_SAFETY_LABEL}`);
  console.log(`[rb-output] local-only Rekordbox UI is fixed at http://127.0.0.1:8787; config path is ${result.path}.`);
  console.log("[rb-output] exact pedal/MIDI/owner-selection policy passed; Syndocal, token, and NIC are not applicable.");
}

if (require.main === module) {
  main();
}

module.exports = {
  verifyCurrentMidiSelection,
  validateRekordboxLocalTestConfigPath,
};
