const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  packagedIdentityFrom,
  computeCoreIdentityHash,
} = require("../../server/buildIdentity");
const { canonicalBytes: canonicalIdentityBytes } = require("../../server/buildIdentity");

const INSTALL_MANIFEST_KIND = "rb-output-install-manifest/v1";
const RELEASE_MANIFEST_KIND = "rb-output-release-manifest/v1";
const MANIFEST_SCHEMA_VERSION = 1;

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function toPosix(relPath) {
  return relPath.split(path.sep).join("/");
}

const WINDOWS_RESERVED_DEVICE_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

// Fail-closed payload path validation. Manifest paths are POSIX-style relative
// names; anything that could escape the install root or abuse Windows path
// quirks is rejected before any filesystem access:
//   - backslashes (both "..\\x" traversal and separator smuggling),
//   - absolute POSIX paths ("/x"), drive letters ("C:/x", "C:\\x"), and
//     UNC paths ("//server/share", "\\\\server\\share"),
//   - "." / ".." / empty segments in any position ("a/../..", "a//b", "./x",
//     "x/", trailing slash), i.e. every non-canonical or normalized-escape
//     form,
//   - control characters and NUL bytes,
//   - Windows-reserved device names (including extension and pre-extension
//     trailing-space aliases such as "AUX .txt") and trailing-dot/space
//     segments ("aux", "x.", "x ") that NTFS may reinterpret,
//   - encoded escape attempts ("%2e%2e") are kept literal but still must
//     survive the canonical-form rule above.
function assertSafePayloadRelPath(relPosix) {
  const reject = (reason) => {
    throw new Error(`unsafe payload path rejected (${reason}): ${JSON.stringify(relPosix)}`);
  };
  if (typeof relPosix !== "string" || relPosix.length === 0 || relPosix.length > 512) {
    reject("must be a non-empty string of at most 512 chars");
  }
  if (/[\u0000-\u001f\u007f]/.test(relPosix)) reject("contains control characters");
  if (relPosix.includes("\\")) reject("backslash is not a legal manifest path separator");
  if (relPosix.startsWith("/")) reject("absolute POSIX path");
  if (/^[A-Za-z]:/.test(relPosix)) reject("drive-letter path");
  if (relPosix.startsWith("//")) reject("UNC path");
  // Encoded escape attempts: product file names never contain percent escapes,
  // so any encoded dot or separator (%2e/%2f/%5c) is rejected outright.
  if (/%(?:2e|2f|5c)/i.test(relPosix)) reject("percent-encoded traversal");
  const segments = relPosix.split("/");
  for (const segment of segments) {
    if (segment.length === 0) reject("empty segment (double or trailing slash)");
    if (segment === "." || segment === "..") reject("dot or dot-dot segment");
    if (segment.includes(":")) reject("Windows ADS or colon is not allowed");
    if (/[. ]$/.test(segment)) reject("segment ends with dot or space");
    // Win32 first removes trailing spaces/dots from the basename before an
    // extension, then interprets reserved device basenames even when an
    // extension follows. Therefore AUX .txt and COM1 .dll are not safe
    // aliases just because the raw segment does not literally equal AUX or
    // COM1. Keep this check per segment so a nested directory cannot bypass
    // the same rule.
    const extensionIndex = segment.indexOf(".");
    const basename = (extensionIndex === -1 ? segment : segment.slice(0, extensionIndex))
      .replace(/[. ]+$/u, "");
    if (WINDOWS_RESERVED_DEVICE_RE.test(basename)) {
      reject(`Windows-reserved device basename ${segment}`);
    }
  }
  // Canonical form required: normalize must be an exact no-op so aliases like
  // "a/./b" or any normalized escape are refused even when they stay inside.
  if (path.posix.normalize(relPosix) !== relPosix) {
    reject("not in canonical normalized form");
  }
  return relPosix;
}

function lstatNoFollow(absPath, label) {
  let stat;
  try {
    stat = fs.lstatSync(absPath);
  } catch (error) {
    throw new Error(`${label} is missing or unreadable: ${error.message}`, { cause: error });
  }
  // On Windows Node reports both symbolic links and junctions as symbolic
  // links through lstatSync. statSync is never suitable here because it
  // follows the reparse point and can make a foreign target look regular.
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} is a symbolic link or junction (reparse points are not allowed)`);
  }
  return stat;
}

function assertNoFollowDirectory(absPath, label = absPath) {
  const stat = lstatNoFollow(absPath, label);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory`);
  return stat;
}

function assertRegularNoFollowPath(absPath, label = absPath) {
  const stat = lstatNoFollow(absPath, label);
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
  return stat;
}

// Resolves a canonical manifest path one component at a time. Every existing
// component is lstat'd before use, so direct payload links and links hidden in
// intermediate directories are rejected without following them.
function resolveNoFollowPayloadPath(root, relPosixPath, { expect = null } = {}) {
  const safePath = assertSafePayloadRelPath(relPosixPath);
  assertNoFollowDirectory(root, `install root ${root}`);
  const segments = safePath.split("/");
  let absolutePath = root;
  let stat = null;
  for (let index = 0; index < segments.length; index += 1) {
    absolutePath = path.join(absolutePath, segments[index]);
    stat = lstatNoFollow(absolutePath, `payload ${safePath}`);
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`payload ${safePath} has a non-directory intermediate component`);
    }
  }
  if (expect === "file" && !stat.isFile()) {
    throw new Error(`payload is not a regular file: ${safePath}`);
  }
  if (expect === "directory" && !stat.isDirectory()) {
    throw new Error(`payload is not a directory: ${safePath}`);
  }
  return { safePath, absolutePath, stat };
}

// Resolves a file that will be written below a trusted root. Parents must
// already exist and be real directories; the destination may be absent, but
// an existing destination must be a regular non-reparse file. Callers do not
// create missing parents because doing so would hide a path substitution after
// validation. This is deliberately separate from the input resolver above:
// output files normally do not exist yet.
function resolveNoFollowOutputPath(root, relPosixPath) {
  const safePath = assertSafePayloadRelPath(relPosixPath);
  assertNoFollowDirectory(root, `install root ${root}`);
  const segments = safePath.split("/");
  let absolutePath = root;
  let finalStat = null;
  for (let index = 0; index < segments.length; index += 1) {
    absolutePath = path.join(absolutePath, segments[index]);
    let stat;
    try {
      stat = lstatNoFollow(absolutePath, `output ${safePath}`);
    } catch (error) {
      // A missing final file is the only permissible missing component.
      if (index === segments.length - 1 && error.cause && error.cause.code === "ENOENT") {
        return { safePath, absolutePath, stat: null };
      }
      throw error;
    }
    finalStat = stat;
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(`output ${safePath} has a non-directory intermediate component`);
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      throw new Error(`output is not a regular file: ${safePath}`);
    }
  }
  return { safePath, absolutePath, stat: finalStat };
}

// Collects files under `absPath` relative to `installRoot` as posix-style
// relative paths. Directories are recursed; empty dirs yield nothing.
// Symbolic links (and Windows junctions) anywhere below the payload are
// rejected: they can silently redirect hashing outside the install root.
function listPayloadFiles(installRoot, relPath) {
  const root = path.resolve(installRoot);
  const requested = assertSafePayloadRelPath(toPosix(relPath));
  const rootPayload = resolveNoFollowPayloadPath(root, requested);
  if (rootPayload.stat.isFile()) return [requested];
  if (!rootPayload.stat.isDirectory()) {
    throw new Error(`payload is neither a regular file nor a directory: ${requested}`);
  }
  const found = [];
  const walk = (dirRel) => {
    const dir = resolveNoFollowPayloadPath(root, dirRel, { expect: "directory" });
    for (const entry of fs.readdirSync(dir.absolutePath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = `${dirRel}/${entry.name}`;
      const child = resolveNoFollowPayloadPath(root, childRel);
      if (child.stat.isDirectory()) walk(child.safePath);
      else if (child.stat.isFile()) found.push(child.safePath);
      else throw new Error(`payload has a non-regular entry: ${child.safePath}`);
    }
  };
  walk(rootPayload.safePath);
  return found;
}

function hashFileUnder(root, relPosixPath) {
  const resolved = resolveNoFollowPayloadPath(path.resolve(root), relPosixPath, { expect: "file" });
  const data = fs.readFileSync(resolved.absolutePath);
  return { bytes: data.length, sha256: sha256Hex(data) };
}

// Builds an install manifest from explicit required payloads. Missing payloads
// are all reported before failing; duplicate payload arguments and unsafe
// paths fail closed; the manifest itself is never an entry of itself (no
// self-hash recursion).
function buildInstallManifest({ installRoot, payloads, identity }) {
  if (!Array.isArray(payloads) || payloads.length === 0) {
    throw new Error("payloads must be a non-empty list of paths relative to the install root");
  }
  const missing = [];
  const requested = new Set();
  const files = new Set();
  for (const rel of payloads) {
    let normalized;
    try {
      normalized = assertSafePayloadRelPath(toPosix(rel));
    } catch (error) {
      missing.push(error.message);
      continue;
    }
    if (requested.has(normalized)) {
      missing.push(`duplicate payload: ${normalized}`);
      continue;
    }
    requested.add(normalized);
    try {
      // Walk (and thus validate every contained path) eagerly so traversal or
      // symlink tricks inside a directory payload also abort the build.
      for (const file of listPayloadFiles(installRoot, normalized)) files.add(file);
    } catch (error) {
      missing.push(error.message);
    }
  }
  if (missing.length > 0) throw new Error(`install manifest aborted:\n- ${missing.join("\n- ")}`);
  const hashed = [...files]
    .sort()
    .map((rel) => ({ path: rel, ...hashFileUnder(installRoot, rel) }));
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: INSTALL_MANIFEST_KIND,
    productVersion: identity.productVersion,
    // Core (commitment-covered) hash — NOT the sidecar bytes hash, so the
    // manifest binding stays aligned with the commitment embedded in the exe.
    identityHash: computeCoreIdentityHash(identity),
    payloads: hashed,
  };
}

function parseManifestFile(manifestPath, { expectedKind } = {}) {
  let text;
  try {
    assertRegularNoFollowPath(manifestPath, `manifest ${manifestPath}`);
    text = fs.readFileSync(manifestPath, "utf8");
  } catch (error) {
    throw new Error(`manifest unreadable at ${manifestPath}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`manifest at ${manifestPath} is not valid JSON: ${error.message}`);
  }
  const formatErrors = [];
  if (Buffer.compare(Buffer.from(text, "utf8"), canonicalBytes(parsed)) !== 0) {
    formatErrors.push("bytes are not canonical JSON (sorted keys, compact separators, trailing newline)");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`manifest at ${manifestPath} must be a JSON object`);
  }
  if (expectedKind && parsed.kind !== expectedKind) {
    formatErrors.push(`kind must be ${expectedKind}, got ${String(parsed.kind)}`);
  }
  if (parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    formatErrors.push(`schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  }
  if (formatErrors.length > 0) {
    throw new Error(`manifest at ${manifestPath} rejected:\n- ${formatErrors.join("\n- ")}`);
  }
  return parsed;
}

// Verifies an installed tree against its install-manifest.json.
// Rejects missing or modified required payloads and a mismatching embedded
// identity. Extra unlisted files are warnings only (operators may add local
// logs); tampering with REQUIRED files always fails.
function verifyInstallTree(installDir, { manifestFileName = "install-manifest.json" } = {}) {
  const warnings = [];
  const failures = [];
  const root = path.resolve(installDir);
  let safeManifestName;
  try {
    safeManifestName = assertSafePayloadRelPath(manifestFileName);
    resolveNoFollowPayloadPath(root, safeManifestName, { expect: "file" });
  } catch (error) {
    failures.push(error.message);
    return { ok: false, failures, warnings };
  }
  const manifestPath = path.join(root, ...safeManifestName.split("/"));
  let manifest;
  try {
    manifest = parseManifestFile(manifestPath, { expectedKind: INSTALL_MANIFEST_KIND });
  } catch (error) {
    failures.push(error.message);
    return { ok: false, failures, warnings };
  }

  if (!Array.isArray(manifest.payloads)) {
    failures.push(`${safeManifestName} payloads must be an array`);
    return { ok: false, failures, warnings, manifest };
  }

  const identityFileName = "build-identity.json";
  const identityEntry = manifest.payloads.find((entry) => entry && entry.path === identityFileName);
  if (!identityEntry) {
    failures.push(`${identityFileName} is not listed in ${manifestFileName}`);
  }
  let identity = null;
  let identityFileBytes = null;
  try {
    const identityPath = resolveNoFollowPayloadPath(root, identityFileName, { expect: "file" }).absolutePath;
    identityFileBytes = fs.readFileSync(identityPath);
    identity = packagedIdentityFrom(identityPath);
  } catch (error) {
    failures.push(error.message);
    identity = null;
  }
  if (identity) {
    // Shipped sidecar must be byte-canonical AND its file bytes must match the
    // manifest entry; separately, its CORE hash (the commitment-covered part)
    // must match manifest.identityHash. A sidecar whose executableBinding was
    // swapped therefore fails even when re-canonicalized.
    if (Buffer.compare(identityFileBytes, canonicalIdentityBytes(identity)) !== 0) {
      failures.push(`${identityFileName} bytes are not canonical JSON`);
    }
    const coreHash = computeCoreIdentityHash(identity);
    if (identityEntry && manifest.identityHash !== undefined && manifest.identityHash !== coreHash) {
      failures.push(
        `manifest identityHash ${manifest.identityHash} does not match installed identity core hash ${coreHash}`,
      );
    }
  }

  const seen = new Set();
  for (const entry of manifest.payloads) {
    let safePath = null;
    try {
      safePath = assertSafePayloadRelPath(entry && typeof entry.path === "string" ? entry.path : String(entry?.path ?? ""));
    } catch (error) {
      failures.push(error.message);
      continue;
    }
    if (seen.has(safePath)) {
      failures.push(`duplicate payload entry: ${safePath}`);
      continue;
    }
    seen.add(safePath);
    try {
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
        throw new Error(`payload bytes must be a non-negative safe integer: ${safePath}`);
      }
      if (!SHA256_RE.test(String(entry.sha256 ?? ""))) {
        throw new Error(`payload sha256 must be 64-char lowercase hex: ${safePath}`);
      }
      const resolved = resolveNoFollowPayloadPath(root, safePath, { expect: "file" });
      if (resolved.stat.size !== entry.bytes) {
        failures.push(`size mismatch for ${safePath}: expected ${entry.bytes}, got ${resolved.stat.size}`);
        continue;
      }
      const digest = sha256Hex(fs.readFileSync(resolved.absolutePath));
      if (digest !== entry.sha256) {
        failures.push(`sha256 mismatch for ${safePath}: expected ${entry.sha256}, got ${digest}`);
      }
    } catch (error) {
      failures.push(
        error && error.cause && error.cause.code === "ENOENT"
          ? `missing payload: ${safePath}`
          : error.message,
      );
      continue;
    }
  }

  // Warn about unlisted regular files but reject unlisted reparse points: the
  // verifier must never recurse through an unknown junction just to report an
  // advisory. Required payloads above are always hard failures.
  if (fs.existsSync(root)) {
    const walkExtras = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of entries) {
        const abs = path.join(dir, dirent.name);
        const rel = toPosix(path.relative(root, abs));
        let stat;
        try {
          stat = fs.lstatSync(abs);
        } catch (error) {
          failures.push(`unlisted path unreadable: ${rel} (${error.message})`);
          continue;
        }
        if (stat.isSymbolicLink()) {
          failures.push(`unlisted symbolic link or junction is not allowed: ${rel}`);
          continue;
        }
        if (stat.isDirectory()) {
          walkExtras(abs);
          continue;
        }
        if (!stat.isFile()) continue;
        if (rel === safeManifestName || seen.has(rel)) continue;
        warnings.push(`unlisted file present (not verified): ${rel}`);
      }
    };
    walkExtras(root);
  }

  return { ok: failures.length === 0, failures, warnings, manifest };
}

module.exports = {
  INSTALL_MANIFEST_KIND,
  RELEASE_MANIFEST_KIND,
  MANIFEST_SCHEMA_VERSION,
  canonicalJson,
  canonicalBytes,
  sha256Hex,
  assertSafePayloadRelPath,
  lstatNoFollow,
  assertNoFollowDirectory,
  assertRegularNoFollowPath,
  resolveNoFollowPayloadPath,
  resolveNoFollowOutputPath,
  listPayloadFiles,
  buildInstallManifest,
  parseManifestFile,
  verifyInstallTree,
};
