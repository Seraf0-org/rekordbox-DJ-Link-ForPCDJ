const path = require("node:path");

function readPackageVersion(pkgPath = path.join(__dirname, "..", "package.json")) {
  try {
    return String(require(pkgPath).version || "unknown");
  } catch {
    return "unknown";
  }
}

function hexIdentity(value, { min = 7, max = 64 } = {}) {
  const normalized = String(value || "").trim().toLowerCase();
  return new RegExp(`^[0-9a-f]{${min},${max}}$`).test(normalized) ? normalized : null;
}

function createBuildIdentity({
  env = process.env,
  version = readPackageVersion(),
  now = () => new Date().toISOString(),
} = {}) {
  // Read-only runtime build identity so a future process owner can
  // version-identify this PID. Only non-secret values supplied at build/start
  // time are surfaced; configuration paths and credential presence are never
  // included.
  return {
    name: "rb-output",
    version: String(version || "unknown"),
    gitCommit: hexIdentity(env.RB_OUTPUT_GIT_COMMIT),
    sourceFingerprint: hexIdentity(env.RB_OUTPUT_SOURCE_FINGERPRINT),
    generatedAt: now(),
  };
}

module.exports = {
  createBuildIdentity,
  hexIdentity,
  readPackageVersion,
};
