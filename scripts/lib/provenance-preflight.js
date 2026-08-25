const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const REQUIRED_PKG_VERSION = "6.22.0";
const TRUSTED_WINDOWS_GIT_EXECUTABLE = "C:\\Program Files\\Git\\cmd\\git.exe";
const WINDOWS_NULL_DEVICE = "NUL";

function normalizeWindowsPath(value) {
  const withoutExtendedPrefix = String(value).replace(/^\\\\\?\\/, "");
  return path.win32.normalize(withoutExtendedPrefix).replace(/[\\/]+$/, "").toLowerCase();
}

function sameWindowsPath(left, right) {
  return normalizeWindowsPath(left) === normalizeWindowsPath(right);
}

function resolveWindowsPath(value, label) {
  const resolved = path.win32.resolve(String(value));
  if (!path.win32.isAbsolute(resolved)) {
    throw new Error(`${label} must be an absolute Windows path: ${value}`);
  }
  return resolved;
}

function lstatOrThrow(fsApi, targetPath, label) {
  try {
    return fsApi.lstatSync(targetPath);
  } catch (error) {
    throw new Error(`${label} is missing or unreadable: ${targetPath} (${error.message})`);
  }
}

function realpathOrThrow(fsApi, targetPath, label) {
  try {
    const nativeRealpath = fsApi.realpathSync.native || fsApi.realpathSync;
    return nativeRealpath(targetPath);
  } catch (error) {
    throw new Error(`${label} cannot be resolved without following a reparse point: ${targetPath} (${error.message})`);
  }
}

// Every path component is checked. `lstat` catches ordinary symlinks and
// junctions; comparing native realpath catches reparse traversal that could
// otherwise escape an apparently trusted lexical root.
function assertNormalNonReparsePath(fsApi, targetPath, label, expectedType) {
  const absolutePath = resolveWindowsPath(targetPath, label);
  const parsed = path.win32.parse(absolutePath);
  const segments = absolutePath.slice(parsed.root.length).split("\\").filter(Boolean);
  let current = parsed.root;

  for (const segment of segments) {
    current = path.win32.join(current, segment);
    const stats = lstatOrThrow(fsApi, current, label);
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} is a symbolic link or junction (reparse points are not allowed): ${current}`);
    }
    const resolved = realpathOrThrow(fsApi, current, label);
    if (!sameWindowsPath(resolved, current)) {
      throw new Error(`${label} resolves through a reparse point (not allowed): ${current} -> ${resolved}`);
    }
  }

  const finalStats = lstatOrThrow(fsApi, absolutePath, label);
  if (expectedType === "directory" && !finalStats.isDirectory()) {
    throw new Error(`${label} must be a normal directory: ${absolutePath}`);
  }
  if (expectedType === "file" && !finalStats.isFile()) {
    throw new Error(`${label} must be a normal file: ${absolutePath}`);
  }
  return absolutePath;
}

function pathExists(fsApi, targetPath) {
  try {
    fsApi.lstatSync(targetPath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    throw error;
  }
}

function assertCriticalMetadataAbsent(fsApi, targetPath, label) {
  if (!pathExists(fsApi, targetPath)) return;
  // Do not resolve the object first: an existing reparse point is itself the
  // rejection condition and must never be followed.
  const stats = lstatOrThrow(fsApi, targetPath, label);
  if (stats.isSymbolicLink()) {
    throw new Error(`${label} is a symbolic link or junction (rejected critical Git metadata): ${targetPath}`);
  }
  throw new Error(`${label} is present (rejected critical Git metadata): ${targetPath}`);
}

function assertPackedReplaceRefsAbsent(fsApi, packedRefsPath) {
  if (!pathExists(fsApi, packedRefsPath)) return;
  assertNormalNonReparsePath(fsApi, packedRefsPath, "Git packed-refs", "file");
  const text = fsApi.readFileSync(packedRefsPath, "utf8");
  if (/^[0-9a-f]+\s+refs\/replace\//mi.test(text)) {
    throw new Error(`Git packed-refs contains replace refs (rejected critical Git metadata): ${packedRefsPath}`);
  }
}

function assertGitMetadataIsTrusted(fsApi, projectRoot) {
  const root = assertNormalNonReparsePath(fsApi, projectRoot, "project root", "directory");
  const gitDir = assertNormalNonReparsePath(fsApi, path.win32.join(root, ".git"), "projectRoot/.git", "directory");

  // These must be normal directories whenever Git uses them. Requiring their
  // existence deliberately rejects incomplete/non-worktree repositories.
  for (const [relativePath, label] of [
    ["objects", "projectRoot/.git/objects"],
    ["objects\\info", "projectRoot/.git/objects/info"],
    ["refs", "projectRoot/.git/refs"],
    ["info", "projectRoot/.git/info"],
  ]) {
    assertNormalNonReparsePath(fsApi, path.win32.join(gitDir, relativePath), label, "directory");
  }
  for (const [relativePath, label] of [
    ["HEAD", "projectRoot/.git/HEAD"],
    ["config", "projectRoot/.git/config"],
  ]) {
    assertNormalNonReparsePath(fsApi, path.win32.join(gitDir, relativePath), label, "file");
  }

  for (const [relativePath, label] of [
    ["objects\\info\\alternates", "Git object alternates"],
    ["objects\\info\\http-alternates", "Git HTTP object alternates"],
    ["refs\\replace", "Git replace refs"],
    ["worktrees", "Git linked-worktree metadata"],
    ["commondir", "Git linked-worktree commondir"],
    ["gitdir", "Git linked-worktree gitdir"],
    ["config.worktree", "Git linked-worktree config"],
    ["shallow", "Git shallow history metadata"],
    ["info\\grafts", "Git graft metadata"],
  ]) {
    assertCriticalMetadataAbsent(fsApi, path.win32.join(gitDir, relativePath), label);
  }
  assertPackedReplaceRefsAbsent(fsApi, path.win32.join(gitDir, "packed-refs"));
  return { root, gitDir };
}

function isolatedGitEnvironment(callerEnvironment, { gitDir, projectRoot }) {
  const environment = {};
  for (const [key, value] of Object.entries(callerEnvironment || {})) {
    if (!key.toUpperCase().startsWith("GIT_")) environment[key] = value;
  }
  // The release preflight must not inherit caller-selected repository/object
  // roots, inline config, aliases, replace refs, or global/system config.
  return {
    ...environment,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_GLOBAL: WINDOWS_NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_DIR: gitDir,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_WORK_TREE: projectRoot,
  };
}

function createTrustedGitRunner(projectRoot, {
  platform = process.platform,
  environment = process.env,
  execFile = execFileSync,
  fsApi = fs,
  trustedGitExecutable = TRUSTED_WINDOWS_GIT_EXECUTABLE,
} = {}) {
  if (platform !== "win32") {
    throw new Error(`release provenance Git is supported only on Windows; got platform '${platform}'`);
  }
  if (!sameWindowsPath(trustedGitExecutable, TRUSTED_WINDOWS_GIT_EXECUTABLE)) {
    throw new Error(`release provenance Git executable must be exactly ${TRUSTED_WINDOWS_GIT_EXECUTABLE}; got ${trustedGitExecutable}`);
  }

  const trustedExecutable = assertNormalNonReparsePath(
    fsApi,
    TRUSTED_WINDOWS_GIT_EXECUTABLE,
    "trusted Git executable",
    "file",
  );
  const initialMetadata = assertGitMetadataIsTrusted(fsApi, projectRoot);
  const expectedRoot = initialMetadata.root;

  return (args, cwd) => {
    const requestedRoot = resolveWindowsPath(cwd, "Git working tree");
    if (!sameWindowsPath(requestedRoot, expectedRoot)) {
      throw new Error(`release provenance Git working tree changed or is outside the fixed project root: ${cwd}`);
    }
    // Revalidate immediately before every subprocess. This makes a metadata
    // substitution between preflight queries fail rather than silently affect
    // HEAD/tree/tag evidence.
    assertNormalNonReparsePath(fsApi, TRUSTED_WINDOWS_GIT_EXECUTABLE, "trusted Git executable", "file");
    const metadata = assertGitMetadataIsTrusted(fsApi, expectedRoot);
    const childEnvironment = isolatedGitEnvironment(environment, {
      gitDir: metadata.gitDir,
      projectRoot: metadata.root,
    });
    const gitArgs = [
      `--git-dir=${metadata.gitDir}`,
      `--work-tree=${metadata.root}`,
      "--no-replace-objects",
      "--no-pager",
      ...args,
    ];
    return execFile(trustedExecutable, gitArgs, {
      cwd: metadata.root,
      encoding: "utf8",
      env: childEnvironment,
      windowsHide: true,
    }).trim();
  };
}

function defaultGit(args, cwd) {
  return createTrustedGitRunner(cwd)(args, cwd);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readInstallerVersion(installerPath) {
  const text = fs.readFileSync(installerPath, "utf8");
  const match = text.match(/^\s*AppVersion=(.+?)\s*$/m);
  if (!match) {
    throw new Error(`installer.iss has no AppVersion line at ${installerPath}`);
  }
  return match[1].trim();
}

function sha256FileBytes(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// Fail-closed release preflight. Collects every failure before reporting so a
// single run surfaces the full problem list. `git` is injectable for tests so
// scenarios never touch the real repository.
function runPreflight({ projectRoot, git = defaultGit } = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  // Preserve the injected seam for deterministic unit tests. Production
  // callers omit it and are bound to the exact trusted Windows Git runner.
  const gitRunner = git;
  const checks = [];
  const failures = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail: ok ? detail : undefined });
    if (!ok) failures.push(`${name}: ${detail}`);
  };

  let porcelain;
  try {
    porcelain = gitRunner(["status", "--porcelain"], projectRoot);
  } catch (error) {
    record("git-status", false, `git status failed: ${error.message}`);
    porcelain = null;
  }
  if (porcelain !== null) {
    const lines = porcelain.split("\n").map((line) => line.trimEnd()).filter(Boolean);
    record(
      "worktree-clean",
      lines.length === 0,
      lines.length === 0
        ? "no dirty or untracked paths"
        : `dirty/untracked paths present:\n  ${lines.join("\n  ")}`,
    );
  }

  let head = null;
  try {
    head = gitRunner(["rev-parse", "HEAD"], projectRoot);
  } catch (error) {
    record("head-full-sha", false, `git rev-parse HEAD failed: ${error.message}`);
  }
  if (head !== null) {
    record(
      "head-full-sha",
      FULL_SHA_RE.test(head),
      FULL_SHA_RE.test(head) ? head : `HEAD must be a full 40-char hex SHA, got "${head}"`,
    );
  }

  let tree = null;
  try {
    tree = gitRunner(["rev-parse", "HEAD^{tree}"], projectRoot);
  } catch (error) {
    record("tree-full-sha", false, `git rev-parse HEAD^{{tree}} failed: ${error.message}`);
  }
  if (tree !== null) {
    record(
      "tree-full-sha",
      FULL_SHA_RE.test(tree),
      FULL_SHA_RE.test(tree) ? tree : `tree must be a full 40-char hex SHA, got "${tree}"`,
    );
  }

  const pkgPath = path.join(projectRoot, "package.json");
  const lockPath = path.join(projectRoot, "package-lock.json");
  const installerPath = path.join(projectRoot, "installer.iss");

  let productVersion;
  let packageJson = null;
  try {
    packageJson = readJsonFile(pkgPath);
    productVersion = String(packageJson.version);
    record("package-version", /^\d+\.\d+\.\d+$/.test(productVersion), productVersion);
  } catch (error) {
    productVersion = null;
    record("package-version", false, error.message);
  }

  let lockVersions = null;
  let packageLock = null;
  try {
    packageLock = readJsonFile(lockPath);
    lockVersions = {
      root: String(packageLock.version),
      self: String(packageLock.packages && packageLock.packages[""] ? packageLock.packages[""].version : ""),
    };
  } catch (error) {
    record("package-lock-readable", false, error.message);
  }
  if (lockVersions !== null) {
    record(
      "package-lock-readable",
      true,
      `root=${lockVersions.root} packages[""]=${lockVersions.self}`,
    );
  }

  if (packageJson !== null) {
    const declared = packageJson.devDependencies && packageJson.devDependencies["@yao-pkg/pkg"];
    record(
      "pkg-devdependency-pin",
      declared === REQUIRED_PKG_VERSION,
      declared === REQUIRED_PKG_VERSION
        ? `package.json devDependencies @yao-pkg/pkg=${REQUIRED_PKG_VERSION}`
        : `package.json devDependencies @yao-pkg/pkg must be exactly ${REQUIRED_PKG_VERSION}, got ${String(declared)}`,
    );
  }
  if (packageLock !== null) {
    const lockRoot = packageLock.packages && packageLock.packages[""];
    const rootDeclared = lockRoot && lockRoot.devDependencies && lockRoot.devDependencies["@yao-pkg/pkg"];
    const lockedPackage = packageLock.packages && packageLock.packages["node_modules/@yao-pkg/pkg"];
    const lockedVersion = lockedPackage && lockedPackage.version;
    const ok = rootDeclared === REQUIRED_PKG_VERSION && lockedVersion === REQUIRED_PKG_VERSION;
    record(
      "pkg-package-lock-pin",
      ok,
      ok
        ? `package-lock root and node_modules/@yao-pkg/pkg are ${REQUIRED_PKG_VERSION}`
        : `package-lock @yao-pkg/pkg must be exactly ${REQUIRED_PKG_VERSION}; root=${String(rootDeclared)} installed=${String(lockedVersion)}`,
    );
  }

  let installerVersion = null;
  try {
    installerVersion = readInstallerVersion(installerPath);
    record("installer-appversion-readable", true, installerVersion);
  } catch (error) {
    record("installer-appversion-readable", false, error.message);
  }

  if (productVersion !== null) {
    const expectedTag = `v${productVersion}`;
    const mismatches = [];
    if (lockVersions !== null) {
      if (lockVersions.root !== productVersion) mismatches.push(`package-lock.json version ${lockVersions.root}`);
      if (lockVersions.self !== productVersion) mismatches.push(`package-lock.json packages[""].version ${lockVersions.self}`);
    }
    if (installerVersion !== null && installerVersion !== productVersion) {
      mismatches.push(`installer.iss AppVersion ${installerVersion}`);
    }
    record(
      "version-triple-match",
      mismatches.length === 0,
      mismatches.length === 0
        ? `package.json/package-lock.json/installer.iss all ${productVersion}`
        : `version mismatch against package.json ${productVersion}: ${mismatches.join("; ")}`,
    );

    if (head !== null && FULL_SHA_RE.test(head)) {
      let tagCommit = null;
      try {
        tagCommit = gitRunner(["rev-parse", `${expectedTag}^{commit}`], projectRoot);
      } catch {
        tagCommit = null;
      }
      record(
        "tag-resolves-to-head",
        tagCommit === head,
        tagCommit === head
          ? `${expectedTag} -> ${head}`
          : tagCommit === null
            ? `tag ${expectedTag} does not resolve; expected HEAD ${head}`
            : `tag ${expectedTag} resolves to ${tagCommit}, expected HEAD ${head}`,
      );
      // The release tag must be an ANNOTATED tag OBJECT (git cat-file -t says
      // "tag"). Lightweight tags point straight at a commit and are rejected:
      // they carry no tagger, message, or signature surface and cannot be
      // distinguished from an accidental branch-shaped ref.
      let tagObjectType = null;
      try {
        tagObjectType = gitRunner(["cat-file", "-t", expectedTag], projectRoot);
      } catch {
        tagObjectType = null;
      }
      record(
        "tag-object-annotated",
        tagObjectType === "tag",
        tagObjectType === "tag"
          ? `${expectedTag} is an annotated tag object`
          : tagObjectType === null
            ? `git cat-file -t ${expectedTag} failed; cannot prove an annotated tag`
            : `tag ${expectedTag} is a ${tagObjectType} object (lightweight); an annotated tag is required`,
      );
      let describe = null;
      try {
        describe = gitRunner(["describe", "--tags", "--exact-match", "HEAD"], projectRoot);
      } catch {
        describe = null;
      }
      record(
        "head-exact-tag",
        describe === expectedTag,
        describe === expectedTag
          ? describe
          : `HEAD is not exactly ${expectedTag}${describe ? ` (describe said "${describe}")` : ""}`,
      );
    }
  }

  let packageLockHash = null;
  try {
    packageLockHash = sha256FileBytes(lockPath);
  } catch (error) {
    failures.push(`package-lock-hash: ${error.message}`);
  }

  if (failures.length > 0) {
    const error = new Error(
      `release preflight failed (${failures.length} problem${failures.length === 1 ? "" : "s"}):\n- ${failures.join("\n- ")}`,
    );
    error.checks = checks;
    error.failures = failures;
    throw error;
  }

  return {
    ok: true,
    commit: head,
    tree,
    tag: `v${productVersion}`,
    productVersion,
    packageLockHash,
    checks,
  };
}

module.exports = {
  runPreflight,
  FULL_SHA_RE,
  REQUIRED_PKG_VERSION,
  // Test-only exports keep the production entry point fixed to the exact
  // Windows Git path while allowing deterministic adversarial unit tests.
  __test: {
    TRUSTED_WINDOWS_GIT_EXECUTABLE,
    createTrustedGitRunner,
  },
};
