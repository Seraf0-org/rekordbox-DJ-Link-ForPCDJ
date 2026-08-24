#!/usr/bin/env node
"use strict";

// Standalone install verifier for Syndocal QA/operators (runs on any system
// Node; no assumption about the installed machine). Checks, against the
// installed install-manifest.json:
//   1. manifest bytes are canonical JSON with the expected kind/schema,
//   2. build-identity.json parses as a valid sidecar, is byte-canonical, and
//      its CORE hash matches both its payload entry and manifest.identityHash,
//   3. every listed payload exists unmodified (size + sha256),
//   4. coherence of server.exe across all bindings: measured sha256 must equal
//      BOTH its manifest payload entry and the sidecar executableBinding.
// Missing or modified required files exit non-zero; unlisted extra files are
// warnings only.
//
// Boundary: this external check cannot see the release commitment compiled
// INTO server.exe. For full packaged provenance run the shipped verifier:
//   server.exe --verify-install
// which additionally proves the running exe matches the embedded identity
// commitment before reporting verified-packaged.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { verifyInstallTree } = require("./lib/manifests");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const installDir = path.resolve(
  argValue("--install-dir") || process.cwd(),
);
const manifestFileName = argValue("--manifest") || "install-manifest.json";

const result = verifyInstallTree(installDir, { manifestFileName });

// Coherence layer C: server.exe must satisfy every binding simultaneously.
// Do not read a payload after the tree verifier rejected it: that preserves the
// no-follow boundary for symlinks/junctions and malformed manifest paths.
if (result.ok) {
  const serverExePath = path.join(installDir, "server.exe");
  const sidecarPath = path.join(installDir, "build-identity.json");
  try {
    const exeEntry = (result.manifest?.payloads || []).find((entry) => entry && entry.path === "server.exe");
    if (!exeEntry) throw new Error("server.exe is not listed in the install manifest");
    const measured = crypto.createHash("sha256").update(fs.readFileSync(serverExePath)).digest("hex");
    if (measured !== exeEntry.sha256) {
      throw new Error(`measured server.exe hash ${measured} does not match manifest entry ${exeEntry.sha256}`);
    }
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    const bound = sidecar?.executableBinding?.exeSha256;
    if (!bound) throw new Error("sidecar has no executableBinding.exeSha256");
    if (bound !== measured) {
      throw new Error(`sidecar executableBinding.exeSha256 ${bound} does not match measured server.exe hash ${measured}`);
    }
    console.log(`server.exe coherence verified: ${measured}`);
  } catch (error) {
    result.failures.push(`server.exe binding coherence failed: ${error.message}`);
  }
}

if (result.warnings.length > 0) {
  console.warn("warnings:");
  for (const warning of result.warnings) console.warn(`- ${warning}`);
}

if (!result.ok || result.failures.length > 0) {
  console.error(`verification FAILED for ${installDir}:`);
  for (const failure of result.failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`verification OK for ${installDir}`);
console.log(`identityHash: ${result.manifest.identityHash}`);
console.log(`payloads verified: ${result.manifest.payloads.length}`);
