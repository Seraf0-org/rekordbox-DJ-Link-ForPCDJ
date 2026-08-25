"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SCRIPT_PATH = path.join(__dirname, "..", "scripts", "build-hook.ps1");
const WINDOWS_DESKTOP_BOOTSTRAP_PATH = path.join(__dirname, "..", "scripts", "initialize-windows-desktop-powershell.ps1");
const REPO_ROOT = path.join(__dirname, "..");
const RELEASE_WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "release.yml");
const MINHOOK_CACHE = path.join(REPO_ROOT, "native", "third_party", "minhook");
const HOOK_SOURCE = path.join(REPO_ROOT, "native", "hookdll", "hookdll.cpp");
const SCRIPT = fs.readFileSync(SCRIPT_PATH, "utf8");
const WINDOWS_DESKTOP_BOOTSTRAP = fs.readFileSync(WINDOWS_DESKTOP_BOOTSTRAP_PATH, "utf8");
const RELEASE_WORKFLOW = fs.readFileSync(RELEASE_WORKFLOW_PATH, "utf8");
const MINHOOK_TAG = "v1.3.4";
const MINHOOK_COMMIT = "c3fcafdc10146beb5919319d0683e44e3c30d537";
// Must stay byte-identical to $bootstrapStateContent in build-hook.ps1
// (LF-joined, no trailing newline, no BOM).
const MINHOOK_REPO = "https://github.com/TsudaKageyu/minhook";
const BOOTSTRAP_STATE_CONTENT = [
  "rb-output-minhook-bootstrap-v1",
  `repo=${MINHOOK_REPO}`,
  `tag=${MINHOOK_TAG}`,
  `commit=${MINHOOK_COMMIT}`,
].join("\n");
// Emitted by the race wrapper on every trusted compiler invocation so the
// Windows PowerShell 5.1 stderr-tolerance behavior is exercised end to end.
const STDERR_NOISE_TEXT = "rb-build-hook-native-stderr-noise";

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

function makeProjectFixture(t) {
  const root = tempRoot(t, "rb-minhook-negative-");
  fs.mkdirSync(path.join(root, "native", "hookdll"), { recursive: true });
  fs.copyFileSync(HOOK_SOURCE, path.join(root, "native", "hookdll", "hookdll.cpp"));
  const cache = path.join(root, "native", "third_party", "minhook");
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  fs.cpSync(MINHOOK_CACHE, cache, { recursive: true });
  // The source checkout may have been materialized under a user's global
  // autocrlf setting. Normalize the copied fixture before the child script
  // deliberately disables global config.
  git(cache, ["config", "core.autocrlf", "false"]);
  git(cache, ["reset", "--hard", "HEAD"]);
  return { root, cache };
}

function runBuild(root, extraEnv = {}, pathPrefix = "", extraArgs = []) {
  const output = path.join(root, "native", "bin", "rb_hook.dll");
  const pathName = Object.keys(process.env).find((name) => name.toLowerCase() === "path") || "Path";
  const inheritedPath = extraEnv[pathName] || process.env[pathName] || "";
  const env = {
    ...process.env,
    ...extraEnv,
    [pathName]: `${pathPrefix}C:\\msys64\\mingw64\\bin;${inheritedPath}`,
    // Exercise the same pwsh7/Git-Bash inherited module path that made the
    // pre-shared bootstrap launcher fail. Production must normalize it itself.
    PSModulePath: [
      "C:\\Program Files\\PowerShell\\Modules",
      "C:\\Program Files\\PowerShell\\7\\Modules",
      "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\Modules",
    ].join(";"),
  };
  const result = spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", SCRIPT_PATH,
    "-ProjectRoot", root,
    "-OutputPath", output,
    ...extraArgs,
  ], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { ...result, output };
}

function makeNetworkUnavailable() {
  // Do not prepend a Git shim: the build script must reject such a caller
  // PATH. A loopback proxy makes an accidental ls-remote/fetch fail while a
  // validated pinned-cache build remains fully offline.
  return {
    env: {
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
      ALL_PROXY: "http://127.0.0.1:1",
      http_proxy: "http://127.0.0.1:1",
      https_proxy: "http://127.0.0.1:1",
      all_proxy: "http://127.0.0.1:1",
      NO_PROXY: "",
      no_proxy: "",
    },
    pathPrefix: "",
  };
}

function makeSourceOnlyProject(t, prefix = "rb-minhook-source-") {
  const root = tempRoot(t, prefix);
  fs.mkdirSync(path.join(root, "native", "hookdll"), { recursive: true });
  fs.copyFileSync(HOOK_SOURCE, path.join(root, "native", "hookdll", "hookdll.cpp"));
  return root;
}

function findNativeGxx() {
  const systemDrive = (process.env.SystemDrive || "C:").replace(/[\\/]+$/, "");
  const candidates = [
    path.join(systemDrive + "\\", "msys64", "mingw64", "bin", "g++.exe"),
    path.join(systemDrive + "\\", "msys32", "mingw64", "bin", "g++.exe"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

// The build script now rejects every caller-PATH compiler that is not a
// native .exe under a trusted installation root, so the post-compile race
// probes must inject their mutation through a native g++.exe wrapper. The
// wrapper is compiled by the machine's trusted MSYS2 g++ into the fixture
// temp directory and registered with the script through its explicit
// -AdditionalTrustedCompilerRoots parameter; no PATH shims are involved.
const RACE_WRAPPER_C = [
  "#include <windows.h>",
  "#include <stdio.h>",
  "#include <string.h>",
  "",
  "static char *join_command_line(const char *real, int argc, char **argv) {",
  "  size_t total = strlen(real) + 4;",
  "  int i;",
  "  char *out;",
  "  for (i = 1; i < argc; i++) total += strlen(argv[i]) + 4;",
  "  out = (char *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, total + 16);",
  "  if (!out) return NULL;",
  "  strcat(out, \"\\\"\");",
  "  strcat(out, real);",
  "  strcat(out, \"\\\"\");",
  "  for (i = 1; i < argc; i++) {",
  "    strcat(out, \" \\\"\");",
  "    strcat(out, argv[i]);",
  "    strcat(out, \"\\\"\");",
  "  }",
  "  return out;",
  "}",
  "",
  "int main(int argc, char **argv) {",
  "  STARTUPINFOA si;",
  "  PROCESS_INFORMATION pi;",
  "  DWORD exitCode = 1;",
  "  char *commandLine;",
  "  FILE *target;",
  "  ZeroMemory(&si, sizeof(si)); si.cb = sizeof(si);",
  "  ZeroMemory(&pi, sizeof(pi));",
  "  commandLine = join_command_line(REAL_COMPILER_PATH, argc, argv);",
  "  if (!commandLine) return 97;",
  "  if (!CreateProcessA(NULL, commandLine, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi)) return 98;",
  "  WaitForSingleObject(pi.hProcess, INFINITE);",
  "  GetExitCodeProcess(pi.hProcess, &exitCode);",
  "  CloseHandle(pi.hThread);",
  "  CloseHandle(pi.hProcess);",
  "  HeapFree(GetProcessHeap(), 0, commandLine);",
  "  if (RACE_STDERR_TEXT[0] != 0) { fputs(RACE_STDERR_TEXT, stderr); fflush(stderr); }",
  "  if (exitCode != 0) return (int)exitCode;",
  "  target = fopen(RACE_TARGET_PATH, \"ab\");",
  "  if (!target) return 99;",
  "  fputs(RACE_CONTENT_TEXT, target);",
  "  fclose(target);",
  "  return 0;",
  "}",
].join("\n");

function makeNativeCompilerRaceWrapper(t, root, target, contentText) {
  const realGxx = findNativeGxx();
  if (!realGxx) {
    return null;
  }
  const shimRoot = path.join(root, "compiler-race-wrapper");
  fs.mkdirSync(shimRoot, { recursive: true });
  const newlineEscape = "\\n";
  const defines = [
    `#define REAL_COMPILER_PATH "${realGxx.replaceAll("\\", "\\\\")}"`,
    `#define RACE_TARGET_PATH "${target.replaceAll("\\", "/")}"`,
    `#define RACE_CONTENT_TEXT "${newlineEscape}${contentText}${newlineEscape}"`,
    `#define RACE_STDERR_TEXT "${STDERR_NOISE_TEXT}${newlineEscape}"`,
  ];
  fs.writeFileSync(path.join(shimRoot, "race_wrapper.c"), [...defines, "", RACE_WRAPPER_C].join("\n"));
  // cc1plus and its MinGW runtime DLLs resolve through the MSYS2 bin
  // directory, so the wrapper compilation needs the same PATH prepend the
  // build script's callers use.
  const pathName = Object.keys(process.env).find((name) => name.toLowerCase() === "path") || "Path";
  const compiled = spawnSync(realGxx, [
    path.join(shimRoot, "race_wrapper.c"),
    "-o", path.join(shimRoot, "g++.exe"),
  ], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      [pathName]: `${path.dirname(realGxx)};${process.env[pathName] || ""}`,
    },
  });
  assert.equal(compiled.status, 0, `race wrapper failed to compile:\n${compiled.stdout}\n${compiled.stderr}`);
  t.after(() => fs.rmSync(shimRoot, { recursive: true, force: true }));
  return shimRoot;
}

test("build-hook pins MinHook to the reviewed immutable release commit", () => {
  assert.match(SCRIPT, new RegExp(`\\$minHookTag\\s*=\\s*"${MINHOOK_TAG}"`));
  assert.match(SCRIPT, new RegExp(`\\$minHookCommit\\s*=\\s*"${MINHOOK_COMMIT}"`));
  assert.equal(MINHOOK_COMMIT.length, 40);
  assert.match(MINHOOK_COMMIT, /^[0-9a-f]{40}$/);
});

test("release workflow uses only the exact MinGW root and explicit trusted-root argument", () => {
  assert.match(RELEASE_WORKFLOW, /C:\\mingw64\\bin/);
  assert.match(RELEASE_WORKFLOW, /run:\s+npm run build:hook -- -AdditionalTrustedCompilerRoots C:\\mingw64/);
  assert.doesNotMatch(RELEASE_WORKFLOW, /C:\\msys64\\mingw64\\bin/);
  assert.doesNotMatch(RELEASE_WORKFLOW, /run:\s+npm run build:hook\s*$/m);
});

test("release workflow pins Actions, serializes each tag, and revalidates before upload", () => {
  const expectedActionPins = [
    ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1", "v7.0.1 (Node 24)"],
    ["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020", "v7.0.0 (Node 24)"],
    ["actions/setup-python", "5fda3b95a4ea91299a34e894583c3862153e4b97", "v7.0.0 (Node 24)"],
    ["softprops/action-gh-release", "3d0d9888cb7fd7b750713d6e236d1fcb99157228", "v3.0.2 (Node 24)"],
  ];
  for (const [action, commit, versionComment] of expectedActionPins) {
    assert.ok(RELEASE_WORKFLOW.includes(`uses: ${action}@${commit}`), `missing immutable pin for ${action}`);
    assert.ok(RELEASE_WORKFLOW.includes(`${action} ${versionComment}`), `missing version comment for ${action}`);
  }
  assert.doesNotMatch(RELEASE_WORKFLOW, /uses:\s+[^\r\n]+@v\d/);
  assert.match(RELEASE_WORKFLOW, /concurrency:\s*\r?\n\s+group:\s+release-\$\{\{\s*github\.ref\s*\}\}\s*\r?\n\s+cancel-in-progress:\s+false/);

  const preflightIndex = RELEASE_WORKFLOW.indexOf("run: node scripts/preflight.js");
  const sealIndex = RELEASE_WORKFLOW.indexOf("node scripts/verify-release-artifacts.js --project-root . --expected-tag $tag");
  const uploadIndex = RELEASE_WORKFLOW.indexOf("uses: softprops/action-gh-release@");
  assert.ok(preflightIndex >= 0, "release workflow must rerun preflight immediately before upload");
  assert.ok(sealIndex > preflightIndex, "release artifact seal must follow the final preflight");
  assert.ok(uploadIndex > sealIndex, "release upload must follow the final release seal");
});

test("release workflow seals the exact v1.1.4 tag, artifacts, and compiler before upload", () => {
  assert.match(RELEASE_WORKFLOW, /runs-on:\s+windows-2025/);
  assert.doesNotMatch(RELEASE_WORKFLOW, /runs-on:\s+windows-latest/);

  const compilerGate = RELEASE_WORKFLOW.indexOf("Require the exact non-reparse MinGW compiler");
  const hookBuild = RELEASE_WORKFLOW.indexOf("name: Build hook DLL");
  assert.ok(compilerGate >= 0 && hookBuild > compilerGate, "exact compiler gate must precede hook build");
  assert.match(RELEASE_WORKFLOW, /Get-Command g\+\+\.exe -CommandType Application -ErrorAction Stop/);
  assert.match(RELEASE_WORKFLOW, /\$expected = "C:\\mingw64\\bin\\g\+\+\.exe"/);
  assert.match(RELEASE_WORKFLOW, /\$command\.Source -cne \$expected/);
  assert.match(RELEASE_WORKFLOW, /ReparsePoint/);

  assert.match(RELEASE_WORKFLOW, /\$expectedTag = "v1\.1\.4"/);
  assert.match(RELEASE_WORKFLOW, /\$env:GITHUB_REF_PROTECTED -cne "true"/);
  assert.match(RELEASE_WORKFLOW, /show-ref --verify --hash "refs\/tags\/\$tag"/);
  assert.match(RELEASE_WORKFLOW, /cat-file -t \$tagObject/);
  assert.match(RELEASE_WORKFLOW, /rev-parse "\$tag\^\{\}"/);
  assert.match(RELEASE_WORKFLOW, /ls-remote --tags --refs origin "refs\/tags\/\$tag"/);
  assert.match(RELEASE_WORKFLOW, /Get-TagBinding -ExpectedObject \$initialObject -ExpectedCommit \$githubSha/);
  assert.match(RELEASE_WORKFLOW, /node scripts\/verify-release-artifacts\.js --project-root \. --expected-tag \$tag/);
  assert.match(RELEASE_WORKFLOW, /tag_name:\s*\$\{\{ github\.ref_name \}\}/);
  assert.match(RELEASE_WORKFLOW, /target_commitish:\s*\$\{\{ github\.sha \}\}/);
  assert.match(RELEASE_WORKFLOW, /dist\/rb-output-1\.1\.4\.zip/);
  assert.doesNotMatch(RELEASE_WORKFLOW, /dist\/rb-output-\*\.zip/);
});

test("build-hook shares the exact fail-closed Windows PowerShell inbox boundary", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(
    packageJson.scripts["build:hook"],
    "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/build-hook.ps1",
  );
  const bootstrapPathIndex = SCRIPT.indexOf("[System.IO.Path]::Combine($PSScriptRoot, \"initialize-windows-desktop-powershell.ps1\")");
  const dotSourceIndex = SCRIPT.indexOf(". $windowsDesktopBootstrapPath");
  const invocationIndex = SCRIPT.search(/^Initialize-WindowsDesktopPowerShellBuildEnvironment$/m);
  const projectRootIndex = SCRIPT.indexOf("if ([string]::IsNullOrWhiteSpace($ProjectRoot))");
  assert.ok(bootstrapPathIndex >= 0 && dotSourceIndex > bootstrapPathIndex, "build-hook does not load the shared Windows PowerShell bootstrap through .NET");
  assert.ok(invocationIndex > dotSourceIndex && projectRootIndex > invocationIndex, "build-hook must normalize the PowerShell module path before project work");
  assert.doesNotMatch(SCRIPT, /function\s+Initialize-WindowsDesktopPowerShellBuildEnvironment/);
  assert.match(SCRIPT, /\[System\.IO\.FileInfo\]::new\(\$windowsDesktopBootstrapPath\)/);
  assert.match(SCRIPT, /windowsDesktopBootstrapItem\.Attributes\s+-band\s+\[System\.IO\.FileAttributes\]::ReparsePoint/);
  assert.match(WINDOWS_DESKTOP_BOOTSTRAP, /\$PSVersionTable\.PSEdition\s+-cne\s+"Desktop"/);
  assert.match(WINDOWS_DESKTOP_BOOTSTRAP, /\$env:PSModulePath\s*=\s+\$nativeModuleDirectory/);
  assert.match(WINDOWS_DESKTOP_BOOTSTRAP, /Get-Command\s+-Name\s+\$requiredCommand\.Name\s+-All\s+-ErrorAction\s+SilentlyContinue/);
});

test("build-hook fetches and verifies the pin without using a moving default branch", () => {
  assert.doesNotMatch(SCRIPT, /git\s+clone\b/i);
  assert.doesNotMatch(SCRIPT, /origin\s+(HEAD|master|main)\b/i);
  assert.doesNotMatch(SCRIPT, /git\s+(clean|reset|rm)\b/i);
  assert.match(SCRIPT, /@\(\s*"fetch"[\s\S]*?"--depth"[\s\S]*?\$minHookRepo[\s\S]*?\$minHookCommit/);
  assert.match(SCRIPT, /"ls-remote"[\s\S]*?\$minHookRepo/);
  assert.match(SCRIPT, /@\(\s*"checkout"[\s\S]*?"--detach"[\s\S]*?\$minHookCommit/);
  assert.match(SCRIPT, /@\(\s*"rev-parse"[\s\S]*?"--verify"[\s\S]*?"HEAD"/);
  assert.match(SCRIPT, /@\(\s*"cat-file"[\s\S]*?"-t"[\s\S]*?"HEAD"/);
  assert.match(SCRIPT, /-cne\s+\$minHookCommit/);
  assert.match(SCRIPT, /\$bootstrapRoot\s*=\s*Join-Path/);
  assert.match(SCRIPT, /\$bootstrapStatePath\s*=\s*Join-Path/);
  assert.match(SCRIPT, /Move-Item\s+-LiteralPath\s+\$bootstrapRoot\s+-Destination\s+\$finalMinHookRoot/);
  assert.match(SCRIPT, /refusing to delete or reuse it/);
});

test("build-hook refuses dirty or reparse-point MinHook caches", () => {
  assert.match(SCRIPT, /ReparsePoint/);
  assert.match(SCRIPT, /status"\s*,\s*"--porcelain=1"/);
  assert.match(SCRIPT, /--untracked-files=all/);
  assert.match(SCRIPT, /checkout is dirty; refusing to overwrite/);
  assert.match(SCRIPT, /refusing to trust it/);
});

test("bootstrap recovery has no broad deletion path", () => {
  assert.doesNotMatch(SCRIPT, /Remove-Item\s+-Recurse/i);
  assert.match(SCRIPT, /Remove-Item\s+-LiteralPath\s+\$bootstrapStatePath/);
  assert.match(SCRIPT, /Remove-Item\s+-LiteralPath\s+\$dllOut/);
  assert.match(SCRIPT, /Move-Item\s+-LiteralPath\s+\$bootstrapRoot/);
  assert.match(SCRIPT, /Unexpected MinHook bootstrap entry/);
});

test("build-hook has an offline fast path for a validated pinned cache", () => {
  assert.match(SCRIPT, /\$needsMinHookNetwork\s*=\s*\$true/);
  assert.match(SCRIPT, /\$cachedHead\.Commit\s*-ceq\s*\$minHookCommit/);
  assert.match(SCRIPT, /Using validated pinned MinHook cache offline/);
  assert.match(SCRIPT, /if \(\$needsMinHookNetwork\)/);
});

test("network refresh verifies the reviewed tag and rejects replacement objects", () => {
  assert.match(SCRIPT, /"ls-remote"[\s\S]*?"--tags"/);
  assert.match(SCRIPT, /refs\/tags\/\$minHookTag/);
  assert.match(SCRIPT, /\$peeledTagRef\s*=\s*"\$tagRef\^\{\}"/);
  assert.match(SCRIPT, /\$remoteTagCommit\s*-cne\s*\$minHookCommit/);
  assert.match(SCRIPT, /GIT_NO_REPLACE_OBJECTS/);
  assert.match(SCRIPT, /"replace",\s*"-l"/);
  assert.match(SCRIPT, /post-compile verification failed/);
  assert.match(SCRIPT, /Remove-ExactDllOutput/);
});

test("Git child calls are isolated from repository-routing and config injection", () => {
  assert.match(SCRIPT, /GIT_DIR/);
  assert.match(SCRIPT, /GIT_WORK_TREE/);
  assert.match(SCRIPT, /GIT_COMMON_DIR/);
  assert.match(SCRIPT, /GIT_OBJECT_DIRECTORY/);
  assert.match(SCRIPT, /GIT_ALTERNATE_OBJECT_DIRECTORIES/);
  assert.match(SCRIPT, /GIT_INDEX_FILE/);
  assert.match(SCRIPT, /GIT_CONFIG_COUNT/);
  assert.match(SCRIPT, /GIT_EXEC_PATH/);
  assert.match(SCRIPT, /GIT_TEMPLATE_DIR/);
  assert.match(SCRIPT, /GIT_EXTERNAL_DIFF/);
  assert.match(SCRIPT, /GIT_CONFIG_\(\?:KEY\|VALUE\)_/);
  assert.match(SCRIPT, /GIT_CONFIG_GLOBAL\s*=\s*"NUL"/);
  assert.match(SCRIPT, /core\.fsmonitor=false/);
  assert.match(SCRIPT, /core\.hooksPath=\$gitHooksPath/);
  assert.match(SCRIPT, /must be a real directory/);
});

test("Git resolution rejects caller PATH shims and fixes one trusted absolute executable", () => {
  assert.match(SCRIPT, /Resolve-TrustedGitExecutable/);
  assert.match(SCRIPT, /CommandType\s*-ne\s+"Application"/);
  assert.match(SCRIPT, /Name\s*-cne\s+"git\.exe"/);
  assert.match(SCRIPT, /Assert-NoReparsePathChain\s+-Path\s+\$candidatePath/);
  assert.match(SCRIPT, /&\s+\$gitExecutable\s+-C\s+\$WorkingDirectory/);
  assert.doesNotMatch(SCRIPT, /&\s+git\s+-C\s+\$WorkingDirectory/);
  assert.match(SCRIPT, /outside the trusted Git for Windows installation roots/);
});

test("Git trust roots derive only from registry and OS known-folder APIs", () => {
  // Caller-controlled environment values must never decide which git.exe
  // installation roots are trusted.
  assert.doesNotMatch(SCRIPT, /ProgramW6432/);
  assert.doesNotMatch(SCRIPT, /GetEnvironmentVariable\(\s*"Program(?:Files|W6432)/);
  assert.doesNotMatch(SCRIPT, /env:ProgramFiles/);
  // Machine-scope derivation instead.
  assert.match(SCRIPT, /Get-TrustedGitInstallationRoots/);
  assert.match(SCRIPT, /HKLM:\\SOFTWARE\\GitForWindows/);
  assert.match(SCRIPT, /HKLM:\\SOFTWARE\\WOW6432Node\\GitForWindows/);
  assert.match(SCRIPT, /GetFolderPath\("ProgramFiles"\)/);
  assert.match(SCRIPT, /GetFolderPath\("ProgramFilesX86"\)/);
});

test("compiler resolution validates native executables against trusted installation roots", () => {
  assert.match(SCRIPT, /Get-TrustedCompilerInstallationRoots/);
  assert.match(SCRIPT, /Assert-TrustedNativeCompilerExecutable/);
  assert.match(SCRIPT, /CommandType\s*-ne\s+"Application"/);
  assert.match(SCRIPT, /\$candidateItem\.Name\s*-cne\s+\$ExecutableFileName/);
  assert.match(SCRIPT, /Assert-NoReparsePathChain\s+-Path\s+\$candidatePath\s+-Label\s+"Trusted compiler executable"/);
  assert.match(SCRIPT, /outside the trusted compiler installation roots/);
  // MSYS2 roots come from the OS system drive; no caller environment value.
  assert.match(SCRIPT, /\[Environment\]::SystemDirectory/);
  assert.doesNotMatch(SCRIPT, /env:MSYSTEM|MSYS2_ROOT|MINGW_PREFIX/);
  // The unvalidated legacy invocations must be gone entirely.
  assert.doesNotMatch(SCRIPT, /Get-Command\s+"g\+\+"/);
  assert.doesNotMatch(SCRIPT, /&\s+\$gxx\.Source\b/);
  assert.doesNotMatch(SCRIPT, /&\s+cl\.exe\b/);
  assert.match(SCRIPT, /Invoke-TrustedNativeExecutable\s+-Label\s+"g\+\+"\s+-ExecutablePath\s+\$gxxExecutable/);
  assert.match(SCRIPT, /Invoke-TrustedNativeExecutable\s+-Label\s+"cl"\s+-ExecutablePath\s+\$clExecutable/);
});

test("Visual Studio toolchain discovery derives only from machine-installed locations", () => {
  assert.doesNotMatch(SCRIPT, /ProgramW6432/);
  assert.doesNotMatch(SCRIPT, /env:ProgramFiles\(x86\)/);
  assert.match(SCRIPT, /Microsoft Visual Studio\\Installer\\vswhere\.exe/);
  assert.match(SCRIPT, /VC\\Tools\\MSVC/);
  assert.match(SCRIPT, /Hostx64/);
  // cl.exe must be resolved by explicit validated path, never by name.
  assert.doesNotMatch(SCRIPT, /&\s+cl\.exe\s+\$clArgs/);
  // The vcvars shell must be the OS system cmd.exe, not a caller ComSpec.
  assert.doesNotMatch(SCRIPT, /&\s+\$env:ComSpec\b/);
  assert.match(SCRIPT, /Join-Path\s+\(\[Environment\]::SystemDirectory\)\s+"cmd\.exe"/);
});

test("caller PATH git.cmd shim is rejected before source or DLL use", (t) => {
  const fixture = makeProjectFixture(t);
  const shimRoot = path.join(fixture.root, "git-shim");
  const marker = path.join(fixture.root, "git-shim-marker.txt");
  fs.mkdirSync(shimRoot, { recursive: true });
  fs.writeFileSync(path.join(shimRoot, "git.cmd"), [
    "@echo off",
    `echo shim-hit>>"${marker}"`,
    "exit /b 91",
    "",
  ].join("\r\n"));

  const result = runBuild(fixture.root, {}, `${shimRoot};`);
  assert.notEqual(result.status, 0, "caller PATH git.cmd shim was accepted");
  assert.match(`${result.stdout}\n${result.stderr}`, /native git\.exe|expected regular git\.exe|trusted Git/i);
  assert.equal(fs.existsSync(marker), false, "Git shim was executed");
  assert.equal(fs.existsSync(result.output), false, "hook DLL was produced after Git shim rejection");
});

test("native git.exe outside trusted installation roots is rejected before execution", (t) => {
  const fixture = makeProjectFixture(t);
  const untrustedRoot = path.join(fixture.root, "untrusted-git");
  fs.mkdirSync(untrustedRoot, { recursive: true });
  // A native-named Application that PowerShell resolves first on PATH. The
  // bytes are never executed: provenance validation must reject it purely on
  // its location outside every machine-scope trusted root.
  fs.writeFileSync(path.join(untrustedRoot, "git.exe"), "not-a-real-executable");

  const result = runBuild(fixture.root, {}, `${untrustedRoot};`);
  assert.notEqual(result.status, 0, "git.exe outside trusted roots was accepted");
  assert.match(`${result.stdout}\n${result.stderr}`, /outside the trusted Git for Windows installation roots/);
  assert.equal(fs.existsSync(result.output), false, "hook DLL was produced after trusted-root rejection");
});

test("caller PATH g++ shim is rejected by compiler provenance validation", (t) => {
  const fixture = makeProjectFixture(t);
  const shimRoot = path.join(fixture.root, "gxx-shim");
  const marker = path.join(fixture.root, "gxx-shim-marker.txt");
  fs.mkdirSync(shimRoot, { recursive: true });
  fs.writeFileSync(path.join(shimRoot, "g++.cmd"), [
    "@echo off",
    `echo gxx-shim-hit>>"${marker}"`,
    "exit /b 92",
    "",
  ].join("\r\n"));

  const result = runBuild(fixture.root, {}, `${shimRoot};`);
  assert.notEqual(result.status, 0, "caller PATH g++.cmd shim was accepted");
  assert.match(`${result.stdout}\n${result.stderr}`, /not a native compiler executable|not the expected regular g\+\+\.exe/i);
  assert.equal(fs.existsSync(marker), false, "g++ shim was executed");
  assert.equal(fs.existsSync(result.output), false, "hook DLL was produced after g++ shim rejection");
});

test("native g++.exe outside trusted compiler roots fails closed without VS fallback", (t) => {
  const fixture = makeProjectFixture(t);
  const untrustedRoot = path.join(fixture.root, "untrusted-gxx");
  fs.mkdirSync(untrustedRoot, { recursive: true });
  // Native-named placeholder that resolves before the real MSYS2 g++. The
  // script must fail closed instead of silently falling back to Visual Studio.
  fs.writeFileSync(path.join(untrustedRoot, "g++.exe"), "not-a-real-executable");

  const result = runBuild(fixture.root, {}, `${untrustedRoot};`);
  assert.notEqual(result.status, 0, "g++.exe outside trusted roots was accepted");
  assert.match(`${result.stdout}\n${result.stderr}`, /outside the trusted compiler installation roots/);
  assert.equal(fs.existsSync(result.output), false, "hook DLL was produced after compiler root rejection");
});

test("local Git config and metadata are parsed fail-closed before Git trust", () => {
  for (const fragment of [
    "Assert-MinHookConfig",
    "Assert-MinHookLocalMetadata",
    "section -notin",
    "unsafe local Git config key rejected",
    "unsafe local Git remote config key rejected",
    "info\\attributes",
    "objects\\info\\alternates",
    "http-alternates",
    "refs\\replace",
  ]) {
    assert.match(SCRIPT, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), fragment);
  }
  assert.match(SCRIPT, /hash-object"[\s\S]*?--no-filters/);
  assert.match(SCRIPT, /ls-files"[\s\S]*?"-v"[\s\S]*?"-z"/);
  assert.match(SCRIPT, /record\[0\][\s\S]*?-cne\s+"H"/);
});

test("malicious local config cannot execute include/filter/credential/url or smudge markers", (t) => {
  const entries = [
    ["include.path", (fixture, marker) => path.join(fixture.root, "include-marker.cmd")],
    ["includeIf.onbranch:master.path", (fixture, marker) => path.join(fixture.root, "includeif-marker.cmd")],
    ["filter.bad.process", (fixture, marker) => path.join(fixture.root, "filter-marker.cmd")],
    ["diff.bad.textconv", (fixture, marker) => path.join(fixture.root, "textconv-marker.cmd")],
    ["merge.bad.driver", (fixture, marker) => path.join(fixture.root, "merge-driver-marker.cmd")],
    ["credential.helper", (fixture, marker) => path.join(fixture.root, "credential-marker.cmd")],
    ["url.file:///attacker/.insteadOf", (fixture, marker) => "https://github.com/TsudaKageyu/minhook"],
    ["core.attributesFile", (fixture, marker) => path.join(fixture.root, "attributes-marker")],
    ["core.fsmonitor", (fixture, marker) => path.join(fixture.root, "fsmonitor-config-marker.cmd")],
    ["core.hooksPath", (fixture, marker) => path.join(fixture.root, "hooks-marker")],
    ["core.worktree", (fixture, marker) => path.join(fixture.root, "worktree-marker")],
    ["core.sparseCheckout", (fixture, marker) => "true"],
    ["http.proxy", (fixture, marker) => "http://127.0.0.1:9"],
    ["remote.origin.uploadpack", (fixture, marker) => path.join(fixture.root, "uploadpack-marker")],
    ["remote.origin.proxy", (fixture, marker) => "http://127.0.0.1:9"],
  ];
  for (const [key, valueFactory] of entries) {
    const fixture = makeProjectFixture(t);
    const marker = path.join(fixture.root, `${key.replace(/[^A-Za-z0-9]+/g, "-")}-executed.txt`);
    const value = valueFactory(fixture, marker);
    if (String(value).endsWith(".cmd")) {
      fs.writeFileSync(value, `@echo marker-hit>>"${marker}"\r\n`);
    } else if (key === "core.hooksPath") {
      fs.mkdirSync(value, { recursive: true });
      fs.writeFileSync(path.join(value, "post-checkout"), `#!/bin/sh\necho marker-hit >> "${marker.replaceAll("\\", "/")}"\n`);
    }
    git(fixture.cache, ["config", key, value]);
    const result = runBuild(fixture.root);
    assert.notEqual(result.status, 0, `${key} injection was accepted`);
    assert.match(`${result.stdout}\n${result.stderr}`, /unsafe local Git (config|remote) |malformed local Git config/);
    assert.equal(fs.existsSync(marker), false, `${key} marker executed`);
    assert.equal(fs.existsSync(result.output), false, `${key} produced a DLL after rejection`);
  }
});

test("info attributes and index assume/skip flags cannot make modified files look clean", (t) => {
  const infoFixture = makeProjectFixture(t);
  const infoMarker = path.join(infoFixture.root, "info-attributes-marker.txt");
  fs.writeFileSync(path.join(infoFixture.cache, ".git", "info", "attributes"), `* filter=bad\n# ${infoMarker}\n`);
  fs.appendFileSync(path.join(infoFixture.cache, "src", "hde", "hde64.h"), "\nattacker-change\n");
  git(infoFixture.cache, ["update-index", "--assume-unchanged", "src/hde/hde64.h"]);
  const infoResult = runBuild(infoFixture.root);
  assert.notEqual(infoResult.status, 0, "info attributes/assume-unchanged fixture was accepted");
  assert.match(`${infoResult.stdout}\n${infoResult.stderr}`, /info attributes|unsafe local Git config/);
  assert.equal(fs.existsSync(infoMarker), false, "info attributes marker executed");

  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const fixture = makeProjectFixture(t);
    const marker = path.join(fixture.root, `${flag.slice(2)}-marker.txt`);
    fs.appendFileSync(path.join(fixture.cache, "src", "hde", "hde64.h"), "\nindex-flag-change\n");
    git(fixture.cache, ["update-index", flag, "src/hde/hde64.h"]);
    const result = runBuild(fixture.root);
    assert.notEqual(result.status, 0, `${flag} fixture was accepted`);
    assert.match(`${result.stdout}\n${result.stderr}`, /assume-unchanged|skip-worktree|raw worktree hash mismatch|dirty/);
    assert.equal(fs.existsSync(marker), false, `${flag} marker executed`);
  }
});

test("clean exact cache builds offline without contacting the MinHook remote", (t) => {
  const fixture = makeProjectFixture(t);
  const first = runBuild(fixture.root);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

  const blocker = makeNetworkUnavailable();
  const result = runBuild(fixture.root, blocker.env, blocker.pathPrefix);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(`${result.stdout}\n${result.stderr}`, /Using validated pinned MinHook cache offline/);
  assert.equal(fs.existsSync(result.output), true, "hook DLL was not produced");
  assert.equal(git(fixture.cache, ["rev-parse", "HEAD"]).stdout.trim(), MINHOOK_COMMIT);
});

test("interrupted HEAD-less bootstrap is retried from owned staging without deletion", (t) => {
  const root = makeSourceOnlyProject(t, "rb-minhook-bootstrap-");
  const unavailable = makeNetworkUnavailable();
  const first = runBuild(root, unavailable.env, unavailable.pathPrefix);
  assert.notEqual(first.status, 0, "network-blocked bootstrap unexpectedly succeeded");

  const thirdParty = path.join(root, "native", "third_party");
  const finalCache = path.join(thirdParty, "minhook");
  const staging = path.join(thirdParty, "minhook.bootstrap");
  const state = path.join(thirdParty, "minhook.bootstrap.state");
  assert.equal(fs.existsSync(finalCache), false, "partial bootstrap became the final cache");
  assert.equal(fs.existsSync(staging), true, "owned bootstrap staging was not preserved");
  assert.equal(fs.existsSync(path.join(staging, ".git")), true, "HEAD-less Git staging repo was not preserved");
  assert.equal(fs.existsSync(state), true, "owned bootstrap state marker was not preserved");

  const retry = runBuild(root);
  assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
  assert.equal(fs.existsSync(retry.output), true, "retry did not produce the hook DLL");
  assert.equal(fs.existsSync(finalCache), true, "verified staging was not renamed into the final cache");
  assert.equal(fs.existsSync(staging), false, "bootstrap staging remained after successful rename");
  assert.equal(fs.existsSync(state), false, "bootstrap state marker remained after successful rename");
  assert.equal(git(finalCache, ["rev-parse", "HEAD"]).stdout.trim(), MINHOOK_COMMIT);
});

test("owned state after rename recovers offline by verifying destination and removing only the marker", (t) => {
  const fixture = makeProjectFixture(t);
  const thirdParty = path.join(fixture.root, "native", "third_party");
  const state = path.join(thirdParty, "minhook.bootstrap.state");
  const staging = path.join(thirdParty, "minhook.bootstrap");

  const first = runBuild(fixture.root);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);

  // Simulate an interruption between the same-parent rename into the final
  // cache and the removal of the owned state marker.
  fs.writeFileSync(state, BOOTSTRAP_STATE_CONTENT);
  assert.equal(fs.existsSync(staging), false, "fixture must not contain staging");

  const blocker = makeNetworkUnavailable();
  const recovery = runBuild(fixture.root, blocker.env, blocker.pathPrefix);
  assert.equal(recovery.status, 0, `${recovery.stdout}\n${recovery.stderr}`);
  assert.match(`${recovery.stdout}\n${recovery.stderr}`, /Using validated pinned MinHook cache offline/);
  assert.equal(fs.existsSync(state), false, "owned bootstrap state marker was not removed");
  assert.equal(fs.existsSync(staging), false, "recovery created unexpected staging");
  assert.equal(fs.existsSync(recovery.output), true, "recovery did not produce the hook DLL");
});

test("destination and owned staging conflict refuses ambiguous recovery", (t) => {
  const fixture = makeProjectFixture(t);
  const thirdParty = path.join(fixture.root, "native", "third_party");
  const staging = path.join(thirdParty, "minhook.bootstrap");
  const state = path.join(thirdParty, "minhook.bootstrap.state");
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, "staging-entry.txt"), "do-not-touch");
  fs.writeFileSync(state, BOOTSTRAP_STATE_CONTENT);

  const result = runBuild(fixture.root);
  assert.notEqual(result.status, 0, "destination+staging conflict was accepted");
  assert.match(`${result.stdout}\n${result.stderr}`, /destination and staging directory both exist/i);
  assert.equal(fs.existsSync(staging), true, "staging directory was modified or deleted during refusal");
  assert.equal(fs.existsSync(path.join(staging, "staging-entry.txt")), true, "staging contents were not preserved");
  assert.equal(fs.existsSync(state), true, "owned state marker was removed during refusal");
  assert.equal(fs.existsSync(result.output), false, "hook DLL was produced despite ambiguous recovery");
});

test("unowned bootstrap staging blocks bootstrap without any deletion", (t) => {
  const root = makeSourceOnlyProject(t, "rb-minhook-unowned-");
  const staging = path.join(root, "native", "third_party", "minhook.bootstrap");
  fs.mkdirSync(path.join(staging, "junk"), { recursive: true });
  fs.writeFileSync(path.join(staging, "attacker.txt"), "do-not-delete");

  const result = runBuild(root);
  assert.notEqual(result.status, 0, "unowned bootstrap staging was accepted");
  assert.match(`${result.stdout}\n${result.stderr}`, /Unowned MinHook bootstrap staging directory exists/);
  assert.equal(fs.existsSync(path.join(staging, "attacker.txt")), true, "unowned staging contents were modified or deleted");
  assert.equal(fs.existsSync(result.output), false, "hook DLL was produced despite unowned staging");
});

test("junction MinHook cache is refused without following or modifying it", (t) => {
  const root = makeSourceOnlyProject(t, "rb-minhook-junction-");
  const thirdParty = path.join(root, "native", "third_party");
  const cacheTarget = path.join(root, "junction-target");
  const cacheLink = path.join(thirdParty, "minhook");
  fs.mkdirSync(thirdParty, { recursive: true });
  fs.mkdirSync(cacheTarget, { recursive: true });
  let linked = false;
  try {
    fs.symlinkSync(cacheTarget, cacheLink, "junction");
    linked = fs.lstatSync(cacheLink).isSymbolicLink();
  } catch {
    linked = false;
  }
  if (!linked) {
    t.skip("junction creation is not permitted in this environment");
    return;
  }

  const result = runBuild(root);
  assert.notEqual(result.status, 0, "junction MinHook checkout was accepted");
  assert.match(`${result.stdout}\n${result.stderr}`, /reparse point; refusing to trust it/i);
  assert.equal(fs.lstatSync(cacheLink).isSymbolicLink(), true, "junction was deleted or replaced instead of refused");
  assert.equal(fs.existsSync(path.join(cacheTarget, ".git")), false, "junction target was populated by bootstrap");
  assert.equal(fs.existsSync(result.output), false, "hook DLL was produced from a junctioned checkout");
});

test("missing cache fetches only the reviewed tag commit and builds", (t) => {
  const root = tempRoot(t, "rb-minhook-missing-");
  fs.mkdirSync(path.join(root, "native", "hookdll"), { recursive: true });
  fs.copyFileSync(HOOK_SOURCE, path.join(root, "native", "hookdll", "hookdll.cpp"));

  const result = runBuild(root);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(result.output), true, "hook DLL was not produced");
  const cache = path.join(root, "native", "third_party", "minhook");
  assert.equal(git(cache, ["rev-parse", "HEAD"]).stdout.trim(), MINHOOK_COMMIT);
  assert.equal(git(cache, ["status", "--porcelain"]).stdout.trim(), "");
});

test("stale clean cache verifies the remote tag and refreshes only to the pin", (t) => {
  const fixture = makeProjectFixture(t);
  git(fixture.cache, [
    "-c", "user.name=minhook-test", "-c", "user.email=minhook-test@example.invalid",
    "commit", "--allow-empty", "-m", "stale-cache",
  ]);
  assert.notEqual(git(fixture.cache, ["rev-parse", "HEAD"]).stdout.trim(), MINHOOK_COMMIT);

  const result = runBuild(fixture.root);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(result.output), true, "hook DLL was not produced");
  assert.equal(git(fixture.cache, ["rev-parse", "HEAD"]).stdout.trim(), MINHOOK_COMMIT);
  assert.equal(git(fixture.cache, ["status", "--porcelain"]).stdout.trim(), "");
});

test("source mutation after compile is caught and only the exact DLL output is removed", (t) => {
  const fixture = makeProjectFixture(t);
  const target = path.join(fixture.cache, "src", "hde", "hde64.h");
  const wrapperRoot = makeNativeCompilerRaceWrapper(t, fixture.root, target, "race-source-change");
  if (!wrapperRoot) {
    t.skip("trusted MSYS2 g++ is unavailable for the post-compile race probe");
    return;
  }

  const result = runBuild(fixture.root, {}, `${wrapperRoot};`, [
    "-AdditionalTrustedCompilerRoots", wrapperRoot,
  ]);
  assert.notEqual(result.status, 0, "source mutation after compile was accepted");
  assert.match(`${result.stdout}\n${result.stderr}`, /post-compile verification failed|source\/config changed|raw worktree hash mismatch/i);
  assert.equal(fs.existsSync(result.output), false, "stale DLL survived source-race rejection");
  assert.equal(fs.existsSync(path.join(fixture.root, "native", "bin", "rb_hook.lib")), false, "unrelated import library was removed or created unexpectedly");
});

test("config mutation after compile is caught and only the exact DLL output is removed", (t) => {
  const fixture = makeProjectFixture(t);
  const target = path.join(fixture.cache, ".git", "config");
  const wrapperRoot = makeNativeCompilerRaceWrapper(
    t, fixture.root, target,
    "[core]\\nfsmonitor=race-config-change\\n",
  );
  if (!wrapperRoot) {
    t.skip("trusted MSYS2 g++ is unavailable for the post-compile config race probe");
    return;
  }

  const result = runBuild(fixture.root, {}, `${wrapperRoot};`, [
    "-AdditionalTrustedCompilerRoots", wrapperRoot,
  ]);
  assert.notEqual(result.status, 0, "config mutation after compile was accepted");
  assert.match(`${result.stdout}\n${result.stderr}`, /post-compile verification failed|source\/config changed|unsafe local Git config/i);
  assert.equal(fs.existsSync(result.output), false, "stale DLL survived config-race rejection");
});

test("clean exact cache rejects a malicious core.fsmonitor command before build", (t) => {
  const fixture = makeProjectFixture(t);
  const marker = path.join(fixture.root, "fsmonitor-marker.txt");
  const command = path.join(fixture.root, "fsmonitor-marker.cmd");
  fs.writeFileSync(command, `@echo fsmonitor-hit>>"${marker}"\r\n`);
  git(fixture.cache, ["config", "core.fsmonitor", command]);

  const result = runBuild(fixture.root);
  assert.notEqual(result.status, 0, "malicious local core.fsmonitor was accepted");
  assert.match(`${result.stdout}\n${result.stderr}`, /unsafe local Git config key rejected/);
  assert.equal(fs.existsSync(marker), false, "malicious fsmonitor command executed");
  assert.equal(fs.existsSync(result.output), false, "hook DLL was produced after rejected cache");
});

test("stale cache rejects a malicious post-checkout hook before refresh", (t) => {
  const fixture = makeProjectFixture(t);
  git(fixture.cache, [
    "-c", "user.name=minhook-test", "-c", "user.email=minhook-test@example.invalid",
    "commit", "--allow-empty", "-m", "stale-cache",
  ]);

  const marker = path.join(fixture.root, "post-checkout-marker.txt");
  const markerPosix = marker.replaceAll("\\", "/");
  const maliciousHooksPath = path.join(fixture.root, "malicious-hooks");
  fs.mkdirSync(maliciousHooksPath, { recursive: true });
  git(fixture.cache, ["config", "core.hooksPath", maliciousHooksPath]);
  fs.writeFileSync(
    path.join(maliciousHooksPath, "post-checkout"),
    `#!/bin/sh\necho post-checkout-hit >> "${markerPosix}"\n`,
  );

  const result = runBuild(fixture.root);
  assert.notEqual(result.status, 0, "malicious local core.hooksPath was accepted");
  assert.match(`${result.stdout}\n${result.stderr}`, /unsafe local Git config key rejected|malicious/i);
  assert.equal(fs.existsSync(marker), false, "malicious post-checkout hook executed");
  assert.equal(fs.existsSync(result.output), false, "hook DLL was produced after rejected cache");
});

test("ordinary .git gitfiles are rejected before source use", (t) => {
  const root = tempRoot(t, "rb-minhook-gitfile-");
  fs.mkdirSync(path.join(root, "native", "hookdll"), { recursive: true });
  fs.copyFileSync(HOOK_SOURCE, path.join(root, "native", "hookdll", "hookdll.cpp"));
  const cache = path.join(root, "native", "third_party", "minhook");
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, ".git"), "gitdir: C:/attacker/gitdir\n");

  const result = runBuild(root);
  assert.notEqual(result.status, 0, "ordinary .git gitfile was accepted");
  assert.match(`${result.stdout}\n${result.stderr}`, /must be a real directory/);
  assert.equal(fs.existsSync(path.join(root, "native", "bin", "rb_hook.dll")), false);
});

test("inherited Git routing and config injection cannot reroute a clean cache", (t) => {
  const fixture = makeProjectFixture(t);
  const marker = path.join(fixture.root, "injection-marker.txt");
  const command = path.join(fixture.root, "injection-marker.cmd");
  fs.writeFileSync(command, `@echo injection-hit>>"${marker}"\r\n`);

  const pathName = Object.keys(process.env).find((name) => name.toLowerCase() === "path") || "Path";
  const env = {
    ...process.env,
    GIT_DIR: path.join(fixture.root, "not-a-repo"),
    GIT_WORK_TREE: fixture.root,
    GIT_COMMON_DIR: path.join(fixture.root, "common-dir"),
    GIT_OBJECT_DIRECTORY: path.join(fixture.root, "objects"),
    GIT_INDEX_FILE: path.join(fixture.root, "attacker-index"),
    GIT_EXEC_PATH: path.join(fixture.root, "attacker-git-exec"),
    GIT_TEMPLATE_DIR: path.join(fixture.root, "attacker-template"),
    GIT_EXTERNAL_DIFF: command,
    GIT_PAGER: command,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: command,
    [pathName]: `C:\\msys64\\mingw64\\bin;${process.env[pathName] || ""}`,
  };
  const output = path.join(fixture.root, "native", "bin", "rb_hook.dll");
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT_PATH,
    "-ProjectRoot", fixture.root, "-OutputPath", output,
  ], { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(marker), false, "inherited Git config injection executed");
  assert.equal(fs.existsSync(output), true, "hook DLL was not produced");
});

test("additional trusted compiler roots satisfy the same trust rules before use", () => {
  assert.match(SCRIPT, /Get-ValidatedAdditionalCompilerRoots/);
  assert.match(SCRIPT, /Additional trusted compiler root is empty/);
  assert.match(SCRIPT, /not rooted; refusing relative additional trusted compiler root/);
  assert.match(SCRIPT, /covers an entire drive; refusing overly broad additional trusted compiler root/);
  assert.match(SCRIPT, /Additional trusted compiler root must be a real directory/);
  assert.match(
    SCRIPT,
    /Assert-NoReparsePathChain -Path \$full -Label "Additional trusted compiler root"/,
  );
  assert.match(
    SCRIPT,
    /\$validatedAdditionalCompilerRoots = @\(Get-ValidatedAdditionalCompilerRoots -Roots \$AdditionalTrustedCompilerRoots\)/,
  );
  assert.match(
    SCRIPT,
    /\$compilerInstallationRoots = @\(Get-TrustedCompilerInstallationRoots\) \+ \$validatedAdditionalCompilerRoots/,
  );
});

test("invalid additional trusted compiler roots are rejected before any compiler trust", (t) => {
  const fixture = makeProjectFixture(t);
  const invalidRoots = [
    "",
    "untrusted-relative-root",
    "C:\\",
    path.join(fixture.root, "does-not-exist"),
  ];
  for (const invalidRoot of invalidRoots) {
    const result = runBuild(fixture.root, {}, "", [
      "-AdditionalTrustedCompilerRoots", invalidRoot,
    ]);
    assert.notEqual(result.status, 0, `invalid additional root was accepted: '${invalidRoot}'`);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /[Aa]dditional trusted compiler root/,
      `rejection lacked the additional-root diagnostic for: '${invalidRoot}'`,
    );
    assert.equal(
      fs.existsSync(result.output),
      false,
      `DLL was produced despite invalid additional root: '${invalidRoot}'`,
    );
  }
});

test("Windows PowerShell 5.1 native stderr cannot fabricate a build failure", () => {
  assert.match(SCRIPT, /function Invoke-TrustedNativeExecutable/);
  assert.match(SCRIPT, /ErrorActionPreference = "Continue"/);
  assert.match(SCRIPT, /-is \[System\.Management\.Automation\.ErrorRecord\]/);
  assert.match(SCRIPT, /failed with exit code \$exitCode/);
  assert.match(SCRIPT, /sanitized diagnostics follow/);
  // The legacy unguarded native invocations are gone entirely.
  assert.doesNotMatch(SCRIPT, /=\s*&\s*\$vsWhere\b/);
  assert.doesNotMatch(SCRIPT, /=\s*&\s*\$commandComSpec\b/);
  assert.doesNotMatch(SCRIPT, /&\s+\$gxxExecutable\s+\$gxxArgs/);
  assert.doesNotMatch(SCRIPT, /&\s+\$clExecutable\s+\$clArgs/);
  assert.match(SCRIPT, /Invoke-TrustedNativeExecutable -Label "vswhere"/);
  assert.match(SCRIPT, /Invoke-TrustedNativeExecutable -Label "Visual Studio build environment initialization"/);
  assert.match(SCRIPT, /Invoke-TrustedNativeExecutable -Label "g\+\+"/);
  assert.match(SCRIPT, /Invoke-TrustedNativeExecutable -Label "cl"/);
});

test("trusted compiler stderr noise with a zero exit keeps the build green", (t) => {
  const fixture = makeProjectFixture(t);
  const noiseTarget = path.join(fixture.root, "noise-target.txt");
  const wrapperRoot = makeNativeCompilerRaceWrapper(t, fixture.root, noiseTarget, "harmless-post-build-note");
  if (!wrapperRoot) {
    t.skip("trusted MSYS2 g++ is unavailable for the stderr-noise probe");
    return;
  }

  const result = runBuild(fixture.root, {}, `${wrapperRoot};`, [
    "-AdditionalTrustedCompilerRoots", wrapperRoot,
  ]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(fs.existsSync(result.output), true, "hook DLL was not produced despite stderr noise on success");
  assert.ok(
    `${result.stdout}\n${result.stderr}`.includes(STDERR_NOISE_TEXT),
    "native stderr noise was neither surfaced nor tolerated",
  );
  assert.ok(
    fs.readFileSync(noiseTarget, "utf8").includes("harmless-post-build-note"),
    "successful compiler invocation did not reach its completion marker",
  );
});

test("the first linker must be the exact MSVC link.exe beside the selected cl.exe", () => {
  assert.match(SCRIPT, /Immediately before cl\.exe runs/);
  assert.match(SCRIPT, /\$expectedLinker = Join-Path \$clDirectory "link\.exe"/);
  assert.match(SCRIPT, /Assert-RegularFile -Path \$expectedLinker -Label "MSVC link"/);
  assert.match(SCRIPT, /Assert-NoReparsePathChain -Path \$expectedLinker -Label "MSVC link"/);
  assert.match(SCRIPT, /Get-Command link -All/);
  assert.match(SCRIPT, /First resolved linker is not a native link\.exe/);
  assert.match(SCRIPT, /First linker on PATH is not the pinned MSVC link\.exe/);
  assert.match(SCRIPT, /Git usr\\bin\\link\.exe can never win/);
  assert.doesNotMatch(SCRIPT, /&\s+link(?:\.exe)?\b/);
});

test("Git pin verification is locale-independent and strips Git noise and paths", () => {
  // No localized Git message may ever be parsed again.
  assert.doesNotMatch(SCRIPT, /Needed a single revision|unknown revision|ambiguous argument/);
  assert.match(SCRIPT, /"rev-parse", "--verify", "--quiet", "HEAD"/);
  assert.match(SCRIPT, /"symbolic-ref", "--quiet", "HEAD"/);
  assert.match(SCRIPT, /\[switch\]\$TolerateExitFailure/);
  assert.match(SCRIPT, /MinHook checkout HEAD is unreadable/);
  assert.match(SCRIPT, /"advice\.detachedHead=false"/);
  assert.match(SCRIPT, /GIT_TRACE_PACKET = "0"/);
  assert.match(SCRIPT, /LC_ALL = "C"/);
  assert.match(
    SCRIPT,
    /git \$verb failed with exit code \$exitCode \(diagnostic output and paths suppressed\)/,
  );
  assert.doesNotMatch(SCRIPT, /failed: \$details/);
  assert.match(SCRIPT, /@gitArguments 2>\$null/);
  assert.match(SCRIPT, /changed or untracked entries \(paths suppressed\)/);
});

test("corrupt HEAD fails closed with a stable sanitized diagnosis and no cleanup", (t) => {
  const fixture = makeProjectFixture(t);
  fs.writeFileSync(path.join(fixture.cache, ".git", "HEAD"), "garbage-unreadable-head\n");
  const blocker = makeNetworkUnavailable();
  const result = runBuild(fixture.root, blocker.env, blocker.pathPrefix);
  assert.notEqual(result.status, 0, "corrupt HEAD fixture was accepted");
  const combined = `${result.stdout}\n${result.stderr}`;
  assert.match(
    combined,
    /git [a-z][a-z0-9-]* failed with exit code \d+ \(diagnostic output and paths suppressed\)/,
    "stable exit-code diagnosis missing",
  );
  assert.doesNotMatch(combined, /[Ff]atal:/, "localized Git stderr leaked into the failure");
  assert.doesNotMatch(
    combined,
    /Needed a single revision|unknown revision|ambiguous argument/,
    "localized Git message text was parsed or echoed",
  );
  assert.equal(fs.existsSync(result.output), false, "DLL was produced despite unreadable HEAD");
  assert.equal(
    fs.existsSync(path.join(fixture.cache, ".git", "HEAD")),
    true,
    "corrupt fixture was modified during refusal",
  );
});

test("every temporary and staging cleanup target is exact, ancestry-validated, and narrow", () => {
  assert.match(SCRIPT, /function Remove-ExactDllOutput/);
  assert.match(SCRIPT, /Assert-NoReparsePathChain -Path \$dllOut -Label "Hook DLL output"/);
  assert.match(SCRIPT, /Assert-NoReparsePathChain -Path \$bootstrapStatePath -Label "MinHook bootstrap state"/);
  assert.match(SCRIPT, /Remove-Item -LiteralPath \$bootstrapStatePath -Force -ErrorAction Stop/);
  assert.match(SCRIPT, /Remove-Item -LiteralPath \$dllOut -Force -ErrorAction Stop/);
  assert.doesNotMatch(SCRIPT, /Remove-Item\s+[^\r\n]*-Recurse/i);
  assert.doesNotMatch(SCRIPT, /Remove-Item\s+-Path\b/);
  assert.doesNotMatch(SCRIPT, /Remove-Item\s+[^\r\n]*\*/);
});
