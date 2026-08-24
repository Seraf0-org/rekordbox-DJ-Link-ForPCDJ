"use strict";

// Installed-release verification shared by:
//   - server.exe --verify-install (packaged; full provenance chain), and
//   - scripts/verify-install.js (system Node; manifest-level checks).
//
// Layers verified here:
//   A. install-manifest.json: canonical bytes, payload size+sha256 for every
//      listed file (including server.exe and build-identity.json),
//   B. sidecar identity: canonical build-identity.json validates with its
//      executableBinding and its core hash matches manifest.identityHash,
//   C. coherence: the measured server.exe hash equals BOTH its manifest entry
//      and the sidecar's bound exeSha256,
//   D. packaged runs only: the commitment compiled into THIS executable covers
//      exactly this release identity, and the RUNNING exe hashes to the bound
//      value. Old-release replay and foreign coherent sets fail closed here.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  computeCoreIdentityHash,
  evaluatePackagedProvenance,
} = require("./buildIdentity");
const {
  verifyInstallTree,
  resolveNoFollowPayloadPath,
} = require("../scripts/lib/manifests");

function sha256HexOf(readFile, filePath) {
  return crypto.createHash("sha256").update(readFile(filePath)).digest("hex");
}

function verifyInstalledInstall({
  exeDir,
  isPackaged = typeof process.pkg !== "undefined",
  execPath = isPackaged ? process.execPath : null,
  readFile = fs.readFileSync,
  embeddedCommitment,
  manifestFileName = "install-manifest.json",
} = {}) {
  const failures = [];
  const warnings = [];

  const tree = verifyInstallTree(exeDir, { manifestFileName });
  failures.push(...tree.failures);
  warnings.push(...tree.warnings);

  // Independent coherence: the sidecar's executableBinding must match the
  // installed server.exe bytes. Evaluated even when manifest-level checks
  // already failed so every binding mismatch is reported at once.
  let sidecar = null;
  try {
    const sidecarPath = resolveNoFollowPayloadPath(
      exeDir,
      "build-identity.json",
      { expect: "file" },
    ).absolutePath;
    const raw = JSON.parse(readFile(sidecarPath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) sidecar = raw;
    else failures.push("build-identity.json must be a JSON object");
  } catch (error) {
    failures.push(`build-identity.json unreadable or invalid JSON: ${error.message}`);
  }

  let serverExeHash = null;
  try {
    const serverExePath = resolveNoFollowPayloadPath(
      exeDir,
      "server.exe",
      { expect: "file" },
    ).absolutePath;
    serverExeHash = sha256HexOf(readFile, serverExePath);
  } catch (error) {
    failures.push(`server.exe could not be hashed: ${error.message}`);
  }

  if (sidecar && typeof sidecar.executableBinding === "object" && sidecar.executableBinding !== null) {
    if (serverExeHash !== null && sidecar.executableBinding.exeSha256 !== serverExeHash) {
      failures.push(
        `sidecar executableBinding.exeSha256 ${sidecar.executableBinding.exeSha256} does not match installed server.exe hash ${serverExeHash}`,
      );
    }
  } else if (sidecar) {
    failures.push("sidecar has no executableBinding.exeSha256");
  }

  // All layers are always evaluated so one run reports every mismatch.
  const manifest = tree.manifest;

  if (manifest) {
    if (
      manifest.productVersion !== undefined &&
      sidecar &&
      manifest.productVersion !== sidecar.productVersion
    ) {
      failures.push(
        `install-manifest productVersion ${manifest.productVersion} does not match sidecar ${sidecar.productVersion}`,
      );
    }
  }

  if (isPackaged) {
    const provenance = evaluatePackagedProvenance({
      exeDir,
      execPath,
      readFile,
      embeddedCommitment,
    });
    if (!provenance.ok) {
      failures.push(...provenance.failures);
    } else {
      if (
        manifest &&
        manifest.identityHash !== undefined &&
        manifest.identityHash !== provenance.coreHash
      ) {
        failures.push(
          `install-manifest identityHash ${manifest.identityHash} does not match running-provenance core hash ${provenance.coreHash}`,
        );
      }
      // The RUNNING executable must be the exact server.exe file listed in the
      // install manifest, closing the gap between "installed file" and
      // "executing image".
      const runningEntry = manifest
        ? (manifest.payloads || []).find((entry) => entry && entry.path === "server.exe")
        : null;
      if (runningEntry && provenance.measuredExeHash !== runningEntry.sha256) {
        failures.push(
          `running exe hash ${provenance.measuredExeHash} does not match install-manifest server.exe entry ${runningEntry.sha256}`,
        );
      }
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    manifest,
    identityHash: sidecar ? computeCoreIdentityHash(sidecar) : null,
  };
}

module.exports = { verifyInstalledInstall };
