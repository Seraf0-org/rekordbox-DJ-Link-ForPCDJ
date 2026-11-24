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
const HOOK_SOURCE = fs.readFileSync(path.join(REPO_ROOT, "native", "hookdll", "hookdll.cpp"), "utf8");

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
  assert.match(HOOK_SOURCE, /InetPtonA\(AF_INET, kUdpHost, &g_destination\.sin_addr\)/);
  assert.doesNotMatch(HOOK_SOURCE, /\binet_addr\s*\(/);
  assert.match(SCRIPT, /\$minHookCompileUnits\s*=\s*@\(/);
  const commonStart = SCRIPT.indexOf("$clCommonArgs = @(");
  const hookArgsStart = SCRIPT.indexOf("$clArgs = $clCommonArgs", commonStart);
  const minHookArgsStart = SCRIPT.indexOf("$minHookArgs = $clCommonArgs", hookArgsStart);
  const linkArgsStart = SCRIPT.indexOf("$linkArgs = @(", minHookArgsStart);
  assert.ok(commonStart >= 0 && hookArgsStart > commonStart && minHookArgsStart > hookArgsStart && linkArgsStart > minHookArgsStart);
  const commonBlock = SCRIPT.slice(commonStart, hookArgsStart);
  const hookArgsBlock = SCRIPT.slice(hookArgsStart, minHookArgsStart);
  const minHookArgsBlock = SCRIPT.slice(minHookArgsStart, linkArgsStart);
  assert.match(commonBlock, /"\/W4"[\s\S]*?"\/WX"/);
  assert.doesNotMatch(commonBlock, /"\/wd(?:4201|4244|4310|4701)"/);
  assert.match(hookArgsBlock, /"\/std:c\+\+17"[\s\S]*?"\/EHsc"/);
  assert.doesNotMatch(hookArgsBlock, /"\/wd(?:4201|4244|4310|4701)"/);
  assert.match(minHookArgsBlock, /"\/wd4201"[\s\S]*?"\/wd4244"[\s\S]*?"\/wd4310"[\s\S]*?"\/wd4701"/);
});

test("hook build rechecks source compiler and MinHook evidence around compilation and validates an AMD64 PE DLL", () => {
  assert.match(SCRIPT, /function\s+Get-TrustedFileEvidence/);
  assert.match(SCRIPT, /Get-FileHash\s+-LiteralPath\s+\$fullPath\s+-Algorithm\s+SHA256/);
  assert.match(SCRIPT, /function\s+Get-CompilerEvidence/);
  assert.match(SCRIPT, /"--version"/);
  assert.match(SCRIPT, /"\/Bv"/);
  assert.match(SCRIPT, /\[int\[\]\]\$AllowedExitCodes\s*=\s*@\(0\)/);
  assert.match(SCRIPT, /\$versionAllowedExitCodes\s*=\s*if \(\$CompilerKind -ceq "cl"\) \{ @\(0, 2\) \}/);
  assert.match(SCRIPT, /\$versionAllowedExitCodes\s*=\s*if \(\$Evidence\.CompilerKind -ceq "cl"\) \{ @\(0, 2\) \}/);
  assert.match(SCRIPT, /Invoke-TrustedNativeExecutable -Label "cl" -ExecutablePath \$clExecutable -ArgumentList \$clArgs\s*$/m);
  assert.match(SCRIPT, /Invoke-TrustedNativeExecutable -Label "link" -ExecutablePath \$linkerEvidence\.Path -ArgumentList \$linkArgs\s*$/m);
  assert.match(SCRIPT, /Get-TrustedFileEvidence -Path \$objectPath -Label "MSVC compiled object"/);
  assert.match(SCRIPT, /Assert-TrustedFileEvidence -Evidence \$evidence -Label "MSVC compiled object"/);
  assert.match(SCRIPT, /Get-TrustedFileEvidence -Path \$expectedLinker -Label "MSVC linker"/);
  assert.match(SCRIPT, /Assert-TrustedFileEvidence -Evidence \$linkerEvidence -Label "MSVC linker"/);
  assert.match(SCRIPT, /"\/DLL",\s*"\/WX"/);
  assert.match(SCRIPT, /function\s+Remove-MsvcObjectStagingDirectory/);
  assert.match(SCRIPT, /obj\.staging\." \+ \[Guid\]::NewGuid/);
  assert.match(SCRIPT, /Hook build or post-compile verification failed;[\s\S]*outputs created by this run were removed/);
  assert.match(SCRIPT, /\[System\.IO\.File\]::Replace\(\$buildDllPath, \$dllOut, \$previousDllBackupPath, \$true\)/);
  assert.match(SCRIPT, /Close Rekordbox if this DLL is loaded, then retry/);
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
