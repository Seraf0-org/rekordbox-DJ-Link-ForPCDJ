const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const REQUIRED_PKG_VERSION = "6.22.0";

function defaultGit(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
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
  const checks = [];
  const failures = [];
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail: ok ? detail : undefined });
    if (!ok) failures.push(`${name}: ${detail}`);
  };

  let porcelain;
  try {
    porcelain = git(["status", "--porcelain"], projectRoot);
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
    head = git(["rev-parse", "HEAD"], projectRoot);
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
    tree = git(["rev-parse", "HEAD^{tree}"], projectRoot);
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
        tagCommit = git(["rev-parse", `${expectedTag}^{commit}`], projectRoot);
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
        tagObjectType = git(["cat-file", "-t", expectedTag], projectRoot);
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
        describe = git(["describe", "--tags", "--exact-match", "HEAD"], projectRoot);
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

module.exports = { runPreflight, FULL_SHA_RE, REQUIRED_PKG_VERSION };
