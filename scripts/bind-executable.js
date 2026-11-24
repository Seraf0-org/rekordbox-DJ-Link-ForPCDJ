#!/usr/bin/env node
"use strict";

// Binds the packaged executable into the release identity sidecar. Runs AFTER
// server.exe exists and BEFORE install-manifest staging:
//   1. re-reads dist/build-identity.json (core identity written pre-package),
//      requiring canonical bytes so nothing drifted between steps,
//   2. measures sha256 of the packaged server.exe,
//   3. rewrites dist/build-identity.json as the shipped sidecar: core fields
//      plus executableBinding { kind: server-exe-sha256, exeSha256 }.
// The embedded commitment inside the exe covers only the core identity; this
// step adds the non-circular exe binding that runtime verification re-measures.

const fs = require("node:fs");
const path = require("node:path");
const {
  EXECUTABLE_BINDING_KIND,
  canonicalBytes,
  validateEmbeddedIdentity,
  validatePackagedIdentity,
} = require("../server/buildIdentity");
const {
  sha256Hex,
  assertSafePayloadRelPath,
  resolveNoFollowPayloadPath,
  resolveNoFollowOutputPath,
} = require("./lib/manifests");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const projectRoot = path.resolve(argValue("--project-root") || path.join(__dirname, ".."));
const distDir = path.resolve(projectRoot, argValue("--dist") || "dist");
const exePath = path.resolve(projectRoot, argValue("--exe") || path.join(distDir, "server.exe"));
const identityPath = path.resolve(
  argValue("--identity") || path.join(distDir, "build-identity.json"),
);

try {
  const identityRel = assertSafePayloadRelPath(
    path.relative(projectRoot, identityPath).split(path.sep).join("/"),
  );
  const exeRel = assertSafePayloadRelPath(
    path.relative(projectRoot, exePath).split(path.sep).join("/"),
  );
  const verifiedIdentityPath = resolveNoFollowPayloadPath(
    projectRoot,
    identityRel,
    { expect: "file" },
  ).absolutePath;
  const verifiedExePath = resolveNoFollowPayloadPath(
    projectRoot,
    exeRel,
    { expect: "file" },
  ).absolutePath;
  const rawBytes = fs.readFileSync(verifiedIdentityPath);
  let core;
  try {
    core = JSON.parse(rawBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`build identity at ${verifiedIdentityPath} is not valid JSON: ${error.message}`);
  }
  const coreVerdict = validateEmbeddedIdentity(core);
  if (!coreVerdict.ok) {
    throw new Error(
      `core build identity at ${verifiedIdentityPath} is malformed:\n- ${coreVerdict.errors.join("\n- ")}`,
    );
  }
  if (rawBytes.compare(canonicalBytes(core)) !== 0) {
    throw new Error(`core build identity at ${verifiedIdentityPath} is not in canonical form; aborting`);
  }

  let exeBytes;
  try {
    exeBytes = fs.readFileSync(verifiedExePath);
  } catch (error) {
    throw new Error(`packaged executable missing or unreadable at ${verifiedExePath}: ${error.message}`);
  }
  const sidecar = {
    ...core,
    executableBinding: {
      kind: EXECUTABLE_BINDING_KIND,
      exeSha256: sha256Hex(exeBytes),
    },
  };
  const sidecarVerdict = validatePackagedIdentity(sidecar);
  if (!sidecarVerdict.ok) {
    throw new Error(
      `generated sidecar failed self-validation:\n- ${sidecarVerdict.errors.join("\n- ")}`,
    );
  }

  // Atomic replace so a crash mid-write can never leave a half-bound sidecar.
  const tmpRel = `${identityRel}.tmp`;
  const tmpPath = resolveNoFollowOutputPath(projectRoot, tmpRel).absolutePath;
  if (fs.existsSync(tmpPath)) {
    throw new Error(`refusing to replace a pre-existing temporary sidecar: ${tmpPath}`);
  }
  fs.writeFileSync(tmpPath, canonicalBytes(sidecar));
  fs.renameSync(tmpPath, verifiedIdentityPath);

  console.log(`executable bound: ${verifiedExePath}`);
  console.log(`exeSha256: ${sidecar.executableBinding.exeSha256}`);
  console.log(`sidecar written: ${verifiedIdentityPath}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
