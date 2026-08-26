#!/usr/bin/env node
"use strict";

// Last-moment release-artifact seal.  build-dist.ps1 produces the manifests;
// this verifier deliberately re-reads every upload input immediately before
// the release action runs.  It is intentionally release-specific: accepting a
// different tag/version or an additional archive must be an explicit code
// change, not an accidental glob expansion.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const {
  INSTALL_MANIFEST_KIND,
  RELEASE_MANIFEST_KIND,
  canonicalBytes,
  parseManifestFile,
  resolveNoFollowPayloadPath,
  sha256Hex,
} = require("./lib/manifests");
const {
  canonicalBytes: canonicalIdentityBytes,
  computeCoreIdentityHash,
  validatePackagedIdentity,
} = require("../server/buildIdentity");

const EXPECTED_PRODUCT_VERSION = "1.1.5";
const EXPECTED_RELEASE_TAG = `v${EXPECTED_PRODUCT_VERSION}`;
const EXPECTED_ARTIFACT_PATHS = Object.freeze([
  "dist/DJLinkForPCDJ-setup.exe",
  `dist/rb-output-${EXPECTED_PRODUCT_VERSION}.zip`,
]);
const SHA256_RE = /^[0-9a-f]{64}$/;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(failures, message) {
  failures.push(message);
}

function isSafeSha256(value) {
  return SHA256_RE.test(String(value ?? ""));
}

function readRegularFile(projectRoot, relativePath, label, failures) {
  try {
    const resolved = resolveNoFollowPayloadPath(projectRoot, relativePath, { expect: "file" });
    return {
      path: resolved.absolutePath,
      stat: resolved.stat,
      bytes: fs.readFileSync(resolved.absolutePath),
    };
  } catch (error) {
    fail(failures, `${label}: ${error.message}`);
    return null;
  }
}

function readCanonicalManifest(projectRoot, relativePath, kind, label, failures) {
  const file = readRegularFile(projectRoot, relativePath, label, failures);
  if (!file) return null;
  try {
    const manifest = parseManifestFile(file.path, { expectedKind: kind });
    return { ...file, manifest };
  } catch (error) {
    fail(failures, `${label}: ${error.message}`);
    return null;
  }
}

function assertExactKeys(value, expectedKeys, label, failures) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(failures, `${label} must be an object`);
    return false;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(failures, `${label} has unexpected keys; expected exactly ${expected.join(", ")}`);
    return false;
  }
  return true;
}

function assertArtifactEntry(entry, expectedPath, expectedFile, failures) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    fail(failures, `release-manifest artifact ${expectedPath} must be an object`);
    return;
  }
  if (!assertExactKeys(entry, ["path", "bytes", "sha256"], `release-manifest artifact ${expectedPath}`, failures)) {
    return;
  }
  if (entry.path !== expectedPath) {
    fail(failures, `release-manifest artifact path must be ${expectedPath}, got ${String(entry.path)}`);
  }
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
    fail(failures, `release-manifest artifact bytes must be a non-negative safe integer: ${expectedPath}`);
  }
  if (!isSafeSha256(entry.sha256)) {
    fail(failures, `release-manifest artifact sha256 must be lowercase 64-char hex: ${expectedPath}`);
  }
  if (!expectedFile) return;
  if (entry.bytes !== expectedFile.stat.size) {
    fail(failures, `release-manifest size mismatch for ${expectedPath}: expected ${entry.bytes}, got ${expectedFile.stat.size}`);
  }
  const actualHash = sha256Hex(expectedFile.bytes);
  if (entry.sha256 !== actualHash) {
    fail(failures, `release-manifest sha256 mismatch for ${expectedPath}: expected ${entry.sha256}, got ${actualHash}`);
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readUInt32(buffer, offset, label) {
  if (offset < 0 || offset + 4 > buffer.length) throw new Error(`${label} is truncated`);
  return buffer.readUInt32LE(offset);
}

function readUInt16(buffer, offset, label) {
  if (offset < 0 || offset + 2 > buffer.length) throw new Error(`${label} is truncated`);
  return buffer.readUInt16LE(offset);
}

function zipEndOfCentralDirectory(zipBytes) {
  // EOCD starts no more than 65,557 bytes from EOF (22-byte header plus an
  // optional 65,535-byte comment).  ZIP64 is deliberately rejected: the
  // release ZIP is far below that boundary and accepting a second format adds
  // an untested parser surface to the sealing path.
  const firstOffset = Math.max(0, zipBytes.length - 0xffff - 22);
  for (let offset = zipBytes.length - 22; offset >= firstOffset; offset -= 1) {
    if (readUInt32(zipBytes, offset, "ZIP end of central directory") !== ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = readUInt16(zipBytes, offset + 20, "ZIP end-of-central-directory comment length");
    if (offset + 22 + commentLength !== zipBytes.length) continue;
    return {
      entries: readUInt16(zipBytes, offset + 10, "ZIP entry count"),
      centralDirectoryBytes: readUInt32(zipBytes, offset + 12, "ZIP central-directory size"),
      centralDirectoryOffset: readUInt32(zipBytes, offset + 16, "ZIP central-directory offset"),
    };
  }
  throw new Error("ZIP end of central directory is missing or malformed");
}

function parseZipEntries(zipBytes) {
  const end = zipEndOfCentralDirectory(zipBytes);
  if (end.entries === 0xffff || end.centralDirectoryBytes === 0xffffffff || end.centralDirectoryOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not accepted by the release seal");
  }
  const centralEnd = end.centralDirectoryOffset + end.centralDirectoryBytes;
  if (centralEnd > zipBytes.length) throw new Error("ZIP central directory extends beyond archive bytes");
  const entries = [];
  let offset = end.centralDirectoryOffset;
  for (let index = 0; index < end.entries; index += 1) {
    if (readUInt32(zipBytes, offset, "ZIP central directory") !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`ZIP central directory entry ${index} has an invalid signature`);
    }
    const flags = readUInt16(zipBytes, offset + 8, `ZIP central directory entry ${index}`);
    const method = readUInt16(zipBytes, offset + 10, `ZIP central directory entry ${index}`);
    const expectedCrc = readUInt32(zipBytes, offset + 16, `ZIP central directory entry ${index}`);
    const compressedBytes = readUInt32(zipBytes, offset + 20, `ZIP central directory entry ${index}`);
    const uncompressedBytes = readUInt32(zipBytes, offset + 24, `ZIP central directory entry ${index}`);
    const nameBytes = readUInt16(zipBytes, offset + 28, `ZIP central directory entry ${index}`);
    const extraBytes = readUInt16(zipBytes, offset + 30, `ZIP central directory entry ${index}`);
    const commentBytes = readUInt16(zipBytes, offset + 32, `ZIP central directory entry ${index}`);
    const diskNumber = readUInt16(zipBytes, offset + 34, `ZIP central directory entry ${index}`);
    const localOffset = readUInt32(zipBytes, offset + 42, `ZIP central directory entry ${index}`);
    const nextOffset = offset + 46 + nameBytes + extraBytes + commentBytes;
    if (nextOffset > centralEnd) throw new Error(`ZIP central directory entry ${index} is truncated`);
    if (flags & 0x0001) throw new Error(`ZIP entry ${index} is encrypted`);
    if ((flags & 0x0008) !== 0) throw new Error(`ZIP entry ${index} uses a data descriptor (not accepted by the release seal)`);
    if (diskNumber !== 0) throw new Error(`ZIP entry ${index} is stored on a non-zero disk`);
    const name = zipBytes.subarray(offset + 46, offset + 46 + nameBytes).toString("utf8");

    if (readUInt32(zipBytes, localOffset, `ZIP local header for ${name}`) !== ZIP_LOCAL_FILE_SIGNATURE) {
      throw new Error(`ZIP local header is missing for ${name}`);
    }
    const localFlags = readUInt16(zipBytes, localOffset + 6, `ZIP local header for ${name}`);
    const localMethod = readUInt16(zipBytes, localOffset + 8, `ZIP local header for ${name}`);
    const localCrc = readUInt32(zipBytes, localOffset + 14, `ZIP local header for ${name}`);
    const localCompressedBytes = readUInt32(zipBytes, localOffset + 18, `ZIP local header for ${name}`);
    const localUncompressedBytes = readUInt32(zipBytes, localOffset + 22, `ZIP local header for ${name}`);
    const localNameBytes = readUInt16(zipBytes, localOffset + 26, `ZIP local header for ${name}`);
    const localExtraBytes = readUInt16(zipBytes, localOffset + 28, `ZIP local header for ${name}`);
    if (localFlags !== flags || localMethod !== method || localCrc !== expectedCrc || localCompressedBytes !== compressedBytes || localUncompressedBytes !== uncompressedBytes) {
      throw new Error(`ZIP local/central metadata mismatch for ${name}`);
    }
    const localName = zipBytes.subarray(localOffset + 30, localOffset + 30 + localNameBytes).toString("utf8");
    if (localName !== name) throw new Error(`ZIP local/central filename mismatch for ${name}`);
    const compressedStart = localOffset + 30 + localNameBytes + localExtraBytes;
    const compressedEnd = compressedStart + compressedBytes;
    if (compressedEnd > end.centralDirectoryOffset) throw new Error(`ZIP compressed data is out of bounds for ${name}`);
    const compressed = zipBytes.subarray(compressedStart, compressedEnd);
    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw new Error(`ZIP compression method ${method} is not accepted for ${name}`);
    if (data.length !== uncompressedBytes) throw new Error(`ZIP uncompressed size mismatch for ${name}`);
    if (crc32(data) !== expectedCrc) throw new Error(`ZIP CRC32 mismatch for ${name}`);
    entries.push({ name, data });
    offset = nextOffset;
  }
  if (offset !== centralEnd) throw new Error("ZIP central directory has trailing bytes");
  return entries;
}

function validManifestPayloads(installManifest, failures) {
  if (!Array.isArray(installManifest.payloads)) {
    fail(failures, "install-manifest payloads must be an array");
    return [];
  }
  const seen = new Set();
  const entries = [];
  for (const entry of installManifest.payloads) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      fail(failures, "install-manifest payload entry must be an object");
      continue;
    }
    if (!assertExactKeys(entry, ["path", "bytes", "sha256"], "install-manifest payload entry", failures)) continue;
    if (typeof entry.path !== "string" || entry.path.length === 0 || entry.path.includes("\\") || entry.path.startsWith("/") || entry.path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      fail(failures, `install-manifest payload path is unsafe: ${String(entry.path)}`);
      continue;
    }
    if (seen.has(entry.path)) {
      fail(failures, `install-manifest has duplicate payload path: ${entry.path}`);
      continue;
    }
    seen.add(entry.path);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      fail(failures, `install-manifest payload bytes must be a non-negative safe integer: ${entry.path}`);
      continue;
    }
    if (!isSafeSha256(entry.sha256)) {
      fail(failures, `install-manifest payload sha256 must be lowercase 64-char hex: ${entry.path}`);
      continue;
    }
    entries.push(entry);
  }
  return entries;
}

function canonicalZipEntryName(name) {
  // Compress-Archive on the supported Windows runner writes backslashes in
  // central-directory names.  Treat that one encoding as a separator, then
  // apply the same no-absolute/no-dot-segment rules as the manifest.  Mixed
  // separators are refused so a second ambiguous spelling cannot bypass the
  // exact entry-set check below.
  if (name.includes("/") && name.includes("\\")) {
    throw new Error("mixed path separators");
  }
  const canonical = name.replaceAll("\\", "/");
  if (canonical.startsWith("/") || canonical.endsWith("/") || canonical.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("absolute, directory, empty, or dot path segment");
  }
  return canonical;
}

function assertZipPayloads(zipBytes, installManifest, identityBytes, installManifestBytes, failures) {
  let zipEntries;
  try {
    zipEntries = parseZipEntries(zipBytes);
  } catch (error) {
    fail(failures, `release ZIP is invalid: ${error.message}`);
    return;
  }
  const payloads = validManifestPayloads(installManifest, failures);
  const expected = new Map(payloads.map((entry) => [entry.path, entry]));
  expected.set("install-manifest.json", {
    path: "install-manifest.json",
    bytes: installManifestBytes.length,
    sha256: sha256Hex(installManifestBytes),
  });
  const actual = new Map();
  for (const entry of zipEntries) {
    let canonicalName;
    try {
      canonicalName = canonicalZipEntryName(entry.name);
    } catch (error) {
      fail(failures, `release ZIP has unsafe entry name ${JSON.stringify(entry.name)}: ${error.message}`);
      continue;
    }
    if (actual.has(canonicalName)) {
      fail(failures, `release ZIP has duplicate entry: ${canonicalName}`);
      continue;
    }
    actual.set(canonicalName, entry);
  }
  for (const [expectedName, manifestEntry] of expected) {
    const zipEntry = actual.get(expectedName);
    if (!zipEntry) {
      fail(failures, `release ZIP is missing required entry: ${expectedName}`);
      continue;
    }
    if (zipEntry.data.length !== manifestEntry.bytes) {
      fail(failures, `release ZIP size mismatch for ${expectedName}: expected ${manifestEntry.bytes}, got ${zipEntry.data.length}`);
      continue;
    }
    const digest = sha256Hex(zipEntry.data);
    if (digest !== manifestEntry.sha256) {
      fail(failures, `release ZIP sha256 mismatch for ${expectedName}: expected ${manifestEntry.sha256}, got ${digest}`);
    }
  }
  for (const name of actual.keys()) {
    if (!expected.has(name)) fail(failures, `release ZIP has unlisted extra entry: ${name}`);
  }
  const zipIdentity = actual.get("build-identity.json");
  if (zipIdentity && !Buffer.from(zipIdentity.data).equals(identityBytes)) {
    fail(failures, "release ZIP build-identity.json differs from the staged identity");
  }
  const zipInstallManifest = actual.get("install-manifest.json");
  if (zipInstallManifest && !Buffer.from(zipInstallManifest.data).equals(installManifestBytes)) {
    fail(failures, "release ZIP install-manifest.json differs from the staged manifest");
  }
}

function sealReleaseArtifacts({ projectRoot, expectedTag = EXPECTED_RELEASE_TAG } = {}) {
  const failures = [];
  const root = path.resolve(projectRoot || path.join(__dirname, ".."));
  if (expectedTag !== EXPECTED_RELEASE_TAG) {
    fail(failures, `release tag must be exactly ${EXPECTED_RELEASE_TAG}, got ${String(expectedTag)}`);
  }

  let topLevel;
  try {
    const dist = resolveNoFollowPayloadPath(root, "dist", { expect: "directory" }).absolutePath;
    topLevel = fs.readdirSync(dist, { withFileTypes: true });
    for (const entry of topLevel) {
      if (entry.isSymbolicLink()) fail(failures, `dist contains a symbolic link or junction: ${entry.name}`);
      if (entry.isFile() && entry.name.endsWith(".zip") && entry.name !== `rb-output-${EXPECTED_PRODUCT_VERSION}.zip`) {
        fail(failures, `dist contains an unapproved extra ZIP artifact: ${entry.name}`);
      }
    }
  } catch (error) {
    fail(failures, `dist inventory failed: ${error.message}`);
  }

  const installer = readRegularFile(root, EXPECTED_ARTIFACT_PATHS[0], "installer artifact", failures);
  const zip = readRegularFile(root, EXPECTED_ARTIFACT_PATHS[1], "ZIP artifact", failures);
  const release = readCanonicalManifest(root, "dist/release-manifest.json", RELEASE_MANIFEST_KIND, "release manifest", failures);
  const install = readCanonicalManifest(root, "dist/install-manifest.json", INSTALL_MANIFEST_KIND, "install manifest", failures);
  const identityFile = readRegularFile(root, "dist/build-identity.json", "build identity", failures);

  let identity = null;
  if (identityFile) {
    try {
      identity = JSON.parse(identityFile.bytes.toString("utf8"));
      if (!Buffer.from(canonicalIdentityBytes(identity)).equals(identityFile.bytes)) {
        fail(failures, "build identity bytes are not canonical JSON");
      }
      const verdict = validatePackagedIdentity(identity);
      if (!verdict.ok) fail(failures, `build identity is malformed: ${verdict.errors.join("; ")}`);
    } catch (error) {
      fail(failures, `build identity is not valid JSON: ${error.message}`);
      identity = null;
    }
  }

  if (release) {
    assertExactKeys(
      release.manifest,
      ["schemaVersion", "kind", "productVersion", "identityHash", "installManifestSha256", "installManifestBytes", "tools", "artifacts", "createdAtUtc", "notes"],
      "release manifest",
      failures,
    );
    if (release.manifest.productVersion !== EXPECTED_PRODUCT_VERSION) {
      fail(failures, `release manifest productVersion must be ${EXPECTED_PRODUCT_VERSION}, got ${String(release.manifest.productVersion)}`);
    }
    if (!isSafeSha256(release.manifest.identityHash)) fail(failures, "release manifest identityHash must be lowercase 64-char hex");
    if (!isSafeSha256(release.manifest.installManifestSha256)) fail(failures, "release manifest installManifestSha256 must be lowercase 64-char hex");
    if (!Number.isSafeInteger(release.manifest.installManifestBytes) || release.manifest.installManifestBytes < 0) {
      fail(failures, "release manifest installManifestBytes must be a non-negative safe integer");
    }
    if (release.manifest.tools === null || typeof release.manifest.tools !== "object" || Array.isArray(release.manifest.tools)) {
      fail(failures, "release manifest tools must be an object");
    }
    if (typeof release.manifest.createdAtUtc !== "string" || !release.manifest.createdAtUtc.endsWith("Z") || Number.isNaN(Date.parse(release.manifest.createdAtUtc))) {
      fail(failures, "release manifest createdAtUtc must be an ISO-8601 UTC timestamp");
    }
    if (typeof release.manifest.notes !== "string" || release.manifest.notes.length === 0) {
      fail(failures, "release manifest notes must be a non-empty string");
    }
    if (!Array.isArray(release.manifest.artifacts) || release.manifest.artifacts.length !== EXPECTED_ARTIFACT_PATHS.length) {
      fail(failures, `release manifest must list exactly ${EXPECTED_ARTIFACT_PATHS.length} release artifacts`);
    } else {
      for (let index = 0; index < EXPECTED_ARTIFACT_PATHS.length; index += 1) {
        assertArtifactEntry(release.manifest.artifacts[index], EXPECTED_ARTIFACT_PATHS[index], index === 0 ? installer : zip, failures);
      }
      const listedPaths = release.manifest.artifacts.map((entry) => entry && entry.path);
      if (new Set(listedPaths).size !== listedPaths.length) fail(failures, "release manifest has duplicate artifact paths");
    }
    if (install) {
      if (release.manifest.installManifestBytes !== install.bytes.length) {
        fail(failures, `release manifest installManifestBytes mismatch: expected ${release.manifest.installManifestBytes}, got ${install.bytes.length}`);
      }
      const actualInstallHash = sha256Hex(install.bytes);
      if (release.manifest.installManifestSha256 !== actualInstallHash) {
        fail(failures, `release manifest installManifestSha256 mismatch: expected ${release.manifest.installManifestSha256}, got ${actualInstallHash}`);
      }
    }
  }

  if (install) {
    if (install.manifest.productVersion !== EXPECTED_PRODUCT_VERSION) {
      fail(failures, `install manifest productVersion must be ${EXPECTED_PRODUCT_VERSION}, got ${String(install.manifest.productVersion)}`);
    }
    if (!isSafeSha256(install.manifest.identityHash)) fail(failures, "install manifest identityHash must be lowercase 64-char hex");
    const payloads = validManifestPayloads(install.manifest, failures);
    for (const entry of payloads) {
      const staged = readRegularFile(root, `dist/${entry.path}`, `staged payload ${entry.path}`, failures);
      if (!staged) continue;
      if (staged.stat.size !== entry.bytes) {
        fail(failures, `staged payload size mismatch for ${entry.path}: expected ${entry.bytes}, got ${staged.stat.size}`);
      }
      const digest = sha256Hex(staged.bytes);
      if (digest !== entry.sha256) {
        fail(failures, `staged payload sha256 mismatch for ${entry.path}: expected ${entry.sha256}, got ${digest}`);
      }
    }
    if (!payloads.some((entry) => entry.path === "build-identity.json")) {
      fail(failures, "install manifest must list build-identity.json");
    }
  }

  if (identity) {
    if (identity.productVersion !== EXPECTED_PRODUCT_VERSION) {
      fail(failures, `build identity productVersion must be ${EXPECTED_PRODUCT_VERSION}, got ${String(identity.productVersion)}`);
    }
    if (identity.releaseTag !== EXPECTED_RELEASE_TAG) {
      fail(failures, `build identity releaseTag must be ${EXPECTED_RELEASE_TAG}, got ${String(identity.releaseTag)}`);
    }
    const identityHash = computeCoreIdentityHash(identity);
    if (install && install.manifest.identityHash !== identityHash) {
      fail(failures, `install manifest identityHash does not match build identity core hash ${identityHash}`);
    }
    if (release && release.manifest.identityHash !== identityHash) {
      fail(failures, `release manifest identityHash does not match build identity core hash ${identityHash}`);
    }
  }

  if (zip && install && identityFile) {
    assertZipPayloads(zip.bytes, install.manifest, identityFile.bytes, install.bytes, failures);
  }

  // A second hash pass is the last operation before the workflow invokes the
  // upload action.  It catches replacement during the more expensive ZIP and
  // manifest checks; no write is performed by this verifier.
  for (const [label, file] of [
    ["installer artifact", installer],
    ["ZIP artifact", zip],
    ["release manifest", release],
    ["install manifest", install],
    ["build identity", identityFile],
  ]) {
    if (!file) continue;
    try {
      const reread = fs.readFileSync(file.path);
      if (!reread.equals(file.bytes)) fail(failures, `${label} changed during release sealing`);
    } catch (error) {
      fail(failures, `${label} could not be re-read during release sealing: ${error.message}`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    productVersion: EXPECTED_PRODUCT_VERSION,
    releaseTag: EXPECTED_RELEASE_TAG,
    artifactPaths: [...EXPECTED_ARTIFACT_PATHS],
  };
}

if (require.main === module) {
  const projectRoot = path.resolve(argValue("--project-root") || path.join(__dirname, ".."));
  const result = sealReleaseArtifacts({ projectRoot, expectedTag: argValue("--expected-tag") || process.env.GITHUB_REF_NAME });
  if (!result.ok) {
    console.error(`release artifact seal failed (${result.failures.length} problem${result.failures.length === 1 ? "" : "s"}):\n- ${result.failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}

module.exports = {
  EXPECTED_PRODUCT_VERSION,
  EXPECTED_RELEASE_TAG,
  EXPECTED_ARTIFACT_PATHS,
  parseZipEntries,
  sealReleaseArtifacts,
};
