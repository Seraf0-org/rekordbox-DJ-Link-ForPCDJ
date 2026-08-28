const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const currentTemplatePath = path.join(repoRoot, "config", "dj-agent-v1.1.11.example.json");
const scriptPath = path.join(repoRoot, "scripts", "upgrade-show-config.js");
const {
  CURRENT_VERSION,
  PREDECESSOR_VERSION,
  TARGET_PATH,
  TEMPLATE_PATH,
  TOKEN_PLACEHOLDER,
  WINDOWS_POWERSHELL_PATH,
  WINDOWS_SECURE_WRITER_SCRIPT,
  WINDOWS_TARGET_ACL_BOUNDARY,
  ShowConfigUpgradeError,
  encodeSecureWriterFrame,
  secureWriterResultCode,
  writeSecureWindowsTarget,
  upgradeShowConfig,
  validateStrictShowConfig,
} = require("../scripts/upgrade-show-config");
const { validateFilterThenFadeThenStopShowConfig } = require("../server/dj-agent/config");

const TEST_ONLY_SECURE_WRITER_SCRIPT = WINDOWS_SECURE_WRITER_SCRIPT.replace(
  "Write-Output 'READY'",
  "Write-Output 'READY'\n  Start-Sleep -Milliseconds 1000",
);
const TEST_ONLY_SECURE_WRITER_FAILURE_SCRIPT = WINDOWS_SECURE_WRITER_SCRIPT
  .replace(
    "  $stream.Flush($true)\n  $exitCode = 0",
    "  $stream.Flush($true)\n  throw 'test-only forced failure'\n  $exitCode = 0",
  )
  .replace(
    "if ($created -and $exitCode -ne 0) {\n  # Re-open",
    "if ($created -and $exitCode -ne 0) {\n  Write-Output 'CLEANUP_READY'\n  Start-Sleep -Milliseconds 1000\n  # Re-open",
  );

function predecessor(token = "0123456789abcdef0123456789abcdef") {
  const value = JSON.parse(fs.readFileSync(currentTemplatePath, "utf8"));
  value.version = PREDECESSOR_VERSION;
  value.syndocal.token = token;
  return value;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeFixture(t, { token } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rb-output-upgrade-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, "source", `dj-agent-v${PREDECESSOR_VERSION}.json`);
  const targetPath = path.join(root, "target", "dj-agent-v1.1.11.json");
  writeJson(sourcePath, predecessor(token));
  return { root, sourcePath, targetPath };
}

function assertUpgradeError(action, code) {
  assert.throws(
    action,
    (error) => error instanceof ShowConfigUpgradeError && error.code === code,
  );
}

function targetPlanForTest(targetPath) {
  const parent = path.dirname(path.resolve(targetPath));
  const pathStat = fs.lstatSync(parent, { bigint: true });
  const resolvedPath = fs.realpathSync.native(parent);
  const resolvedStat = fs.statSync(resolvedPath, { bigint: true });
  return {
    parentEvidence: {
      path: parent,
      pathStat,
      resolvedPath,
      resolvedStat,
      identity: `${String(pathStat.dev)}:${String(pathStat.ino)}`,
    },
  };
}

function instrumentFs({ beforeOpen, afterOpen, onLstat, onWrite, onFtruncate } = {}) {
  const fsApi = { ...fs, constants: fs.constants };
  const realpathSync = (...args) => fs.realpathSync(...args);
  realpathSync.native = (...args) => fs.realpathSync.native(...args);
  fsApi.realpathSync = realpathSync;
  fsApi.openSync = (...args) => {
    beforeOpen?.(...args);
    const descriptor = fs.openSync(...args);
    afterOpen?.(args[0], descriptor, ...args.slice(1));
    return descriptor;
  };
  fsApi.lstatSync = (...args) => {
    onLstat?.(...args);
    return fs.lstatSync(...args);
  };
  fsApi.writeFileSync = (...args) => {
    onWrite?.(...args);
    return fs.writeFileSync(...args);
  };
  fsApi.ftruncateSync = (...args) => {
    onFtruncate?.(...args);
    return fs.ftruncateSync(...args);
  };
  return fsApi;
}

test("upgrades only the exact predecessor, preserves its token, and stays silent about config content", (t) => {
  const fixture = makeFixture(t);
  const token = JSON.parse(fs.readFileSync(fixture.sourcePath, "utf8")).syndocal.token;
  const sourceBefore = fs.readFileSync(fixture.sourcePath);
  const logged = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => logged.push(args.join(" "));
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const result = upgradeShowConfig({
      env: { DJ_AGENT_CONFIG_PATH: fixture.sourcePath },
      targetPath: fixture.targetPath,
    });
    assert.equal(result.targetPath, path.resolve(fixture.targetPath));
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  const upgradedRaw = fs.readFileSync(fixture.targetPath, "utf8");
  const upgraded = JSON.parse(upgradedRaw);
  assert.equal(upgraded.version, CURRENT_VERSION);
  assert.equal(upgraded.syndocal.token, token);
  assert.equal(validateStrictShowConfig(upgraded, CURRENT_VERSION), true);
  assert.equal(validateFilterThenFadeThenStopShowConfig(upgraded), true);
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), sourceBefore);
  assert.equal(logged.some((line) => line.includes(token)), false);
  assert.equal(upgradedRaw.includes(TOKEN_PLACEHOLDER), false);
  assert.equal(TEMPLATE_PATH, currentTemplatePath);
  assert.equal(TARGET_PATH, String.raw`C:\SyndocalShow\dj-agent-v1.1.11.json`);
  assert.equal(PREDECESSOR_VERSION, "1.1.10");
});

test("fails closed for missing, relative, local, non-regular, and linked sources", (t) => {
  const fixture = makeFixture(t);
  const cases = [
    { name: "missing env", env: {}, code: "SOURCE_PATH_INVALID" },
    { name: "relative source", env: { DJ_AGENT_CONFIG_PATH: "source.json" }, code: "SOURCE_PATH_INVALID" },
    { name: "missing source", env: { DJ_AGENT_CONFIG_PATH: path.join(fixture.root, "missing.json") }, code: "SOURCE_UNAVAILABLE" },
    { name: "source directory", env: { DJ_AGENT_CONFIG_PATH: fixture.root }, code: "SOURCE_NOT_REGULAR" },
    { name: "checkout-local source", env: { DJ_AGENT_CONFIG_PATH: currentTemplatePath }, code: "SOURCE_CHECKOUT_LOCAL" },
  ];
  for (const item of cases) {
    assertUpgradeError(
      () => upgradeShowConfig({ env: item.env, targetPath: fixture.targetPath }),
      item.code,
    );
  }

  const linkPath = path.join(fixture.root, "source-link.json");
  try {
    fs.symlinkSync(fixture.sourcePath, linkPath, "file");
  } catch (error) {
    t.diagnostic(`source symlink case skipped: ${error.code || "symlink unavailable"}`);
  }
  if (fs.existsSync(linkPath)) {
    assertUpgradeError(
      () => upgradeShowConfig({ env: { DJ_AGENT_CONFIG_PATH: linkPath }, targetPath: fixture.targetPath }),
      "SOURCE_NOT_REGULAR",
    );
  }
});

test("rejects inherited forbidden overrides before creating the target", (t) => {
  const fixture = makeFixture(t);
  const sourceBefore = fs.readFileSync(fixture.sourcePath);
  assertUpgradeError(
    () => upgradeShowConfig({
      env: {
        DJ_AGENT_CONFIG_PATH: fixture.sourcePath,
        SYNDOCAL_TOKEN: "inherited-secret-must-not-be-used",
      },
      targetPath: fixture.targetPath,
    }),
    "FORBIDDEN_ENV",
  );
  assert.equal(fs.existsSync(fixture.targetPath), false);
  assert.deepEqual(fs.readFileSync(fixture.sourcePath), sourceBefore);
});

test("rejects unknown and future predecessor versions, malformed contracts, and invalid tokens", (t) => {
  const fixture = makeFixture(t);
  const cases = [
    ["unknown version", { ...predecessor(), version: "1.1.9" }],
    ["future version", { ...predecessor(), version: "1.1.12" }],
    ["extra key", { ...predecessor(), unexpected: true }],
    ["placeholder", predecessor(TOKEN_PLACEHOLDER)],
    ["short token", predecessor("short")],
    ["whitespace token", predecessor("0123456789abcdef0123456789abcde ")],
    ["newline token", predecessor(`0123456789abcdef0123456789abcdef\n`)],
    ["too long token", predecessor("x".repeat(257))],
    ["broken JSON", null],
  ];
  for (const [name, value] of cases) {
    const sourcePath = path.join(fixture.root, `${name.replaceAll(" ", "-")}.json`);
    if (value === null) fs.writeFileSync(sourcePath, "{broken", "utf8");
    else writeJson(sourcePath, value);
    assertUpgradeError(
      () => upgradeShowConfig({ env: { DJ_AGENT_CONFIG_PATH: sourcePath }, targetPath: fixture.targetPath }),
      value === null ? "SOURCE_INVALID_JSON" : "SOURCE_NOT_KNOWN_PREDECESSOR",
    );
    assert.equal(fs.existsSync(fixture.targetPath), false, `${name} must not create a target`);
  }
});

test("refuses target overwrite, checkout-local targets, linked parents, and hostile templates", (t) => {
  const fixture = makeFixture(t);
  fs.mkdirSync(path.dirname(fixture.targetPath), { recursive: true });
  const existing = "must remain byte-identical\n";
  fs.writeFileSync(fixture.targetPath, existing, "utf8");
  assertUpgradeError(
    () => upgradeShowConfig({ env: { DJ_AGENT_CONFIG_PATH: fixture.sourcePath }, targetPath: fixture.targetPath }),
    "TARGET_EXISTS",
  );
  assert.equal(fs.readFileSync(fixture.targetPath, "utf8"), existing);

  const localTarget = path.join(repoRoot, "target-v1.1.11.json");
  assertUpgradeError(
    () => upgradeShowConfig({ env: { DJ_AGENT_CONFIG_PATH: fixture.sourcePath }, targetPath: localTarget }),
    "TARGET_CHECKOUT_LOCAL",
  );

  const hostileTemplate = path.join(fixture.root, "hostile-template.json");
  const hostile = fs.readFileSync(currentTemplatePath, "utf8").replace(
    TOKEN_PLACEHOLDER,
    "0123456789abcdef0123456789abcdef",
  );
  fs.writeFileSync(hostileTemplate, hostile, "utf8");
  const hostileTarget = path.join(fixture.root, "hostile-target.json");
  assertUpgradeError(
    () => upgradeShowConfig({
      env: { DJ_AGENT_CONFIG_PATH: fixture.sourcePath },
      targetPath: hostileTarget,
      templatePath: hostileTemplate,
    }),
    "TEMPLATE_CONTRACT_MISMATCH",
  );
  assert.equal(fs.existsSync(hostileTarget), false);

  const linkedParent = path.join(fixture.root, "linked-parent");
  try {
    fs.symlinkSync(path.dirname(fixture.targetPath), linkedParent, "junction");
  } catch (error) {
    t.diagnostic(`target junction case skipped: ${error.code || "junction unavailable"}`);
  }
  if (fs.existsSync(linkedParent)) {
    assertUpgradeError(
      () => upgradeShowConfig({
        env: { DJ_AGENT_CONFIG_PATH: fixture.sourcePath },
        targetPath: path.join(linkedParent, "linked-target.json"),
      }),
      "TARGET_REPARSE_PATH",
    );
  }
});

test("binds source bytes to the opened descriptor when the source path is swapped", (t) => {
  const fixture = makeFixture(t);
  const originalPath = path.join(fixture.root, "source-original.json");
  const replacementPath = path.join(fixture.root, "source-replacement.json");
  const sourceBefore = fs.readFileSync(fixture.sourcePath);
  const replacementToken = "abcdef0123456789abcdef0123456789";
  writeJson(replacementPath, predecessor(replacementToken));
  const fsApi = instrumentFs({
    afterOpen(openedPath) {
      if (path.resolve(openedPath) !== path.resolve(fixture.sourcePath)) return;
      fs.renameSync(fixture.sourcePath, originalPath);
      fs.renameSync(replacementPath, fixture.sourcePath);
    },
  });

  assertUpgradeError(
    () => upgradeShowConfig({
      env: { DJ_AGENT_CONFIG_PATH: fixture.sourcePath },
      targetPath: fixture.targetPath,
      fsApi,
    }),
    "SOURCE_CHANGED",
  );
  assert.equal(fs.existsSync(fixture.targetPath), false);
  assert.deepEqual(fs.readFileSync(originalPath), sourceBefore);
  assert.equal(fs.readFileSync(fixture.sourcePath, "utf8").includes(replacementToken), true);
});

test("rejects a target parent redirect after the pre-open plan and leaves no target", (t) => {
  const fixture = makeFixture(t);
  const parent = path.dirname(fixture.targetPath);
  const oldParent = path.join(fixture.root, "target-parent-original");
  const redirectedParent = path.join(fixture.root, "target-parent-redirected");
  fs.mkdirSync(redirectedParent, { recursive: true });
  let redirected = false;
  const fsApi = instrumentFs({
    beforeOpen(openedPath) {
      if (redirected || path.resolve(openedPath) !== path.resolve(fixture.targetPath)) return;
      redirected = true;
      fs.renameSync(parent, oldParent);
      fs.renameSync(redirectedParent, parent);
    },
  });

  assertUpgradeError(
    () => upgradeShowConfig({
      env: { DJ_AGENT_CONFIG_PATH: fixture.sourcePath },
      targetPath: fixture.targetPath,
      fsApi,
    }),
    "TARGET_REPARSE_PATH",
  );
  assert.equal(fs.existsSync(fixture.targetPath), false);
  assert.equal(fs.existsSync(path.join(oldParent, path.basename(fixture.targetPath))), false);
});

test("cleans the empty target when post-create verification fails before token write", (t) => {
  const fixture = makeFixture(t);
  let failNextTargetLstat = false;
  let writeCalls = 0;
  const fsApi = instrumentFs({
    afterOpen(openedPath) {
      if (path.resolve(openedPath) === path.resolve(fixture.targetPath)) failNextTargetLstat = true;
    },
    onLstat(checkedPath) {
      if (!failNextTargetLstat || path.resolve(checkedPath) !== path.resolve(fixture.targetPath)) return;
      failNextTargetLstat = false;
      const error = new Error("injected post-create lstat failure");
      error.code = "EIO";
      throw error;
    },
    onWrite() {
      writeCalls += 1;
    },
  });

  assertUpgradeError(
    () => upgradeShowConfig({
      env: { DJ_AGENT_CONFIG_PATH: fixture.sourcePath },
      targetPath: fixture.targetPath,
      fsApi,
    }),
    "TARGET_WRITE_FAILED",
  );
  assert.equal(writeCalls, 0);
  assert.equal(fs.existsSync(fixture.targetPath), false);
});

test("scrubs and removes a partially written target without leaking the token", (t) => {
  const fixture = makeFixture(t);
  let writeCalls = 0;
  let truncateCalls = 0;
  const fsApi = instrumentFs({
    onWrite(descriptor, output, encoding) {
      writeCalls += 1;
      const tokenStart = output.indexOf(JSON.parse(fs.readFileSync(fixture.sourcePath, "utf8")).syndocal.token);
      assert.ok(tokenStart > 0);
      fs.writeFileSync(descriptor, output.slice(0, tokenStart + 32), encoding);
      const error = new Error("injected partial write failure");
      error.code = "EIO";
      throw error;
    },
    onFtruncate() {
      truncateCalls += 1;
    },
  });

  assertUpgradeError(
    () => upgradeShowConfig({
      env: { DJ_AGENT_CONFIG_PATH: fixture.sourcePath },
      targetPath: fixture.targetPath,
      fsApi,
    }),
    "TARGET_WRITE_FAILED",
  );
  assert.equal(writeCalls, 1);
  assert.equal(truncateCalls >= 1, true);
  assert.equal(fs.existsSync(fixture.targetPath), false);
});

test("Windows secure writer denies target rename and replacement while its handle is live", { skip: process.platform !== "win32" }, async (t) => {
  const fixture = makeFixture(t);
  const targetPath = fixture.targetPath;
  const movedPath = path.join(fixture.root, "moved-target.json");
  const payload = "secret-token-bearing-payload\n";
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const targetPlan = targetPlanForTest(targetPath);
  const child = childProcess.spawn(
    WINDOWS_POWERSHELL_PATH,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", TEST_ONLY_SECURE_WRITER_SCRIPT],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let finished = false;
  t.after(() => {
    if (!finished) child.kill();
  });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("secure writer did not publish its live-handle marker")), 5000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString("utf8").includes("READY")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  child.stdin.end(encodeSecureWriterFrame(targetPath, payload, targetPlan));
  await ready;

  assert.throws(() => fs.renameSync(targetPath, movedPath));
  assert.throws(() => fs.writeFileSync(targetPath, "attacker replacement\n", "utf8"));
  const parent = path.dirname(targetPath);
  const movedParent = path.join(fixture.root, "moved-target-parent");
  assert.throws(() => fs.renameSync(parent, movedParent));

  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  finished = true;
  assert.equal(exit.code, 0);
  assert.equal(exit.signal, null);
  assert.deepEqual(fs.readFileSync(targetPath, "utf8"), payload);
  assert.equal(fs.existsSync(movedPath), false);
  assert.equal(fs.existsSync(movedParent), false);
  assert.match(WINDOWS_SECURE_WRITER_SCRIPT, /\[IO\.FileMode\]::CreateNew/);
  assert.match(WINDOWS_SECURE_WRITER_SCRIPT, /\[IO\.FileShare\]::None/);
  assert.match(WINDOWS_SECURE_WRITER_SCRIPT, /\[IO\.Directory\]::GetAccessControl/);
  assert.match(WINDOWS_SECURE_WRITER_SCRIPT, /S-1-1-0/);
  assert.doesNotMatch(WINDOWS_SECURE_WRITER_SCRIPT, /RB_OUTPUT_SECURE_WRITER_HOLD_MS/);
  assert.equal(WINDOWS_TARGET_ACL_BOUNDARY.parent, String.raw`C:\SyndocalShow`);
  assert.equal(WINDOWS_TARGET_ACL_BOUNDARY.unixModeClaim, false);
});

test("Windows parent identity handle permits child open but retains delete fence", () => {
  assert.match(
    WINDOWS_SECURE_WRITER_SCRIPT,
    /\$parent,\s*\r?\n\s*0x00000080,\s*\r?\n\s*0x00000003,/,
  );
  assert.match(WINDOWS_SECURE_WRITER_SCRIPT, /FILE_SHARE_DELETE/);
  assert.match(WINDOWS_SECURE_WRITER_SCRIPT, /FILE_READ_ATTRIBUTES/);
  assert.match(WINDOWS_SECURE_WRITER_SCRIPT, /C:\\SyndocalShow/);
  assert.match(WINDOWS_SECURE_WRITER_SCRIPT, /S-1-5-11/);
  assert.match(WINDOWS_SECURE_WRITER_SCRIPT, /target parent ACL grants broad write access/);
  assert.doesNotMatch(WINDOWS_SECURE_WRITER_SCRIPT, /SetAccessControl/);
  assert.doesNotMatch(WINDOWS_SECURE_WRITER_SCRIPT, /SetAccessRuleProtection/);
  assert.doesNotMatch(WINDOWS_SECURE_WRITER_SCRIPT, /AddAccessRule/);
  assert.doesNotMatch(WINDOWS_SECURE_WRITER_SCRIPT, /RemoveAccessRuleSpecific/);
  assert.match(WINDOWS_SECURE_WRITER_SCRIPT, /PARENT_ACL_UNSAFE/);
  assert.match(WINDOWS_SECURE_WRITER_SCRIPT, /RB_OUTPUT_SECURE_WRITER_RESULT=/);
});

test("secure writer diagnostics accept only fixed codes and never echo helper output", () => {
  assert.equal(
    secureWriterResultCode({ stdout: "READY\r\nRB_OUTPUT_SECURE_WRITER_RESULT=PARENT_OPEN_FAILED\r\n" }),
    "PARENT_OPEN_FAILED",
  );
  assert.equal(
    secureWriterResultCode({ stdout: "RB_OUTPUT_SECURE_WRITER_RESULT=SECRET_TOKEN_VALUE\r\n" }),
    "NO_RESULT",
  );
  assert.equal(
    secureWriterResultCode({ stdout: "", error: new Error("token must never be logged") }),
    "PROCESS_SPAWN_FAILED",
  );
});

test("secure writer does not accept a zero exit without the fixed success marker", (t) => {
  const fixture = makeFixture(t);
  fs.mkdirSync(path.dirname(fixture.targetPath), { recursive: true });
  const targetPlan = targetPlanForTest(fixture.targetPath);
  const originalSpawnSync = childProcess.spawnSync;
  t.after(() => { childProcess.spawnSync = originalSpawnSync; });
  childProcess.spawnSync = () => ({ status: 0, stdout: "", stderr: "" });
  assert.throws(
    () => writeSecureWindowsTarget(fixture.targetPath, "safe-payload\n", targetPlan),
    (error) => error instanceof ShowConfigUpgradeError &&
      error.code === "TARGET_WRITE_FAILED" &&
      error.message.includes("writer reason: NO_RESULT"),
  );
});

test("Windows writer rejects a parent replacement after Node preflight", { skip: process.platform !== "win32" }, (t) => {
  for (const kind of ["directory", "junction"]) {
    const fixture = makeFixture(t);
    const parent = path.dirname(fixture.targetPath);
    const oldParent = path.join(fixture.root, `${kind}-original-parent`);
    const replacement = path.join(fixture.root, `${kind}-replacement-parent`);
    if (kind === "directory") {
      fs.mkdirSync(replacement, { recursive: true });
    } else {
      const junctionTarget = path.join(fixture.root, `${kind}-junction-target`);
      fs.mkdirSync(junctionTarget, { recursive: true });
      try {
        fs.symlinkSync(junctionTarget, replacement, "junction");
      } catch (error) {
        t.skip(`junction setup unavailable: ${error.code || "unknown error"}`);
        return;
      }
    }
    let injected = false;
    assertUpgradeError(
      () => upgradeShowConfig({
        env: { DJ_AGENT_CONFIG_PATH: fixture.sourcePath },
        targetPath: fixture.targetPath,
        secureWriter: (targetPath, output, targetPlan) => {
          injected = true;
          fs.renameSync(parent, oldParent);
          fs.renameSync(replacement, parent);
          writeSecureWindowsTarget(targetPath, output, targetPlan);
        },
      }),
      "TARGET_WRITE_FAILED",
    );
    assert.equal(injected, true);
    assert.equal(fs.existsSync(path.join(parent, path.basename(fixture.targetPath))), false);
    assert.equal(fs.existsSync(path.join(oldParent, path.basename(fixture.targetPath))), false);
    assert.equal(fs.existsSync(path.join(replacement, path.basename(fixture.targetPath))), false);
  }
});

test("Windows writer cleanup never deletes a replacement after the original handle closes", { skip: process.platform !== "win32" }, async (t) => {
  const fixture = makeFixture(t);
  const targetPath = fixture.targetPath;
  const movedPath = path.join(fixture.root, "failed-original-target.json");
  const payload = "secret-token-bearing-payload\n";
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const targetPlan = targetPlanForTest(targetPath);
  const child = childProcess.spawn(
    WINDOWS_POWERSHELL_PATH,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", TEST_ONLY_SECURE_WRITER_FAILURE_SCRIPT],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let finished = false;
  t.after(() => {
    if (!finished) child.kill();
  });
  const cleanupReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("secure writer did not publish its cleanup marker")), 5000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString("utf8").includes("CLEANUP_READY")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  child.stdin.end(encodeSecureWriterFrame(targetPath, payload, targetPlan));
  await cleanupReady;
  fs.renameSync(targetPath, movedPath);
  fs.writeFileSync(targetPath, "attacker replacement\n", "utf8");
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  finished = true;
  assert.equal(exit.code, 1);
  assert.equal(exit.signal, null);
  assert.equal(fs.readFileSync(targetPath, "utf8"), "attacker replacement\n");
  assert.deepEqual(fs.readFileSync(movedPath), Buffer.alloc(0));
  assert.doesNotMatch(fs.readFileSync(targetPath, "utf8"), /secret-token-bearing-payload/);
  assert.doesNotMatch(fs.readFileSync(movedPath, "utf8"), /secret-token-bearing-payload/);
});

test("launcher exposes a single upgrade argument and preflights the new target without starting runtime", () => {
  const launcher = fs.readFileSync(path.join(repoRoot, "start-all.bat"), "utf8");
  const updater = fs.readFileSync(scriptPath, "utf8");
  const handoff = fs.readFileSync(path.join(repoRoot, "SYNDOCAL_PEDAL_HANDOFF.md"), "utf8");
  assert.match(launcher, /--upgrade-config/);
  assert.match(launcher, /node scripts\\upgrade-show-config\.js/);
  assert.match(launcher, /set "DJ_AGENT_CONFIG_PATH=C:\\SyndocalShow\\dj-agent-v1\.1\.11\.json"/i);
  assert.match(launcher, /strict current v1\.1\.11 preflight passed/i);
  assert.match(launcher, /\$env:DJ_AGENT_CONFIG_PATH = 'C:\\SyndocalShow\\dj-agent-v1\.1\.11\.json'/);
  const upgrade = launcher.indexOf("goto upgrade_show_config");
  const build = launcher.indexOf("call npm run build:hook");
  const preflight = launcher.indexOf("call :validate_show_config", upgrade);
  assert.ok(upgrade >= 0);
  assert.ok(preflight > upgrade);
  assert.ok(build > preflight);
  assert.match(launcher, /exit \/b 0\s*\r?\n\s*:initialize_show_config/);
  assert.match(launcher, /:upgrade_show_config[\s\S]*?exit \/b 0/);
  assert.doesNotMatch(launcher.slice(upgrade, launcher.indexOf(":reject_retired_rekordbox_override", upgrade + 1)), /restarting the source server|injecting hook/i);
  assert.match(updater, /SYNDOCAL_TOKEN/);
  const forbiddenGate = updater.indexOf("assertNoForbiddenEnvironment(env);");
  const sourceRead = updater.indexOf("const sourceRaw = readValidatedSource");
  const upgradeFunction = updater.indexOf("function upgradeShowConfig");
  const targetCreate = updater.indexOf("writeExclusive(fsApi, target,", upgradeFunction);
  assert.ok(upgradeFunction >= 0 && upgradeFunction < forbiddenGate && forbiddenGate < sourceRead);
  assert.ok(forbiddenGate < targetCreate);
  assert.match(handoff, /Windows target security is bounded by the NTFS ACL/);
  assert.match(handoff, /does not claim Unix\s+mode bits as a Windows\s+ACL/);
});

test("launcher rejects an inherited token before touching the fixed target", (t) => {
  if (fs.existsSync(TARGET_PATH)) {
    t.skip("fixed production target already exists; refusing to disturb it in a test");
    return;
  }
  const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
  const result = childProcess.spawnSync(comspec, ["/d", "/c", "start-all.bat", "--upgrade-config"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DJ_AGENT_CONFIG_PATH: String.raw`C:\outside\source.json`,
      SYNDOCAL_TOKEN: "inherited-launcher-secret-must-not-leak",
    },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout + result.stderr, /inherited-launcher-secret-must-not-leak/);
  assert.equal(fs.existsSync(TARGET_PATH), false);
});

test("upgrade CLI accepts no arguments and never prints source config content", () => {
  const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
  const result = childProcess.spawnSync(process.execPath, [scriptPath, "unexpected"], {
    cwd: repoRoot,
    env: { ...process.env, DJ_AGENT_CONFIG_PATH: "C:\\outside\\source.json" },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /accepts no arguments/i);
  assert.doesNotMatch(result.stdout + result.stderr, /DJ_AGENT_CONFIG_PATH|source\.json/i);
  assert.equal(typeof comspec, "string");
});
