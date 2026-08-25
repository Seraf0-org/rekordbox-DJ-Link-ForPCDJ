"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");
const BUILD_SCRIPT = path.join(REPO_ROOT, "scripts", "build-dist.ps1");

function runPowerShell(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
    { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true },
  );
}

test("build-dist uses separated PS5.1 probe streams and rejects malformed metadata", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows PowerShell 5.1 is required");
    return;
  }

  const source = fs.readFileSync(BUILD_SCRIPT, "utf8");
  assert.doesNotMatch(source, /ConvertFrom-Json/);
  assert.match(source, /RedirectStandardOutput/);
  assert.match(source, /RedirectStandardError/);
  assert.match(source, /ReadToEndAsync/);
  assert.match(source, /emitted stderr on success/);

  const script = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Invoke-Probe([string]$Source) {
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = "node"
  $startInfo.Arguments = "-"
  $startInfo.WorkingDirectory = (Get-Location).Path
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) { throw "Process.Start returned false" }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.Write($Source)
    $process.StandardInput.Close()
    $process.WaitForExit()
    return [pscustomobject]@{
      ExitCode = $process.ExitCode
      Stdout = $stdoutTask.Result
      Stderr = $stderrTask.Result
    }
  } finally {
    $process.Dispose()
  }
}

function Assert-Rejected([string]$Name, [string]$Output) {
  $values = $Output -split '\|'
  $rejected = $values.Count -ne 4
  if (-not $rejected) {
    foreach ($value in $values) {
      if ([string]::IsNullOrEmpty($value) -or $value -match '[|\r\n]') {
        $rejected = $true
        break
      }
    }
  }
  if (-not $rejected) {
    if ($values[1] -cne "6.22.0" -or $values[2] -cne "6.22.0" -or $values[3] -cne "6.22.0") {
      $rejected = $true
    }
  }
  if (-not $rejected) { throw "$Name was accepted" }
}

$good = Invoke-Probe 'process.stdout.write("1.1.2|6.22.0|6.22.0|6.22.0");'
if ($good.ExitCode -ne 0 -or $good.Stderr -ne "" -or $good.Stdout -cne "1.1.2|6.22.0|6.22.0|6.22.0") {
  throw "happy path stream capture failed"
}

$withStderr = Invoke-Probe 'process.stdout.write("1.1.2|6.22.0|6.22.0|6.22.0"); process.stderr.write("benign warning");'
if ($withStderr.ExitCode -ne 0 -or $withStderr.Stdout -cne "1.1.2|6.22.0|6.22.0|6.22.0" -or $withStderr.Stderr -cne "benign warning") {
  throw "synthetic stderr capture failed"
}
if ($withStderr.Stderr -eq "") { throw "success-with-stderr was not observable" }

Assert-Rejected "malformed field count" "1.1.2|6.22.0|6.22.0"
Assert-Rejected "missing pin" "1.1.2||6.22.0|6.22.0"
Assert-Rejected "wrong pin" "1.1.2|6.22.1|6.22.0|6.22.0"
Assert-Rejected "newline field" "1.1.2\`n|6.22.0|6.22.0|6.22.0"

Write-Output "PS5.1 probe happy path and negative cases passed"
`;
  const result = runPowerShell(script);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PS5\.1 probe happy path and negative cases passed/);
});
