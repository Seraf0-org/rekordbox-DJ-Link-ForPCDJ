"use strict";

// Hermetic executable tests for the final GitHub-release artifact seal.  The
// fixtures intentionally exercise actual archive parsing and hashing; static
// workflow text checks alone cannot prove a changed release input is refused.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  canonicalBytes,
  sha256Hex,
} = require("../scripts/lib/manifests");
const {
  REQUIRED_TOOL_VERSIONS,
  WIRE_CONTRACT_ADVISORY,
  canonicalBytes: canonicalIdentityBytes,
  computeCoreIdentityHash,
} = require("../server/buildIdentity");

const REPO_ROOT = path.join(__dirname, "..");
const VERIFIER = path.join(REPO_ROOT, "scripts", "verify-release-artifacts.js");
const VERSION = "1.1.11";
const TAG = `v${VERSION}`;

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rb-release-seal-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value, 0);
  return out;
}

function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value >>> 0, 0);
  return out;
}

// Small STORE-only ZIP writer for portable test fixtures.  The production
// verifier also accepts the DEFLATE method emitted by Compress-Archive.
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const fileName = Buffer.from(name, "utf8");
    const bytes = Buffer.from(data);
    const crc = crc32(bytes);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(bytes.length), u32(bytes.length), u16(fileName.length), u16(0), fileName, bytes,
    ]);
    locals.push(local);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(bytes.length), u32(bytes.length), u16(fileName.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), fileName,
    ]));
    offset += local.length;
  }
  const centralBytes = Buffer.concat(central);
  return Buffer.concat([
    ...locals,
    centralBytes,
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBytes.length), u32(offset), u16(0),
  ]);
}

function writeCanonical(filePath, value) {
  fs.writeFileSync(filePath, canonicalBytes(value));
}

function createFixture(t) {
  const root = tempRoot(t);
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist, { recursive: true });
  const serverBytes = Buffer.from("sealed server payload\n", "utf8");
  const hookBytes = Buffer.from("sealed hook payload\n", "utf8");
  fs.writeFileSync(path.join(dist, "server.exe"), serverBytes);
  fs.mkdirSync(path.join(dist, "native", "bin"), { recursive: true });
  fs.writeFileSync(path.join(dist, "native", "bin", "rb_hook.dll"), hookBytes);
  const identity = {
    schemaVersion: 1,
    name: "rb-output",
    productVersion: VERSION,
    releaseTag: TAG,
    gitCommit: "a".repeat(40),
    gitTree: "b".repeat(40),
    dirty: false,
    packageLockHash: "c".repeat(64),
    generatedAtUtc: "2026-08-25T00:00:00.000Z",
    wireContracts: WIRE_CONTRACT_ADVISORY,
    tools: {
      node: "v22.22.1",
      pkg: REQUIRED_TOOL_VERSIONS.pkg,
      pyinstaller: REQUIRED_TOOL_VERSIONS.pyinstaller,
    },
    executableBinding: {
      kind: "server-exe-sha256",
      exeSha256: sha256Hex(serverBytes),
    },
  };
  const identityBytes = canonicalIdentityBytes(identity);
  fs.writeFileSync(path.join(dist, "build-identity.json"), identityBytes);
  const installManifest = {
    schemaVersion: 1,
    kind: "rb-output-install-manifest/v1",
    productVersion: VERSION,
    identityHash: computeCoreIdentityHash(identity),
    payloads: [
      { path: "build-identity.json", bytes: identityBytes.length, sha256: sha256Hex(identityBytes) },
      { path: "native/bin/rb_hook.dll", bytes: hookBytes.length, sha256: sha256Hex(hookBytes) },
      { path: "server.exe", bytes: serverBytes.length, sha256: sha256Hex(serverBytes) },
    ],
  };
  const installBytes = canonicalBytes(installManifest);
  fs.writeFileSync(path.join(dist, "install-manifest.json"), installBytes);
  const zipBytes = makeZip([
    // Windows Compress-Archive uses these backslash forms in production.
    { name: "build-identity.json", data: identityBytes },
    { name: "native\\bin\\rb_hook.dll", data: hookBytes },
    { name: "server.exe", data: serverBytes },
    { name: "install-manifest.json", data: installBytes },
  ]);
  const zipPath = path.join(dist, `rb-output-${VERSION}.zip`);
  fs.writeFileSync(zipPath, zipBytes);
  const installerPath = path.join(dist, "DJLinkForPCDJ-setup.exe");
  fs.writeFileSync(installerPath, crypto.randomBytes(64));
  const releaseManifest = {
    schemaVersion: 1,
    kind: "rb-output-release-manifest/v1",
    productVersion: VERSION,
    identityHash: computeCoreIdentityHash(identity),
    installManifestSha256: sha256Hex(installBytes),
    installManifestBytes: installBytes.length,
    tools: {},
    artifacts: [
      { path: "dist/DJLinkForPCDJ-setup.exe", bytes: fs.statSync(installerPath).size, sha256: sha256Hex(fs.readFileSync(installerPath)) },
      { path: `dist/rb-output-${VERSION}.zip`, bytes: zipBytes.length, sha256: sha256Hex(zipBytes) },
    ],
    createdAtUtc: "2026-08-25T00:00:00.000Z",
    notes: "fixture",
  };
  writeCanonical(path.join(dist, "release-manifest.json"), releaseManifest);
  return { root, dist, serverBytes, installBytes, identityBytes, releaseManifest, zipPath, installerPath };
}

function runSeal(root, tag = TAG) {
  return spawnSync(process.execPath, [VERIFIER, "--project-root", root, "--expected-tag", tag], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 20_000,
  });
}

function rewriteReleaseManifest(fixture, mutate) {
  const next = structuredClone(fixture.releaseManifest);
  mutate(next);
  writeCanonical(path.join(fixture.dist, "release-manifest.json"), next);
}

test("release artifact seal accepts only the exact v1.1.11 fixture", (t) => {
  const fixture = createFixture(t);
  const result = runSeal(fixture.root);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"releaseTag": "v1\.1\.11"/);

  const wrongTag = runSeal(fixture.root, "v1.1.3");
  assert.notEqual(wrongTag.status, 0);
  assert.match(wrongTag.stderr, /release tag must be exactly v1.1.11/);
});

test("release artifact seal rejects a missing, mutated, or extra upload artifact", (t) => {
  const missing = createFixture(t);
  fs.rmSync(missing.installerPath);
  const missingRun = runSeal(missing.root);
  assert.notEqual(missingRun.status, 0);
  assert.match(missingRun.stderr, /installer artifact/);

  const mutated = createFixture(t);
  fs.appendFileSync(mutated.installerPath, "mutated after manifest\n");
  const mutatedRun = runSeal(mutated.root);
  assert.notEqual(mutatedRun.status, 0);
  assert.match(mutatedRun.stderr, /release-manifest sha256 mismatch for dist\/DJLinkForPCDJ-setup\.exe/);

  const extra = createFixture(t);
  fs.writeFileSync(path.join(extra.dist, "rb-output-foreign.zip"), "unapproved artifact\n");
  const extraRun = runSeal(extra.root);
  assert.notEqual(extraRun.status, 0);
  assert.match(extraRun.stderr, /unapproved extra ZIP artifact/);
});

test("release artifact seal verifies ZIP payload hashes even after its outer hash is replayed", (t) => {
  const fixture = createFixture(t);
  const alteredServer = Buffer.concat([fixture.serverBytes, Buffer.from("tampered\n")]);
  const tamperedZip = makeZip([
    { name: "build-identity.json", data: fixture.identityBytes },
    { name: "native\\bin\\rb_hook.dll", data: Buffer.from("sealed hook payload\n", "utf8") },
    { name: "server.exe", data: alteredServer },
    { name: "install-manifest.json", data: fixture.installBytes },
  ]);
  fs.writeFileSync(fixture.zipPath, tamperedZip);
  rewriteReleaseManifest(fixture, (manifest) => {
    manifest.artifacts[1].bytes = tamperedZip.length;
    manifest.artifacts[1].sha256 = sha256Hex(tamperedZip);
  });
  const result = runSeal(fixture.root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release ZIP (size|sha256) mismatch for server\.exe/);
});
