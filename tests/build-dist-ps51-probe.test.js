"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");
const BUILD_SCRIPT = path.join(REPO_ROOT, "scripts", "build-dist.ps1");
const WINDOWS_DESKTOP_BOOTSTRAP = path.join(REPO_ROOT, "scripts", "initialize-windows-desktop-powershell.ps1");
const PROBE_HELPER = path.join(REPO_ROOT, "scripts", "invoke-packaging-probe.ps1");

function runPowerShellFile(executable, filePath) {
  return spawnSync(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", filePath],
    { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true, timeout: 180000 },
  );
}

function extractProbeSource(helperSource) {
  const startMarker = "$script:PackagingMetadataProbeSource = @'\n";
  const endMarker = "\n'@";
  const startIndex = helperSource.indexOf(startMarker);
  assert.ok(startIndex >= 0, "probe source herestring start marker missing");
  const bodyStart = startIndex + startMarker.length;
  const endIndex = helperSource.indexOf(endMarker, bodyStart);
  assert.ok(endIndex > bodyStart, "probe source herestring end marker missing");
  return helperSource.slice(bodyStart, endIndex);
}

function buildProbeScenarioScript(helperPath, rootPath) {
  const helperLiteral = helperPath.replaceAll("'", "''");
  const rootLiteral = rootPath.replaceAll("'", "''");
  return [
    `$ErrorActionPreference = "Stop"`,
    `$ProgressPreference = "SilentlyContinue"`,
    `. '${helperLiteral}'`,
    ``,
    `function Assert-ThrowsLike([string]$Name, [string]$Pattern, [scriptblock]$Action) {`,
    `  try {`,
    `    & $Action`,
    `  } catch {`,
    `    if ($_.Exception.Message -notmatch $Pattern) {`,
    `      throw "$Name failed with an unexpected error: $($_.Exception.Message)"`,
    `    }`,
    `    return $_.Exception.Message`,
    `  }`,
    `  throw "$Name was accepted"`,
    `}`,
    ``,
    `# PID-reuse tolerant liveness check: the child is gone when no process has`,
    `# that PID anymore, or when the current occupant started after the call`,
    `# returned (a different process reused the identifier).`,
    `function Assert-ChildGone([int]$ProcessId, [DateTime]$ObservedAtUtc) {`,
    `  for ($attempt = 0; $attempt -lt 20; $attempt++) {`,
    `    $survivor = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue`,
    `    if (-not $survivor) { return }`,
    `    $survivorStart = $null`,
    `    try { $survivorStart = $survivor.StartTime.ToUniversalTime() } catch { return }`,
    `    if ($survivorStart -gt $ObservedAtUtc) { return }`,
    `    Start-Sleep -Milliseconds 50`,
    `  }`,
    `  throw "packaging probe child process $ProcessId survived termination"`,
    `}`,
    ``,
    `function Invoke-SyntheticOutput([string]$Output) {`,
    `  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Output))`,
    `  $source = "process.stdout.write(Buffer.from('$encoded', 'base64'));";`,
    `  return Invoke-NodePackagingProbeProcess -ProjectRoot '${rootLiteral}' -ProbeSource $source -TimeoutMs 5000`,
    `}`,
    ``,
    `$metadata = Get-PackagingMetadata -ProjectRoot '${rootLiteral}' -PkgVersion '6.22.0' -TimeoutMs 8000`,
    `if (`,
    `  $metadata.ProductVersion -cne '1.1.4' -or`,
    `  $metadata.DeclaredPkg -cne '6.22.0' -or`,
    `  $metadata.LockedPkgRoot -cne '6.22.0' -or`,
    `  $metadata.LockedPkgNode -cne '6.22.0'`,
    `) {`,
    `  throw "real repository metadata did not pass through the shared helper"`,
    `}`,
    ``,
    `$withStderr = Invoke-NodePackagingProbeProcess -ProjectRoot '${rootLiteral}' -ProbeSource 'process.stdout.write("1.1.4|6.22.0|6.22.0|6.22.0"); process.stderr.write("benign warning");' -TimeoutMs 5000`,
    `if ($withStderr.ExitCode -ne 0 -or $withStderr.Stdout -cne "1.1.4|6.22.0|6.22.0|6.22.0" -or $withStderr.Stderr -cne "benign warning") {`,
    `  throw "synthetic stderr capture failed"`,
    `}`,
    `$stderrRejectedMessage = Assert-ThrowsLike "success-with-stderr" "emitted stderr on success" {`,
    `  ConvertFrom-PackagingProbeResult -ProbeResult $withStderr -PkgVersion '6.22.0'`,
    `}`,
    `if ($stderrRejectedMessage -match 'benign') {`,
    `  throw "success-with-stderr error reflected raw child output"`,
    `}`,
    ``,
    `$malformedCases = @(`,
    `  @{ Name = "malformed field count"; Output = "1.1.4|6.22.0|6.22.0"; Pattern = "invalid field count" },`,
    `  @{ Name = "missing pin"; Output = "1.1.4||6.22.0|6.22.0"; Pattern = "invalid field" },`,
    `  @{ Name = "wrong pin"; Output = "1.1.4|6.22.1|6.22.0|6.22.0"; Pattern = "must be exactly" },`,
    `  @{ Name = "newline field"; Output = "1.1.4\`n|6.22.0|6.22.0|6.22.0"; Pattern = "invalid field" }`,
    `)`,
    `foreach ($case in $malformedCases) {`,
    `  $result = Invoke-SyntheticOutput -Output $case.Output`,
    `  Assert-ThrowsLike $case.Name $case.Pattern {`,
    `    ConvertFrom-PackagingProbeResult -ProbeResult $result -PkgVersion '6.22.0'`,
    `  }`,
    `}`,
    ``,
    `Assert-ThrowsLike "oversized probe source" "maximum allowed byte length" {`,
    `  Invoke-NodePackagingProbeProcess -ProjectRoot '${rootLiteral}' -ProbeSource ('x' * ($script:PackagingMetadataProbeMaxSourceBytes + 1)) -TimeoutMs 5000`,
    `}`,
    ``,
    `$hostileSource = 'process.stderr.write("RBSECRET-PATH C:\\\\Users\\\\k\\\\t" + String.fromCharCode(7)); console.log("RBSNIPPET-ZEBRA"); process.exit(7);'`,
    `$hostileResult = Invoke-NodePackagingProbeProcess -ProjectRoot '${rootLiteral}' -ProbeSource $hostileSource -TimeoutMs 5000`,
    `if ($hostileResult.ExitCode -ne 7) { throw "hostile probe child did not surface its exit code" }`,
    `$nonzeroMessage = Assert-ThrowsLike "nonzero sanitized" "nonzero exit code 7" {`,
    `  ConvertFrom-PackagingProbeResult -ProbeResult $hostileResult -PkgVersion '6.22.0'`,
    `}`,
    `if ($nonzeroMessage -match 'RBSECRET|ZEBRA|Users') {`,
    `  throw "nonzero exit error reflected raw child output or paths"`,
    `}`,
    ``,
    `$tempRoot = [IO.Path]::GetTempPath()`,
    `$hangPidPath = Join-Path $tempRoot ("rb-output-probe-" + [guid]::NewGuid().ToString("N") + ".pid")`,
    `$overflowOutPidPath = Join-Path $tempRoot ("rb-output-probe-" + [guid]::NewGuid().ToString("N") + ".pid")`,
    `$overflowErrPidPath = Join-Path $tempRoot ("rb-output-probe-" + [guid]::NewGuid().ToString("N") + ".pid")`,
    `$previousPidPath = $env:RB_OUTPUT_PROBE_PID_PATH`,
    `try {`,
    `  # A near-capacity stdin payload against a hung child stays inside the total deadline.`,
    `  # 1500ms exceeds node cold-start jitter so the child reliably reaches its`,
    `  # first statement before the bound; the interval keeps it alive until killed.`,
    `  $env:RB_OUTPUT_PROBE_PID_PATH = $hangPidPath`,
    `  $largeHangSource = '/*' + ('a' * 14000) + '*/require("node:fs").writeFileSync(process.env.RB_OUTPUT_PROBE_PID_PATH, String(process.pid)); setInterval(() => {}, 1000);'`,
    `  $observedAtUtc = [DateTime]::UtcNow`,
    `  Assert-ThrowsLike "large stdin hung probe" "timed out after 1500ms" {`,
    `    Invoke-NodePackagingProbeProcess -ProjectRoot '${rootLiteral}' -ProbeSource $largeHangSource -TimeoutMs 1500`,
    `  }`,
    `  $hungPid = [int](Get-Content -LiteralPath $hangPidPath -Raw)`,
    `  Assert-ChildGone -ProcessId $hungPid -ObservedAtUtc $observedAtUtc`,
    ``,
    `  $env:RB_OUTPUT_PROBE_PID_PATH = $overflowOutPidPath`,
    `  $stdoutFloodSource = 'require("node:fs").writeFileSync(process.env.RB_OUTPUT_PROBE_PID_PATH, String(process.pid)); for (let i = 0; i < 8; i++) { process.stdout.write("A".repeat(12000)); } setInterval(() => {}, 1000);'`,
    `  $observedAtUtc = [DateTime]::UtcNow`,
    `  $stdoutOverflowMessage = Assert-ThrowsLike "stdout overflow" "capture limit" {`,
    `    Invoke-NodePackagingProbeProcess -ProjectRoot '${rootLiteral}' -ProbeSource $stdoutFloodSource -TimeoutMs 5000`,
    `  }`,
    `  if ($stdoutOverflowMessage -match 'A{12,}') { throw "stdout overflow error leaked captured output" }`,
    `  Assert-ChildGone -ProcessId ([int](Get-Content -LiteralPath $overflowOutPidPath -Raw)) -ObservedAtUtc $observedAtUtc`,
    ``,
    `  $env:RB_OUTPUT_PROBE_PID_PATH = $overflowErrPidPath`,
    `  $stderrFloodSource = 'require("node:fs").writeFileSync(process.env.RB_OUTPUT_PROBE_PID_PATH, String(process.pid)); for (let i = 0; i < 8; i++) { process.stderr.write("B".repeat(12000)); } setInterval(() => {}, 1000);'`,
    `  $observedAtUtc = [DateTime]::UtcNow`,
    `  $stderrOverflowMessage = Assert-ThrowsLike "stderr overflow" "capture limit" {`,
    `    Invoke-NodePackagingProbeProcess -ProjectRoot '${rootLiteral}' -ProbeSource $stderrFloodSource -TimeoutMs 5000`,
    `  }`,
    `  if ($stderrOverflowMessage -match 'B{12,}') { throw "stderr overflow error leaked captured output" }`,
    `  Assert-ChildGone -ProcessId ([int](Get-Content -LiteralPath $overflowErrPidPath -Raw)) -ObservedAtUtc $observedAtUtc`,
    `} finally {`,
    `  if ($null -eq $previousPidPath) {`,
    `    Remove-Item Env:RB_OUTPUT_PROBE_PID_PATH -ErrorAction SilentlyContinue`,
    `  } else {`,
    `    $env:RB_OUTPUT_PROBE_PID_PATH = $previousPidPath`,
    `  }`,
    `  Remove-Item -LiteralPath $hangPidPath, $overflowOutPidPath, $overflowErrPidPath -Force -ErrorAction SilentlyContinue`,
    `}`,
    ``,
    `Write-Output "shared packaging probe happy path and negative cases passed"`,
    ``,
  ].join("\n");
}

test("build-dist and PS5.1 tests execute the same bounded packaging probe helper", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows PowerShell 5.1 is required");
    return;
  }

  const buildSource = fs.readFileSync(BUILD_SCRIPT, "utf8");
  const bootstrapSource = fs.readFileSync(WINDOWS_DESKTOP_BOOTSTRAP, "utf8");
  const helperSource = fs.readFileSync(PROBE_HELPER, "utf8");
  assert.match(buildSource, /\[System\.IO\.Path\]::Combine\(\$PSScriptRoot, "initialize-windows-desktop-powershell\.ps1"\)/);
  assert.match(buildSource, /\[System\.IO\.FileInfo\]::new\(\$windowsDesktopBootstrapPath\)/);
  assert.match(buildSource, /windowsDesktopBootstrapItem\.Attributes\s+-band\s+\[System\.IO\.FileAttributes\]::ReparsePoint/);
  assert.match(buildSource, /^Initialize-WindowsDesktopPowerShellBuildEnvironment$/m);
  assert.doesNotMatch(buildSource, /function\s+Initialize-WindowsDesktopPowerShellBuildEnvironment/);
  assert.match(bootstrapSource, /function\s+Initialize-WindowsDesktopPowerShellBuildEnvironment/);
  assert.doesNotMatch(buildSource, /ConvertFrom-Json/);
  assert.match(buildSource, /invoke-packaging-probe\.ps1/);
  assert.match(buildSource, /Get-PackagingMetadata/);
  assert.doesNotMatch(buildSource, /ProcessStartInfo|WaitForExit|ReadToEndAsync/);
  assert.match(buildSource, /\$pkgVersion\s*=\s*"6\.22\.0"/);
  assert.match(buildSource, /\$pyinstallerRequiredVersion\s*=\s*"6\.22\.2"/);
  const preflightIndex = buildSource.indexOf("node scripts\\preflight.js");
  const probeIndex = buildSource.indexOf("Get-PackagingMetadata");
  const cleanupIndex = buildSource.indexOf("Remove-Item -LiteralPath");
  const buildIndex = buildSource.indexOf('Write-Host "Step 1/7');
  assert.ok(preflightIndex >= 0 && preflightIndex < probeIndex, "release preflight did not precede the packaging probe");
  assert.ok(probeIndex >= 0 && probeIndex < cleanupIndex, "packaging probe did not precede exact packaging metadata cleanup");
  assert.ok(cleanupIndex >= 0 && cleanupIndex < buildIndex, "bounded cleanup did not precede the payload build");

  assert.match(helperSource, /RedirectStandardOutput/);
  assert.match(helperSource, /RedirectStandardError/);
  assert.doesNotMatch(helperSource, /ReadToEndAsync/);
  assert.match(helperSource, /BaseStream\.WriteAsync/);
  assert.doesNotMatch(helperSource, /StandardInput\.Write\(/);
  assert.match(helperSource, /WaitForExit\(/);
  assert.match(helperSource, /\.Kill\(\)/);
  assert.match(helperSource, /Resolve-PackagingProbeNodeExecutable/);
  assert.match(helperSource, /GetByteCount/);
  assert.match(helperSource, /PackagingMetadataProbeMaxSourceBytes/);
  assert.match(helperSource, /PackagingMetadataProbeMaxOutputChars/);
  assert.match(helperSource, /emitted stderr on success/);
  assert.match(helperSource, /nonzero exit code/);
  assert.doesNotMatch(helperSource, /\$packagingProbeError\$packagingProbeOutput/);

  new vm.Script(extractProbeSource(helperSource), { filename: "packaging-probe-source.js" });

  const scenarioPath = path.join(os.tmpdir(), `rb-output-probe-scenario-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(scenarioPath, buildProbeScenarioScript(PROBE_HELPER, REPO_ROOT), "utf8");
  try {
    const ps51 = runPowerShellFile("powershell.exe", scenarioPath);
    assert.equal(
      ps51.status,
      0,
      `PS5.1 scenario failed:\n${ps51.stdout}\n${ps51.stderr}`,
    );
    assert.match(ps51.stdout, /shared packaging probe happy path and negative cases passed/);

    const pwshProbe = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8", windowsHide: true, timeout: 60000 });
    if (pwshProbe.error || pwshProbe.status !== 0) {
      t.skip("pwsh is not installed; PS5.1-only coverage applied");
      return;
    }
    const pwsh = runPowerShellFile("pwsh.exe", scenarioPath);
    assert.equal(
      pwsh.status,
      0,
      `pwsh parity scenario failed:\n${pwsh.stdout}\n${pwsh.stderr}`,
    );
    assert.match(pwsh.stdout, /shared packaging probe happy path and negative cases passed/);
  } finally {
    fs.rmSync(scenarioPath, { force: true });
  }
});
