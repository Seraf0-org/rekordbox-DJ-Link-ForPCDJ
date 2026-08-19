const fs = require("node:fs");
const path = require("node:path");

function parseVersionFromDirectory(name) {
  const match = /^rekordbox\s+(\d+)\.(\d+)\.(\d+)$/i.exec(String(name || "").trim());
  if (!match) {
    return null;
  }
  return match.slice(1).map(Number);
}

function compareVersionsDescending(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (right[index] || 0) - (left[index] || 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function findLatestRekordboxExe(programFiles = process.env.ProgramFiles || "C:\\Program Files") {
  const installRoot = path.join(programFiles, "rekordbox");
  let entries;
  try {
    entries = fs.readdirSync(installRoot, { withFileTypes: true });
  } catch {
    return "";
  }

  const installs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ entry, version: parseVersionFromDirectory(entry.name) }))
    .filter((item) => item.version !== null)
    .sort((left, right) => compareVersionsDescending(left.version, right.version));

  for (const install of installs) {
    const executable = path.join(installRoot, install.entry.name, "rekordbox.exe");
    if (fs.existsSync(executable)) {
      return executable;
    }
  }
  return "";
}

function resolveRekordboxExePath(explicitPath = process.env.REKORDBOX_EXE_PATH || "") {
  const requested = String(explicitPath || "").trim();
  if (requested) {
    return requested;
  }
  return findLatestRekordboxExe();
}

module.exports = {
  compareVersionsDescending,
  findLatestRekordboxExe,
  parseVersionFromDirectory,
  resolveRekordboxExePath,
};
