"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  hasRekordboxLocalTestForbiddenEnv,
  REKORDBOX_LOCAL_TEST_CONFIG_PATH,
  REKORDBOX_LOCAL_TEST_SAFETY_LABEL,
  validateRekordboxLocalTestConfig,
} = require("../server/dj-agent/config");
const { enumerateMidiOutputs } = require("../server/dj-agent/midiPorts");
const { installAndVerifyRekordboxLocalTestAcl } = require("../server/dj-agent/rekordboxLocalTestAcl");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const TEMPLATE_PATH = path.join(PROJECT_ROOT, "config", "rb-output-rekordbox-local-test-v1.example.json");
const TARGET_PATH = REKORDBOX_LOCAL_TEST_CONFIG_PATH;
const MIDI_DEVICE_NAME = "CustomMIDI1";
const MIDI_MODULE_NAME = "@julusian/midi";

class RekordboxLocalTestConfigInitializationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RekordboxLocalTestConfigInitializationError";
    this.code = code;
  }
}

function requireRegularNonLink(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new RekordboxLocalTestConfigInitializationError(
      `${label.toUpperCase()}_UNAVAILABLE`,
      `${label} is unavailable: ${error.code || "unknown filesystem error"}`,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new RekordboxLocalTestConfigInitializationError(
      `${label.toUpperCase()}_NOT_REGULAR`,
      `${label} must be a regular non-link file`,
    );
  }
}

function captureCreatedTargetOwnership(filePath, expectedContent) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return null;
  }
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    bytes: Buffer.from(expectedContent, "utf8"),
  };
}

function removeCreatedTargetIfUnchanged(filePath, ownership) {
  if (!ownership) {
    return false;
  }
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() ||
      stat.dev !== ownership.dev || stat.ino !== ownership.ino || stat.size !== ownership.size) {
      return false;
    }
    const currentBytes = fs.readFileSync(filePath);
    if (Buffer.compare(currentBytes, ownership.bytes) !== 0) {
      return false;
    }
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function pathIsInsideCheckout(filePath) {
  const root = path.resolve(PROJECT_ROOT).toLowerCase() + path.sep;
  return path.resolve(filePath).toLowerCase().startsWith(root);
}

function parseTemplate(raw) {
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new RekordboxLocalTestConfigInitializationError(
      "TEMPLATE_INVALID_JSON",
      "bundled Rekordbox local test config template is not valid JSON",
    );
  }
  if (config?.midi?.port !== 0) {
    throw new RekordboxLocalTestConfigInitializationError(
      "TEMPLATE_CONTRACT_MISMATCH",
      "bundled Rekordbox local test template must use port 0 as its discovery marker",
    );
  }
  return config;
}

function parseAndValidateTemplate(raw, { midiPort } = {}) {
  const config = parseTemplate(raw);
  const finalPort = Number.isInteger(midiPort) ? midiPort : config.midi.port;
  const candidate = {
    ...config,
    midi: { ...config.midi, port: finalPort },
  };
  if (!validateRekordboxLocalTestConfig(candidate)) {
    throw new RekordboxLocalTestConfigInitializationError(
      "TEMPLATE_CONTRACT_MISMATCH",
      "bundled Rekordbox local test template does not match the exact local-only schema",
    );
  }
  return candidate;
}

function selectCustomMidiPort(result) {
  if (!result || result.ok !== true || result.available !== true || !Array.isArray(result.ports)) {
    throw new RekordboxLocalTestConfigInitializationError(
      "MIDI_ENUMERATION_FAILED",
      `exact ${MIDI_DEVICE_NAME} output enumeration failed closed (${result?.reason || "unavailable"})`,
    );
  }
  const matches = result.ports.filter((entry) => entry?.name === MIDI_DEVICE_NAME &&
    Number.isInteger(entry?.port) && entry.port >= 0 && entry.port <= 4096);
  if (matches.length !== 1) {
    throw new RekordboxLocalTestConfigInitializationError(
      matches.length === 0 ? "MIDI_DEVICE_NOT_FOUND" : "MIDI_DEVICE_NOT_UNIQUE",
      `exact ${MIDI_DEVICE_NAME} output must enumerate exactly once; found ${matches.length}`,
    );
  }
  return matches[0].port;
}

function discoverCustomMidiPort(enumerateOutputs = enumerateMidiOutputs) {
  if (typeof enumerateOutputs !== "function") {
    throw new RekordboxLocalTestConfigInitializationError(
      "MIDI_ENUMERATOR_UNAVAILABLE",
      `exact ${MIDI_DEVICE_NAME} output enumerator is unavailable`,
    );
  }
  let result;
  try {
    result = enumerateOutputs({ moduleName: MIDI_MODULE_NAME });
  } catch (error) {
    throw new RekordboxLocalTestConfigInitializationError(
      "MIDI_ENUMERATION_FAILED",
      `exact ${MIDI_DEVICE_NAME} output enumeration failed closed (${error?.message || "exception"})`,
    );
  }
  return selectCustomMidiPort(result);
}

function assertCleanTestEnvironment(env = process.env) {
  if (hasRekordboxLocalTestForbiddenEnv(env)) {
    throw new RekordboxLocalTestConfigInitializationError(
      "FORBIDDEN_ENVIRONMENT",
      "Rekordbox local test config initialization refuses forbidden environment overrides",
    );
  }
}

function initializeRekordboxLocalTestConfig(options = {}) {
  assertCleanTestEnvironment(options.env || process.env);
  const templatePath = path.resolve(options.templatePath || TEMPLATE_PATH);
  const targetPath = path.resolve(options.targetPath || TARGET_PATH);
  if (!path.isAbsolute(targetPath) || pathIsInsideCheckout(targetPath)) {
    throw new RekordboxLocalTestConfigInitializationError(
      "TARGET_CHECKOUT_LOCAL",
      "Rekordbox local test config target must remain outside the checkout",
    );
  }
  requireRegularNonLink(templatePath, "template");

  const raw = fs.readFileSync(templatePath, "utf8");
  const midiPort = discoverCustomMidiPort(options.enumerateOutputs);
  const config = parseAndValidateTemplate(raw, { midiPort });
  const output = `${JSON.stringify(config, null, 2)}\n`;

  try {
    fs.lstatSync(targetPath);
    throw new RekordboxLocalTestConfigInitializationError(
      "TARGET_EXISTS",
      `refusing to overwrite existing Rekordbox local test config; validate or move it explicitly before retrying: ${targetPath}`,
    );
  } catch (error) {
    if (error instanceof RekordboxLocalTestConfigInitializationError || error?.code !== "ENOENT") {
      throw error;
    }
  }

  const targetDirectory = path.dirname(targetPath);
  let directoryStat;
  try {
    fs.mkdirSync(targetDirectory, { recursive: true });
    directoryStat = fs.lstatSync(targetDirectory);
  } catch (error) {
    throw new RekordboxLocalTestConfigInitializationError(
      "TARGET_DIRECTORY_UNAVAILABLE",
      `Rekordbox local test config parent is unavailable: ${error?.code || "unknown filesystem error"}`,
    );
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new RekordboxLocalTestConfigInitializationError(
      "TARGET_DIRECTORY_NOT_REGULAR",
      `Rekordbox local test config parent must be a regular non-link directory: ${targetDirectory}`,
    );
  }

  let descriptor;
  try {
    descriptor = fs.openSync(targetPath, "wx", 0o600);
    fs.writeFileSync(descriptor, output, "utf8");
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new RekordboxLocalTestConfigInitializationError(
        "TARGET_EXISTS",
        `refusing to overwrite existing Rekordbox local test config; validate or move it explicitly before retrying: ${targetPath}`,
      );
    }
    throw new RekordboxLocalTestConfigInitializationError(
      "TARGET_WRITE_FAILED",
      `Rekordbox local test config could not be created: ${error?.code || "unknown filesystem error"}`,
    );
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }

  const createdTargetOwnership = captureCreatedTargetOwnership(targetPath, output);
  try {
    const installAcl = options.installAcl || installAndVerifyRekordboxLocalTestAcl;
    const aclResult = installAcl(targetPath);
    if (aclResult === false || aclResult?.ok === false) throw new Error("ACL verification returned false");
  } catch {
    removeCreatedTargetIfUnchanged(targetPath, createdTargetOwnership);
    throw new RekordboxLocalTestConfigInitializationError(
      "TARGET_ACL_FAILED",
      "Rekordbox local test config restrictive Windows ACL could not be installed and verified; no runtime was activated",
    );
  }

  return { targetPath, midiPort, config };
}

function main() {
  if (process.argv.length !== 2) {
    console.error("[ERROR] init-rekordbox-local-test-config accepts no arguments.");
    process.exitCode = 64;
    return;
  }
  if (process.platform !== "win32") {
    console.error("[ERROR] Rekordbox local test config initialization is supported only on the controlled Windows DJ PC.");
    process.exitCode = 1;
    return;
  }

  try {
    const { targetPath, midiPort } = initializeRekordboxLocalTestConfig();
    console.log(`[rb-output] created ${REKORDBOX_LOCAL_TEST_SAFETY_LABEL} config: ${targetPath}`);
    console.log(`[rb-output] exact ${MIDI_DEVICE_NAME} output discovered at port ${midiPort}; no token, Syndocal, or NIC is used.`);
    console.log("[rb-output] Run start-all.bat --preflight-rekordbox-local-test before the full-runtime test start.");
    console.log("[rb-output] Production start-all.bat with no arguments is unchanged.");
  } catch (error) {
    if (error instanceof RekordboxLocalTestConfigInitializationError) {
      console.error(`[ERROR] ${error.message}`);
      process.exitCode = error.code === "TARGET_EXISTS" ? 17 : 1;
      return;
    }
    console.error("[ERROR] Rekordbox local test config initialization failed closed.");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  MIDI_DEVICE_NAME,
  MIDI_MODULE_NAME,
  PROJECT_ROOT,
  TARGET_PATH,
  TEMPLATE_PATH,
  RekordboxLocalTestConfigInitializationError,
  captureCreatedTargetOwnership,
  discoverCustomMidiPort,
  initializeRekordboxLocalTestConfig,
  parseAndValidateTemplate,
  removeCreatedTargetIfUnchanged,
  selectCustomMidiPort,
};
