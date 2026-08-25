const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const {
  IDENTITY_FILENAME,
  EXECUTABLE_BINDING_KIND,
  WIRE_CONTRACT_ADVISORY,
  canonicalJson,
  canonicalBytes,
  computeIdentityHash,
  computeCoreIdentityHash,
  validateEmbeddedIdentity,
  validatePackagedIdentity,
  validateEmbeddedReleaseCommitment,
  loadEmbeddedReleaseCommitment,
  resolveBuildIdentity,
} = require("../server/buildIdentity");
const { verifyInstalledInstall } = require("../server/installVerification");
const {
  runPreflight,
  __test: preflightTestApi,
} = require("../scripts/lib/provenance-preflight");
const {
  assertSafePayloadRelPath,
  buildInstallManifest,
  parseManifestFile,
  verifyInstallTree,
} = require("../scripts/lib/manifests");

const REPO_ROOT = path.join(__dirname, "..");

const COMMIT_A = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
const COMMIT_B = "b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
const TREE = "c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0";
const LOCK_HASH = "d".repeat(64);
// Stand-ins for measured server.exe hashes of two different releases.
const EXE_HASH_A = "a".repeat(64);
const EXE_HASH_B = "b".repeat(64);

function tempDir(t, prefix = "rb-provenance-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function validIdentityFixture() {
  return {
    schemaVersion: 1,
    name: "rb-output",
    productVersion: "1.1.1",
    releaseTag: "v1.1.1",
    gitCommit: COMMIT_A,
    gitTree: TREE,
    dirty: false,
    packageLockHash: LOCK_HASH,
    generatedAtUtc: "2026-08-25T00:00:00.000Z",
    wireContracts: WIRE_CONTRACT_ADVISORY,
    tools: { node: "v22.22.1", npm: "10.9.4", pkg: "6.22.0", pyinstaller: "6.22.2" },
  };
}

function sidecarFixture(exeSha256 = EXE_HASH_A, coreOverrides = {}) {
  return {
    ...validIdentityFixture(),
    ...coreOverrides,
    executableBinding: { kind: EXECUTABLE_BINDING_KIND, exeSha256 },
  };
}

function commitmentFixture(identityHash, { kind = "rb-output-release-commitment/v1", schemaVersion = 1 } = {}) {
  return { schemaVersion, kind, identityHash };
}

function writeCanonical(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, canonicalBytes(value));
}

function writeExeFile(t, bytes = crypto.randomBytes(512)) {
  const p = path.join(tempDir(t), "server.exe");
  fs.writeFileSync(p, bytes);
  return p;
}

// ---------------------------------------------------------------------------
// canonical formatting + identity hash
// ---------------------------------------------------------------------------

test("canonicalJson is key-order independent and hashes are stable", (t) => {
  const a = { b: 1, a: { z: [1, 2], y: null } };
  const b = { a: { y: null, z: [1, 2] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":{"y":null,"z":[1,2]},"b":1}');
  assert.equal(computeIdentityHash(a), computeIdentityHash(b));
  assert.match(canonicalJson(validIdentityFixture()), /^\{/);
});

test("canonical bytes end with a single trailing newline", (t) => {
  const bytes = canonicalBytes({ x: 1 });
  assert.equal(bytes[bytes.length - 1], 0x0a);
  assert.equal(bytes[bytes.length - 2], 0x7d); // closing "}"
  assert.deepEqual(bytes, Buffer.from('{"x":1}\n', "utf8"));
});

// ---------------------------------------------------------------------------
// embedded identity validation (fail-closed)
// ---------------------------------------------------------------------------

test("valid embedded identity passes validation with computed identity hash", (t) => {
  const identity = validIdentityFixture();
  const verdict = validateEmbeddedIdentity(identity);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.errors, []);
  assert.match(computeIdentityHash(identity), /^[0-9a-f]{64}$/);
});

function assertMalformed(mutate, expectedFragment) {
  const identity = validIdentityFixture();
  mutate(identity);
  const verdict = validateEmbeddedIdentity(identity);
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.errors.some((message) => message.includes(expectedFragment)),
    `expected an error mentioning "${expectedFragment}", got: ${JSON.stringify(verdict.errors)}`,
  );
}

test("embedded identity rejects malformed variants", (t) => {
  assertMalformed((i) => { i.schemaVersion = 2; }, "schemaVersion");
  assertMalformed((i) => { i.name = "other"; }, "name");
  assertMalformed((i) => { i.productVersion = "1.1"; }, "productVersion");
  assertMalformed((i) => { i.releaseTag = "v9.9.9"; }, "releaseTag");
  assertMalformed((i) => { i.gitCommit = "abc1234"; }, "gitCommit");
  assertMalformed((i) => { i.gitCommit = COMMIT_A.toUpperCase(); }, "gitCommit");
  assertMalformed((i) => { i.gitTree = "z".repeat(40); }, "gitTree");
  assertMalformed((i) => { i.dirty = true; }, "dirty");
  assertMalformed((i) => { i.packageLockHash = "e".repeat(63); }, "packageLockHash");
  assertMalformed((i) => { i.generatedAtUtc = "not-a-date"; }, "generatedAtUtc");
  assertMalformed((i) => { i.wireContracts = { adapters: [] }; }, "wireContracts");
  assertMalformed((i) => { i.tools = {}; }, "tools.node");
  assertMalformed((i) => { i.tools.pkg = "6.22.0-test"; }, "tools.pkg");
  assertMalformed((i) => { i.tools.pyinstaller = "6.22.2-test"; }, "tools.pyinstaller");
  assertMalformed((i) => { delete i.tools.pyinstaller; }, "tools.pyinstaller");
  assertMalformed((i) => { i.surprise = 1; }, "unexpected key");
});

test("wire contract advisory pins the exact Syndocal adapter names", (t) => {
  // Changing this list is a deliberate DJ wire-contract change; it must be
  // updated together with server/dj-agent/config.js and syndocalClient.js.
  assert.deepEqual(WIRE_CONTRACT_ADVISORY.adapters.map((entry) => entry.adapter), [
    "syndocal-envelope-v2",
  ]);
  assertMalformed(
    (i) => { i.wireContracts = { adapters: [{ adapter: "syndocal-envelope-v1", wireProtocol: "syndocal-envelope-v1" }] }; },
    "wireContracts",
  );
});

// ---------------------------------------------------------------------------
// packaged resolution: exe binding, embedded commitment, env-forgery
// resistance, fail-closed startup
// ---------------------------------------------------------------------------

// Writes a complete packaged fixture: server.exe stand-in bytes, a canonical
// sidecar build-identity.json bound to those bytes, and the matching embedded
// commitment so callers can simulate the compiled-in module.
function writePackagedFixture(t, { coreOverrides, mutateSidecar, mutateExe } = {}) {
  const exeDir = tempDir(t);
  const exeBytes = crypto.randomBytes(512);
  if (mutateExe) mutateExe(exeBytes);
  fs.writeFileSync(path.join(exeDir, "server.exe"), exeBytes);
  const measured = crypto.createHash("sha256").update(exeBytes).digest("hex");
  const identity = validIdentityFixture();
  if (coreOverrides) Object.assign(identity, coreOverrides);
  const sidecar = {
    ...identity,
    executableBinding: { kind: EXECUTABLE_BINDING_KIND, exeSha256: measured },
  };
  if (mutateSidecar) mutateSidecar(sidecar);
  writeCanonical(path.join(exeDir, IDENTITY_FILENAME), sidecar);
  const commitment = commitmentFixture(computeCoreIdentityHash(sidecar));
  return { exeDir, identity, sidecar, commitment, exeHash: measured };
}

test("valid packaged fixture verifies end-to-end and ignores runtime env vars", (t) => {
  const fx = writePackagedFixture(t);
  const forgedEnv = {
    RB_OUTPUT_GIT_COMMIT: "f".repeat(40),
    RB_OUTPUT_SOURCE_FINGERPRINT: "deadbeefcafe",
  };
  const resolved = resolveBuildIdentity({
    isPackaged: true,
    exeDir: fx.exeDir,
    execPath: path.join(fx.exeDir, "server.exe"),
    embeddedCommitment: fx.commitment,
    env: forgedEnv,
  });
  assert.equal(resolved.provenance.status, "verified-packaged");
  assert.equal(resolved.provenance.commitmentVerified, true);
  assert.equal(resolved.provenance.identityHash, fx.commitment.identityHash);
  assert.equal(resolved.provenance.measuredExeSha256, fx.exeHash);
  assert.equal(resolved.provenance.exeSha256, fx.exeHash);
  assert.equal(resolved.gitCommit, fx.identity.gitCommit);
  assert.equal(resolved.provenance.releaseTag, "v1.1.1");
  assert.equal(resolved.provenance.dirty, false);
  const serialized = JSON.stringify(resolved);
  assert.equal(serialized.includes(forgedEnv.RB_OUTPUT_SOURCE_FINGERPRINT), false);
  assert.equal(serialized.includes(forgedEnv.RB_OUTPUT_GIT_COMMIT), false);
});

test("ATTACK old-release replay: foreign sidecar next to a different exe fails closed", (t) => {
  // A package of release A (sidecar A + commitment A) replayed against an exe
  // whose embedded commitment covers a DIFFERENT release identity.
  const fx = writePackagedFixture(t);
  assert.throws(
    () => resolveBuildIdentity({
      isPackaged: true,
      exeDir: fx.exeDir,
      execPath: path.join(fx.exeDir, "server.exe"),
      embeddedCommitment: commitmentFixture("c".repeat(64)),
    }),
    /does not cover this build-identity\.json/,
  );
});

test("ATTACK coherent foreign set: consistent sidecar+commitment against a replaced exe fails closed", (t) => {
  // Sidecar and commitment are internally consistent but the binary was
  // swapped: the running exe hashes differently than the bound value.
  const fx = writePackagedFixture(t);
  const tamperedTarget = tempDir(t);
  fs.cpSync(fx.exeDir, tamperedTarget, { recursive: true });
  fs.writeFileSync(path.join(tamperedTarget, "server.exe"), Buffer.from("MZ attacker rebuild"));
  assert.throws(
    () => resolveBuildIdentity({
      isPackaged: true,
      exeDir: tamperedTarget,
      execPath: path.join(tamperedTarget, "server.exe"),
      embeddedCommitment: fx.commitment,
    }),
    /does not match executableBinding\.exeSha256/,
  );
});

test("packaged provenance rejects linked exe directory, identity, and execution image", (t) => {
  const linkedRootFixture = writePackagedFixture(t);
  const linkedRoot = path.join(tempDir(t), "linked-release");
  try {
    fs.symlinkSync(linkedRootFixture.exeDir, linkedRoot, "junction");
  } catch {
    t.skip("directory junction creation unavailable");
    return;
  }
  assert.throws(
    () => resolveBuildIdentity({
      isPackaged: true,
      exeDir: linkedRoot,
      execPath: path.join(linkedRoot, "server.exe"),
      embeddedCommitment: linkedRootFixture.commitment,
    }),
    /symbolic link or junction/,
  );

  for (const fileName of [IDENTITY_FILENAME, "server.exe"]) {
    const fx = writePackagedFixture(t);
    const outside = path.join(tempDir(t), fileName);
    const target = path.join(fx.exeDir, fileName);
    fs.copyFileSync(target, outside);
    fs.rmSync(target);
    try {
      fs.symlinkSync(outside, target, "file");
    } catch {
      t.skip("file symlink creation unavailable");
      return;
    }
    assert.throws(
      () => resolveBuildIdentity({
        isPackaged: true,
        exeDir: fx.exeDir,
        execPath: path.join(fx.exeDir, "server.exe"),
        embeddedCommitment: fx.commitment,
      }),
      /symbolic link or junction/,
      fileName,
    );
  }
});

test("ATTACK stripped or forged embedded commitment fails closed in packaged mode", (t) => {
  const intact = writePackagedFixture(t);
  for (const missing of [null, undefined]) {
    assert.throws(
      () => resolveBuildIdentity({
        isPackaged: true,
        exeDir: intact.exeDir,
        execPath: path.join(intact.exeDir, "server.exe"),
        embeddedCommitment: missing,
      }),
      /embedded release commitment/,
    );
  }
  assert.throws(
    () => resolveBuildIdentity({
      isPackaged: true,
      exeDir: intact.exeDir,
      execPath: path.join(intact.exeDir, "server.exe"),
      embeddedCommitment: commitmentFixture("e".repeat(64)),
    }),
    /does not cover this build-identity\.json/,
  );
});

test("packaged mode rejects missing or unreadable build-identity.json before server start", (t) => {
  const missingDir = tempDir(t);
  assert.throws(
    () => resolveBuildIdentity({ isPackaged: true, exeDir: missingDir }),
    /missing or unreadable/,
  );
  const emptyDir = tempDir(t);
  fs.writeFileSync(path.join(emptyDir, IDENTITY_FILENAME), "");
  assert.throws(
    () => resolveBuildIdentity({ isPackaged: true, exeDir: emptyDir }),
    /not valid JSON/,
  );
});

test("packaged mode rejects malformed sidecars with reasons", (t) => {
  const cases = [
    ["dirty", (i) => { i.dirty = true; }],
    ["40-char lowercase hex", (i) => { i.gitCommit = "cdd90e1"; }],
    ["releaseTag", (i) => { i.releaseTag = "v1.0.0"; }],
    ["unexpected key", (i) => { i.extra = true; }],
    ["wireContracts", (i) => { i.wireContracts = {}; }],
    ["executableBinding must be an object", (i) => { delete i.executableBinding; }],
    ["kind must be", (i) => { i.executableBinding.kind = "bogus"; }],
    ["exeSha256 must be 64-char", (i) => { i.executableBinding.exeSha256 = "zz"; }],
  ];
  for (const [expectedFragment, mutate] of cases) {
    const { exeDir } = writePackagedFixture(t, { mutateSidecar: mutate });
    assert.throws(
      () => resolveBuildIdentity({
        isPackaged: true,
        exeDir,
        execPath: path.join(exeDir, "server.exe"),
        embeddedCommitment: commitmentFixture(EXE_HASH_A),
      }),
      (error) => error.message.includes(expectedFragment),
      `expected rejection mentioning "${expectedFragment}"`,
    );
  }
  // Non-canonical bytes must still parse; content rules decide.
  const pretty = writePackagedFixture(t);
  fs.writeFileSync(
    path.join(pretty.exeDir, IDENTITY_FILENAME),
    JSON.stringify(pretty.sidecar, null, 2),
  );
  const resolved = resolveBuildIdentity({
    isPackaged: true,
    exeDir: pretty.exeDir,
    execPath: path.join(pretty.exeDir, "server.exe"),
    embeddedCommitment: pretty.commitment,
  });
  assert.equal(resolved.provenance.status, "verified-packaged");
});

test("dev mode keeps legacy env-derived fields and marks provenance unverified", (t) => {
  const fixedNow = () => "2026-08-25T00:00:00.000Z";
  const dev = resolveBuildIdentity({
    isPackaged: false,
    now: fixedNow,
    env: { RB_OUTPUT_GIT_COMMIT: COMMIT_A },
  });
  assert.equal(dev.gitCommit, COMMIT_A);
  assert.equal(dev.sourceFingerprint, null);
  assert.equal(dev.generatedAt, fixedNow());
  assert.equal(dev.provenance.status, "dev-unverified");
  assert.equal(dev.provenance.identityHash, null);
});

// ---------------------------------------------------------------------------
// release preflight via seams (never touches the real repository)
// ---------------------------------------------------------------------------

function preflightFixture(t, { dirtyOutput = "", head = COMMIT_A, tree = TREE, tagCommit = COMMIT_A, describe = "v1.1.1", tagObjectType = "tag", versions = {} } = {}) {
  const projectRoot = tempDir(t);
  const productVersion = versions.package ?? "1.1.1";
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify({
      name: "rb-output",
      version: productVersion,
      devDependencies: { "@yao-pkg/pkg": versions.pkgDeclared ?? "6.22.0" },
    }),
  );
  fs.writeFileSync(
    path.join(projectRoot, "package-lock.json"),
    JSON.stringify({
      name: "rb-output",
      version: versions.lockRoot ?? "1.1.1",
      packages: {
        "": {
          name: "rb-output",
          version: versions.lockSelf ?? "1.1.1",
          devDependencies: { "@yao-pkg/pkg": versions.pkgLockRoot ?? "6.22.0" },
        },
        "node_modules/@yao-pkg/pkg": { version: versions.pkgLockNode ?? "6.22.0" },
      },
    }),
  );
  fs.writeFileSync(
    path.join(projectRoot, "installer.iss"),
    `AppVersion=${versions.installer ?? "1.1.1"}\n`,
  );
  const git = (args) => {
    if (args.includes("--porcelain")) {
      if (dirtyOutput === "__throw__") throw new Error("simulated git failure");
      return dirtyOutput;
    }
    if (args[1] === "HEAD") {
      if (head === "__throw__") throw new Error("simulated git failure");
      return head;
    }
    if (args[1] === "HEAD^{tree}") return tree;
    if (args[1] === "v1.1.1^{commit}") {
      if (tagCommit === "__missing__") throw new Error("fatal: Needed a single revision");
      return tagCommit;
    }
    if (args[0] === "cat-file" && args[1] === "-t" && args[2] === "v1.1.1") {
      if (tagObjectType === "__throw__") throw new Error("fatal: Not a valid object name v1.1.1");
      return tagObjectType;
    }
    if (args[0] === "describe") {
      if (describe === "__missing__") throw new Error("fatal: no tag exactly matches");
      return describe;
    }
    throw new Error(`unexpected git args: ${args.join(" ")}`);
  };
  return { projectRoot, git };
}

function trustedGitFixture(t) {
  const projectRoot = tempDir(t, "rb-trusted-git-");
  const gitDir = path.join(projectRoot, ".git");
  for (const relativePath of ["objects/info", "refs", "info"]) {
    fs.mkdirSync(path.join(gitDir, relativePath), { recursive: true });
  }
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n");
  return { projectRoot, gitDir };
}

function virtualTrustedGitFs() {
  // Unit tests must not depend on a workstation installing Git in Program
  // Files. Production does not have this seam: it always lstat/realpaths the
  // exact path itself.
  const normalized = (value) => path.win32.normalize(value).replace(/[\\/]+$/, "").toLowerCase();
  const dirs = new Set([
    normalized("C:\\"),
    normalized("C:\\Program Files"),
    normalized("C:\\Program Files\\Git"),
    normalized("C:\\Program Files\\Git\\cmd"),
  ]);
  const file = normalized(preflightTestApi.TRUSTED_WINDOWS_GIT_EXECUTABLE);
  const isVirtual = (target) => dirs.has(normalized(target)) || normalized(target) === file;
  const fakeStats = (target) => ({
    isDirectory: () => dirs.has(normalized(target)),
    isFile: () => normalized(target) === file,
    isSymbolicLink: () => false,
  });
  const realpathSync = (target) => (isVirtual(target) ? target : fs.realpathSync(target));
  realpathSync.native = (target) => (isVirtual(target) ? target : fs.realpathSync.native(target));
  return {
    ...fs,
    lstatSync: (target) => (isVirtual(target) ? fakeStats(target) : fs.lstatSync(target)),
    realpathSync,
  };
}

function createCapturedTrustedGitRunner(t, environment = {}) {
  const fixture = trustedGitFixture(t);
  const calls = [];
  const runner = preflightTestApi.createTrustedGitRunner(fixture.projectRoot, {
    platform: "win32",
    environment,
    fsApi: virtualTrustedGitFs(),
    execFile: (file, args, options) => {
      calls.push({ file, args, options });
      return "";
    },
  });
  return { ...fixture, calls, runner };
}

test("trusted default Git ignores PATH shim, pins git-dir/work-tree, and scrubs caller GIT config", (t) => {
  const { projectRoot, gitDir, calls, runner } = createCapturedTrustedGitRunner(t, {
    PATH: "C:\\attacker-shim;C:\\Windows\\System32",
    GIT_DIR: "C:\\attacker\\.git",
    GIT_WORK_TREE: "C:\\attacker",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "alias.status",
    GIT_CONFIG_VALUE_0: "!attacker-command",
    GIT_CONFIG_GLOBAL: "C:\\attacker\\.gitconfig",
    GIT_REPLACE_REF_BASE: "refs/replace-attacker",
  });
  assert.equal(runner(["status", "--porcelain"], projectRoot), "");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, preflightTestApi.TRUSTED_WINDOWS_GIT_EXECUTABLE);
  assert.deepEqual(calls[0].args, [
    `--git-dir=${gitDir}`,
    `--work-tree=${projectRoot}`,
    "--no-replace-objects",
    "--no-pager",
    "status",
    "--porcelain",
  ]);
  assert.equal(calls[0].options.cwd, projectRoot);
  assert.equal(calls[0].options.env.PATH, "C:\\attacker-shim;C:\\Windows\\System32");
  assert.equal(calls[0].options.env.GIT_DIR, gitDir);
  assert.equal(calls[0].options.env.GIT_WORK_TREE, projectRoot);
  assert.equal(calls[0].options.env.GIT_CONFIG_GLOBAL, "NUL");
  assert.equal(calls[0].options.env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(calls[0].options.env.GIT_CONFIG_COUNT, "0");
  assert.equal(calls[0].options.env.GIT_NO_REPLACE_OBJECTS, "1");
  assert.equal(calls[0].options.env.GIT_CONFIG_KEY_0, undefined);
  assert.equal(calls[0].options.env.GIT_CONFIG_VALUE_0, undefined);
  assert.equal(calls[0].options.env.GIT_REPLACE_REF_BASE, undefined);
});

test("trusted default Git rejects unknown platform and an unexpected work-tree", (t) => {
  const { projectRoot } = trustedGitFixture(t);
  assert.throws(
    () => preflightTestApi.createTrustedGitRunner(projectRoot, {
      platform: "linux",
      fsApi: virtualTrustedGitFs(),
    }),
    /supported only on Windows/,
  );

  assert.throws(
    () => preflightTestApi.createTrustedGitRunner(projectRoot, {
      platform: "win32",
      trustedGitExecutable: "C:\\attacker\\git.exe",
      fsApi: virtualTrustedGitFs(),
    }),
    /must be exactly C:\\Program Files\\Git\\cmd\\git\.exe/,
  );

  const { runner } = createCapturedTrustedGitRunner(t);
  assert.throws(
    () => runner(["status", "--porcelain"], path.join(projectRoot, "other")),
    /outside the fixed project root/,
  );
});

test("trusted default Git rejects linked worktrees, alternates, replace refs, and graft metadata", (t) => {
  const cases = [
    ["object alternates", "objects/info/alternates", "Git object alternates"],
    ["HTTP alternates", "objects/info/http-alternates", "Git HTTP object alternates"],
    ["replace refs", "refs/replace", "Git replace refs"],
    ["linked worktree", "worktrees/other", "Git linked-worktree metadata"],
    ["commondir", "commondir", "Git linked-worktree commondir"],
    ["gitdir", "gitdir", "Git linked-worktree gitdir"],
    ["config.worktree", "config.worktree", "Git linked-worktree config"],
    ["shallow history", "shallow", "Git shallow history metadata"],
    ["graft metadata", "info/grafts", "Git graft metadata"],
  ];
  for (const [name, relativePath, expected] of cases) {
    const { projectRoot, gitDir } = trustedGitFixture(t);
    const target = path.join(gitDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (relativePath.endsWith("replace") || relativePath.endsWith("other")) {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.writeFileSync(target, "attacker metadata\n");
    }
    assert.throws(
      () => preflightTestApi.createTrustedGitRunner(projectRoot, {
        platform: "win32",
        fsApi: virtualTrustedGitFs(),
      }),
      new RegExp(expected),
      name,
    );
  }

  const packed = trustedGitFixture(t);
  fs.writeFileSync(
    path.join(packed.gitDir, "packed-refs"),
    `${COMMIT_A} refs/replace/${COMMIT_B}\n`,
  );
  assert.throws(
    () => preflightTestApi.createTrustedGitRunner(packed.projectRoot, {
      platform: "win32",
      fsApi: virtualTrustedGitFs(),
    }),
    /packed-refs contains replace refs/,
  );
});

test("trusted default Git rejects .git files and reparse-point metadata", (t) => {
  const fileMetadata = trustedGitFixture(t);
  fs.rmSync(fileMetadata.gitDir, { recursive: true, force: true });
  fs.writeFileSync(fileMetadata.gitDir, "gitdir: C:/attacker/worktrees/release\n");
  assert.throws(
    () => preflightTestApi.createTrustedGitRunner(fileMetadata.projectRoot, {
      platform: "win32",
      fsApi: virtualTrustedGitFs(),
    }),
    /projectRoot\/.git must be a normal directory/,
  );

  const linked = trustedGitFixture(t);
  const actualGitDir = path.join(linked.projectRoot, "actual-git");
  fs.renameSync(linked.gitDir, actualGitDir);
  try {
    fs.symlinkSync(actualGitDir, linked.gitDir, "junction");
  } catch {
    t.skip("directory junction creation unavailable");
    return;
  }
  assert.throws(
    () => preflightTestApi.createTrustedGitRunner(linked.projectRoot, {
      platform: "win32",
      fsApi: virtualTrustedGitFs(),
    }),
    /symbolic link or junction|reparse point/,
  );

  const baseFs = virtualTrustedGitFs();
  const executableAsLink = {
    ...baseFs,
    lstatSync: (target) => {
      if (path.win32.normalize(target).toLowerCase() === preflightTestApi.TRUSTED_WINDOWS_GIT_EXECUTABLE.toLowerCase()) {
        return {
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => true,
        };
      }
      return baseFs.lstatSync(target);
    },
  };
  const executableFixture = trustedGitFixture(t);
  assert.throws(
    () => preflightTestApi.createTrustedGitRunner(executableFixture.projectRoot, {
      platform: "win32",
      fsApi: executableAsLink,
    }),
    /trusted Git executable is a symbolic link or junction/,
  );
});

test("preflight passes on clean tree, full SHAs, exact tag, matching versions", (t) => {
  const { projectRoot, git } = preflightFixture(t);
  const result = runPreflight({ projectRoot, git });
  assert.equal(result.ok, true);
  assert.equal(result.commit, COMMIT_A);
  assert.equal(result.tree, TREE);
  assert.equal(result.tag, "v1.1.1");
  assert.equal(result.productVersion, "1.1.1");
  assert.match(result.packageLockHash, /^[0-9a-f]{64}$/);
  // package-lock.json fixture bytes hash deterministically.
  const expectedHash = crypto.createHash("sha256")
    .update(fs.readFileSync(path.join(projectRoot, "package-lock.json")))
    .digest("hex");
  assert.equal(result.packageLockHash, expectedHash);
});

test("preflight rejects dirty trees and untracked files, reporting every path", (t) => {
  const dirty = preflightFixture(t, { dirtyOutput: " M server/index.js\n" });
  assert.throws(() => runPreflight({ projectRoot: dirty.projectRoot, git: dirty.git }), /server\/index\.js/);

  const untracked = preflightFixture(t, { dirtyOutput: "?? dist/new-artifact.bin\n" });
  try {
    runPreflight({ projectRoot: untracked.projectRoot, git: untracked.git });
    assert.fail("untracked file must fail preflight");
  } catch (error) {
    assert.match(error.message, /worktree-clean/);
    assert.match(error.message, /dist\/new-artifact\.bin/);
  }

  const both = preflightFixture(t, { dirtyOutput: " M a.txt\n?? b.txt\n" });
  assert.throws(
    () => runPreflight({ projectRoot: both.projectRoot, git: both.git }),
    /a\.txt[\s\S]*b\.txt/,
  );
});

test("preflight rejects non-full HEAD SHA", (t) => {
  const fx = preflightFixture(t, { head: "cdd90e1" });
  assert.throws(
    () => runPreflight({ projectRoot: fx.projectRoot, git: fx.git }),
    /full 40-char hex SHA.*cdd90e1/s,
  );
});

test("preflight rejects HEAD/tag mismatch and non-exact tags", (t) => {
  const mismatched = preflightFixture(t, { tagCommit: COMMIT_B });
  assert.throws(
    () => runPreflight({ projectRoot: mismatched.projectRoot, git: mismatched.git }),
    /tag v1\.1\.1 resolves to .* expected HEAD/,
  );

  const notExact = preflightFixture(t, { describe: "v1.0.9-5-gdeadbee" });
  assert.throws(
    () => runPreflight({ projectRoot: notExact.projectRoot, git: notExact.git }),
    /head-exact-tag/,
  );

  const noTag = preflightFixture(t, { tagCommit: "__missing__", describe: "__missing__" });
  let failures;
  try {
    runPreflight({ projectRoot: noTag.projectRoot, git: noTag.git });
    assert.fail("missing tag must fail preflight");
  } catch (error) {
    failures = error.message;
  }
  assert.match(failures, /does not resolve/);
  assert.match(failures, /head-exact-tag/);
});

test("preflight requires an ANNOTATED tag object and rejects lightweight tags", (t) => {
  const annotated = preflightFixture(t, { tagObjectType: "tag" });
  const ok = runPreflight({ projectRoot: annotated.projectRoot, git: annotated.git });
  const recorded = ok.checks.find((check) => check.name === "tag-object-annotated");
  assert.equal(recorded.ok, true);
  assert.match(recorded.detail, /annotated tag object/);

  // Lightweight tag: cat-file -t says "commit" -> fail closed.
  const lightweight = preflightFixture(t, { tagObjectType: "commit" });
  try {
    runPreflight({ projectRoot: lightweight.projectRoot, git: lightweight.git });
    assert.fail("lightweight tag must fail preflight");
  } catch (error) {
    assert.match(error.message, /tag-object-annotated/);
    assert.match(error.message, /lightweight/);
    assert.match(error.message, /annotated tag is required/);
  }

  // Blob/tree types or a failing cat-file are equally unacceptable.
  const blobType = preflightFixture(t, { tagObjectType: "blob" });
  assert.throws(
    () => runPreflight({ projectRoot: blobType.projectRoot, git: blobType.git }),
    /is a blob object \(lightweight\)/,
  );
  const brokenGit = preflightFixture(t, { tagObjectType: "__throw__" });
  assert.throws(
    () => runPreflight({ projectRoot: brokenGit.projectRoot, git: brokenGit.git }),
    /cannot prove an annotated tag/,
  );
});

test("preflight rejects package/package-lock/installer version mismatches together", (t) => {
  const fx = preflightFixture(t, { versions: { lockRoot: "1.1.0", installer: "1.2.0" } });
  try {
    runPreflight({ projectRoot: fx.projectRoot, git: fx.git });
    assert.fail("version mismatch must fail preflight");
  } catch (error) {
    assert.match(error.message, /version-triple-match/);
    assert.match(error.message, /package-lock\.json version 1\.1\.0/);
    assert.match(error.message, /installer\.iss AppVersion 1\.2\.0/);
  }
  // A broken package.json also surfaces as its own failure.
  const broken = preflightFixture(t);
  fs.writeFileSync(path.join(broken.projectRoot, "package.json"), "{not json");
  assert.throws(
    () => runPreflight({ projectRoot: broken.projectRoot, git: broken.git }),
    /package-version/,
  );
});

test("preflight requires the tracked exact pkg devDependency and lock entry", (t) => {
  for (const versions of [
    { pkgDeclared: "^6.22.0" },
    { pkgDeclared: "6.22.1" },
    { pkgLockRoot: "6.22.1" },
    { pkgLockNode: "6.22.1" },
  ]) {
    const fx = preflightFixture(t, { versions });
    assert.throws(
      () => runPreflight({ projectRoot: fx.projectRoot, git: fx.git }),
      /pkg-(?:devdependency|package-lock)-pin/,
    );
  }
});

// ---------------------------------------------------------------------------
// install manifest: staging, tampering, verification
// ---------------------------------------------------------------------------

function installFixture(t) {
  const installRoot = tempDir(t);
  fs.mkdirSync(path.join(installRoot, "native", "bin"), { recursive: true });
  fs.mkdirSync(path.join(installRoot, "public"), { recursive: true });
  const payloadBytes = {
    "server.exe": crypto.randomBytes(256),
    "native/bin/rb_hook.dll": crypto.randomBytes(128),
    "start-rb.bat": Buffer.from("@echo off\r\n"),
    "public/app.js": Buffer.from("// app\n"),
  };
  for (const [rel, data] of Object.entries(payloadBytes)) {
    fs.writeFileSync(path.join(installRoot, ...rel.split("/")), data);
  }
  // Shipped sidecar: core identity plus the binding to the packaged exe.
  const identity = sidecarFixture(
    crypto.createHash("sha256").update(payloadBytes["server.exe"]).digest("hex"),
  );
  writeCanonical(path.join(installRoot, IDENTITY_FILENAME), identity);
  const manifest = buildInstallManifest({
    installRoot,
    payloads: [
      "server.exe",
      "native/bin/rb_hook.dll",
      "start-rb.bat",
      "public/app.js",
      IDENTITY_FILENAME,
    ],
    identity,
  });
  writeCanonical(path.join(installRoot, "install-manifest.json"), manifest);
  return { installRoot, identity, manifest, payloadBytes };
}

test("install manifest lists nested payloads sorted with size+sha256 and binds the CORE identity hash", (t) => {
  const { manifest, identity } = installFixture(t);
  assert.equal(manifest.kind, "rb-output-install-manifest/v1");
  // Binding is against the commitment-covered core, not the sidecar bytes.
  assert.equal(manifest.identityHash, computeCoreIdentityHash(identity));
  assert.notEqual(manifest.identityHash, computeIdentityHash(identity));
  assert.deepEqual(manifest.payloads.map((p) => p.path), [
    "build-identity.json",
    "native/bin/rb_hook.dll",
    "public/app.js",
    "server.exe",
    "start-rb.bat",
  ]);
  const serverEntry = manifest.payloads.find((p) => p.path === "server.exe");
  assert.equal(serverEntry.bytes, 256);
  assert.match(serverEntry.sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.payloads.filter((p) => p.path === "install-manifest.json").length, 0);
});

test("verifier accepts an intact installed tree", (t) => {
  const { installRoot } = installFixture(t);
  const result = verifyInstallTree(installRoot);
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.failures.length, 0);
});

test("verifier rejects a one-byte payload modification", (t) => {
  const { installRoot } = installFixture(t);
  const target = path.join(installRoot, "server.exe");
  const bytes = fs.readFileSync(target);
  bytes[0] ^= 0x01;
  fs.writeFileSync(target, bytes);
  const result = verifyInstallTree(installRoot);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.startsWith("sha256 mismatch for server.exe")));
});

test("verifier rejects missing payloads", (t) => {
  const { installRoot } = installFixture(t);
  fs.rmSync(path.join(installRoot, "native", "bin", "rb_hook.dll"));
  const result = verifyInstallTree(installRoot);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.includes("missing payload: native/bin/rb_hook.dll")));
});

test("verifier rejects non-canonical and tampered manifests", (t) => {
  // Pretty-printed rewrite breaks canonical byte format.
  const prettyRoot = tempDir(t);
  const { manifest, installRoot } = installFixture(t);
  fs.cpSync(installRoot, prettyRoot, { recursive: true });
  fs.writeFileSync(path.join(prettyRoot, "install-manifest.json"), JSON.stringify(manifest, null, 2));
  const prettyResult = verifyInstallTree(prettyRoot);
  assert.equal(prettyResult.ok, false);
  assert.ok(prettyResult.failures.some((f) => f.includes("canonical")));

  // Semantically re-canonicalized manifest with a flipped identity hash char
  // passes format checks but must fail the identity binding.
  const semanticRoot = tempDir(t);
  fs.cpSync(installRoot, semanticRoot, { recursive: true });
  const tampered = structuredClone(manifest);
  const firstChar = tampered.identityHash[0];
  tampered.identityHash = `${firstChar === "0" ? "1" : "0"}${tampered.identityHash.slice(1)}`;
  writeCanonical(path.join(semanticRoot, "install-manifest.json"), tampered);
  const semanticResult = verifyInstallTree(semanticRoot);
  assert.equal(semanticResult.ok, false);
  assert.ok(semanticResult.failures.some((f) => f.includes("identity")));
});

test("verifier rejects traversal paths and warns about unlisted extras", (t) => {
  const evilRoot = tempDir(t);
  const { installRoot, identity } = installFixture(t);
  fs.cpSync(installRoot, evilRoot, { recursive: true });
  const evilManifest = {
    schemaVersion: 1,
    kind: "rb-output-install-manifest/v1",
    productVersion: identity.productVersion,
    identityHash: computeCoreIdentityHash(identity),
    payloads: [{ path: "../outside.exe", bytes: 1, sha256: "0".repeat(64) }],
  };
  writeCanonical(path.join(evilRoot, "install-manifest.json"), evilManifest);
  const evilResult = verifyInstallTree(evilRoot);
  assert.equal(evilResult.ok, false);
  assert.ok(evilResult.failures.some((f) => f.includes("unsafe payload path rejected")));

  const extraRoot = tempDir(t);
  fs.cpSync(installRoot, extraRoot, { recursive: true });
  fs.writeFileSync(path.join(extraRoot, "operator-notes.txt"), "local only\n");
  const extraResult = verifyInstallTree(extraRoot);
  assert.equal(extraResult.ok, true);
  assert.ok(extraResult.warnings.some((w) => w.includes("operator-notes.txt")));
});

// ---------------------------------------------------------------------------
// CLI integration (real repo read-only; outputs go to temp fixtures)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CLI integration (hermetic temp git repo; never touches the real repository)
// ---------------------------------------------------------------------------

function makeTempGitRepo(t) {
  const repo = tempDir(t);
  const git = (args) =>
    spawnSync("git", [
      "-C", repo,
      "-c", "user.email=qa@example.invalid",
      "-c", "user.name=qa",
      "-c", "commit.gpgsign=false",
      ...args,
    ], { encoding: "utf8" });
  assert.equal(git(["init"]).status, 0);
  fs.writeFileSync(
    path.join(repo, "package.json"),
    JSON.stringify({
      name: "rb-output",
      version: "1.1.1",
      devDependencies: { "@yao-pkg/pkg": "6.22.0" },
    }),
  );
  fs.writeFileSync(
    path.join(repo, "package-lock.json"),
    JSON.stringify({
      name: "rb-output",
      version: "1.1.1",
      packages: {
        "": {
          name: "rb-output",
          version: "1.1.1",
          devDependencies: { "@yao-pkg/pkg": "6.22.0" },
        },
        "node_modules/@yao-pkg/pkg": { version: "6.22.0" },
      },
    }),
  );
  fs.writeFileSync(path.join(repo, "installer.iss"), "AppVersion=1.1.1\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "dist/\n");
  // Empty directories are not Git entries, but release build-dist creates
  // dist before the no-follow identity generator writes into it.
  fs.mkdirSync(path.join(repo, "dist"), { recursive: true });
  assert.equal(git(["add", "-A"]).status, 0);
  assert.equal(git(["commit", "-m", "fixture"]).status, 0);
  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  // Release tags must be ANNOTATED tag objects (preflight rejects lightweight).
  assert.equal(git(["tag", "-a", "v1.1.1", "-m", "release v1.1.1"]).status, 0);
  assert.equal(git(["cat-file", "-t", "v1.1.1"]).stdout.trim(), "tag");
  return { repo, head };
}

test("generate-build-identity CLI emits the commitment module bound to the identity", (t) => {
  const { repo } = makeTempGitRepo(t);
  const outPath = path.join(repo, "dist", IDENTITY_FILENAME);
  const modulePath = path.join(repo, "dist", "embedded-commitment.js");
  const spawned = spawnSync(process.execPath, [
    path.join(REPO_ROOT, "scripts", "generate-build-identity.js"),
    "--project-root", repo,
    "--out", outPath,
    "--emit-module", modulePath,
    "--tool", "pkg=6.22.0",
    "--tool", "pyinstaller=6.22.2",
  ], { encoding: "utf8" });
  assert.equal(spawned.status, 0, spawned.stderr || spawned.stdout);
  const raw = fs.readFileSync(outPath);
  const identity = JSON.parse(raw.toString("utf8"));
  assert.equal(validateEmbeddedIdentity(identity).ok, true);
  assert.deepEqual(identity.wireContracts, WIRE_CONTRACT_ADVISORY);
  assert.equal(identity.tools.pkg, "6.22.0");
  assert.equal(identity.tools.pyinstaller, "6.22.2");
  assert.ok(spawned.stdout.includes(computeIdentityHash(identity)));
  assert.deepEqual(raw, canonicalBytes(identity));

  // The generated module must be loadable and commit to EXACTLY this identity.
  const { EMBEDDED_RELEASE_COMMITMENT } = require(modulePath);
  assert.equal(validateEmbeddedReleaseCommitment(EMBEDDED_RELEASE_COMMITMENT).ok, true);
  assert.equal(EMBEDDED_RELEASE_COMMITMENT.identityHash, computeIdentityHash(identity));
  // The commitment covers only immutable identity fields: wrapping the SAME
  // core in a sidecar with any executableBinding never moves the hash (no
  // circular exe-self-hash commitment).
  const rebound = {
    ...identity,
    executableBinding: { kind: EXECUTABLE_BINDING_KIND, exeSha256: EXE_HASH_B },
  };
  assert.equal(EMBEDDED_RELEASE_COMMITMENT.identityHash, computeCoreIdentityHash(rebound));

  // A dirty temp-repo tree must abort generation with a non-zero exit.
  fs.writeFileSync(path.join(repo, "untracked.txt"), "dirty\n");
  const dirtyRun = spawnSync(process.execPath, [
    path.join(REPO_ROOT, "scripts", "generate-build-identity.js"),
    "--project-root", repo,
    "--out", path.join(repo, "dist", "should-not-exist.json"),
    "--tool", "pkg=6.22.0",
    "--tool", "pyinstaller=6.22.2",
  ], { encoding: "utf8" });
  assert.notEqual(dirtyRun.status, 0);
  assert.match(dirtyRun.stderr, /worktree-clean|untracked/);
  assert.equal(fs.existsSync(path.join(repo, "dist", "should-not-exist.json")), false);
});

test("generate-build-identity rejects linked identity output before writing", (t) => {
  const { repo } = makeTempGitRepo(t);
  const outside = path.join(tempDir(t), IDENTITY_FILENAME);
  fs.writeFileSync(outside, "attacker sidecar\n");
  const output = path.join(repo, "dist", IDENTITY_FILENAME);
  try {
    fs.symlinkSync(outside, output, "file");
  } catch {
    t.skip("file symlink creation unavailable");
    return;
  }
  const run = spawnSync(process.execPath, [
    path.join(REPO_ROOT, "scripts", "generate-build-identity.js"),
    "--project-root", repo,
    "--out", output,
    "--tool", "pkg=6.22.0",
    "--tool", "pyinstaller=6.22.2",
  ], { encoding: "utf8" });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /symbolic link or junction/);
});

test("verify-install CLI exits zero on intact fixtures and non-zero on tampering", (t) => {
  const { installRoot } = installFixture(t);
  const okRun = spawnSync(process.execPath, [
    path.join(REPO_ROOT, "scripts", "verify-install.js"),
    "--install-dir", installRoot,
  ], { encoding: "utf8" });
  assert.equal(okRun.status, 0, okRun.stderr || okRun.stdout);
  assert.match(okRun.stdout, /verification OK/);
  assert.match(okRun.stdout, /server\.exe coherence verified/);

  const bytes = fs.readFileSync(path.join(installRoot, "start-rb.bat"));
  bytes[bytes.length - 1] ^= 0xff;
  fs.writeFileSync(path.join(installRoot, "start-rb.bat"), bytes);
  const badRun = spawnSync(process.execPath, [
    path.join(REPO_ROOT, "scripts", "verify-install.js"),
    "--install-dir", installRoot,
  ], { encoding: "utf8" });
  assert.equal(badRun.status, 1);
  assert.match(badRun.stderr, /sha256 mismatch for start-rb\.bat/);
});

test("verify-install CLI rejects a sidecar whose exe binding points elsewhere", (t) => {
  const { installRoot, identity } = installFixture(t);
  const rebound = structuredClone(identity);
  rebound.executableBinding.exeSha256 = EXE_HASH_B;
  writeCanonical(path.join(installRoot, IDENTITY_FILENAME), rebound);
  // Manifest still lists the ORIGINAL sidecar bytes -> payload mismatch fires;
  // even with a rebuilt manifest the coherence layer must reject the binding.
  const manifest = buildInstallManifest({
    installRoot,
    payloads: ["server.exe", IDENTITY_FILENAME],
    identity: rebound,
  });
  writeCanonical(path.join(installRoot, "install-manifest.json"), manifest);
  const run = spawnSync(process.execPath, [
    path.join(REPO_ROOT, "scripts", "verify-install.js"),
    "--install-dir", installRoot,
  ], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /does not match measured server\.exe hash|executableBinding/);
});

// ---------------------------------------------------------------------------
// pkg bundling contract: the generated commitment MUST be compiled into
// server.exe. These always-on regressions pin every leg of that guarantee so
// reintroducing a dynamic require, moving the module outside the pkg.scripts
// globs, or tracking generated debris fails here — before a release build.
// ---------------------------------------------------------------------------

const COMMITMENT_RELPATH = "server/embedded-commitment.js";

function globCovers(pattern, relPath) {
  // Minimal glob semantics for pkg.scripts entries: ** crosses directories,
  // * does not. Enough to prove static coverage of one known path.
  const rx = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("**", "\u0000")
    .replaceAll("*", "[^/]*")
    .replaceAll("\u0000/", "(?:.*/)?")
    .replaceAll("\u0000", ".*");
  return new RegExp(`^${rx}$`).test(relPath);
}

test("PACKAGING CONTRACT commitment require is a string literal pkg can statically follow", () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, "server", "buildIdentity.js"), "utf8");
  // The exact literal pairing with the generator's emit path.
  assert.ok(
    source.includes('require("./embedded-commitment.js")'),
    "buildIdentity must require ./embedded-commitment.js via a string literal",
  );
  // Adversarial: any require of the commitment reached through a variable,
  // concatenation, or indirection is invisible to @yao-pkg/pkg's static
  // analyzer and would silently omit the module from server.exe (an earlier
  // P0). Every require mentioning the commitment module must take a direct
  // string literal argument.
  const commitmentRequires = [...source.matchAll(/require\(\s*([^)]*[Ee]mbedded[^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(commitmentRequires.length >= 1, "commitment module require not found");
  for (const arg of commitmentRequires) {
    assert.match(
      arg,
      /^["']\.\/embedded-commitment\.js["']$/,
      `commitment require argument must be the literal "./embedded-commitment.js", got: ${arg}`,
    );
  }
  assert.equal(source.includes("EMBEDDED_COMMITMENT_MODULE"), false);
});

test("PACKAGING CONTRACT pkg.scripts globs cover the generated commitment module", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  const scriptGlobs = pkg.pkg?.scripts ?? [];
  assert.ok(
    scriptGlobs.some((pattern) => globCovers(pattern, COMMITMENT_RELPATH)),
    `no pkg.scripts pattern covers ${COMMITMENT_RELPATH}; got ${JSON.stringify(scriptGlobs)}`,
  );
  // And the generator's documented emit target matches the required literal.
  const generator = fs.readFileSync(path.join(REPO_ROOT, "scripts", "build-dist.ps1"), "utf8");
  assert.match(generator, /--emit-module "server\\embedded-commitment\.js"/);
});

test("PACKAGING CONTRACT the generated module stays out of the Git tree", () => {
  const gitignore = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8");
  const lines = gitignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.ok(
    lines.some((line) => line === "/server/embedded-commitment.js"),
    ".gitignore must exclude /server/embedded-commitment.js",
  );
});

test("generated commitment module pairs with buildIdentity literal path in a hermetic layout", (t) => {
  // Prove the FILENAME contract end-to-end without writing into the repo:
  // copy the real buildIdentity.js next to a real generated commitment module
  // (same relative layout as the packaged exe), then exercise both branches of
  // loadEmbeddedReleaseCommitment through fresh module instances.
  const { repo } = makeTempGitRepo(t);
  const work = tempDir(t);
  const serverDir = path.join(work, "server");
  fs.mkdirSync(serverDir, { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "server", "buildIdentity.js"),
    path.join(serverDir, "buildIdentity.js"),
  );
  const identityPath = path.join(repo, "dist", IDENTITY_FILENAME);
  const emittedModulePath = path.join(repo, "dist", "embedded-commitment.js");
  const emitted = spawnSync(process.execPath, [
    path.join(REPO_ROOT, "scripts", "generate-build-identity.js"),
    "--project-root", repo,
    "--out", identityPath,
    "--emit-module", emittedModulePath,
    "--tool", "pkg=6.22.0",
    "--tool", "pyinstaller=6.22.2",
  ], { encoding: "utf8" });
  assert.equal(emitted.status, 0, emitted.stderr || emitted.stdout);
  fs.copyFileSync(emittedModulePath, path.join(serverDir, "embedded-commitment.js"));

  const freshLoad = () => {
    // Drop BOTH cached modules so each load rebuilds the loader's internal
    // memoization from current disk state.
    delete require.cache[path.join(serverDir, "buildIdentity.js")];
    delete require.cache[path.join(serverDir, "embedded-commitment.js")];
    return require(path.join(serverDir, "buildIdentity.js"));
  };
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));

  // With the module present (packaged reality), it loads and commits to
  // exactly this identity hash.
  const withModule = freshLoad().loadEmbeddedReleaseCommitment();
  assert.equal(validateEmbeddedReleaseCommitment(withModule).ok, true);
  assert.equal(withModule.identityHash, computeIdentityHash(identity));

  // With the module absent (dev checkout or a broken package), the loader is
  // null and callers fail closed instead of crashing on require.
  fs.rmSync(path.join(serverDir, "embedded-commitment.js"));
  const withoutModule = freshLoad().loadEmbeddedReleaseCommitment();
  assert.equal(withoutModule, null);
});

test("parseManifestFile rejects wrong kind and schema", (t) => {
  const dir = tempDir(t);
  const manifestPath = path.join(dir, "manifest.json");
  assert.throws(
    () => parseManifestFile(manifestPath),
    /unreadable/,
  );
  writeCanonical(manifestPath, { schemaVersion: 99, kind: "something-else" });
  assert.throws(() => parseManifestFile(manifestPath, { expectedKind: "rb-output-install-manifest/v1" }), /kind|schemaVersion/);
});

// ---------------------------------------------------------------------------
// path traversal battery (slash AND backslash, drive/UNC, normalized escape)
// ---------------------------------------------------------------------------

test("payload path validator rejects the full traversal attack battery", () => {
  const evilPaths = [
    "../outside.exe",
    "..%2fout.exe",
    "a/../..",
    "public/../../server.exe",
    "..\\outside.exe",
    "public\\..\\..\\server.exe",
    "a\\b",
    "/abs/path.exe",
    "//server/share/x.dll",
    "\\\\server\\share\\x.dll",
    "C:/Windows/system32.dll",
    "C:\\Windows\\system32.dll",
    "c:relative.exe",
    "./x.exe",
    "public//app.js",
    "public/app.js/",
    "x/./y",
    "x/../y",
    "aux",
    "aux.txt",
    "AUX .txt",
    "AUX. .txt",
    "COM1",
    "COM1.dll",
    "COM1 .dll",
    "nested/LPT9 .log",
    "con/trojan.dll",
    "public/normal.txt:stream",
    "server.exe:payload",
    "x.",
    "x ",
    "x/y ",
    "%2e%2e/x",
    "",
    null,
    42,
    `${"a".repeat(513)}`,
    "trailing\0nul.exe",
    "bell\x07.exe",
  ];
  for (const evil of evilPaths) {
    assert.throws(
      () => assertSafePayloadRelPath(evil),
      /unsafe payload path rejected/,
      `expected rejection of ${JSON.stringify(evil)}`,
    );
  }
  // Benign canonical paths stay accepted.
  for (const good of ["server.exe", "native/bin/rb_hook.dll", "public/assets/x y.css"]) {
    assert.equal(assertSafePayloadRelPath(good), good);
  }
});

test("buildInstallManifest rejects duplicate payloads instead of silently deduping", (t) => {
  const { installRoot, identity } = installFixture(t);
  assert.throws(
    () => buildInstallManifest({
      installRoot,
      payloads: ["server.exe", "server.exe"],
      identity,
    }),
    /duplicate payload: server\.exe/,
  );
  // A benign directory payload still builds cleanly.
  const manifest = buildInstallManifest({ installRoot, payloads: ["public"], identity });
  assert.deepEqual(manifest.payloads.map((p) => p.path), ["public/app.js"]);
});

test("verifyInstallTree rejects every traversal encoding in a forged manifest", (t) => {
  const evilVariants = [
    "../outside.exe",
    "..\\outside.exe",
    "/abs.exe",
    "C:/abs.exe",
    "\\\\srv\\share\\x",
    "public/../../win.ini",
    "public//deep.js",
    "./rel.js",
  ];
  for (const evil of evilVariants) {
    const src = installFixture(t);
    const evilManifest = {
      schemaVersion: 1,
      kind: "rb-output-install-manifest/v1",
      productVersion: src.identity.productVersion,
      identityHash: computeCoreIdentityHash(src.identity),
      payloads: [{ path: evil, bytes: 1, sha256: "0".repeat(64) }],
    };
    writeCanonical(path.join(src.installRoot, "install-manifest.json"), evilManifest);
    const result = verifyInstallTree(src.installRoot);
    assert.equal(result.ok, false, `expected failure for ${evil}`);
    assert.ok(
      result.failures.some((f) => f.includes("unsafe payload path rejected")),
      `expected unsafe-path failure for ${evil}, got ${JSON.stringify(result.failures)}`,
    );
  }
});

test("buildInstallManifest fails closed on symlinks inside a directory payload", (t) => {
  const { installRoot, identity } = installFixture(t);
  const outside = path.join(tempDir(t), "secret.txt");
  fs.writeFileSync(outside, "secret\n");
  let linkMade = true;
  try {
    fs.symlinkSync(outside, path.join(installRoot, "public", "leak.txt"), "file");
  } catch {
    linkMade = false; // unprivileged environments may forbid symlinks
  }
  if (!linkMade) {
    t.skip("symlink creation unavailable");
    return;
  }
  assert.throws(
    () => buildInstallManifest({ installRoot, payloads: ["public"], identity }),
    /symbolic link or junction/,
  );
});

test("build and installed verification reject direct payload links and linked intermediate directories", (t) => {
  const direct = installFixture(t);
  const outsideFile = path.join(tempDir(t), "same-server.exe");
  fs.copyFileSync(path.join(direct.installRoot, "server.exe"), outsideFile);
  const directTarget = path.join(direct.installRoot, "server.exe");
  fs.rmSync(directTarget);
  try {
    fs.symlinkSync(outsideFile, directTarget, "file");
  } catch {
    t.skip("file symlink creation unavailable");
    return;
  }
  assert.throws(
    () => buildInstallManifest({
      installRoot: direct.installRoot,
      payloads: ["server.exe"],
      identity: direct.identity,
    }),
    /symbolic link or junction/,
  );
  const directVerify = verifyInstallTree(direct.installRoot);
  assert.equal(directVerify.ok, false);
  assert.ok(directVerify.failures.some((failure) => /symbolic link or junction/.test(failure)));

  const nested = installFixture(t);
  const outsideDir = tempDir(t);
  fs.mkdirSync(path.join(outsideDir, "public"), { recursive: true });
  fs.copyFileSync(
    path.join(nested.installRoot, "public", "app.js"),
    path.join(outsideDir, "public", "app.js"),
  );
  const publicTarget = path.join(nested.installRoot, "public");
  fs.rmSync(publicTarget, { recursive: true, force: true });
  try {
    // Junction is intentional: it exercises the Windows reparse mechanism
    // even where unprivileged file symlink creation is disabled.
    fs.symlinkSync(path.join(outsideDir, "public"), publicTarget, "junction");
  } catch {
    t.skip("directory junction creation unavailable");
    return;
  }
  assert.throws(
    () => buildInstallManifest({
      installRoot: nested.installRoot,
      payloads: ["public"],
      identity: nested.identity,
    }),
    /symbolic link or junction/,
  );
  const nestedVerify = verifyInstallTree(nested.installRoot);
  assert.equal(nestedVerify.ok, false);
  assert.ok(nestedVerify.failures.some((failure) => /symbolic link or junction/.test(failure)));
});

test("installed verification rejects linked manifest and identity sidecars before parsing", (t) => {
  for (const fileName of ["install-manifest.json", IDENTITY_FILENAME]) {
    const fx = installFixture(t);
    const outside = path.join(tempDir(t), fileName);
    const target = path.join(fx.installRoot, fileName);
    fs.copyFileSync(target, outside);
    fs.rmSync(target);
    try {
      fs.symlinkSync(outside, target, "file");
    } catch {
      t.skip("file symlink creation unavailable");
      return;
    }
    const result = verifyInstallTree(fx.installRoot);
    assert.equal(result.ok, false, fileName);
    assert.ok(
      result.failures.some((failure) => /symbolic link or junction/.test(failure)),
      `${fileName}: ${JSON.stringify(result.failures)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// installed verification layers (dev coherence + packaged full chain)
// ---------------------------------------------------------------------------

test("verifyInstalledInstall accepts an intact tree in dev mode without embedded checks", (t) => {
  const { installRoot } = installFixture(t);
  const outcome = verifyInstalledInstall({
    exeDir: installRoot,
    isPackaged: false,
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome.failures));
  assert.match(outcome.identityHash, /^[0-9a-f]{64}$/);
});

test("ATTACK verifyInstalledInstall rejects swapped/foreign exes against a released set", (t) => {
  const src = installFixture(t);
  const target = tempDir(t);
  fs.cpSync(src.installRoot, target, { recursive: true });

  // Scenario 1: the installed server.exe is replaced (foreign or rebuilt
  // binary) while the RELEASED sidecar and manifest stay intact. Every layer
  // must fail: manifest payload hash, sidecar binding, and packaged
  // running-exe checks.
  fs.writeFileSync(path.join(target, "server.exe"), Buffer.from("MZ foreign binary"));
  const devOutcome = verifyInstalledInstall({ exeDir: target, isPackaged: false });
  assert.equal(devOutcome.ok, false);
  assert.ok(
    devOutcome.failures.some((f) => f.includes("does not match installed server.exe hash")),
    JSON.stringify(devOutcome.failures),
  );
  assert.ok(
    devOutcome.failures.some((f) => /^(size|sha256) mismatch for server\.exe/.test(f)),
    JSON.stringify(devOutcome.failures),
  );

  const commitment = commitmentFixture(computeCoreIdentityHash(src.identity));
  const packagedOutcome = verifyInstalledInstall({
    exeDir: target,
    isPackaged: true,
    execPath: path.join(target, "server.exe"),
    embeddedCommitment: commitment,
  });
  assert.equal(packagedOutcome.ok, false);

  // Scenario 2: old-release replay — the RELEASED sidecar+manifest of this
  // package stay in place, but the executing image is a different release's
  // exe whose compiled-in commitment covers a different identity.
  const foreignExe = Buffer.from("MZ old-release binary");
  fs.writeFileSync(path.join(target, "server.exe"), foreignExe);
  const replayOutcome = verifyInstalledInstall({
    exeDir: target,
    isPackaged: true,
    execPath: path.join(target, "server.exe"),
    // Release-A sidecar/manifest intact; running exe carries a B commitment.
    embeddedCommitment: commitmentFixture("c".repeat(64)),
  });
  assert.equal(replayOutcome.ok, false);
  assert.ok(
    replayOutcome.failures.some((f) => f.includes("does not cover this build-identity.json")),
    JSON.stringify(replayOutcome.failures),
  );
});

test("verifyInstalledInstall requires the RUNNING exe to be the installed server.exe", (t) => {
  const src = installFixture(t);
  const elsewhere = writeExeFile(t); // some other binary entirely
  // Sidecar and manifest are coherent with the INSTALLED file; but the
  // executing image is a different binary that happens to carry a compatible
  // sidecar. Layer D must catch it via the manifest entry cross-check.
  const outcome = verifyInstalledInstall({
    exeDir: src.installRoot,
    isPackaged: true,
    execPath: elsewhere,
    embeddedCommitment: commitmentFixture(computeCoreIdentityHash(src.identity)),
  });
  assert.equal(outcome.ok, false);
  assert.ok(
    outcome.failures.some(
      (f) => f.includes("running executable hash") || f.includes("does not match install-manifest server.exe entry"),
    ),
    JSON.stringify(outcome.failures),
  );
});

test("ATTACK verifyInstalledInstall catches sidecar/manifest identityHash drift", (t) => {
  const src = installFixture(t);
  const tamperedManifest = structuredClone(src.manifest);
  tamperedManifest.identityHash = "f".repeat(64);
  writeCanonical(path.join(src.installRoot, "install-manifest.json"), tamperedManifest);
  const outcome = verifyInstalledInstall({ exeDir: src.installRoot, isPackaged: false });
  assert.equal(outcome.ok, false);
  assert.ok(outcome.failures.some((f) => f.includes("identity core hash")));
});

test("server --verify-install exits 0 intact / 1 tampered WITHOUT starting the HTTP server", (t) => {
  const { installRoot } = installFixture(t);
  const okRun = spawnSync(process.execPath, [
    path.join(REPO_ROOT, "server", "index.js"),
    "--verify-install",
    "--install-dir", installRoot,
  ], { encoding: "utf8", timeout: 20000 });
  assert.equal(okRun.status, 0, okRun.stderr || okRun.stdout);
  assert.match(okRun.stdout, /installation verification OK/);
  assert.equal(okRun.stdout.includes("listening"), false);

  const bytes = fs.readFileSync(path.join(installRoot, "public", "app.js"));
  bytes[0] ^= 0x7f;
  fs.writeFileSync(path.join(installRoot, "public", "app.js"), bytes);
  const badRun = spawnSync(process.execPath, [
    path.join(REPO_ROOT, "server", "index.js"),
    "--verify-install",
    "--install-dir", installRoot,
  ], { encoding: "utf8", timeout: 20000 });
  assert.equal(badRun.status, 1);
  assert.match(badRun.stderr, /installation verification FAILED|sha256 mismatch/);
  assert.equal(badRun.stdout.includes("listening"), false);
});

test("bind-executable CLI binds canonical core to measured exe and rejects drift", (t) => {
  const work = tempDir(t);
  const distDir = path.join(work, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const exeBytes = crypto.randomBytes(300);
  const core = validIdentityFixture();
  writeCanonical(path.join(distDir, IDENTITY_FILENAME), core);
  fs.writeFileSync(path.join(distDir, "server.exe"), exeBytes);

  const run = spawnSync(process.execPath, [
    path.join(REPO_ROOT, "scripts", "bind-executable.js"),
    "--project-root", work,
    "--dist", "dist",
  ], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const expectedHash = crypto.createHash("sha256").update(exeBytes).digest("hex");
  assert.match(run.stdout, new RegExp(expectedHash));
  const sidecarRaw = fs.readFileSync(path.join(distDir, IDENTITY_FILENAME));
  const sidecar = JSON.parse(sidecarRaw.toString("utf8"));
  assert.equal(validatePackagedIdentity(sidecar).ok, true);
  assert.equal(sidecar.executableBinding.exeSha256, expectedHash);
  assert.deepEqual(sidecarRaw, canonicalBytes(sidecar));

  // A non-canonical core file must abort instead of binding silently.
  const badWork = tempDir(t);
  const badDist = path.join(badWork, "dist");
  fs.mkdirSync(badDist, { recursive: true });
  fs.writeFileSync(path.join(badDist, IDENTITY_FILENAME), JSON.stringify(core, null, 2));
  fs.writeFileSync(path.join(badDist, "server.exe"), exeBytes);
  const badRun = spawnSync(process.execPath, [
    path.join(REPO_ROOT, "scripts", "bind-executable.js"),
    "--project-root", badWork,
    "--dist", "dist",
  ], { encoding: "utf8" });
  assert.notEqual(badRun.status, 0);
  assert.match(badRun.stderr, /canonical form/);

  // A missing executable must abort.
  const noExe = tempDir(t);
  const noExeDist = path.join(noExe, "dist");
  fs.mkdirSync(noExeDist, { recursive: true });
  writeCanonical(path.join(noExeDist, IDENTITY_FILENAME), core);
  const noExeRun = spawnSync(process.execPath, [
    path.join(REPO_ROOT, "scripts", "bind-executable.js"),
    "--project-root", noExe,
    "--dist", "dist",
  ], { encoding: "utf8" });
  assert.notEqual(noExeRun.status, 0);
  assert.match(noExeRun.stderr, /missing or unreadable/);
});

test("bind-executable refuses linked identity, executable, and dist paths", (t) => {
  const core = validIdentityFixture();
  for (const fileName of [IDENTITY_FILENAME, "server.exe"]) {
    const work = tempDir(t);
    const dist = path.join(work, "dist");
    fs.mkdirSync(dist, { recursive: true });
    writeCanonical(path.join(dist, IDENTITY_FILENAME), core);
    fs.writeFileSync(path.join(dist, "server.exe"), crypto.randomBytes(64));
    const target = path.join(dist, fileName);
    const outside = path.join(tempDir(t), fileName);
    fs.copyFileSync(target, outside);
    fs.rmSync(target);
    try {
      fs.symlinkSync(outside, target, "file");
    } catch {
      t.skip("file symlink creation unavailable");
      return;
    }
    const run = spawnSync(process.execPath, [
      path.join(REPO_ROOT, "scripts", "bind-executable.js"),
      "--project-root", work,
      "--dist", "dist",
    ], { encoding: "utf8" });
    assert.notEqual(run.status, 0, fileName);
    assert.match(run.stderr, /symbolic link or junction/, fileName);
  }

  const root = tempDir(t);
  const outsideDist = path.join(tempDir(t), "dist");
  fs.mkdirSync(outsideDist, { recursive: true });
  writeCanonical(path.join(outsideDist, IDENTITY_FILENAME), core);
  fs.writeFileSync(path.join(outsideDist, "server.exe"), crypto.randomBytes(64));
  try {
    fs.symlinkSync(outsideDist, path.join(root, "dist"), "junction");
  } catch {
    t.skip("directory junction creation unavailable");
    return;
  }
  const junctionRun = spawnSync(process.execPath, [
    path.join(REPO_ROOT, "scripts", "bind-executable.js"),
    "--project-root", root,
    "--dist", "dist",
  ], { encoding: "utf8" });
  assert.notEqual(junctionRun.status, 0);
  assert.match(junctionRun.stderr, /symbolic link or junction/);
});

function scriptDistFixture(t) {
  const install = installFixture(t);
  const root = tempDir(t);
  const dist = path.join(root, "dist");
  fs.cpSync(install.installRoot, dist, { recursive: true });
  return { root, dist };
}

test("manifest writer CLIs reject linked identity, manifest, artifacts, and dist intermediates", (t) => {
  for (const fileName of [IDENTITY_FILENAME, "install-manifest.json"]) {
    const { root, dist } = scriptDistFixture(t);
    const target = path.join(dist, fileName);
    const outside = path.join(tempDir(t), fileName);
    fs.copyFileSync(target, outside);
    fs.rmSync(target);
    try {
      fs.symlinkSync(outside, target, "file");
    } catch {
      t.skip("file symlink creation unavailable");
      return;
    }
    const run = spawnSync(process.execPath, [
      path.join(REPO_ROOT, "scripts", "write-install-manifest.js"),
      "--project-root", root,
      "--dist", "dist",
      "--payload", "server.exe",
      "--payload", IDENTITY_FILENAME,
    ], { encoding: "utf8" });
    assert.notEqual(run.status, 0, fileName);
    assert.match(run.stderr, /symbolic link or junction/, fileName);
  }

  const artifactFixture = scriptDistFixture(t);
  const artifact = path.join(artifactFixture.dist, "release.zip");
  fs.writeFileSync(artifact, "release artifact\n");
  const outsideArtifact = path.join(tempDir(t), "release.zip");
  fs.copyFileSync(artifact, outsideArtifact);
  fs.rmSync(artifact);
  try {
    fs.symlinkSync(outsideArtifact, artifact, "file");
  } catch {
    t.skip("file symlink creation unavailable");
    return;
  }
  const artifactRun = spawnSync(process.execPath, [
    path.join(REPO_ROOT, "scripts", "write-release-manifest.js"),
    "--project-root", artifactFixture.root,
    "--install-manifest", "dist/install-manifest.json",
    "--artifact", "dist/release.zip",
  ], { encoding: "utf8" });
  assert.notEqual(artifactRun.status, 0);
  assert.match(artifactRun.stderr, /symbolic link or junction/);

  const junctionRoot = tempDir(t);
  const linkedDist = path.join(tempDir(t), "dist");
  fs.mkdirSync(linkedDist, { recursive: true });
  try {
    fs.symlinkSync(linkedDist, path.join(junctionRoot, "dist"), "junction");
  } catch {
    t.skip("directory junction creation unavailable");
    return;
  }
  const junctionRun = spawnSync(process.execPath, [
    path.join(REPO_ROOT, "scripts", "write-install-manifest.js"),
    "--project-root", junctionRoot,
    "--dist", "dist",
    "--payload", "server.exe",
  ], { encoding: "utf8" });
  assert.notEqual(junctionRun.status, 0);
  assert.match(junctionRun.stderr, /symbolic link or junction/);
});
