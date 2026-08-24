#!/usr/bin/env node
"use strict";

// Writes dist/install-manifest.json binding the canonical identity hash to
// every shipped payload. Must run AFTER all payloads are final and BEFORE the
// ZIP/installer is created so the manifest ships inside them.

const fs = require("node:fs");
const path = require("node:path");
const {
  buildInstallManifest,
  parseManifestFile,
  assertSafePayloadRelPath,
  resolveNoFollowPayloadPath,
  resolveNoFollowOutputPath,
} = require("./lib/manifests");
const { packagedIdentityFrom } = require("../server/buildIdentity");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argValues(flag) {
  const values = [];
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] === flag) values.push(process.argv[i + 1]);
  }
  return values;
}

const projectRoot = path.resolve(argValue("--project-root") || path.join(__dirname, ".."));
const distDir = path.resolve(projectRoot, argValue("--dist") || "dist");
const identityPath = path.resolve(argValue("--identity") || path.join(distDir, "build-identity.json"));
const payloads = argValues("--payload");

try {
  if (payloads.length === 0) {
    throw new Error("at least one --payload <relative-path> is required (fail-closed: nothing is guessed)");
  }
  const distRel = assertSafePayloadRelPath(
    path.relative(projectRoot, distDir).split(path.sep).join("/"),
  );
  const verifiedDistDir = resolveNoFollowPayloadPath(
    projectRoot,
    distRel,
    { expect: "directory" },
  ).absolutePath;
  const identityRel = assertSafePayloadRelPath(
    path.relative(projectRoot, identityPath).split(path.sep).join("/"),
  );
  const verifiedIdentityPath = resolveNoFollowPayloadPath(
    projectRoot,
    identityRel,
    { expect: "file" },
  ).absolutePath;
  const identity = packagedIdentityFrom(verifiedIdentityPath);
  const manifest = buildInstallManifest({
    installRoot: verifiedDistDir,
    payloads,
    identity,
  });
  const outPath = resolveNoFollowOutputPath(
    projectRoot,
    `${distRel}/install-manifest.json`,
  ).absolutePath;
  fs.writeFileSync(outPath, require("./lib/manifests").canonicalBytes(manifest));
  console.log(`install manifest written: ${outPath}`);
  // Round-trip check: what we just wrote must re-parse canonically.
  parseManifestFile(outPath, { expectedKind: manifest.kind });
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
