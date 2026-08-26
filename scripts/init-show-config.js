"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const TEMPLATE_PATH = path.join(PROJECT_ROOT, "config", "dj-agent-v1.1.5.example.json");
const TARGET_PATH = String.raw`C:\SyndocalShow\dj-agent-v1.1.5.json`;
const TOKEN_PLACEHOLDER = "<SYNDOCAL_ONE_TIME_TOKEN>";

class ShowConfigInitializationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ShowConfigInitializationError";
    this.code = code;
  }
}

function requireRegularNonLink(filePath, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    throw new ShowConfigInitializationError(
      `${label.toUpperCase()}_UNAVAILABLE`,
      `${label} is unavailable: ${error.code || "unknown filesystem error"}`,
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ShowConfigInitializationError(
      `${label.toUpperCase()}_NOT_REGULAR`,
      `${label} must be a regular non-link file`,
    );
  }
}

function parseAndValidateTemplate(raw) {
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new ShowConfigInitializationError("TEMPLATE_INVALID_JSON", "bundled show config template is not valid JSON");
  }

  const valid = config?.enabled === true
    && config?.syndocal?.enabled === true
    && config.syndocal.host === "192.168.50.1"
    && config.syndocal.port === 9100
    && config.syndocal.path === "/dj-link"
    && config.syndocal.nic === "192.168.50.2"
    && config.syndocal.token === TOKEN_PLACEHOLDER
    && config.syndocal.adapter === "syndocal-envelope-v3"
    && config.syndocal.heartbeatMs === 5000
    && config?.pedal?.enabled === true
    && config?.midi?.enabled === true
    && config.midi.device === "CustomMIDI1"
    && Number.isInteger(config.midi.port)
    && config?.midi?.releaseMacro?.enabled === false;

  if (!valid) {
    throw new ShowConfigInitializationError(
      "TEMPLATE_CONTRACT_MISMATCH",
      "bundled show config template does not match the strict v1.1.5 contract",
    );
  }
  return config;
}

function initializeShowConfig(options = {}) {
  const templatePath = path.resolve(options.templatePath || TEMPLATE_PATH);
  const targetPath = path.resolve(options.targetPath || TARGET_PATH);
  requireRegularNonLink(templatePath, "template");

  const raw = fs.readFileSync(templatePath, "utf8");
  parseAndValidateTemplate(raw);

  try {
    fs.lstatSync(targetPath);
    throw new ShowConfigInitializationError(
      "TARGET_EXISTS",
      `refusing to overwrite existing show config; validate or move it explicitly before retrying: ${targetPath}`,
    );
  } catch (error) {
    if (error instanceof ShowConfigInitializationError || error?.code !== "ENOENT") {
      throw error;
    }
  }

  const targetDirectory = path.dirname(targetPath);
  let directoryStat;
  try {
    fs.mkdirSync(targetDirectory, { recursive: true });
    directoryStat = fs.lstatSync(targetDirectory);
  } catch (error) {
    throw new ShowConfigInitializationError(
      "TARGET_DIRECTORY_UNAVAILABLE",
      `show config parent is unavailable: ${error?.code || "unknown filesystem error"}`,
    );
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new ShowConfigInitializationError(
      "TARGET_DIRECTORY_NOT_REGULAR",
      `show config parent must be a regular non-link directory: ${targetDirectory}`,
    );
  }

  let descriptor;
  try {
    descriptor = fs.openSync(targetPath, "wx", 0o600);
    fs.writeFileSync(descriptor, raw, "utf8");
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new ShowConfigInitializationError(
        "TARGET_EXISTS",
        `refusing to overwrite existing show config; validate or move it explicitly before retrying: ${targetPath}`,
      );
    }
    throw new ShowConfigInitializationError(
      "TARGET_WRITE_FAILED",
      `show config could not be created: ${error?.code || "unknown filesystem error"}`,
    );
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }

  return { targetPath };
}

function main() {
  if (process.argv.length !== 2) {
    console.error("[ERROR] init-show-config accepts no arguments.");
    process.exitCode = 64;
    return;
  }
  if (process.platform !== "win32") {
    console.error("[ERROR] init-show-config is supported only on the controlled Windows DJ PC.");
    process.exitCode = 1;
    return;
  }

  try {
    const { targetPath } = initializeShowConfig();
    console.log(`[rb-output] created token-free show config: ${targetPath}`);
    console.log("[rb-output] Replace only <SYNDOCAL_ONE_TIME_TOKEN>, verify the exact MIDI port, then run start-all.bat from the same PowerShell.");
  } catch (error) {
    if (error instanceof ShowConfigInitializationError) {
      console.error(`[ERROR] ${error.message}`);
      process.exitCode = error.code === "TARGET_EXISTS" ? 17 : 1;
      return;
    }
    console.error("[ERROR] show config initialization failed closed.");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  TARGET_PATH,
  TEMPLATE_PATH,
  TOKEN_PLACEHOLDER,
  ShowConfigInitializationError,
  initializeShowConfig,
  parseAndValidateTemplate,
};
