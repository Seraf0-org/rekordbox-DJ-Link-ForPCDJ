#!/usr/bin/env node
"use strict";

// Finalizes a release by writing the external release-manifest.json at the
// project root. It binds artifact (ZIP/installer) hashes plus the install
// manifest hash WITHOUT hashing itself, so there is no self-hash recursion.
// Repeatable --tool name=value pairs record build-tool provenance (for
// example the pinned Inno Setup compiler version and ISCC.exe SHA256) in the
// tools object. Fail-closed: every --artifact must exist; --expect-artifact
// must be present; --tool names must be unique 1..100-char strings with
// non-empty values.

const fs = require("node:fs");
const path = require("node:path");
const {
  RELEASE_MANIFEST_KIND,
  MANIFEST_SCHEMA_VERSION,
  canonicalBytes,
  parseManifestFile,
  sha256Hex,
  assertSafePayloadRelPath,
  assertNoFollowDirectory,
  resolveNoFollowPayloadPath,
  resolveNoFollowOutputPath,
} = require("./lib/manifests");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argValues(flag) {
  const values = [];
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] === flag) {
      if (i + 1 >= process.argv.length) {
        throw new Error(`missing value for ${flag}`);
      }
      values.push(process.argv[i + 1]);
    }
  }
  return values;
}

const projectRoot = path.resolve(argValue("--project-root") || path.join(__dirname, ".."));
const requestedInstallManifest = argValue("--install-manifest") || path.join("dist", "install-manifest.json");
let artifacts;
let expectArtifacts;
let toolPairs;
try {
  artifacts = argValues("--artifact");
  expectArtifacts = argValues("--expect-artifact");
  toolPairs = argValues("--tool");
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

try {
  if (artifacts.length === 0) {
    throw new Error("at least one --artifact <relative-path> is required");
  }

  const tools = {};
  for (const pair of toolPairs) {
    const eq = typeof pair === "string" ? pair.indexOf("=") : -1;
    if (eq <= 0) throw new Error(`--tool expects name=value, got "${pair}"`);
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name.length === 0 || name.length > 100) {
      throw new Error(`--tool name must be a non-empty string of at most 100 chars, got "${name}"`);
    }
    if (value.length === 0 || value.length > 100) {
      throw new Error(`--tool value must be a non-empty string of at most 100 chars for ${name}`);
    }
    if (Object.prototype.hasOwnProperty.call(tools, name)) {
      throw new Error(`duplicate --tool name: ${name}`);
    }
    tools[name] = value;
  }

  const installManifestCandidate = path.isAbsolute(requestedInstallManifest)
    ? path.resolve(requestedInstallManifest)
    : path.resolve(projectRoot, requestedInstallManifest);
  const installManifestRel = assertSafePayloadRelPath(
    path.relative(projectRoot, installManifestCandidate).split(path.sep).join("/"),
  );
  const installManifestPath = resolveNoFollowPayloadPath(
    projectRoot,
    installManifestRel,
    { expect: "file" },
  ).absolutePath;
  const installManifest = parseManifestFile(installManifestPath);
  const installManifestBytes = fs.readFileSync(installManifestPath);

  const missing = [];
  const seenArtifacts = new Set();
  const entries = [];
  for (const rel of artifacts) {
    let normalized;
    try {
      normalized = assertSafePayloadRelPath(path.normalize(rel).split(path.sep).join("/"));
    } catch (error) {
      missing.push(error.message);
      continue;
    }
    if (seenArtifacts.has(normalized)) continue;
    seenArtifacts.add(normalized);
    try {
      const artifact = resolveNoFollowPayloadPath(projectRoot, normalized, { expect: "file" });
      entries.push({
        path: normalized,
        bytes: artifact.stat.size,
        sha256: sha256Hex(fs.readFileSync(artifact.absolutePath)),
      });
    } catch (error) {
      missing.push(`artifact rejected: ${normalized} (${error.message})`);
      continue;
    }
  }

  for (const expected of expectArtifacts) {
    let normalized;
    try {
      normalized = assertSafePayloadRelPath(path.normalize(expected).split(path.sep).join("/"));
    } catch (error) {
      missing.push(error.message);
      continue;
    }
    if (!seenArtifacts.has(normalized)) {
      missing.push(`expected artifact was not produced: ${normalized}`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`release finalization aborted:\n- ${missing.join("\n- ")}`);
  }

  const releaseManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: RELEASE_MANIFEST_KIND,
    productVersion: installManifest.productVersion,
    identityHash: installManifest.identityHash,
    installManifestSha256: sha256Hex(installManifestBytes),
    installManifestBytes: installManifestBytes.length,
    tools,
    artifacts: entries.sort((a, b) => a.path.localeCompare(b.path)),
    createdAtUtc: new Date().toISOString(),
    notes:
      "Deterministic manifest binding; this file intentionally excludes its own hash and makes no reproducible-build or cryptographic-signature claim.",
  };

  // Written under dist/ (gitignored) so a completed release never leaves an
  // untracked root artifact that would fail the next run's clean-tree preflight.
  const outPath = resolveNoFollowOutputPath(
    projectRoot,
    "dist/release-manifest.json",
  ).absolutePath;
  assertNoFollowDirectory(path.dirname(outPath), "release dist directory");
  fs.writeFileSync(outPath, canonicalBytes(releaseManifest));
  console.log(`release manifest written: ${outPath}`);
  console.log(JSON.stringify(releaseManifest.artifacts, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
