"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "build-hook.ps1");
const SCRIPT = fs.readFileSync(SCRIPT_PATH, "utf8");

const CALLER_CONTROLLED_ENVIRONMENT_NAMES = [
  "CC",
  "CXX",
  "CFLAGS",
  "CXXFLAGS",
  "CPPFLAGS",
  "CPATH",
  "C_INCLUDE_PATH",
  "CPLUS_INCLUDE_PATH",
  "OBJC_INCLUDE_PATH",
  "COMPILER_PATH",
  "GCC_EXEC_PREFIX",
  "LIBRARY_PATH",
  "INCLUDE",
  "LIB",
  "LIBPATH",
  "CL",
  "_CL_",
  "LINK",
  "_LINK_",
  "VCINSTALLDIR",
  "VCToolsInstallDir",
  "VSINSTALLDIR",
  "WindowsSdkDir",
  "WindowsSDKVersion",
  "UniversalCRTSdkDir",
  "UCRTVersion",
];

test("hook build admits no caller compiler or include/linker environment", () => {
  for (const name of CALLER_CONTROLLED_ENVIRONMENT_NAMES) {
    assert.match(SCRIPT, new RegExp(`"${name}"`));
  }
  assert.match(SCRIPT, /function\s+Assert-NoCallerCompilerEnvironmentOverrides/);
  assert.match(SCRIPT, /Caller compiler environment override is set during \$\{Phase\}: \$name/);
  assert.match(SCRIPT, /function\s+Assert-MsvcEnvironmentWasInitializedByVcvars/);
  assert.match(SCRIPT, /vcvars64 did not provide required MSVC environment variable: \$name/);
  assert.match(SCRIPT, /vcvars64 produced a prohibited compiler override environment variable: \$name/);
  const bootstrapIndex = SCRIPT.indexOf("Initialize-WindowsDesktopPowerShellBuildEnvironment");
  const guardIndex = SCRIPT.indexOf('Assert-NoCallerCompilerEnvironmentOverrides -Phase "build start"');
  const projectRootIndex = SCRIPT.indexOf("if ([string]::IsNullOrWhiteSpace($ProjectRoot))");
  assert.ok(bootstrapIndex >= 0 && guardIndex > bootstrapIndex && projectRootIndex > guardIndex);
});

test("hook build pins Vista-and-newer x64 flags and fails first-party warnings", () => {
  for (const flag of [
    '"-m64"',
    '"-D_WIN32_WINNT=0x0600"',
    '"-Wall"',
    '"-Wextra"',
    '"-Werror"',
    '"/D_WIN32_WINNT=0x0600"',
    '"/W4"',
    '"/WX"',
  ]) {
    assert.match(SCRIPT, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(SCRIPT, /VC\\Auxiliary\\Build\\vcvars64\.bat/);
  assert.match(SCRIPT, /bin\\Hostx64\\x64\\cl\.exe/);
  assert.match(SCRIPT, /Assert-MsvcEnvironmentWasInitializedByVcvars/);
});

test("hook build rechecks source compiler and MinHook evidence around compilation and validates an AMD64 PE DLL", () => {
  assert.match(SCRIPT, /function\s+Get-TrustedFileEvidence/);
  assert.match(SCRIPT, /Get-FileHash\s+-LiteralPath\s+\$fullPath\s+-Algorithm\s+SHA256/);
  assert.match(SCRIPT, /function\s+Get-CompilerEvidence/);
  assert.match(SCRIPT, /"--version"/);
  assert.match(SCRIPT, /"\/Bv"/);
  assert.match(SCRIPT, /function\s+Assert-HookCompileInputEvidence/);
  assert.match(SCRIPT, /Assert-MinHookTreeAndWorktree\s+-Commit\s+\$minHookCommit/);
  assert.match(SCRIPT, /function\s+Assert-HookDllOutput/);
  assert.match(SCRIPT, /ReadByte\(\)\s+-ne\s+0x4d/);
  assert.match(SCRIPT, /ReadUInt32\(\)\s+-ne\s+\[UInt32\]0x00004550/);
  assert.match(SCRIPT, /ReadUInt16\(\)\s+-ne\s+\[UInt16\]0x8664/);
  assert.match(SCRIPT, /Assert-TrustedFileEvidence\s+-Evidence\s+\$evidence\s+-Label\s+"Hook DLL output"/);
  assert.match(SCRIPT, /Hook DLL evidence: path=\$\(\$dllEvidence\.Path\) machine=\$\(\$dllEvidence\.Machine\) sha256=\$\(\$dllEvidence\.Sha256\)/);

  const gxxEvidenceIndex = SCRIPT.indexOf('$compileInputEvidence = Get-HookCompileInputEvidence -HookSourcePath $hookCpp -CompilerKind "g++"');
  const gxxInvokeIndex = SCRIPT.indexOf('$gxxInvocation = Invoke-TrustedNativeExecutable');
  const clEvidenceIndex = SCRIPT.indexOf('$compileInputEvidence = Get-HookCompileInputEvidence -HookSourcePath $hookCpp -CompilerKind "cl"');
  const clInvokeIndex = SCRIPT.indexOf('$clInvocation = Invoke-TrustedNativeExecutable');
  const postCompileVerifyIndex = SCRIPT.lastIndexOf("Assert-HookCompileInputEvidence -Evidence $compileInputEvidence");
  assert.ok(gxxEvidenceIndex >= 0 && gxxEvidenceIndex < gxxInvokeIndex);
  assert.ok(clEvidenceIndex >= 0 && clEvidenceIndex < clInvokeIndex);
  assert.ok(postCompileVerifyIndex > gxxInvokeIndex && postCompileVerifyIndex > clInvokeIndex);
});

test("caller CFLAGS injection fails before the temporary project is mutated", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rb-hook-provenance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "native", "bin", "rb_hook.dll");
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-File", SCRIPT_PATH,
    "-ProjectRoot", root,
    "-OutputPath", output,
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      CFLAGS: "-D RB_OUTPUT_INJECTED=1",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Caller compiler environment override is set during build start: CFLAGS/);
  assert.equal(fs.existsSync(path.join(root, "native")), false);
});
