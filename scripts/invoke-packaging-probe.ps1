# Shared, bounded packaging metadata probe helpers.
#
# Bounding model: ONE total deadline covers source delivery, child execution,
# stdout/stderr draining, termination, and reap. Every blocking operation is
# bounded by the remaining time; none may wait outside it.
#
# Sanitization model: thrown errors are stable and categorized. They never
# reflect raw child output, absolute paths, secrets, source snippets, or
# length/hash fingerprints of captured data.
#
# Child boundary: the probe starts exactly one node.exe child via a resolved
# full path. Termination kills only that exact Process object handle (never a
# PID lookup, which would risk acting on a reused PID). The production source
# below is a trusted constant that spawns no descendants, so no tree-kill is
# claimed or attempted; non-production callers passing other sources own any
# grandchild lifecycle themselves.

$script:PackagingMetadataProbeMaxSourceBytes = 16384
$script:PackagingMetadataProbeMaxOutputChars = 65536

$script:PackagingMetadataProbeSource = @'
const fs = require("node:fs");
function read(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
const manifest = read("package.json");
const lock = read("package-lock.json");
const root = lock.packages && lock.packages[""];
const installed = lock.packages && lock.packages["node_modules/@yao-pkg/pkg"];
const values = [
  manifest.version,
  manifest.devDependencies && manifest.devDependencies["@yao-pkg/pkg"],
  root && root.devDependencies && root.devDependencies["@yao-pkg/pkg"],
  installed && installed.version,
];
if (values.some((value) => typeof value !== "string" || /[|\r\n]/.test(value))) {
  throw new Error("packaging metadata values must be single-line strings");
}
process.stdout.write(values.join("|"));
'@

function Resolve-PackagingProbeNodeExecutable {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot
  )

  $command = Get-Command -Name "node.exe" -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $command -or [string]::IsNullOrEmpty($command.Path)) {
    throw "Node packaging metadata probe could not resolve a node executable"
  }
  $leaf = Get-Item -LiteralPath $command.Path -Force -ErrorAction SilentlyContinue
  if ($null -eq $leaf -or $leaf.PSIsContainer) {
    throw "Node packaging metadata probe resolved node to a non-file location"
  }
  # Exact-leaf trust check. The parent directory chain is intentionally not
  # required to be reparse-free because standard version managers (for example
  # nvm4w) expose node.exe as a regular file beneath a junctioned directory.
  if (($leaf.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Node packaging metadata probe resolved node through a reparse point"
  }
  if (-not $leaf.FullName.EndsWith("\node.exe", [StringComparison]::OrdinalIgnoreCase)) {
    throw "Node packaging metadata probe requires an exact node.exe leaf"
  }
  $rootFull = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
  $rootPrefix = $rootFull + '\'
  if ($leaf.FullName.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Node packaging metadata probe refuses a node executable planted in the project root"
  }
  return $leaf.FullName
}

function Stop-PackagingProbeChildBounded {
  param(
    [Parameter(Mandatory = $true)]$Child,
    [Parameter(Mandatory = $true)][DateTime]$DeadlineUtc
  )

  try {
    if (-not $Child.HasExited) {
      $Child.Kill()
    }
  } catch { }
  $reapRemainingMs = [int][Math]::Floor(($DeadlineUtc - [DateTime]::UtcNow).TotalMilliseconds)
  if ($reapRemainingMs -lt 0) { $reapRemainingMs = 0 }
  try { [void]$Child.WaitForExit($reapRemainingMs) } catch { }
}

function Wait-PackagingProbeTasksBounded {
  param(
    [Parameter(Mandatory = $true)]$Tasks,
    [Parameter(Mandatory = $true)][DateTime]$DeadlineUtc
  )

  foreach ($task in $Tasks) {
    if ($null -eq $task -or $task.IsCompleted) { continue }
    $remainingMs = [int][Math]::Floor(($DeadlineUtc - [DateTime]::UtcNow).TotalMilliseconds)
    if ($remainingMs -lt 0) { $remainingMs = 0 }
    try { [void]$task.Wait($remainingMs) } catch { }
  }
}

function Invoke-NodePackagingProbeProcess {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$ProbeSource,
    [ValidateRange(1, 300000)][int]$TimeoutMs = 30000
  )

  # Defense before any process exists. This is an explicit cap; pipe capacity
  # is never relied upon to bound delivery.
  $probeSourceByteCount = [Text.Encoding]::UTF8.GetByteCount($ProbeSource)
  if ($probeSourceByteCount -gt $script:PackagingMetadataProbeMaxSourceBytes) {
    throw "Node packaging metadata probe source exceeds the maximum allowed byte length"
  }

  $nodeExecutablePath = Resolve-PackagingProbeNodeExecutable -ProjectRoot $ProjectRoot

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $nodeExecutablePath
  $startInfo.Arguments = "-"
  $startInfo.WorkingDirectory = $ProjectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
  $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8

  $probeProcess = New-Object System.Diagnostics.Process
  $probeProcess.StartInfo = $startInfo
  # The raw start exception can embed absolute paths, so it is never rethrown.
  try {
    if (-not $probeProcess.Start()) {
      throw "Node packaging metadata probe could not be started"
    }
  } catch {
    throw "Node packaging metadata probe could not be started"
  }

  $deadlineUtc = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)

  $readChunkSize = 4096
  $stdoutBuffer = New-Object 'char[]' $readChunkSize
  $stderrBuffer = New-Object 'char[]' $readChunkSize
  $stdoutText = New-Object System.Text.StringBuilder
  $stderrText = New-Object System.Text.StringBuilder

  # Both readers start before stdin delivery so a child that fills either
  # redirected pipe can never deadlock the write side.
  $stdoutReader = $probeProcess.StandardOutput
  $stderrReader = $probeProcess.StandardError
  $stdinWriter = $probeProcess.StandardInput
  $stdoutTask = $stdoutReader.ReadAsync($stdoutBuffer, 0, $readChunkSize)
  $stderrTask = $stderrReader.ReadAsync($stderrBuffer, 0, $readChunkSize)

  # Stdin delivery is asynchronous and bounded by the same total deadline;
  # a large source or a child that stops draining can no longer block outside
  # the timeout.
  $sourceBytes = [Text.Encoding]::UTF8.GetBytes($ProbeSource)
  $stdinTask = $stdinWriter.BaseStream.WriteAsync($sourceBytes, 0, $sourceBytes.Length)

  $outcome = "completed"
  $capturedStdoutChars = 0
  $capturedStderrChars = 0
  $stdoutOpen = $true
  $stderrOpen = $true
  $stdinDone = $false
  $exitSeen = $false

  try {
    while ($true) {
      $remainingMs = [int][Math]::Floor(($deadlineUtc - [DateTime]::UtcNow).TotalMilliseconds)
      if ($remainingMs -le 0) {
        if ($exitSeen) { $outcome = "stream-incomplete" } else { $outcome = "timeout" }
        break
      }
      $sliceMs = [Math]::Min(100, $remainingMs)

      if (-not $stdinDone) {
        $stdinSignalled = $false
        $stdinFaulted = $false
        try {
          $stdinSignalled = $stdinTask.Wait($sliceMs)
        } catch {
          $stdinSignalled = $true
          $stdinFaulted = $true
        }
        if ($stdinSignalled) {
          if (-not $stdinFaulted -and ($stdinTask.IsFaulted -or $stdinTask.IsCanceled)) { $stdinFaulted = $true }
          $stdinDone = $true
          if ($stdinFaulted) {
            $outcome = "stdin-write"
            break
          }
          try { $stdinWriter.Close() } catch {
            $outcome = "stdin-write"
            break
          }
        }
      }

      if ($stdoutOpen) {
        $stdoutSignalled = $false
        $stdoutFaulted = $false
        try {
          $stdoutSignalled = $stdoutTask.Wait($sliceMs)
        } catch {
          $stdoutSignalled = $true
          $stdoutFaulted = $true
        }
        if ($stdoutSignalled) {
          if (-not $stdoutFaulted -and ($stdoutTask.IsFaulted -or $stdoutTask.IsCanceled)) { $stdoutFaulted = $true }
          if ($stdoutFaulted) {
            $outcome = "stream-incomplete"
            break
          }
          $chunkChars = $stdoutTask.Result
          if ($chunkChars -le 0) {
            $stdoutOpen = $false
          } else {
            $spaceLeft = $script:PackagingMetadataProbeMaxOutputChars - $capturedStdoutChars
            if ($chunkChars -gt $spaceLeft) {
              $outcome = "output-limit"
              break
            }
            [void]$stdoutText.Append($stdoutBuffer, 0, $chunkChars)
            $capturedStdoutChars += $chunkChars
            $stdoutTask = $stdoutReader.ReadAsync($stdoutBuffer, 0, $readChunkSize)
          }
        }
      }

      if ($stderrOpen) {
        $stderrSignalled = $false
        $stderrFaulted = $false
        try {
          $stderrSignalled = $stderrTask.Wait($sliceMs)
        } catch {
          $stderrSignalled = $true
          $stderrFaulted = $true
        }
        if ($stderrSignalled) {
          if (-not $stderrFaulted -and ($stderrTask.IsFaulted -or $stderrTask.IsCanceled)) { $stderrFaulted = $true }
          if ($stderrFaulted) {
            $outcome = "stream-incomplete"
            break
          }
          $chunkChars = $stderrTask.Result
          if ($chunkChars -le 0) {
            $stderrOpen = $false
          } else {
            $spaceLeft = $script:PackagingMetadataProbeMaxOutputChars - $capturedStderrChars
            if ($chunkChars -gt $spaceLeft) {
              $outcome = "output-limit"
              break
            }
            [void]$stderrText.Append($stderrBuffer, 0, $chunkChars)
            $capturedStderrChars += $chunkChars
            $stderrTask = $stderrReader.ReadAsync($stderrBuffer, 0, $readChunkSize)
          }
        }
      }

      if (-not $exitSeen -and $probeProcess.HasExited) { $exitSeen = $true }
      if ($exitSeen -and $stdinDone -and -not $stdoutOpen -and -not $stderrOpen) { break }
    }

    if ($outcome -ne "completed") {
      Stop-PackagingProbeChildBounded -Child $probeProcess -DeadlineUtc $deadlineUtc
      $drainTasks = @($stdoutTask, $stderrTask)
      if (-not $stdinDone) { $drainTasks += $stdinTask }
      Wait-PackagingProbeTasksBounded -Tasks $drainTasks -DeadlineUtc $deadlineUtc
    }

    switch ($outcome) {
      "timeout" { throw "Node packaging metadata probe timed out after ${TimeoutMs}ms and its exact child process was terminated" }
      "stream-incomplete" { throw "Node packaging metadata probe redirected streams did not complete and its exact child process was terminated" }
      "output-limit" { throw "Node packaging metadata probe output exceeded the capture limit and its exact child process was terminated" }
      "stdin-write" { throw "Node packaging metadata probe failed to deliver its source to the child process and was terminated" }
      default { }
    }

    return [pscustomobject]@{
      ExitCode = [int]$probeProcess.ExitCode
      Stdout = $stdoutText.ToString()
      Stderr = $stderrText.ToString()
    }
  } finally {
    foreach ($stream in @($stdinWriter, $stdoutReader, $stderrReader)) {
      if ($null -ne $stream) {
        try { $stream.Dispose() } catch { }
      }
    }
    try { $probeProcess.Dispose() } catch { }
  }
}

function ConvertFrom-PackagingProbeResult {
  param(
    [Parameter(Mandatory = $true)]$ProbeResult,
    [Parameter(Mandatory = $true)][string]$PkgVersion
  )

  $probeExitCode = [int]$ProbeResult.ExitCode
  $packagingProbeOutput = [string]$ProbeResult.Stdout
  $packagingProbeError = [string]$ProbeResult.Stderr
  # Raw child streams are never reflected into error text: they may contain
  # hostile absolute paths, control bytes, secrets, or unbounded data.
  if ($probeExitCode -ne 0) {
    throw "Node packaging metadata probe failed with nonzero exit code $probeExitCode"
  }
  if (-not [string]::IsNullOrEmpty($packagingProbeError)) {
    throw "Node packaging metadata probe emitted stderr on success"
  }
  $packagingProbeValues = $packagingProbeOutput.Split([char]'|')
  if ($packagingProbeValues.Count -ne 4) {
    throw "Node packaging metadata probe returned an invalid field count"
  }
  foreach ($packagingProbeValue in $packagingProbeValues) {
    if ([string]::IsNullOrEmpty($packagingProbeValue) -or $packagingProbeValue -match '[|\r\n]') {
      throw "Node packaging metadata probe returned an invalid field"
    }
  }
  if (
    $packagingProbeValues[1] -cne $PkgVersion -or
    $packagingProbeValues[2] -cne $PkgVersion -or
    $packagingProbeValues[3] -cne $PkgVersion
  ) {
    throw "@yao-pkg/pkg must be exactly $PkgVersion in package.json and package-lock.json; run npm ci after restoring the tracked lockfile"
  }
  return [pscustomobject]@{
    ProductVersion = $packagingProbeValues[0]
    DeclaredPkg = $packagingProbeValues[1]
    LockedPkgRoot = $packagingProbeValues[2]
    LockedPkgNode = $packagingProbeValues[3]
  }
}

function Get-PackagingMetadata {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot,
    [Parameter(Mandatory = $true)][string]$PkgVersion,
    [ValidateRange(1, 300000)][int]$TimeoutMs = 30000
  )

  $probeResult = Invoke-NodePackagingProbeProcess `
    -ProjectRoot $ProjectRoot `
    -ProbeSource $script:PackagingMetadataProbeSource `
    -TimeoutMs $TimeoutMs
  return ConvertFrom-PackagingProbeResult -ProbeResult $probeResult -PkgVersion $PkgVersion
}
