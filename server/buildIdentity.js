const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const IDENTITY_FILENAME = "build-identity.json";
const IDENTITY_SCHEMA_VERSION = 1;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const REQUIRED_TOOL_VERSIONS = Object.freeze({
  pkg: "6.22.0",
  pyinstaller: "6.22.2",
});

// Sidecar executable binding: written AFTER packaging, it binds the immutable
// release identity to the measured sha256 of server.exe itself. The embedded
// commitment compiled into server.exe intentionally covers ONLY the identity
// (never the exe hash), which would be circular; the exe hash lives only in
// this sidecar and is re-measured at runtime before any verified-packaged
// status is reported.
const EXECUTABLE_BINDING_KIND = "server-exe-sha256";

// Commitment module generated pre-package by
// scripts/generate-build-identity.js --emit-module into THIS directory and
// compiled into server.exe. The require argument MUST remain a STRING LITERAL:
// @yao-pkg/pkg only statically follows literal requires, so a variable path
// would silently omit the module from the packaged executable. The literal
// path is also covered by the package.json pkg.scripts glob "server/**/*.js",
// giving two independent inclusion mechanisms. Guarded require: absent in dev
// checkouts (null), guaranteed present inside an exe built by
// scripts/build-dist.ps1; a packaged run that cannot load it fails closed
// below.
let cachedEmbeddedCommitment;
function loadEmbeddedReleaseCommitment() {
  if (cachedEmbeddedCommitment === undefined) {
    try {
      cachedEmbeddedCommitment =
        require("./embedded-commitment.js").EMBEDDED_RELEASE_COMMITMENT ?? null;
    } catch {
      cachedEmbeddedCommitment = null;
    }
  }
  return cachedEmbeddedCommitment;
}

function validateEmbeddedReleaseCommitment(value) {
  const errors = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["embedded commitment must be an object"] };
  }
  if (value.schemaVersion !== IDENTITY_SCHEMA_VERSION) {
    errors.push(`commitment schemaVersion must be ${IDENTITY_SCHEMA_VERSION}`);
  }
  if (value.kind !== "rb-output-release-commitment/v1") {
    errors.push('commitment kind must be "rb-output-release-commitment/v1"');
  }
  if (!SHA256_RE.test(String(value.identityHash ?? ""))) {
    errors.push("commitment identityHash must be 64-char lowercase hex");
  }
  for (const key of Object.keys(value)) {
    if (!["schemaVersion", "kind", "identityHash"].includes(key)) {
      errors.push(`unexpected commitment key: ${key}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// Wire-contract advisory recorded at build time. Names are the exact adapter
// identifiers accepted by server/dj-agent/config.js and syndocalClient.js;
// changing them is a deliberate wire-contract change that must update this
// advisory and the focused tests together.
const WIRE_CONTRACT_ADVISORY = Object.freeze({
  adapters: Object.freeze([
    Object.freeze({
      adapter: "syndocal-envelope-v2",
      wireProtocol: "syndocal-envelope-v2",
    }),
  ]),
});

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

function computeIdentityHash(identity) {
  return sha256Hex(canonicalBytes(identity));
}

function assertNoFollowDirectory(absPath, label = absPath) {
  let stat;
  try {
    stat = fs.lstatSync(absPath);
  } catch (error) {
    throw new Error(`${label} is missing or unreadable: ${error.message}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} is a symbolic link or junction (reparse points are not allowed)`);
  }
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory`);
  return stat;
}

function assertRegularNoFollowPath(absPath, label = absPath) {
  let stat;
  try {
    stat = fs.lstatSync(absPath);
  } catch (error) {
    throw new Error(`${label} is missing or unreadable: ${error.message}`);
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} is a symbolic link or junction (reparse points are not allowed)`);
  }
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
  return stat;
}

function hexIdentity(value, { min = 7, max = 64 } = {}) {
  const normalized = String(value || "").trim().toLowerCase();
  return new RegExp(`^[0-9a-f]{${min},${max}}$`).test(normalized) ? normalized : null;
}

function readPackageVersion(pkgPath = path.join(__dirname, "..", "package.json")) {
  try {
    return String(require(pkgPath).version || "unknown");
  } catch {
    return "unknown";
  }
}

function validateEmbeddedIdentity(raw) {
  const errors = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, identity: null, errors: ["identity must be a JSON object"] };
  }
  const allowed = new Set([
    "schemaVersion",
    "name",
    "productVersion",
    "releaseTag",
    "gitCommit",
    "gitTree",
    "dirty",
    "packageLockHash",
    "generatedAtUtc",
    "wireContracts",
    "tools",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) errors.push(`unexpected key: ${key}`);
  }
  const need = (ok, message) => {
    if (!ok) errors.push(message);
  };
  need(raw.schemaVersion === IDENTITY_SCHEMA_VERSION, `schemaVersion must be ${IDENTITY_SCHEMA_VERSION}`);
  need(raw.name === "rb-output", 'name must be "rb-output"');
  const productVersion = String(raw.productVersion ?? "");
  need(SEMVER_RE.test(productVersion), "productVersion must be semver x.y.z");
  need(
    raw.releaseTag === `v${productVersion}`,
    "releaseTag must equal v<productVersion>",
  );
  need(FULL_SHA_RE.test(String(raw.gitCommit ?? "")), "gitCommit must be a full 40-char lowercase hex SHA");
  need(FULL_SHA_RE.test(String(raw.gitTree ?? "")), "gitTree must be a full 40-char lowercase hex SHA");
  need(raw.dirty === false, "dirty must be exactly false");
  need(SHA256_RE.test(String(raw.packageLockHash ?? "")), "packageLockHash must be 64-char lowercase hex");
  const generatedAtUtc = String(raw.generatedAtUtc ?? "");
  need(generatedAtUtc.endsWith("Z") && !Number.isNaN(Date.parse(generatedAtUtc)), "generatedAtUtc must be an ISO-8601 UTC timestamp");
  need(deepEqualStructured(raw.wireContracts, WIRE_CONTRACT_ADVISORY), "wireContracts must match the known adapter advisory");
  const tools = raw.tools;
  if (tools === null || typeof tools !== "object" || Array.isArray(tools)) {
    errors.push("tools must be an object of non-empty strings");
  } else {
    for (const [tool, version] of Object.entries(tools)) {
      need(
        typeof version === "string" && version.trim().length > 0 && version.length <= 100,
        `tools.${tool} must be a non-empty string`,
      );
    }
    need(typeof tools.node === "string" && tools.node.length > 0, "tools.node is required");
    need(
      tools.pkg === REQUIRED_TOOL_VERSIONS.pkg,
      `tools.pkg must be exactly ${REQUIRED_TOOL_VERSIONS.pkg}`,
    );
    need(
      tools.pyinstaller === REQUIRED_TOOL_VERSIONS.pyinstaller,
      `tools.pyinstaller must be exactly ${REQUIRED_TOOL_VERSIONS.pyinstaller}`,
    );
  }
  if (errors.length > 0) {
    return { ok: false, identity: null, errors };
  }
  return { ok: true, identity: raw, errors: [] };
}

function deepEqualStructured(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqualStructured(item, b[i]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((key) => deepEqualStructured(a[key], b[key]));
  }
  return false;
}

// Keys that make up the immutable release identity (the part covered by the
// embedded commitment). The packaged sidecar is exactly these keys plus one
// executableBinding object.
const CORE_IDENTITY_KEYS = [
  "schemaVersion",
  "name",
  "productVersion",
  "releaseTag",
  "gitCommit",
  "gitTree",
  "dirty",
  "packageLockHash",
  "generatedAtUtc",
  "wireContracts",
  "tools",
];

function coreIdentityFromPackaged(sidecar) {
  const core = {};
  for (const key of CORE_IDENTITY_KEYS) core[key] = sidecar[key];
  return core;
}

function computeCoreIdentityHash(sidecar) {
  return computeIdentityHash(coreIdentityFromPackaged(sidecar));
}

// Validates the packaged sidecar: a valid embedded identity plus EXACTLY one
// executableBinding of kind server-exe-sha256 carrying the packaged exe hash.
function validatePackagedIdentity(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, identity: null, errors: ["packaged identity must be a JSON object"] };
  }
  const errors = [];
  const core = {};
  for (const key of CORE_IDENTITY_KEYS) {
    core[key] = raw[key];
  }
  const coreVerdict = validateEmbeddedIdentity(core);
  if (!coreVerdict.ok) errors.push(...coreVerdict.errors);
  const binding = raw.executableBinding;
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)) {
    errors.push("executableBinding must be an object");
  } else {
    for (const key of Object.keys(binding)) {
      if (!["kind", "exeSha256"].includes(key)) errors.push(`unexpected executableBinding key: ${key}`);
    }
    if (binding.kind !== EXECUTABLE_BINDING_KIND) {
      errors.push(`executableBinding.kind must be ${EXECUTABLE_BINDING_KIND}`);
    }
    if (!SHA256_RE.test(String(binding.exeSha256 ?? ""))) {
      errors.push("executableBinding.exeSha256 must be 64-char lowercase hex");
    }
  }
  for (const key of Object.keys(raw)) {
    if (!CORE_IDENTITY_KEYS.includes(key) && key !== "executableBinding") {
      errors.push(`unexpected key: ${key}`);
    }
  }
  if (errors.length > 0) return { ok: false, identity: null, errors };
  return { ok: true, identity: raw, errors: [] };
}

function readPackagedIdentityFile(readFile, identityPath) {
  let text;
  try {
    assertRegularNoFollowPath(identityPath, `packaged build identity at ${identityPath}`);
    text = readFile(identityPath, "utf8");
  } catch (error) {
    throw new Error(
      `packaged build identity missing or unreadable at ${identityPath}: ${error.message}`,
    );
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`packaged build identity at ${identityPath} is not valid JSON: ${error.message}`);
  }
  const verdict = validatePackagedIdentity(raw);
  if (!verdict.ok) {
    throw new Error(
      `packaged build identity at ${identityPath} is malformed:\n- ${verdict.errors.join("\n- ")}`,
    );
  }
  return verdict.identity;
}

// Full packaged provenance evaluation. Returns { ok, identity, failures } and
// never throws; resolveBuildIdentity turns failures into a startup abort.
// Checks, in order:
//   1. sidecar build-identity.json parses + validates (identity + exe binding),
//   2. the commitment compiled INTO THIS EXE covers exactly this identity —
//      rejects old-release replay and foreign coherent sidecar/manifest sets,
//   3. the ACTUAL running executable hashes to the sidecar's bound exeSha256.
// Only when all three hold may status be reported as verified-packaged.
function evaluatePackagedProvenance({
  exeDir,
  execPath,
  readFile = fs.readFileSync,
  embeddedCommitment = loadEmbeddedReleaseCommitment(),
} = {}) {
  const failures = [];
  let identity = null;
  try {
    assertNoFollowDirectory(exeDir, `packaged executable directory ${exeDir}`);
  } catch (error) {
    failures.push(error.message);
    return { ok: false, identity: null, failures };
  }
  try {
    identity = readPackagedIdentityFile(readFile, path.join(exeDir, IDENTITY_FILENAME));
  } catch (error) {
    failures.push(error.message);
    return { ok: false, identity: null, failures };
  }

  const coreHash = computeCoreIdentityHash(identity);
  const commitmentVerdict = validateEmbeddedReleaseCommitment(embeddedCommitment);
  if (!commitmentVerdict.ok) {
    failures.push(
      `embedded release commitment missing or invalid in this executable:\n- ${commitmentVerdict.errors.join("\n- ")}`,
    );
  } else if (embeddedCommitment.identityHash !== coreHash) {
    failures.push(
      `embedded release commitment identityHash ${embeddedCommitment.identityHash} does not cover this build-identity.json (computed ${coreHash}); refusing old-release replay or foreign sidecar`,
    );
  }

  let measuredExeHash = null;
  try {
    assertRegularNoFollowPath(execPath, `running executable ${execPath}`);
    measuredExeHash = sha256Hex(readFile(execPath));
  } catch (error) {
    failures.push(`running executable could not be hashed at ${execPath}: ${error.message}`);
  }
  if (measuredExeHash !== null && measuredExeHash !== identity.executableBinding.exeSha256) {
    failures.push(
      `running executable hash ${measuredExeHash} does not match executableBinding.exeSha256 ${identity.executableBinding.exeSha256}`,
    );
  }

  return { ok: failures.length === 0, identity, failures, coreHash, measuredExeHash };
}

function packagedIdentityFrom(exeDirOrIdentityPath, { readFile = fs.readFileSync } = {}) {
  const identityPath = exeDirOrIdentityPath.toLowerCase().endsWith(".json")
    ? exeDirOrIdentityPath
    : path.join(exeDirOrIdentityPath, IDENTITY_FILENAME);
  return readPackagedIdentityFile(readFile, identityPath);
}

// Packaged mode: the ONLY trusted sources are (a) the release commitment
// compiled into this executable and (b) build-identity.json shipped next to it,
// which additionally binds that identity to the measured hash of the running
// exe. Any missing/malformed/mismatching input throws before the HTTP server
// starts (fail-closed). Runtime environment variables can never forge it.
function resolveBuildIdentity({
  isPackaged = typeof process.pkg !== "undefined",
  exeDir = isPackaged ? path.dirname(process.execPath) : null,
  execPath = isPackaged ? process.execPath : null,
  env = process.env,
  now = () => new Date().toISOString(),
  version,
  readFile = fs.readFileSync,
  embeddedCommitment,
} = {}) {
  if (isPackaged) {
    const evaluation = evaluatePackagedProvenance({
      exeDir,
      execPath,
      readFile,
      embeddedCommitment,
    });
    if (!evaluation.ok) {
      throw new Error(
        `packaged provenance verification failed:\n- ${evaluation.failures.join("\n- ")}`,
      );
    }
    const identity = evaluation.identity;
    return {
      name: identity.name,
      version: identity.productVersion,
      gitCommit: identity.gitCommit,
      sourceFingerprint: null,
      generatedAt: identity.generatedAtUtc,
      provenance: {
        status: "verified-packaged",
        schemaVersion: identity.schemaVersion,
        releaseTag: identity.releaseTag,
        commit: identity.gitCommit,
        tree: identity.gitTree,
        dirty: identity.dirty,
        packageLockHash: identity.packageLockHash,
        identityHash: evaluation.coreHash,
        exeSha256: identity.executableBinding.exeSha256,
        measuredExeSha256: evaluation.measuredExeHash,
        commitmentVerified: true,
        wireContracts: identity.wireContracts,
        tools: identity.tools,
        generatedAtUtc: identity.generatedAtUtc,
        identitySource: IDENTITY_FILENAME,
      },
    };
  }
  // Development mode keeps the legacy read-only env-derived fields. These are
  // informational only and never present in a packaged process.
  return {
    name: "rb-output",
    version: String(version || readPackageVersion() || "unknown"),
    gitCommit: hexIdentity(env.RB_OUTPUT_GIT_COMMIT),
    sourceFingerprint: hexIdentity(env.RB_OUTPUT_SOURCE_FINGERPRINT),
    generatedAt: now(),
    provenance: {
      status: "dev-unverified",
      identitySource: null,
      identityHash: null,
    },
  };
}

// Back-compat alias used by tests and tooling that predate provenance mode.
function createBuildIdentity(options = {}) {
  return resolveBuildIdentity({ ...options, isPackaged: false });
}

module.exports = {
  IDENTITY_FILENAME,
  IDENTITY_SCHEMA_VERSION,
  EXECUTABLE_BINDING_KIND,
  REQUIRED_TOOL_VERSIONS,
  WIRE_CONTRACT_ADVISORY,
  canonicalJson,
  canonicalBytes,
  sha256Hex,
  computeIdentityHash,
  assertNoFollowDirectory,
  assertRegularNoFollowPath,
  validateEmbeddedIdentity,
  validateEmbeddedReleaseCommitment,
  loadEmbeddedReleaseCommitment,
  coreIdentityFromPackaged,
  computeCoreIdentityHash,
  validatePackagedIdentity,
  evaluatePackagedProvenance,
  readPackagedIdentityFile,
  packagedIdentityFrom,
  resolveBuildIdentity,
  createBuildIdentity,
  hexIdentity,
  readPackageVersion,
};
