# Fail-closed Windows source builder for the @ktamas77/abletonlink native addon.
#
# Reproduces the lock-pinned npm package from its exact reviewed compile surface
# into a non-TEMP, git-ignored staging tree, applies only the three reviewed
# binding.gyp changes, builds with pinned node-gyp / Node / MSVC tools under a
# sanitized environment (Git's usr\bin\link.exe can never win), ratchets build
# warnings to zero, validates the PE image, its imports and a live N-API probe,
# and only then atomically replaces
#   node_modules\@ktamas77\abletonlink\build\Release\abletonlink.node
# restoring the previous binary byte-for-byte on any failure.
#
# The offline toolchain inputs are proven before configure/build: every Node
# header/metadata byte consumed by node-gyp and the win-x64 node.lib linker
# input must match patches\ableton-link-source\node-headers-manifest.json
# (tracked; derived from the hash-verified official v22.22.1 headers archive,
# with the official SHASUMS256.txt node.lib byte pin enforced). The builder
# never downloads anything and never mutates the node-gyp cache.
#
# Modes:
#   (default)                     full licensed build + validated promotion
#   -ValidatePrerequisitesOnly    everything through staged patch + configure +
#                                 generated-project inspection; no compile
#   -WriteSourceManifest          re-derive source-manifest.json + patched
#                                 reference from an installed tree (authoring)
#   -WriteToolchainJson <path>    dump derived trusted toolchain as JSON
#   -PromoteOnly                  validate + promote an existing staged addon
#
# Ableton Link core is dual-licensed (GPL-2.0-or-later OR proprietary). Building
# it locally requires choosing GPL mode explicitly via
#   -LinkLicenseMode GPL-2.0-or-later
# This script never changes the repository license and grants no distribution
# rights. Packaging integration is intentionally out of scope for this script.
#
# PowerShell 5.1 compatible; pure ASCII.

[CmdletBinding()]
param(
  [string]$ProjectRoot = "",
  [switch]$ValidatePrerequisitesOnly,
  [switch]$PromoteOnly,
  [string]$StagedAddonPath = "",
  [string]$DestinationAddonPath = "",
  [switch]$FixtureMode,
  [switch]$SkipLoadProbe,
  [string]$LinkLicenseMode = "",
  [string]$SourcePackageDir = "",
  [string]$SourceManifestPath = "",
  [string]$OutputManifestPath = "",
  [string]$StagingRoot = "",
  [string]$NodeExe = "",
  [string]$MsvcToolsVersion = "14.44.35207",
  [string]$WriteToolchainJson = "",
  [int]$ProbeTimeoutMs = 30000
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Pinned facts (proven by the retained C:\TEMP\opencode\abletonlink-win-probe)
# ---------------------------------------------------------------------------
$script:PackageName = "@ktamas77/abletonlink"
$script:PackageVersion = "1.2.3"
$script:PackageIntegrity = "sha512-xST1G85OiYtpU2DXmhPlf4r6VwuNNiru82atuD3LSVLowuGOhsrcOh+grn7R4XIK2MP7bXJ6olFiKlrEb8j6/g=="
$script:NodeVersionPin = "22.22.1"
$script:NodeArchPin = "x64"
$script:NapiTarget = 10
$script:NodeGypVersionPin = "12.4.0"
$script:NodeLibOfficialShaPin = "0d8d8bcc11daea60f5dd4da414e72ccb785718345ec8fbec52cfc7d1a2326293"
$script:HeadersArchiveOfficialName = "node-v22.22.1-headers.tar.gz"
$script:HeadersArchiveOfficialShaPin = "0f76c31ce76a623a6a3a4038cb62eae281b2e33ad189dcf2d514ec32ae74d9b2"
$script:HeadersAltArchiveOfficialShaPin = "3f435f2ac1ab363f8220f4beb60c7493a3f680918a7426ff83b7d4c6e1d314fa"
$script:HeadersManifestRel = "node-headers-manifest.json"
$script:MsvcToolsVersionPin = $MsvcToolsVersion
$script:VsRootSuffix = "Microsoft Visual Studio\2022\Community"
$script:LicenseAllowed = "GPL-2.0-or-later"
$script:DefaultSourceRel = "node_modules\@ktamas77\abletonlink"
$script:DefaultDestRel = "node_modules\@ktamas77\abletonlink\build\Release\abletonlink.node"
$script:PatchesRel = "patches\ableton-link-source"
$script:DefaultStagingRel = "node_modules\.cache\rb-output-ableton-link-src"

# System import allowlist for the built addon. Everything else (besides the
# delay-loaded host "node.exe") is rejected.
$script:SystemImportAllowlist = @(
  "kernel32.dll", "user32.dll", "gdi32.dll", "advapi32.dll", "shell32.dll",
  "ole32.dll", "oleaut32.dll", "ws2_32.dll", "iphlpapi.dll", "wsock32.dll",
  "ntdll.dll", "msvcrt.dll", "ucrtbase.dll", "vcruntime140.dll",
  "vcruntime140_1.dll", "msvcp140.dll", "setupapi.dll", "cfgmgr32.dll",
  "winmm.dll", "comctl32.dll", "shlwapi.dll", "version.dll", "bcrypt.dll"
)

# Bare .lib tokens permitted in generated AdditionalDependencies.
$script:LibTokenAllowlist = @(
  "kernel32.lib", "user32.lib", "gdi32.lib", "winspool.lib", "comdlg32.lib",
  "advapi32.lib", "shell32.lib", "ole32.lib", "oleaut32.lib", "uuid.lib",
  "odbc32.lib", "delayimp.lib"
)

function Fail {
  param([string]$Message)
  throw ("[ableton-link-build] " + $Message)
}

function Info {
  param([string]$Message)
  Write-Output ("[ableton-link-build] " + $Message)
}

# ---------------------------------------------------------------------------
# Trusted root derivation. Registry (64-bit view) and known-folder APIs only;
# caller-settable ProgramFiles-like environment variables are never consulted.
# ---------------------------------------------------------------------------
function Get-TrustedRegValue {
  param([string]$SubKey, [string]$ValueName)
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::LocalMachine,
    [Microsoft.Win32.RegistryView]::Registry64)
  try {
    $key = $base.OpenSubKey($SubKey)
    if ($null -eq $key) { return "" }
    try {
      $value = $key.GetValue($ValueName)
      if ($null -eq $value) { return "" }
      return ([string]$value).Trim()
    } finally {
      $key.Close()
    }
  } finally {
    $base.Dispose()
  }
}

function Assert-TrustedDir {
  param([string]$Path, [string]$Label)
  if ([string]::IsNullOrWhiteSpace($Path)) { Fail "$Label registry derivation returned empty" }
  if (-not ($Path -match '^[A-Za-z]:\\')) { Fail "$Label is not an absolute local path" }
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { Fail "$Label does not exist: directory part of $([IO.Path]::GetFileName($Path.TrimEnd('\')))" }
  return ([IO.Path]::GetFullPath($Path).TrimEnd('\'))
}

function Get-TrustedProgramFiles { # 64-bit Program Files
  $v = Get-TrustedRegValue "SOFTWARE\Microsoft\Windows\CurrentVersion" "ProgramW6432Dir"
  if ([string]::IsNullOrWhiteSpace($v)) {
    $v = Get-TrustedRegValue "SOFTWARE\Microsoft\Windows\CurrentVersion" "ProgramFilesDir"
  }
  Assert-TrustedDir -Path $v -Label "trusted 64-bit Program Files"
}

function Get-TrustedProgramFilesX86 {
  $v = Get-TrustedRegValue "SOFTWARE\Microsoft\Windows\CurrentVersion" "ProgramFilesDir (x86)"
  Assert-TrustedDir -Path $v -Label "trusted 32-bit Program Files"
}

function Get-TrustedCommonFiles {
  $v = Get-TrustedRegValue "SOFTWARE\Microsoft\Windows\CurrentVersion" "CommonW6432Dir"
  if ([string]::IsNullOrWhiteSpace($v)) {
    $v = Get-TrustedRegValue "SOFTWARE\Microsoft\Windows\CurrentVersion" "CommonFilesDir"
  }
  Assert-TrustedDir -Path $v -Label "trusted common files"
}

function Get-TrustedSystemRoot {
  $v = Get-TrustedRegValue "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "SystemRoot"
  Assert-TrustedDir -Path $v -Label "trusted system root"
}

function Get-TrustedLocalAppData {
  $p = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  if ([string]::IsNullOrWhiteSpace($p)) { Fail "known-folder LocalApplicationData unavailable" }
  return ([IO.Path]::GetFullPath($p).TrimEnd('\'))
}

function Get-TrustedRoamingAppData {
  $p = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
  if ([string]::IsNullOrWhiteSpace($p)) { Fail "known-folder ApplicationData unavailable" }
  return ([IO.Path]::GetFullPath($p).TrimEnd('\'))
}

# Python for gyp is derived from the OS (PEP 514 registry, 64-bit view) plus
# the SystemRoot py.exe launcher only; hardcoded install roots are never trusted.
function Get-TrustedPythonCandidateExes {
  $candidates = @()
  $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
    [Microsoft.Win32.RegistryHive]::LocalMachine,
    [Microsoft.Win32.RegistryView]::Registry64)
  try {
    $core = $base.OpenSubKey("SOFTWARE\Python\PythonCore")
    if ($null -ne $core) {
      try {
        $tags = @()
        foreach ($tag in $core.GetSubKeyNames()) {
          if ($tag -match '^3\.(\d+)(?:-.+)?$') {
            $minor = [int]$Matches[1]
            if ($minor -ge 8 -and $minor -le 13) { $tags += @{ Tag = $tag; Minor = $minor } }
          }
        }
        $sorted = [object[]]$tags
        [System.Array]::Sort($sorted, [System.Comparison[object]]{ param($a, $b) $b.Minor.CompareTo($a.Minor) })
        foreach ($entry in $sorted) {
          $ipKey = $core.OpenSubKey($entry.Tag + "\InstallPath")
          if ($null -eq $ipKey) { continue }
          try {
            $dirValue = $ipKey.GetValue("")
            $exeValue = $ipKey.GetValue("ExecutablePath")
            if (-not [string]::IsNullOrWhiteSpace([string]$exeValue)) {
              $candidates += ([string]$exeValue).Trim()
            } elseif (-not [string]::IsNullOrWhiteSpace([string]$dirValue)) {
              $candidates += (Join-Path (([string]$dirValue).Trim()) "python.exe")
            }
          } finally {
            $ipKey.Close()
          }
        }
      } finally {
        $core.Close()
      }
    }
  } finally {
    $base.Dispose()
  }
  $candidates += (Join-Path (Get-TrustedSystemRoot) "py.exe")
  return @($candidates)
}

# ---------------------------------------------------------------------------
# Filesystem safety helpers
# ---------------------------------------------------------------------------
function Assert-NoReparsePathChain {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Label)
  try {
    $current = [IO.Path]::GetFullPath($Path)
  } catch {
    Fail "$Label path is invalid"
  }
  while ($true) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { Fail "$Label is missing or inaccessible" }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Fail "$Label contains a symbolic link or junction (reparse points are not allowed)"
    }
    $parentInfo = [IO.Directory]::GetParent($current)
    if ($null -eq $parentInfo) { break }
    $parent = $parentInfo.FullName
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent.Equals($current, [StringComparison]::OrdinalIgnoreCase)) { break }
    $current = $parent
  }
}

function Get-Sha256Hex {
  param([byte[]]$Bytes)
  $sha = New-Object System.Security.Cryptography.SHA256CryptoServiceProvider
  try {
    return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-FileSha256 {
  param([string]$Path)
  $bytes = [IO.File]::ReadAllBytes($Path)
  return Get-Sha256Hex -Bytes $bytes
}

# ---------------------------------------------------------------------------
# Reviewed patch operations on binding.gyp (each must match exactly once).
# ---------------------------------------------------------------------------
$script:PatchOpGlobalCflags = '      "cflags_cc": [ "-std=c++14" ],'
$script:PatchOpGlobalMacosDefine = '        "LINK_PLATFORM_MACOSX=1",'
$script:PatchOpWinOldBlock = '              "ExceptionHandling": 1,' + "`r`n" + '              "AdditionalOptions": [ "/std:c++14" ]'
$script:PatchOpWinNewBlock = '              "ExceptionHandling": 1'

function Invoke-BindingGypPatch {
  param([string]$OriginalText)

  $nl = ""
  if ($OriginalText.Contains("`r`n")) { $nl = "`r`n" } elseif ($OriginalText.Contains("`n")) { $nl = "`n" }
  if ([string]::IsNullOrEmpty($nl)) { Fail "binding.gyp has no recognizable line endings" }

  $op1 = $script:PatchOpGlobalCflags + $nl
  $op2 = $script:PatchOpGlobalMacosDefine + $nl
  $op3old = $script:PatchOpWinOldBlock.Replace("`r`n", $nl) + $nl
  $op3new = $script:PatchOpWinNewBlock + $nl

  foreach ($needle in @($op1, $op2, $op3old)) {
    $first = $OriginalText.IndexOf($needle, [StringComparison]::Ordinal)
    if ($first -lt 0) { Fail "binding.gyp patch operation target not found (patch drift or source drift)" }
    if ($OriginalText.IndexOf($needle, $first + 1, [StringComparison]::Ordinal) -ge 0) {
      Fail "binding.gyp patch operation target is ambiguous"
    }
  }

  $idx1 = $OriginalText.IndexOf($op1, [StringComparison]::Ordinal)
  $text = $OriginalText.Remove($idx1, $op1.Length)
  $idx2 = $text.IndexOf($op2, [StringComparison]::Ordinal)
  $text = $text.Remove($idx2, $op2.Length)
  $idx3 = $text.IndexOf($op3old, [StringComparison]::Ordinal)
  $text = $text.Remove($idx3, $op3old.Length).Insert($idx3, $op3new)
  if ($env:ALB_DEBUG_PATCH) {
    [Console]::Error.WriteLine("DBG len=" + $text.Length + " sha=" + (Get-Sha256Hex -Bytes ([Text.Encoding]::UTF8.GetBytes($text))))
  }
  return $text
}

# ---------------------------------------------------------------------------
# Tree hashing (must match patches\ableton-link-source\source-manifest.json meta)
# ---------------------------------------------------------------------------
function Get-TreeHashInfo {
  param([string]$Root)
  $entries = @()
  $stack = New-Object System.Collections.Stack
  $stack.Push($Root)
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    foreach ($child in (Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop)) {
      if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail "watched source tree contains a reparse point"
      }
      if ($child.PSIsContainer) {
        $stack.Push($child.FullName)
      } elseif (-not $child.PSIsContainer) {
        $rel = $child.FullName.Substring($Root.Length).Replace("\", "/")
        if ($rel.StartsWith("/")) { $rel = $rel.Substring(1) }
        $entries += [pscustomobject]@{
          Key  = $rel.ToLowerInvariant()
          Rel  = $rel
          Full = $child.FullName
        }
      } else {
        Fail "watched source tree contains a non-regular entry"
      }
    }
  }
  # Order must be byte-deterministic (ordinal), matching the manifest's
  # Node-side hashing; PowerShell's Sort-Object is culture-sensitive.
  $sortedArray = [object[]]$entries
  [System.Array]::Sort($sortedArray, [System.Comparison[object]]{ param($a, $b) [String]::CompareOrdinal($a.Key, $b.Key) })
  $sorted = $sortedArray
  $sha = New-Object System.Security.Cryptography.SHA256CryptoServiceProvider
  try {
    foreach ($e in $sorted) {
      $bytes = [IO.File]::ReadAllBytes($e.Full)
      $line = $e.Rel + "`n" + $bytes.Length + "`n" + (Get-Sha256Hex -Bytes $bytes) + "`n"
      $lineBytes = [Text.Encoding]::UTF8.GetBytes($line)
      $sha.TransformBlock($lineBytes, 0, $lineBytes.Length, $null, 0) | Out-Null
    }
    $sha.TransformFinalBlock(@(), 0, 0) | Out-Null
    $hash = ([System.BitConverter]::ToString($sha.Hash)).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
  return @{
    FileCount  = @($sorted).Count
    TreeSha256 = $hash
    Bytes      = (@($sorted) | ForEach-Object { ([IO.FileInfo]($_.Full)).Length } | Measure-Object -Sum).Sum
  }
}

# ---------------------------------------------------------------------------
# Sanitized child-process execution (whitelist environment, no inherited env)
# ---------------------------------------------------------------------------
function New-SanitizedEnvironment {
  param([string[]]$ExtraPathEntries = @(), [string]$TempDir = "", [string]$PinnedLinkExe = "")

  $systemRoot = Get-TrustedSystemRoot
  $pf = Get-TrustedProgramFiles
  $pfx86 = Get-TrustedProgramFilesX86
  $commonFiles = Get-TrustedCommonFiles
  $localAppData = Get-TrustedLocalAppData
  $roamingAppData = Get-TrustedRoamingAppData
  $systemDrive = $systemRoot.Substring(0, 2) + "\"
  $comSpec = Join-Path $systemRoot "System32\cmd.exe"
  if (-not (Test-Path -LiteralPath $comSpec -PathType Leaf)) { Fail "trusted ComSpec missing" }

  $pathEntries = @()
  foreach ($entry in $ExtraPathEntries) {
    if (-not [string]::IsNullOrWhiteSpace($entry)) { $pathEntries += $entry }
  }

  $callerThreats = @()
  $rawCallerPath = ""
  $rawCallerPathEnv = $env:PATH
  if ($null -ne $rawCallerPathEnv) { $rawCallerPath = $rawCallerPathEnv }
  foreach ($entry in ($rawCallerPath -split ";")) {
    $trimmed = $entry.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }
    $isGitTree = $trimmed -match '(?i)(^|[\\/])git([\\/]|$)'
    if ($isGitTree) {
      $probeLink = Join-Path $trimmed "link.exe"
      if (Test-Path -LiteralPath $probeLink -PathType Leaf) {
        $callerThreats += ("git-tree link.exe on caller PATH (excluded): leaf=" + [IO.Path]::GetFileName($trimmed))
      }
      continue
    }
    if (-not (Test-Path -LiteralPath $trimmed -PathType Container)) { continue }
    $probeLink = Join-Path $trimmed "link.exe"
    if (Test-Path -LiteralPath $probeLink -PathType Leaf) {
      $callerThreats += ("non-pinned link.exe directory on caller PATH (candidate, excluded unless trusted): leaf=" + [IO.Path]::GetFileName($trimmed))
    }
    $pathEntries += $trimmed
  }

  $systemDirs = @(
    (Join-Path $systemRoot "System32"),
    $systemRoot,
    (Join-Path $systemRoot "System32\wbem"),
    (Join-Path $systemRoot "System32\WindowsPowerShell\v1.0")
  )
  foreach ($sd in $systemDirs) { $pathEntries += $sd }

  $deduped = @()
  $seen = @{}
  foreach ($entry in $pathEntries) {
    $normalized = ([IO.Path]::GetFullPath($entry)).TrimEnd('\')
    $k = $normalized.ToLowerInvariant()
    if (-not $seen.ContainsKey($k)) {
      $seen[$k] = $true
      $deduped += $normalized
    }
  }

  if (-not [string]::IsNullOrEmpty($PinnedLinkExe)) {
    $pinnedFull = [IO.Path]::GetFullPath($PinnedLinkExe)
    $filtered = @()
    foreach ($entry in $deduped) {
      $candidateLink = Join-Path $entry "link.exe"
      if ((Test-Path -LiteralPath $candidateLink -PathType Leaf) -and
        -not $candidateLink.Equals($pinnedFull, [StringComparison]::OrdinalIgnoreCase)) {
        $callerThreats += ("excluded non-pinned link.exe directory from build PATH: leaf=" + [IO.Path]::GetFileName($entry))
        continue
      }
      $filtered += $entry
    }
    $deduped = $filtered
  }

  $env = @{}
  $env["PATH"] = ($deduped -join ";")
  $env["SystemRoot"] = $systemRoot
  $env["windir"] = $systemRoot
  $env["SystemDrive"] = $systemDrive
  $env["ComSpec"] = $comSpec
  $env["ProgramFiles"] = $pf
  $env["ProgramFiles(x86)"] = $pfx86
  $env["ProgramW6432"] = $pf
  $env["CommonProgramFiles"] = $commonFiles
  $env["CommonProgramFiles(x86)"] = $commonFiles
  $env["ProgramData"] = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)
  $env["LOCALAPPDATA"] = $localAppData
  $env["APPDATA"] = $roamingAppData
  $env["PATHEXT"] = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"
  $env["PROCESSOR_ARCHITECTURE"] = "AMD64"
  $env["VSLANG"] = "1033"
  $env["GYP_MSVS_VERSION"] = "2022"
  if (-not [string]::IsNullOrEmpty($TempDir)) {
    if (-not (Test-Path -LiteralPath $TempDir -PathType Container)) {
      New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
    }
    $env["TEMP"] = $TempDir
    $env["TMP"] = $TempDir
  }

  return @{
    Env               = $env
    PathEntries       = $deduped
    CallerPathThreats = $callerThreats
  }
}

function Start-TrustedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$ArgumentList,
    [hashtable]$Environment,
    [string]$WorkingDirectory,
    [int]$TimeoutMs = 120000,
    [string]$StdOutFile = "",
    [string]$StdErrFile = ""
  )

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.Arguments = (($ArgumentList | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join " ")
  if (-not [string]::IsNullOrEmpty($WorkingDirectory)) {
    $psi.WorkingDirectory = $WorkingDirectory
  }
  if ($null -ne $Environment) {
    # Exact-whitelist enforcement: EnvironmentVariables seeds itself from the
    # current process, so every inherited key must be cleared first. This keeps
    # caller-injected NODE_OPTIONS/npm_config_*/GYP_* out of all children.
    $psi.EnvironmentVariables.Clear()
    foreach ($k in $Environment.Keys) {
      $psi.EnvironmentVariables[$k] = [string]$Environment[$k]
    }
  }

  $proc = [System.Diagnostics.Process]::Start($psi)
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()

  $exited = $proc.WaitForExit($TimeoutMs)
  if (-not $exited) {
    try { $proc.Kill() } catch { }
    Fail ("process timed out after ${TimeoutMs}ms: " + [IO.Path]::GetFileName($FilePath))
  }
  $stdout = $outTask.GetAwaiter().GetResult()
  $stderr = $errTask.GetAwaiter().GetResult()
  if (-not [string]::IsNullOrEmpty($StdOutFile)) { [IO.File]::WriteAllText($StdOutFile, $stdout) }
  if (-not [string]::IsNullOrEmpty($StdErrFile)) { [IO.File]::WriteAllText($StdErrFile, $stderr) }

  return @{
    ExitCode = $proc.ExitCode
    StdOut   = $stdout
    StdErr   = $stderr
  }
}

# ---------------------------------------------------------------------------
# Toolchain resolution (exact pins proven before anything is copied/built)
# ---------------------------------------------------------------------------
function Resolve-Toolchain {
  param([string]$ProjectRoot, [string]$NodeExeOverride = "", [string]$TempDir = "")

  # --- Node ---
  $nodeExe = $NodeExeOverride
  if ([string]::IsNullOrWhiteSpace($nodeExe)) {
    $cmd = Get-Command -Name "node.exe" -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $cmd) { Fail "node.exe was not found on PATH" }
    $nodeExe = $cmd.Source
  }
  $nodeExe = [IO.Path]::GetFullPath($nodeExe)
  if (-not (Test-Path -LiteralPath $nodeExe -PathType Leaf)) { Fail "node executable is missing" }

  $sanitizedBase = New-SanitizedEnvironment -TempDir $TempDir
  $verResult = Start-TrustedProcess -FilePath $nodeExe -ArgumentList @("--version") `
    -Environment $sanitizedBase.Env -TimeoutMs 20000
  if ($verResult.ExitCode -ne 0) {
    Fail ("node --version failed (exit " + $verResult.ExitCode + "): " + (($verResult.StdErr.Trim() + " " + $verResult.StdOut.Trim()).Trim()))
  }
  $nodeVersion = $verResult.StdOut.Trim()
  if ($nodeVersion -ne ("v" + $script:NodeVersionPin)) {
    Fail ("node version must be exactly v" + $script:NodeVersionPin + ", got " + $nodeVersion)
  }
  $archResult = Start-TrustedProcess -FilePath $nodeExe `
    -ArgumentList @("-p", "process.arch + '/' + process.platform") `
    -Environment $sanitizedBase.Env -TimeoutMs 20000
  if ($archResult.ExitCode -ne 0) {
    Fail ("node arch probe failed (exit " + $archResult.ExitCode + "): " + (($archResult.StdErr.Trim() + " " + $archResult.StdOut.Trim()).Trim()))
  }
  $archPlatform = $archResult.StdOut.Trim()
  if ($archPlatform -ne ($script:NodeArchPin + "/win32")) {
    Fail ("node must be x64/win32, got " + $archPlatform)
  }
  $napiResult = Start-TrustedProcess -FilePath $nodeExe `
    -ArgumentList @("-p", "Number(process.versions.napi)") `
    -Environment $sanitizedBase.Env -TimeoutMs 20000
  if ($napiResult.ExitCode -ne 0) { Fail "node napi probe failed" }
  $napiLevel = 0
  if (-not [int]::TryParse($napiResult.StdOut.Trim(), [ref]$napiLevel)) { Fail "node napi level unparsable" }
  if ($napiLevel -lt $script:NapiTarget) {
    Fail ("node N-API level must be at least " + $script:NapiTarget + ", got " + $napiLevel)
  }

  # --- node-gyp (exact pinned devDependency inside the project) ---
  $nodeGypJs = Join-Path $ProjectRoot "node_modules\node-gyp\bin\node-gyp.js"
  if (-not (Test-Path -LiteralPath $nodeGypJs -PathType Leaf)) {
    Fail "pinned node-gyp is missing; run: npm install --save-exact --save-dev node-gyp@$script:NodeGypVersionPin"
  }
  $ngPkgJsonPath = Join-Path $ProjectRoot "node_modules\node-gyp\package.json"
  $ngPkgRaw = [IO.File]::ReadAllText($ngPkgJsonPath)
  $ngVersionMatch = [regex]::Match($ngPkgRaw, '"version"\s*:\s*"([^"]+)"')
  if (-not $ngVersionMatch.Success) { Fail "node-gyp package.json version unreadable" }
  if ($ngVersionMatch.Groups[1].Value -ne $script:NodeGypVersionPin) {
    Fail ("node-gyp version must be exactly " + $script:NodeGypVersionPin + ", got " + $ngVersionMatch.Groups[1].Value)
  }

  # --- node headers cache (offline guarantee: no downloads permitted) ---
  $localAppData = Get-TrustedLocalAppData
  $headersCache = Join-Path $localAppData ("node-gyp\Cache\" + $script:NodeVersionPin)
  $headersCommonGypi = Join-Path $headersCache "include\node\common.gypi"
  $nodeLibExpected = Join-Path $headersCache "x64\node.lib"
  if (-not (Test-Path -LiteralPath $headersCommonGypi -PathType Leaf)) {
    Fail "pinned node headers cache is missing (downloads are not permitted)"
  }
  if (-not (Test-Path -LiteralPath $nodeLibExpected -PathType Leaf)) {
    Fail "pinned node.lib cache is missing (downloads are not permitted)"
  }
  # Exact trust-surface proof: every header/metadata byte node-gyp consumes plus
  # the linker input must match the tracked reviewed manifest (derived from the
  # hash-verified official headers archive) before configure/build can run.
  # Evidence is reported by Main (output here would be captured by the caller).
  $headersManifest = Read-NodeHeadersManifest -Path (Join-Path $ProjectRoot ($script:PatchesRel + "\" + $script:HeadersManifestRel))
  $headersProof = Assert-NodeHeadersSurface -CacheRoot $headersCache -Manifest $headersManifest

  # --- Python for gyp (OS-derived candidates, validated by probing) ---
  $pythonExe = ""
  foreach ($candidate in (Get-TrustedPythonCandidateExes)) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    if (-not ($candidate -match '^[A-Za-z]:\\')) { continue }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $candidateArgs = @("--version")
    if (([IO.Path]::GetFileName($candidate) -ieq "py.exe")) { $candidateArgs = @("-3", "--version") }
    $pyProbe = Start-TrustedProcess -FilePath $candidate -ArgumentList $candidateArgs `
      -Environment $sanitizedBase.Env -TimeoutMs 15000
    $pyOut = ($pyProbe.StdOut + $pyProbe.StdErr)
    if ($pyProbe.ExitCode -ne 0) { continue }
    if ($pyOut -match '^Python 3\.(\d+)\.') {
      $minor = [int]$Matches[1]
      if ($minor -ge 8 -and $minor -le 13) { $pythonExe = $candidate; break }
    }
  }
  if ([string]::IsNullOrEmpty($pythonExe)) { Fail "no usable Python 3.8-3.13 interpreter found for gyp" }
  Assert-NoReparsePathChain -Path $pythonExe -Label "Python interpreter"

  # --- Visual Studio 2022 Community via trusted vswhere ---
  $pfX86 = Get-TrustedProgramFilesX86
  $pf = Get-TrustedProgramFiles
  $vswhere = Join-Path $pfX86 "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { Fail "vswhere is missing from the trusted installer directory" }
  $vsQuery = Start-TrustedProcess -FilePath $vswhere `
    -ArgumentList @("-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath") `
    -Environment $sanitizedBase.Env -TimeoutMs 30000
  if ($vsQuery.ExitCode -ne 0) { Fail "vswhere query failed" }
  $vsRoot = ""
  foreach ($line in ($vsQuery.StdOut -split "\r?\n")) {
    $t = $line.Trim()
    if (-not [string]::IsNullOrWhiteSpace($t)) { $vsRoot = $t; break }
  }
  $expectedVsRoot = Join-Path $pf $script:VsRootSuffix
  if ([string]::IsNullOrWhiteSpace($vsRoot)) { Fail "vswhere returned no VS installation with VC tools" }
  if (-not $vsRoot.Equals(([IO.Path]::GetFullPath($expectedVsRoot)), [StringComparison]::OrdinalIgnoreCase)) {
    Fail "resolved VS installation does not match the pinned VS2022 Community root"
  }
  Assert-NoReparsePathChain -Path $vsRoot -Label "Visual Studio installation"

  # --- MSVC toolset (exact version) ---
  $msvcRoot = Join-Path $vsRoot ("VC\Tools\MSVC\" + $script:MsvcToolsVersionPin)
  if (-not (Test-Path -LiteralPath $msvcRoot -PathType Container)) {
    Fail ("MSVC tools " + $script:MsvcToolsVersionPin + " are not installed under the pinned VS root")
  }
  $hostBin = Join-Path $msvcRoot "bin\Hostx64\x64"
  $clExe = Join-Path $hostBin "cl.exe"
  $linkExe = Join-Path $hostBin "link.exe"
  $linkFileVer = ""
  $clFileVer = ""
  # Toolset identity is proven by the exact MSVC directory pin above.
  # Binaries differ in versioning scheme: cl.exe reports the compiler family
  # (19.44.x for VS toolset 14.44), link.exe reports the toolset itself.
  $clVi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($clExe)
  if ($clVi.FileMajorPart -ne 19 -or $clVi.FileMinorPart -ne 44) {
    Fail ("MSVC compiler family mismatch; expected 19.44 for toolset " + $script:MsvcToolsVersionPin + ", got " + $clVi.FileMajorPart + "." + $clVi.FileMinorPart)
  }
  $clFileVer = "$($clVi.FileMajorPart).$($clVi.FileMinorPart).$($clVi.FileBuildPart).$($clVi.FilePrivatePart)"
  $linkVi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($linkExe)
  if ($linkVi.FileMajorPart -ne 14 -or $linkVi.FileMinorPart -ne 44) {
    Fail ("MSVC linker family mismatch; expected 14.44 for toolset " + $script:MsvcToolsVersionPin + ", got " + $linkVi.FileMajorPart + "." + $linkVi.FileMinorPart)
  }
  $linkFileVer = "$($linkVi.FileMajorPart).$($linkVi.FileMinorPart).$($linkVi.FileBuildPart).$($linkVi.FilePrivatePart)"
  $msbuildExe = Join-Path $vsRoot "MSBuild\Current\Bin\MSBuild.exe"
  if (-not (Test-Path -LiteralPath $msbuildExe -PathType Leaf)) { Fail "MSBuild.exe is missing under the pinned VS root" }
  $msbVi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($msbuildExe)
  if ($msbVi.FileMajorPart -ne 17) { Fail "unexpected MSBuild major version" }

  return @{
    NodeExe            = $nodeExe
    NodeVersion        = $nodeVersion
    NodeArch           = $script:NodeArchPin
    NapiLevel          = $napiLevel
    NodeGypJs          = $nodeGypJs
    NodeGypVersion     = $script:NodeGypVersionPin
    HeadersCache       = $headersCache
    ExpectedNodeLib    = $nodeLibExpected
    HeadersFileCount   = $headersProof.FileCount
    NodeLibSha256      = $headersProof.NodeLibSha256
    PythonExe          = $pythonExe
    VsRoot             = $vsRoot
    MsvcRoot           = $msvcRoot
    MsvcHostBin        = $hostBin
    ClExe              = $clExe
    ClFileVer          = $clFileVer
    LinkExe            = $linkExe
    LinkFileVer        = $linkFileVer
    MsbuildExe         = $msbuildExe
  }
}

function Assert-SanitizedLinkResolution {
  param([hashtable]$Sanitized, [string]$PinnedLinkExe)
  $resolved = ""
  foreach ($entry in $Sanitized.PathEntries) {
    $candidate = Join-Path $entry "link.exe"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { $resolved = $candidate; break }
  }
  if ([string]::IsNullOrEmpty($resolved)) {
    Fail "link.exe does not resolve anywhere on the sanitized PATH"
  }
  if (-not $resolved.Equals(([IO.Path]::GetFullPath($PinnedLinkExe)), [StringComparison]::OrdinalIgnoreCase)) {
    Fail "link.exe on the sanitized PATH does not resolve to the pinned MSVC linker"
  }
  foreach ($entry in $Sanitized.PathEntries) {
    if ($entry -match '(?i)(^|[\\/])git([\\/]|$)') {
      Fail "Git directory survived PATH sanitization"
    }
  }
  return $resolved
}

# ---------------------------------------------------------------------------
# Node headers / node.lib trust surface (tracked reviewed extracted-tree manifest)
# ---------------------------------------------------------------------------
function Read-NodeHeadersManifest {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail "node headers manifest is missing" }
  Assert-NoReparsePathChain -Path $Path -Label "node headers manifest"
  try {
    $manifest = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
  } catch {
    Fail "node headers manifest is not valid JSON"
  }
  if ($manifest.schema -ne "rb-output.ableton-link.node-headers-manifest/1") { Fail "unknown node headers manifest schema" }
  if ([string]$manifest.meta.nodeVersion -ne $script:NodeVersionPin) {
    Fail ("node headers manifest node version drift: expected " + $script:NodeVersionPin + ", got " + $manifest.meta.nodeVersion)
  }
  if ([string]$manifest.meta.arch -ne $script:NodeArchPin) {
    Fail ("node headers manifest arch drift: expected " + $script:NodeArchPin + ", got " + $manifest.meta.arch)
  }
  if ([string]$manifest.meta.sourceArchiveName -ne $script:HeadersArchiveOfficialName) { Fail "node headers manifest source archive name drift" }
  if (-not ([string]$manifest.meta.sourceArchiveSha256).Equals($script:HeadersArchiveOfficialShaPin, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "node headers manifest source archive hash does not match the official pin"
  }
  if (-not ([string]$manifest.meta.altSourceArchiveSha256).Equals($script:HeadersAltArchiveOfficialShaPin, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "node headers manifest alternate archive hash does not match the official pin"
  }
  if ([string]$manifest.headersDir -ne "include/node") { Fail "node headers manifest declared headers root is unexpected" }
  if ([string]$manifest.nodeLib.path -ne "x64/node.lib") { Fail "node headers manifest node.lib entry path is unexpected" }
  if ([string]$manifest.nodeLib.sha256 -notmatch '^[0-9a-fA-F]{64}$') {
    Fail "node headers manifest node.lib entry has a malformed sha256"
  }
  $entries = @($manifest.files)
  if ($entries.Count -lt 1) { Fail "node headers manifest lists no files" }
  if (-not $manifest.fileCount -or [int64]$manifest.fileCount -ne $entries.Count) {
    Fail "node headers manifest fileCount disagrees with its entries"
  }
  return $manifest
}

function Assert-NodeHeadersSurface {
  param([string]$CacheRoot, $Manifest, [string]$ExpectedNodeLibSha = $script:NodeLibOfficialShaPin)

  if ([string]::IsNullOrWhiteSpace($CacheRoot)) { Fail "node headers cache root was not derived" }
  if (-not [string]::IsNullOrEmpty($ExpectedNodeLibSha) -and
    -not ([string]$Manifest.nodeLib.sha256).Equals($ExpectedNodeLibSha, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "node headers manifest node.lib hash does not match the pinned official value"
  }
  $CacheRoot = ([IO.Path]::GetFullPath($CacheRoot)).TrimEnd('\')
  if (-not (Test-Path -LiteralPath $CacheRoot -PathType Container)) { Fail "pinned node headers cache root is missing" }
  Assert-NoReparsePathChain -Path $CacheRoot -Label "node headers cache"

  $headersFull = ([IO.Path]::GetFullPath((Join-Path $CacheRoot "include\node"))).TrimEnd('\')
  if (-not (Test-Path -LiteralPath $headersFull -PathType Container)) {
    Fail "declared include\node root is missing from the node headers cache"
  }

  $expected = @{}
  foreach ($entry in @($Manifest.files)) {
    $rel = [string]$entry.path
    if ($rel -notmatch '^include/node/[A-Za-z0-9._\-/]+$' -or $rel.Contains("..")) {
      Fail ("node headers manifest contains an unsafe or out-of-root path: " + $rel)
    }
    if (-not ([string]$entry.sha256 -match '^[0-9a-fA-F]{64}$')) {
      Fail ("node headers manifest entry has a malformed sha256: " + $rel)
    }
    $key = $rel.ToLowerInvariant()
    if ($expected.ContainsKey($key)) { Fail ("node headers manifest contains a duplicate path: " + $rel) }
    $expected[$key] = $entry
  }

  $actual = @{}
  $stack = New-Object System.Collections.Stack
  $stack.Push($headersFull)
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    foreach ($child in (Get-ChildItem -LiteralPath $dir -Force -ErrorAction Stop)) {
      if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Fail ("node headers cache contains a symbolic link or junction inside the declared roots (leaf=" + [IO.Path]::GetFileName($child.FullName) + ")")
      }
      if ($child.PSIsContainer) {
        $stack.Push($child.FullName)
        continue
      }
      $rel = "include/node/" + $child.FullName.Substring($headersFull.Length).Replace("\", "/").TrimStart("/")
      $actual[$rel.ToLowerInvariant()] = $child
    }
  }

  $missing = @($expected.Keys | Where-Object { -not $actual.ContainsKey($_) } | Sort-Object)
  if ($missing.Count -gt 0) {
    $missingSample = @($missing | Select-Object -First 3) -join ", "
    Fail ("node headers cache drift: " + $missing.Count + " file(s) missing from the declared roots (e.g. " + $missingSample + ")")
  }
  $extra = @($actual.Keys | Where-Object { -not $expected.ContainsKey($_) } | Sort-Object)
  if ($extra.Count -gt 0) {
    $extraSample = @($extra | Select-Object -First 3) -join ", "
    Fail ("node headers cache drift: " + $extra.Count + " unexpected extra file(s) inside the declared roots (e.g. " + $extraSample + ")")
  }

  foreach ($pair in $actual.GetEnumerator()) {
    $entry = $expected[$pair.Key]
    $fileLen = ([IO.FileInfo]$pair.Value.FullName).Length
    if ($fileLen -ne [int64]$entry.size) {
      Fail ("node headers cache drift: size changed (leaf=" + [IO.Path]::GetFileName($pair.Value.FullName) + ")")
    }
    if (-not (Get-FileSha256 -Path $pair.Value.FullName).Equals([string]$entry.sha256, [StringComparison]::OrdinalIgnoreCase)) {
      Fail ("node headers cache drift: content hash changed (leaf=" + [IO.Path]::GetFileName($pair.Value.FullName) + ")")
    }
  }

  $nodeLibFull = Join-Path $CacheRoot (([string]$Manifest.nodeLib.path) -replace "/", "\")
  if (-not (Test-Path -LiteralPath $nodeLibFull -PathType Leaf)) { Fail "pinned node.lib is missing from the headers cache" }
  $libItem = Get-Item -LiteralPath $nodeLibFull -Force
  if (($libItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail "cached node.lib is a symbolic link or junction" }
  if ($libItem.Length -ne [int64]$Manifest.nodeLib.size) { Fail "cached node.lib size does not match the reviewed pin" }
  $libSha = Get-FileSha256 -Path $nodeLibFull
  if (-not $libSha.Equals([string]$Manifest.nodeLib.sha256, [StringComparison]::OrdinalIgnoreCase)) {
    Fail ("cached node.lib byte hash does not match the pinned official value (expected " + [string]$Manifest.nodeLib.sha256 + ")")
  }

  return @{ FileCount = $actual.Count; NodeLibSha256 = $libSha }
}

# ---------------------------------------------------------------------------
# Source manifest handling
# ---------------------------------------------------------------------------
function Read-SourceManifest {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail "source manifest is missing" }
  Assert-NoReparsePathChain -Path $Path -Label "source manifest"
  try {
    $manifest = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
  } catch {
    Fail "source manifest is not valid JSON"
  }
  if ($manifest.schema -ne "rb-output.ableton-link.source-manifest/1") { Fail "unknown source manifest schema" }
  if ($manifest.meta.packageName -ne $script:PackageName) { Fail "source manifest package name drift" }
  if ($manifest.meta.packageVersion -ne $script:PackageVersion) { Fail "source manifest package version drift" }
  if ($manifest.meta.lockIntegrity -cne $script:PackageIntegrity) { Fail "source manifest lock integrity drift" }
  return $manifest
}

function Test-TreeAgainstManifestEntry {
  param([string]$RootDir, $Entry)
  if (-not (Test-Path -LiteralPath $RootDir -PathType Container)) {
    Fail ("source drift: watched tree is missing (leaf=" + [IO.Path]::GetFileName($RootDir) + ")")
  }
  $info = Get-TreeHashInfo -Root $RootDir
  if ($info.FileCount -ne [int]$Entry.fileCount) {
    Fail ("source drift: watched tree file count changed (leaf=" + [IO.Path]::GetFileName($RootDir) + ")")
  }
  if (-not $info.TreeSha256.Equals([string]$Entry.treeSha256, [StringComparison]::OrdinalIgnoreCase)) {
    Fail ("source drift: watched tree hash changed (leaf=" + [IO.Path]::GetFileName($RootDir) + ")")
  }
  return $info
}

function Write-SourceManifestImpl {
  param([string]$ProjectRoot, [string]$SourceDir, [string]$OutputPath, [string]$PatchedReferencePath)

  if (-not (Test-Path -LiteralPath $SourceDir -PathType Container)) { Fail "source package directory is not a directory" }
  Assert-NoReparsePathChain -Path $SourceDir -Label "source package"

  $pkgJsonPath = Join-Path $SourceDir "package.json"
  if (-not (Test-Path -LiteralPath $pkgJsonPath -PathType Leaf)) { Fail "source package.json is missing" }
  $pkg = [IO.File]::ReadAllText($pkgJsonPath) | ConvertFrom-Json
  if ($pkg.name -ne $script:PackageName) { Fail "source package name drift" }
  if ($pkg.version -ne $script:PackageVersion) { Fail "source package version drift" }

  $origBindingPath = Join-Path $SourceDir "binding.gyp"
  if (-not (Test-Path -LiteralPath $origBindingPath -PathType Leaf)) { Fail "binding.gyp is missing from the source package" }
  $origBytes = [IO.File]::ReadAllBytes($origBindingPath)
  $origSha = Get-Sha256Hex -Bytes $origBytes

  $patchedText = Invoke-BindingGypPatch -OriginalText ([Text.Encoding]::UTF8.GetString($origBytes))

  $files = @()
  foreach ($f in @("binding.gyp", "package.json")) {
    $bytes = [IO.File]::ReadAllBytes((Join-Path $SourceDir ($f -replace "/", "\")))
    $files += @{ path = $f; size = $bytes.Length; sha256 = (Get-Sha256Hex -Bytes $bytes) }
  }
  $trees = @()
  foreach ($t in @("src", "link/include", "link/modules/asio-standalone/asio/include", "node_modules/node-addon-api")) {
    $full = Join-Path $SourceDir ($t -replace "/", "\")
    $info = Get-TreeHashInfo -Root $full
    $trees += @{ path = $t; fileCount = $info.FileCount; bytes = $info.Bytes; treeSha256 = $info.TreeSha256 }
  }

  $patchedSha = Get-Sha256Hex -Bytes ([Text.Encoding]::UTF8.GetBytes($patchedText))

  if (-not [string]::IsNullOrEmpty($PatchedReferencePath)) {
    if (Test-Path -LiteralPath $PatchedReferencePath -PathType Leaf) {
      $existingRef = [IO.File]::ReadAllBytes($PatchedReferencePath)
      $existingRefSha = Get-Sha256Hex -Bytes $existingRef
      if (-not $existingRefSha.Equals($patchedSha, [StringComparison]::OrdinalIgnoreCase)) {
        Fail "reviewed binding.gyp.patched reference would change; this requires explicit review"
      }
    } else {
      $parent = [IO.Path]::GetDirectoryName($PatchedReferencePath)
      if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
      }
      [IO.File]::WriteAllText($PatchedReferencePath, $patchedText, (New-Object System.Text.UTF8Encoding($false)))
    }
  }

  $manifest = [ordered]@{
    schema = "rb-output.ableton-link.source-manifest/1"
    meta   = [ordered]@{
      packageName        = $script:PackageName
      packageVersion     = $script:PackageVersion
      lockIntegrity      = $script:PackageIntegrity
      treeHashAlgorithm  = "sha256 over UTF-8 concatenation of per-file lines '<relPath>\n<size>\n<lowercase-sha256-hex>\n' with relPath POSIX-normalized, sorted case-insensitively then ordinally"
      scopeNote          = "Exact reviewed compile surface of the npm package. Everything outside these entries (docs, tests, assets) is deliberately not copied into staging."
    }
    files  = $files
    trees  = $trees
    patch  = [ordered]@{
      target                 = "binding.gyp"
      expectedOrigSha256     = $origSha
      operations             = @(
        "remove the global cflags_cc '-std=c++14' entry (Node-provided C++20 standard must win)",
        "remove the global LINK_PLATFORM_MACOSX=1 define (retained only inside the OS=='mac' condition)",
        "remove the Windows AdditionalOptions '/std:c++14' entry, keeping ExceptionHandling=1 (avoids D9025 /std override)"
      )
      patchedReference       = "binding.gyp.patched"
      expectedPatchedSha256  = $patchedSha
    }
    build  = [ordered]@{
      nodeTarget            = $script:NodeVersionPin
      nodeArch              = $script:NodeArchPin
      napiTarget            = $script:NapiTarget
      msvcToolsVersion      = $script:MsvcToolsVersionPin
      visualStudioRootName  = $script:VsRootSuffix
      nodeGypVersion        = $script:NodeGypVersionPin
    }
  }

  $json = ($manifest | ConvertTo-Json -Depth 6) + "`n"
  [IO.File]::WriteAllText($OutputPath, $json, (New-Object System.Text.UTF8Encoding($false)))
  Info ("source manifest written: leaf=" + [IO.Path]::GetFileName($OutputPath) + " origSha256=" + $origSha + " patchedSha256=" + $patchedSha)
  return $manifest
}

# ---------------------------------------------------------------------------
# Staging: copy exactly the reviewed compile surface, then apply the patch
# ---------------------------------------------------------------------------
function Copy-StagingFromManifest {
  param([string]$SourceDir, [string]$StagingSrc, $Manifest)

  if (Test-Path -LiteralPath $StagingSrc -PathType Container) {
    Remove-Item -LiteralPath $StagingSrc -Recurse -Force -ErrorAction Stop
  }
  New-Item -ItemType Directory -Path $StagingSrc -Force | Out-Null

  foreach ($f in $Manifest.files) {
    $src = Join-Path $SourceDir ($f.path -replace "/", "\")
    $dst = Join-Path $StagingSrc ($f.path -replace "/", "\")
    Copy-Item -LiteralPath $src -Destination $dst -Force -ErrorAction Stop
  }
  foreach ($t in $Manifest.trees) {
    $src = Join-Path $SourceDir ($t.path -replace "/", "\")
    $dst = Join-Path $StagingSrc ($t.path -replace "/", "\")
    $dstParent = [IO.Path]::GetDirectoryName($dst)
    if (-not (Test-Path -LiteralPath $dstParent -PathType Container)) {
      New-Item -ItemType Directory -Path $dstParent -Force | Out-Null
    }
    Copy-Item -LiteralPath $src -Destination $dst -Recurse -Force -ErrorAction Stop
  }

  foreach ($f in $Manifest.files) {
    $dst = Join-Path $StagingSrc ($f.path -replace "/", "\")
    $bytes = [IO.File]::ReadAllBytes($dst)
    $actual = Get-Sha256Hex -Bytes $bytes
    if (-not $actual.Equals([string]$f.sha256, [StringComparison]::OrdinalIgnoreCase)) {
      Fail ("staged copy fidelity failure for file leaf=" + [IO.Path]::GetFileName($dst))
    }
  }
  foreach ($t in $Manifest.trees) {
    $dst = Join-Path $StagingSrc ($t.path -replace "/", "\")
    $info = Get-TreeHashInfo -Root $dst
    if ($info.FileCount -ne [int]$t.fileCount -or -not $info.TreeSha256.Equals([string]$t.treeSha256, [StringComparison]::OrdinalIgnoreCase)) {
      Fail ("staged copy fidelity failure for tree leaf=" + [IO.Path]::GetFileName($dst))
    }
  }
}

function Assert-PatchStagedBindingGyp {
  param([string]$StagingSrc, $Manifest, [string]$PatchedReferencePath)

  $stagedOrig = Join-Path $StagingSrc "binding.gyp"
  $bytes = [IO.File]::ReadAllBytes($stagedOrig)
  $origSha = Get-Sha256Hex -Bytes $bytes
  if (-not $origSha.Equals([string]$Manifest.patch.expectedOrigSha256, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "patch drift: staged binding.gyp does not match the reviewed original hash"
  }

  if (-not (Test-Path -LiteralPath $PatchedReferencePath -PathType Leaf)) { Fail "reviewed binding.gyp.patched reference is missing" }
  $referenceBytes = [IO.File]::ReadAllBytes($PatchedReferencePath)
  $referenceSha = Get-Sha256Hex -Bytes $referenceBytes
  if (-not $referenceSha.Equals([string]$Manifest.patch.expectedPatchedSha256, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "reviewed binding.gyp.patched reference hash does not match the manifest"
  }

  $patchedText = Invoke-BindingGypPatch -OriginalText ([Text.Encoding]::UTF8.GetString($bytes))
  $patchedBytes = [Text.Encoding]::UTF8.GetBytes($patchedText)
  $patchedSha = Get-Sha256Hex -Bytes $patchedBytes
  if (-not $patchedSha.Equals([string]$Manifest.patch.expectedPatchedSha256, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "post-patch binding.gyp does not match the reviewed reference"
  }
  for ($i = 0; $i -lt $patchedBytes.Length; $i++) {
    if ($i -ge $referenceBytes.Length -or $patchedBytes[$i] -ne $referenceBytes[$i]) {
      Fail "post-patch binding.gyp differs from the reviewed reference bytes"
    }
  }
  if ($patchedBytes.Length -ne $referenceBytes.Length) {
    Fail "post-patch binding.gyp length differs from the reviewed reference"
  }

  [IO.File]::WriteAllBytes($stagedOrig, $patchedBytes)
  $afterBytes = [IO.File]::ReadAllBytes($stagedOrig)
  if (-not (Get-Sha256Hex -Bytes $afterBytes).Equals($patchedSha, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "staged post-patch binding.gyp verification failed"
  }
  return $patchedSha
}

# ---------------------------------------------------------------------------
# Generated project inspection (configure output gate)
# ---------------------------------------------------------------------------
function Assert-GeneratedProject {
  param([string]$StagingSrc, [string]$ExpectedNodeLib)

  $vcxproj = Join-Path $StagingSrc "build\abletonlink.vcxproj"
  if (-not (Test-Path -LiteralPath $vcxproj -PathType Leaf)) { Fail "generated abletonlink.vcxproj is missing" }
  Assert-NoReparsePathChain -Path $vcxproj -Label "generated project"
  $raw = [IO.File]::ReadAllText($vcxproj)

  if ($raw -notmatch 'Include="Release\|x64"') { Fail "generated project lacks a Release|x64 configuration" }
  if ($raw -match 'std:c\+\+1[47]') {
    Fail "generated project overrides the language standard (D9025 risk); reviewed patch must remove all /std:c++NN flags"
  }

  # Pinned linker-input forms: the canonical single-backslash node.lib path is
  # the only absolute path allowed verbatim; its gyp-escaped form (every backslash
  # doubled) is the ONLY anomaly ever rewritten, and only after a full read-only
  # analysis proves no other anomaly exists.
  $expectedCanonical = [regex]::Replace([IO.Path]::GetFullPath($ExpectedNodeLib), "/", "\")
  $expectedEscaped = $expectedCanonical.Replace("\", "\\")

  function Analyze-Deps([string]$Text) {
    $unexpected = @()
    $pending = @()
    $matches0 = [regex]::Matches($Text, '<AdditionalDependencies>(.*?)</AdditionalDependencies>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if ($matches0.Count -eq 0) {
      return @{ Unexpected = @("generated project has no AdditionalDependencies to inspect"); Pending = @() ; Matches = @() }
    }
    foreach ($m in $matches0) {
      # XML stores quotes as &quot; entities whose trailing ';' would break
      # naive tokenization; analyze a decoded copy and re-encode afterwards.
      # node-gyp joins VCLinkerTool inputs with spaces prefixed by $(NOINHERIT),
      # so tokens are split on both ';' and whitespace.
      $valueRaw = $m.Groups[1].Value
      $value = $valueRaw.Replace("&quot;", '"')
      $cleanedValue = $value
      foreach ($tokenRaw in ($value -split "[;\s]+")) {
        $token = $tokenRaw.Trim().Trim('"')
        if ([string]::IsNullOrWhiteSpace($token)) { continue }
        if ($token -match '^[\$%]\([^)]*\)$') { continue }
        if ($token.Contains("\\")) {
          if ($token.Equals($expectedEscaped, [StringComparison]::OrdinalIgnoreCase)) {
            $cleanedValue = $cleanedValue.Replace($token, $expectedCanonical)
            if (-not ($pending -contains $valueRaw)) { $pending += $valueRaw }
          } else {
            $unexpected += "unrecognized double-backslash linker input (only the pinned node.lib escape form may be normalized): " + [IO.Path]::GetFileName(($token.Replace("\\", "\")))
          }
          continue
        }
        $lower = $token.ToLowerInvariant()
        if ($script:LibTokenAllowlist -contains $lower) { continue }
        if ($lower.EndsWith(".lib") -and -not $token.Contains("\")) {
          $unexpected += "unrecognized bare library token: " + [IO.Path]::GetFileName($token)
          continue
        }
        if ($token.Contains(":\")) {
          if (-not $token.Equals($expectedCanonical, [StringComparison]::OrdinalIgnoreCase)) {
            $unexpected += "unexpected absolute linker input: " + [IO.Path]::GetFileName($token)
          }
          continue
        }
        $unexpected += "unexpected linker/library token: " + [IO.Path]::GetFileName($token)
      }
    }
    return @{ Unexpected = $unexpected; Pending = $pending; Matches = @($matches0) }
  }

  $analysis = Analyze-Deps -Text $raw
  if ($analysis.Unexpected.Count -gt 0) {
    $distinct = @($analysis.Unexpected | Select-Object -Unique)
    Fail ("generated project contains unexpected linker/library paths (" + $distinct.Count + " distinct): " + (@($distinct | Select-Object -First 3) -join "; "))
  }

  if ($analysis.Pending.Count -gt 0) {
    # Analysis already proved that the ONLY anomaly class present is the exact
    # pinned escaped node.lib form, so a targeted replacement inside each
    # affected AdditionalDependencies value is safe; the post-write re-analysis
    # below still has to come back completely clean.
    $cleaned = $raw
    foreach ($valueRaw in $analysis.Pending) {
      $decoded = $valueRaw.Replace("&quot;", '"')
      $cleanedValue = $decoded.Replace($expectedEscaped, $expectedCanonical)
      $cleaned = $cleaned.Replace($valueRaw, $cleanedValue.Replace('"', "&quot;"))
    }
    [IO.File]::WriteAllText($vcxproj, $cleaned)
    $raw2 = [IO.File]::ReadAllText($vcxproj)
    $recheck = Analyze-Deps -Text $raw2
    if ($raw2 -match '\\\\') { Fail "double-backslash anomalies persisted in generated project after normalization" }
    if ($recheck.Pending.Count -gt 0 -or $recheck.Unexpected.Count -gt 0) {
      Fail "generated project re-inspection failed after pinned node.lib escape normalization"
    }
  }
}

# ---------------------------------------------------------------------------
# PE validation + import table parsing
# ---------------------------------------------------------------------------
function Read-PeImage {
  param([string]$Path, [string]$Label)

  Assert-NoReparsePathChain -Path $Path -Label $Label
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -eq $item -or $item.PSIsContainer) { Fail "$Label is not a regular file" }
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Fail "$Label contains a symbolic link or junction" }

  $bytes = [IO.File]::ReadAllBytes($item.FullName)
  if ($bytes.Length -lt 0x100) { Fail "$Label is truncated" }
  if ($bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) { Fail "$Label is not a Windows PE image (missing MZ signature)" }

  $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
  if ($peOffset -lt 0 -or $peOffset -gt ($bytes.Length - 24)) { Fail "$Label has an invalid PE header offset" }
  if ($bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or $bytes[$peOffset + 2] -ne 0x00 -or $bytes[$peOffset + 3] -ne 0x00) {
    Fail "$Label is not a Windows PE image (missing PE signature)"
  }

  $machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
  if ($machine -ne 0x8664) {
    Fail ("$Label has unsupported machine 0x{0:X4}; expected Windows x64" -f $machine)
  }
  $numberOfSections = [BitConverter]::ToUInt16($bytes, $peOffset + 6)
  $optionalHeaderSize = [BitConverter]::ToUInt16($bytes, $peOffset + 20)
  $coffCharacteristics = [BitConverter]::ToUInt16($bytes, $peOffset + 22)
  if (($coffCharacteristics -band 0x2000) -eq 0) { Fail "$Label is not marked as a DLL" }

  $optionalHeaderOffset = $peOffset + 24
  if ($optionalHeaderSize -lt 112 -or $optionalHeaderOffset -gt ($bytes.Length - $optionalHeaderSize)) {
    Fail "$Label has an invalid optional PE header"
  }
  $optionalMagic = [BitConverter]::ToUInt16($bytes, $optionalHeaderOffset)
  if ($optionalMagic -ne 0x20B) { Fail "$Label is not a PE32+ image" }

  $imageBase = [BitConverter]::ToUInt64($bytes, $optionalHeaderOffset + 24)
  # Data directories begin at optionalHeaderOffset+112 (PE32+); each entry is
  # {VirtualAddress(4), Size(4)}. dir[1] = import table, dir[13] = delay imports.
  $importRva = [BitConverter]::ToUInt32($bytes, $optionalHeaderOffset + 120)
  $importSize = [BitConverter]::ToUInt32($bytes, $optionalHeaderOffset + 124)
  $delayRva = [BitConverter]::ToUInt32($bytes, $optionalHeaderOffset + 216)
  $delaySize = [BitConverter]::ToUInt32($bytes, $optionalHeaderOffset + 220)

  $sectionTableOffset = $optionalHeaderOffset + $optionalHeaderSize
  if ($env:ALB_DEBUG_PE) {
    [Console]::Error.WriteLine("DBG pe=" + $peOffset + " opt=" + $optionalHeaderOffset + " impRva=" + $importRva + " impSize=" + $importSize + " delayRva=" + $delayRva + " sections=" + $numberOfSections)
  }
  $sections = @()
  for ($i = 0; $i -lt $numberOfSections; $i++) {
    $so = $sectionTableOffset + $i * 40
    if ($so + 40 -gt $bytes.Length) { Fail "$Label section table is truncated" }
    $virtualSize = [BitConverter]::ToUInt32($bytes, $so + 8)
    $virtualAddress = [BitConverter]::ToUInt32($bytes, $so + 12)
    $sizeOfRawData = [BitConverter]::ToUInt32($bytes, $so + 16)
    $pointerToRawData = [BitConverter]::ToUInt32($bytes, $so + 20)
    $sections += , @{
      Va     = $virtualAddress
      VSize  = $virtualSize
      Raw    = $pointerToRawData
      RawLen = $sizeOfRawData
    }
  }

  $script:rvaToOffset = {
    param([uint32]$Rva)
    foreach ($s in $sections) {
      $vEnd = $s.Va + [Math]::Max($s.VSize, $s.RawLen)
      if ($Rva -ge $s.Va -and $Rva -lt $vEnd) {
        $delta = $Rva - $s.Va
        if ($delta -ge $s.RawLen) { return -1 }
        return [int]($s.Raw + $delta)
      }
    }
    return -1
  }

  function Read-CStringAt([byte[]]$Buffer, [int]$Offset) {
    if ($Offset -lt 0 -or $Offset -ge $Buffer.Length) { return "" }
    $end = $Offset
    while ($end -lt $Buffer.Length -and $Buffer[$end] -ne 0) { $end++ }
    if ($end -ge $Buffer.Length) { return "" }
    return ([Text.Encoding]::ASCII.GetString($Buffer, $Offset, $end - $Offset))
  }

  function Get-ImportNames([uint32]$DirRva, [uint32]$DirSize, [bool]$Delay) {
    $names = @()
    if ($DirRva -eq 0 -or $DirSize -eq 0) { return $names }
    $baseOff = & $script:rvaToOffset $DirRva
    if ($baseOff -lt 0) { Fail "$Label import directory RVA is unmapped" }
    if ($Delay) {
      # IMAGE_DELAYLOAD_DESCRIPTOR: DWORD grAttrs; DWORD szName; ...
      for ($off = $baseOff; $off + 32 -le $bytes.Length; $off += 32) {
        $grAttrs = [BitConverter]::ToUInt32($bytes, $off)
        $namePtr = [BitConverter]::ToUInt32($bytes, $off + 4)
        if ($grAttrs -eq 0 -and $namePtr -eq 0) { break }
        $nameOff = -1
        if (($grAttrs -band 1) -ne 0) {
          $nameOff = & $script:rvaToOffset $namePtr
        } else {
          $rva = [uint32]([UInt64]$namePtr - $imageBase)
          $nameOff = & $script:rvaToOffset $rva
        }
        if ($nameOff -lt 0) { Fail "$Label delay import name is unmapped" }
        $names += (Read-CStringAt $bytes $nameOff)
      }
    } else {
      for ($off = $baseOff; $off + 20 -le $bytes.Length; $off += 20) {
        $nameRva = [BitConverter]::ToUInt32($bytes, $off + 12)
        if ($nameRva -eq 0) { break }
        $nameOff = & $script:rvaToOffset $nameRva
        if ($nameOff -lt 0) { Fail "$Label import name is unmapped" }
        $names += (Read-CStringAt $bytes $nameOff)
      }
    }
    return $names
  }

  $regularImports = @(Get-ImportNames $importRva $importSize $false)
  $delayImports = @(Get-ImportNames $delayRva $delaySize $true)

  $after = Get-Item -LiteralPath $Path -Force
  if ($after.Length -ne $bytes.Length) { Fail "$Label changed during validation" }

  return @{
    Machine        = $machine
    Size           = $bytes.Length
    RegularImports = $regularImports
    DelayImports   = $delayImports
  }
}

function Assert-PePolicy {
  param($Pe, [bool]$RequireHostImport)

  if ($env:ALB_DEBUG_PE) {
    [Console]::Error.WriteLine("DBG imports regular=[" + ($Pe.RegularImports -join ",") + "] delay=[" + ($Pe.DelayImports -join ",") + "]")
  }
  foreach ($name in $Pe.RegularImports) {
    $l = $name.ToLowerInvariant()
    if (-not ($script:SystemImportAllowlist -contains $l)) {
      Fail ("unexpected imported module in regular import table: " + [IO.Path]::GetFileName($l))
    }
  }
  foreach ($name in $Pe.DelayImports) {
    $l = $name.ToLowerInvariant()
    if ($l -eq "node.exe") { continue }
    if (-not ($script:SystemImportAllowlist -contains $l)) {
      Fail ("unexpected imported module in delay import table: " + [IO.Path]::GetFileName($l))
    }
  }
  if ($RequireHostImport) {
    $all = @($Pe.RegularImports) + @($Pe.DelayImports)
    $foundHost = $false
    foreach ($name in $all) {
      if ($name.ToLowerInvariant() -eq "node.exe") { $foundHost = $true; break }
    }
    if (-not $foundHost) {
      Fail "built addon does not delay-import the node.exe host"
    }
  }
}

# ---------------------------------------------------------------------------
# Functional N-API probe
# ---------------------------------------------------------------------------
$script:LoadProbeSource = @'
"use strict";
const addonPath = process.argv[2];
const mod = require(addonPath);
const AL = mod.AbletonLink || mod.default || mod;
if (typeof AL !== "function") { throw new Error("module exposes no AbletonLink constructor"); }
const link = new AL(120);
const tempo = Number(link.getTempo());
if (!Number.isFinite(tempo) || Math.abs(tempo - 120) > 0.001) { throw new Error("tempo not sane: " + tempo); }
const peers = Number(link.getNumPeers());
if (!Number.isInteger(peers) || peers < 0) { throw new Error("peer count not sane: " + peers); }
if (typeof link.enable !== "function") { throw new Error("enable() missing"); }
if (typeof link.enableSync !== "function" && typeof link.enableStartStopSync !== "function") {
  // tolerated: method surface varies between bindings versions
}
const playing = Boolean(link.isPlaying());
if (typeof playing !== "boolean") { throw new Error("isPlaying() not boolean"); }
if (Number(process.versions.napi) < 10) { throw new Error("N-API level below 10"); }
process.stdout.write(JSON.stringify({ ok: true, tempo: tempo, peers: peers, playing: playing, napi: Number(process.versions.napi) }));
'@

function Invoke-LoadProbe {
  param([string]$NodeExe, [string]$AddonPath, [hashtable]$Env, [string]$WorkDir, [int]$TimeoutMs, [string]$ProbeFile)

  [IO.File]::WriteAllText($ProbeFile, $script:LoadProbeSource, (New-Object System.Text.UTF8Encoding($false)))
  $result = Start-TrustedProcess -FilePath $NodeExe -ArgumentList @($ProbeFile, $AddonPath) `
    -Environment $Env -WorkingDirectory $WorkDir -TimeoutMs $TimeoutMs
  if ($result.ExitCode -ne 0) {
    Fail "addon could not be loaded by the packaging Node runtime (load probe failed)"
  }
  $payload = $result.StdOut.Trim()
  try { $parsed = $payload | ConvertFrom-Json } catch { Fail "load probe produced unparsable output" }
  if ($parsed.ok -ne $true) { Fail "load probe reported failure" }
  if ([Math]::Abs(([double]$parsed.tempo) - 120) -gt 0.001) { Fail "load probe tempo assertion failed" }
  return $parsed
}

# ---------------------------------------------------------------------------
# Promotion with rollback
# ---------------------------------------------------------------------------
function Invoke-Promotion {
  param(
    [string]$StagedAddonPath,
    [string]$DestinationAddonPath,
    [string]$NodeExe,
    [hashtable]$ProbeEnv,
    [string]$ProbeWorkDir,
    [int]$ProbeTimeoutMs,
    [string]$ProbeFile,
    [bool]$DoLoadProbe,
    [bool]$Fixture,
    [bool]$RequireHostImport
  )

  Assert-NoReparsePathChain -Path $DestinationAddonPath -Label "destination addon"
  $destDir = [IO.Path]::GetDirectoryName($DestinationAddonPath)
  if (-not (Test-Path -LiteralPath $destDir -PathType Container)) { Fail "destination Release directory does not exist" }

  if (-not (Test-Path -LiteralPath $StagedAddonPath -PathType Leaf)) { Fail "staged addon is missing" }
  Assert-NoReparsePathChain -Path $StagedAddonPath -Label "staged addon"
  $stagedBytesLen = ([IO.FileInfo]$StagedAddonPath).Length
  $pe = Read-PeImage -Path $StagedAddonPath -Label "staged Ableton Link addon"
  Assert-PePolicy -Pe $pe -RequireHostImport:$RequireHostImport
  $stagedSha = Get-FileSha256 -Path $StagedAddonPath

  $backupPath = $DestinationAddonPath + ".rbak-abletonlink"
  if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
    # Recover from an interrupted earlier promotion before starting a new one.
    if (Test-Path -LiteralPath $DestinationAddonPath -PathType Leaf) {
      Remove-Item -LiteralPath $DestinationAddonPath -Force -ErrorAction Stop
    }
    Move-Item -LiteralPath $backupPath -Destination $DestinationAddonPath -Force -ErrorAction Stop
    Info "recovered interrupted promotion backup over destination"
  }

  $hadOld = Test-Path -LiteralPath $DestinationAddonPath -PathType Leaf
  $oldSha = ""
  if ($hadOld) {
    $oldSha = Get-FileSha256 -Path $DestinationAddonPath
    Move-Item -LiteralPath $DestinationAddonPath -Destination $backupPath -Force -ErrorAction Stop
  }

  try {
    Copy-Item -LiteralPath $StagedAddonPath -Destination $DestinationAddonPath -Force -ErrorAction Stop
    $newSha = Get-FileSha256 -Path $DestinationAddonPath
    if (-not $newSha.Equals($stagedSha, [StringComparison]::OrdinalIgnoreCase)) {
      Fail "promoted addon hash mismatch"
    }
    if ($DoLoadProbe) {
      Invoke-LoadProbe -NodeExe $NodeExe -AddonPath $DestinationAddonPath -Env $ProbeEnv `
        -WorkDir $ProbeWorkDir -TimeoutMs $ProbeTimeoutMs -ProbeFile $ProbeFile | Out-Null
    }
  } catch {
    $promotionError = $_.Exception.Message
    try {
      if (Test-Path -LiteralPath $DestinationAddonPath -PathType Leaf) {
        Remove-Item -LiteralPath $DestinationAddonPath -Force -ErrorAction Stop
      }
      if ($hadOld) {
        Move-Item -LiteralPath $backupPath -Destination $DestinationAddonPath -Force -ErrorAction Stop
        $restoredSha = Get-FileSha256 -Path $DestinationAddonPath
        if (-not $restoredSha.Equals($oldSha, [StringComparison]::OrdinalIgnoreCase)) {
          Fail "rollback could not restore the previous addon byte-for-byte"
        }
      }
    } catch {
      # Never discard the original failure when the rollback also fails.
      $rollbackError = $_.Exception.Message
      Fail ("promotion failed AND rollback failed (destination may hold the new binary); original error: " + $promotionError + "; rollback error: " + $rollbackError)
    }
    if (-not $Fixture) {
      Fail ("promotion rolled back: " + $promotionError)
    } else {
      Fail ("promotion rolled back (fixture): " + $promotionError)
    }
  }

  $backupBytes = 0
  if ($hadOld) {
    $backupBytes = ([IO.FileInfo]$backupPath).Length
    Remove-Item -LiteralPath $backupPath -Force -ErrorAction Stop
  }

  return @{
    Sha256        = $stagedSha
    Size          = $stagedBytesLen
    PreviousSha   = $oldSha
    ReclaimedOld  = $backupBytes
    PeRegularDeps = $pe.RegularImports
    PeDelayDeps   = $pe.DelayImports
  }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
function Main {
  $repoRootDetected = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

  if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = $repoRootDetected
  }
  $ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
  $rootItem = Get-Item -LiteralPath $ProjectRoot -Force -ErrorAction Stop
  if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Fail "project root is a symbolic link or junction"
  }
  if (-not $rootItem.PSIsContainer) { Fail "project root is not a directory" }

  # ---- Authoring mode: regenerate the reviewed source manifest ----
  if ($OutputManifestPath -and -not $ValidatePrerequisitesOnly -and -not $PromoteOnly) {
    if ([string]::IsNullOrWhiteSpace($SourcePackageDir)) {
      Fail "manifest authoring requires an explicit -SourcePackageDir"
    }
    $trackedManifest = Join-Path $ProjectRoot ($script:PatchesRel + "\source-manifest.json")
    if ([string]::IsNullOrWhiteSpace($SourceManifestPath)) {
      $SourceManifestPath = $OutputManifestPath
    }
    $SourceManifestPath = [IO.Path]::GetFullPath($SourceManifestPath)
    $trackedManifestFull = [IO.Path]::GetFullPath($trackedManifest)
    if ($SourceManifestPath.Equals($trackedManifestFull, [StringComparison]::OrdinalIgnoreCase)) {
      Fail "refusing to overwrite the tracked source manifest implicitly; stage the change out-of-tree and update patches\ableton-link-source deliberately"
    }
    $patchedRef = Join-Path $ProjectRoot ($script:PatchesRel + "\binding.gyp.patched")
    Write-SourceManifestImpl -ProjectRoot $ProjectRoot -SourceDir $SourcePackageDir `
      -OutputPath $SourceManifestPath -PatchedReferencePath $patchedRef | Out-Null
    if ($OutputManifestPath -ine $SourceManifestPath) {
      Copy-Item -LiteralPath $SourceManifestPath -Destination $OutputManifestPath -Force
    }
    exit 0
  }

  # ---- Authoring mode: dump toolchain JSON only ----
  if (-not [string]::IsNullOrEmpty($WriteToolchainJson)) {
    $tempDirForDump = Join-Path $repoRootDetected ($script:DefaultStagingRel + "\.tmp")
    $toolchain = Resolve-Toolchain -ProjectRoot $ProjectRoot -NodeExeOverride $NodeExe -TempDir $tempDirForDump
    $sanitized = New-SanitizedEnvironment `
      -ExtraPathEntries @($toolchain.MsvcHostBin, ([IO.Path]::GetDirectoryName($toolchain.NodeExe)), ([IO.Path]::GetDirectoryName($toolchain.PythonExe))) `
      -TempDir $tempDirForDump -PinnedLinkExe $toolchain.LinkExe
    $resolvedLink = Assert-SanitizedLinkResolution -Sanitized $sanitized -PinnedLinkExe $toolchain.LinkExe
    $dump = [ordered]@{
      nodeExe                = $toolchain.NodeExe
      nodeVersion            = $toolchain.NodeVersion
      nodeArch               = $toolchain.NodeArch
      napiLevel              = $toolchain.NapiLevel
      nodeGypJs              = $toolchain.NodeGypJs
      nodeGypVersion         = $toolchain.NodeGypVersion
      pythonExe              = $toolchain.PythonExe
      vsRoot                 = $toolchain.VsRoot
      msvcRoot               = $toolchain.MsvcRoot
      msvcToolsVersion       = $script:MsvcToolsVersionPin
      clExe                  = $toolchain.ClExe
      clFileVersion          = $toolchain.ClFileVer
      linkExe                = $toolchain.LinkExe
      linkFileVersion        = $toolchain.LinkFileVer
      msbuildExe             = $toolchain.MsbuildExe
      headersCachePresent    = (Test-Path -LiteralPath (Join-Path $toolchain.HeadersCache "include\node\common.gypi") -PathType Leaf)
      headersVerifiedFileCount = $toolchain.HeadersFileCount
      nodeLibSha256          = $toolchain.NodeLibSha256
      sanitizedPath          = $sanitized.PathEntries
      sanitizedResolvedLink  = $resolvedLink
      callerPathThreats      = $sanitized.CallerPathThreats
    }
    $json = ($dump | ConvertTo-Json -Depth 4) + "`n"
    [IO.File]::WriteAllText($WriteToolchainJson, $json, (New-Object System.Text.UTF8Encoding($false)))
    Info ("toolchain JSON written: " + [IO.Path]::GetFileName($WriteToolchainJson))
    exit 0
  }

  # ---- License acknowledgment gate ----
  if ([string]::IsNullOrWhiteSpace($LinkLicenseMode)) {
    Fail ("missing -LinkLicenseMode acknowledgment; Ableton Link core is GPL-2.0-or-later OR proprietary; pass -LinkLicenseMode " + $script:LicenseAllowed)
  }
  if (-not $LinkLicenseMode.Equals($script:LicenseAllowed, [StringComparison]::OrdinalIgnoreCase)) {
    Fail ("unsupported license mode '" + $LinkLicenseMode + "' ; only " + $script:LicenseAllowed + " build mode is implemented here")
  }
  Info ("license mode acknowledged: " + $script:LicenseAllowed + " (repository license unchanged; no distribution rights granted)")

  if ($SkipLoadProbe -and -not $FixtureMode) {
    Fail "-SkipLoadProbe requires -FixtureMode"
  }

  # ---- Promotion-only mode ----
  if ($PromoteOnly) {
    if ($ValidatePrerequisitesOnly) { Fail "-PromoteOnly and -ValidatePrerequisitesOnly are mutually exclusive" }
    if ([string]::IsNullOrWhiteSpace($StagedAddonPath)) { Fail "-PromoteOnly requires -StagedAddonPath" }
    if ([string]::IsNullOrWhiteSpace($DestinationAddonPath)) { Fail "-PromoteOnly requires -DestinationAddonPath" }
    $tempRoot = Join-Path $repoRootDetected ($script:DefaultStagingRel + "\.tmp")
    if (-not (Test-Path -LiteralPath $tempRoot -PathType Container)) {
      New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
    }
    $toolchain = Resolve-Toolchain -ProjectRoot $ProjectRoot -NodeExeOverride $NodeExe -TempDir $tempRoot
    Info ("node headers cache proven against the tracked manifest: files=" + $toolchain.HeadersFileCount + " node.lib matches the official SHASUMS256.txt pin")
    $sanitized = New-SanitizedEnvironment `
      -ExtraPathEntries @($toolchain.MsvcHostBin, ([IO.Path]::GetDirectoryName($toolchain.NodeExe)), ([IO.Path]::GetDirectoryName($toolchain.PythonExe))) `
      -TempDir $tempRoot -PinnedLinkExe $toolchain.LinkExe
    if (-not $FixtureMode) {
      $destFull = [IO.Path]::GetFullPath($DestinationAddonPath)
      $prodPrefix = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "node_modules"))
      if (-not $destFull.StartsWith($prodPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        Fail "non-fixture promotion destination must stay inside the project node_modules tree"
      }
    } else {
      $destFull = [IO.Path]::GetFullPath($DestinationAddonPath)
      $prodPrefix = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "node_modules"))
      if ($destFull.StartsWith($prodPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        Fail "fixture promotion must not touch the production node_modules tree"
      }
    }
    $probeEnv = $sanitized.Env
    $result = Invoke-Promotion -StagedAddonPath $StagedAddonPath -DestinationAddonPath $DestinationAddonPath `
      -NodeExe $toolchain.NodeExe -ProbeEnv $probeEnv -ProbeWorkDir $tempRoot -ProbeTimeoutMs $ProbeTimeoutMs `
      -ProbeFile (Join-Path $tempRoot "load-probe-promote.cjs") -DoLoadProbe:(-not $SkipLoadProbe) -Fixture:$FixtureMode `
      -RequireHostImport:(-not $FixtureMode)
    Info ("promotion complete sha256=" + $result.Sha256 + " size=" + $result.Size)
    exit 0
  }

  # ---- Full / prerequisites-only flow ----
  if ([string]::IsNullOrWhiteSpace($SourceManifestPath)) {
    $SourceManifestPath = Join-Path $ProjectRoot ($script:PatchesRel + "\source-manifest.json")
  }
  if ([string]::IsNullOrWhiteSpace($SourcePackageDir)) {
    $SourcePackageDir = Join-Path $ProjectRoot $script:DefaultSourceRel
  }
  if ([string]::IsNullOrWhiteSpace($StagingRoot)) {
    $StagingRoot = Join-Path $ProjectRoot $script:DefaultStagingRel
  }
  $StagingRoot = [IO.Path]::GetFullPath($StagingRoot)
  $stagingAllowedPrefix = [IO.Path]::GetFullPath((Join-Path $ProjectRoot "node_modules\.cache\"))
  if (-not $StagingRoot.StartsWith($stagingAllowedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "staging root must live inside the git-ignored node_modules cache of the project"
  }
  if ($StagingRoot -match '(?i)\btemp\b') { Fail "staging root must not live under TEMP" }
  # Fail fast on a poisoned staging location before any expensive stage runs.
  if (Test-Path -LiteralPath $StagingRoot) {
    Assert-NoReparsePathChain -Path $StagingRoot -Label "staging root"
  }

  $manifest = Read-SourceManifest -Path $SourceManifestPath
  $patchedReference = Join-Path $ProjectRoot ($script:PatchesRel + "\binding.gyp.patched")

  Info "deriving trusted toolchain..."
  $tempRoot = Join-Path $StagingRoot ".tmp"
  if (-not (Test-Path -LiteralPath $tempRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  }
  $toolchain = Resolve-Toolchain -ProjectRoot $ProjectRoot -NodeExeOverride $NodeExe -TempDir $tempRoot
  Info ("node headers cache proven against the tracked manifest: files=" + $toolchain.HeadersFileCount + " node.lib matches the official SHASUMS256.txt pin")

  $extraPath = @($toolchain.MsvcHostBin, ([IO.Path]::GetDirectoryName($toolchain.NodeExe)), ([IO.Path]::GetDirectoryName($toolchain.PythonExe)))
  $sanitized = New-SanitizedEnvironment -ExtraPathEntries $extraPath -TempDir $tempRoot -PinnedLinkExe $toolchain.LinkExe
  $resolvedLink = Assert-SanitizedLinkResolution -Sanitized $sanitized -PinnedLinkExe $toolchain.LinkExe
  Info ("sanitized PATH proof: link resolves to pinned MSVC linker (leaf check passed, entries=" + $sanitized.PathEntries.Count + ")")

  # Lock integrity (parsed through node to avoid PS5.1 JSON edge cases)
  $lockPath = Join-Path $ProjectRoot "package-lock.json"
  if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) { Fail "package-lock.json is missing" }
  $lockPathJs = $lockPath.Replace("\", "/").Replace("'", "")
  $lockScript = "const l=require('" + $lockPathJs + "');const p=l.packages['node_modules/@ktamas77/abletonlink'];if(!p){process.exit(3)};process.stdout.write(JSON.stringify({v:p.version,i:p.integrity}))"
  $lockResult = Start-TrustedProcess -FilePath $toolchain.NodeExe -ArgumentList @("-e", $lockScript) `
    -Environment $sanitized.Env -WorkingDirectory $ProjectRoot -TimeoutMs 20000
  if ($lockResult.ExitCode -eq 3) { Fail "lockfile has no @ktamas77/abletonlink entry" }
  if ($lockResult.ExitCode -ne 0) {
    Fail ("lockfile could not be parsed (exit " + $lockResult.ExitCode + "): " + (($lockResult.StdErr.Trim() -split "\r?\n" | Where-Object { $_ -match "Error|Cannot" } | Select-Object -First 1)))
  }
  $lockInfo = $lockResult.StdOut.Trim() | ConvertFrom-Json
  if ($lockInfo.v -ne $script:PackageVersion) { Fail ("lockfile version drift: expected " + $script:PackageVersion) }
  if ($lockInfo.i -cne $script:PackageIntegrity) { Fail "lockfile integrity drift against the pinned proven integrity" }
  Info ("lockfile verified: version=" + $lockInfo.v + " integrity matches pin")

  # Source verification
  Assert-NoReparsePathChain -Path $SourcePackageDir -Label "installed source package"

  Info "verifying reviewed source manifest against the installed tree..."
  foreach ($f in $manifest.files) {
    $full = Join-Path $SourcePackageDir ($f.path -replace "/", "\")
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
      Fail ("source drift: reviewed file missing (leaf=" + [IO.Path]::GetFileName($full) + ")")
    }
    $actual = Get-FileSha256 -Path $full
    if (-not $actual.Equals([string]$f.sha256, [StringComparison]::OrdinalIgnoreCase)) {
      Fail ("source drift: reviewed file hash changed (leaf=" + [IO.Path]::GetFileName($full) + ")")
    }
  }
  foreach ($t in $manifest.trees) {
    $full = Join-Path $SourcePackageDir ($t.path -replace "/", "\")
    Test-TreeAgainstManifestEntry -RootDir $full -Entry $t | Out-Null
  }

  # Staging
  $reclaimed = 0
  if (Test-Path -LiteralPath $StagingRoot -PathType Container) {
    Assert-NoReparsePathChain -Path $StagingRoot -Label "existing staging root"
    $reclaimed = ((Get-ChildItem -LiteralPath $StagingRoot -Recurse -Force -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum)
    if ($null -eq $reclaimed) { $reclaimed = 0 }
    Remove-Item -LiteralPath $StagingRoot -Recurse -Force -ErrorAction Stop
    Info ("stale staging removed (regenerable build product), reclaimed bytes=" + $reclaimed)
  }
  New-Item -ItemType Directory -Path $StagingRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  Assert-NoReparsePathChain -Path $StagingRoot -Label "fresh staging root"

  $stagingSrc = Join-Path $StagingRoot "src-pkg"
  Info "copying reviewed compile surface into staging..."
  Copy-StagingFromManifest -SourceDir $SourcePackageDir -StagingSrc $stagingSrc -Manifest $manifest

  $patchedSha = Assert-PatchStagedBindingGyp -StagingSrc $stagingSrc -Manifest $manifest -PatchedReferencePath $patchedReference
  Info ("binding.gyp patched and verified post-patch sha256=" + $patchedSha)

  # Configure
  $nodeGypLog = Join-Path $tempRoot "node-gyp-configure.log"
  $configureArgs = @(
    $toolchain.NodeGypJs, "configure",
    "--arch=x64",
    "--msvs_version=2022",
    ("--python=" + $toolchain.PythonExe)
  )
  $cfg = Start-TrustedProcess -FilePath $toolchain.NodeExe -ArgumentList $configureArgs `
    -Environment $sanitized.Env -WorkingDirectory $stagingSrc -TimeoutMs 180000 `
    -StdOutFile $nodeGypLog -StdErrFile ($nodeGypLog + ".err")
  if ($cfg.ExitCode -ne 0) { Fail "node-gyp configure failed (see staging log)" }
  Info "node-gyp configure completed"

  Assert-GeneratedProject -StagingSrc $stagingSrc -ExpectedNodeLib $toolchain.ExpectedNodeLib
  Info "generated project inspection passed (linker inputs pinned, no /std override, no double-backslash anomalies)"

  $toolchainJsonPath = Join-Path $StagingRoot "toolchain.json"
  $toolchainDump = [ordered]@{
    nodeExe               = $toolchain.NodeExe
    nodeVersion           = $toolchain.NodeVersion
    nodeArch              = $toolchain.NodeArch
    napiLevel             = $toolchain.NapiLevel
    nodeGypVersion        = $toolchain.NodeGypVersion
    headersVerifiedFileCount = $toolchain.HeadersFileCount
    nodeLibSha256         = $toolchain.NodeLibSha256
    pythonExeLeaf         = [IO.Path]::GetFileName($toolchain.PythonExe)
    msvcToolsVersion      = $script:MsvcToolsVersionPin
    linkExeLeaf           = [IO.Path]::GetFileName($toolchain.LinkExe)
    msbuildPresent        = (Test-Path -LiteralPath $toolchain.MsbuildExe -PathType Leaf)
    sanitizedResolvedLink = $resolvedLink
    sanitizedPath         = @($sanitized.PathEntries)
    sanitizedPathCount    = $sanitized.PathEntries.Count
    callerPathThreats     = $sanitized.CallerPathThreats
    patchedBindingGypSha  = $patchedSha
    stagingRoot           = $StagingRoot
  }
  [IO.File]::WriteAllText($toolchainJsonPath, (($toolchainDump | ConvertTo-Json -Depth 4) + "`n"), (New-Object System.Text.UTF8Encoding($false)))

  if ($ValidatePrerequisitesOnly) {
    Info "prerequisites validated; stopping before compilation"
    exit 0
  }

  # Build
  Info "compiling with pinned MSVC toolset..."
  $buildOutLog = Join-Path $tempRoot "msbuild-out.log"
  $buildErrLog = Join-Path $tempRoot "msbuild-err.log"
  $msbuildArgs = @(
    "build\binding.sln",
    "/clp:Verbosity=minimal",
    "/nologo",
    "/nodeReuse:false",
    "/p:Configuration=Release;Platform=x64"
  )
  $build = Start-TrustedProcess -FilePath $toolchain.MsbuildExe -ArgumentList $msbuildArgs `
    -Environment $sanitized.Env -WorkingDirectory $stagingSrc -TimeoutMs 600000 `
    -StdOutFile $buildOutLog -StdErrFile $buildErrLog
  $combinedLog = ""
  foreach ($logFile in @($buildOutLog, $buildErrLog)) {
    if (Test-Path -LiteralPath $logFile -PathType Leaf) {
      $combinedLog += [IO.File]::ReadAllText($logFile) + "`n"
    }
  }
  if ($build.ExitCode -ne 0) { Fail "MSBuild failed (exit code " + $build.ExitCode + ")" }

  $warningRegex = '(?i)\bwarning\s+[A-Z]{1,6}\d{3,5}\b|:\s*warning\s'
  $warningMatches = [regex]::Matches($combinedLog, $warningRegex)
  if ($warningMatches.Count -gt 0) {
    $codes = @{}
    foreach ($wm in $warningMatches) {
      $codeMatch = [regex]::Match($wm.Value, '(?i)[A-Z]{1,6}\d{3,5}')
      if ($codeMatch.Success) {
        $k = $codeMatch.Value.ToUpperInvariant()
        if (-not $codes.ContainsKey($k)) { $codes[$k] = 0 }
        $codes[$k] = $codes[$k] + 1
      }
    }
    $parts = @()
    foreach ($k in $codes.Keys) { $parts += ($k + "=" + $codes[$k]) }
    Fail ("first-party warning ratchet violated; warnings present (" + ($parts -join ", ") + "); zero tolerance policy")
  }
  Info "build warnings: 0 (zero-tolerance ratchet satisfied)"

  # Validate built addon
  $stagedAddon = Join-Path $stagingSrc "build\Release\abletonlink.node"
  if (-not (Test-Path -LiteralPath $stagedAddon -PathType Leaf)) { Fail "built abletonlink.node is missing" }
  $pe = Read-PeImage -Path $stagedAddon -Label "built Ableton Link addon"
  Assert-PePolicy -Pe $pe -RequireHostImport:$true
  Info ("PE validation passed: machine=0x8664 PE32+ DLL regularImports=" + ($pe.RegularImports.Count) + " delayImports=" + (($pe.DelayImports | ForEach-Object { $_.ToLowerInvariant() }) -join ","))

  $probeResult = Invoke-LoadProbe -NodeExe $toolchain.NodeExe -AddonPath $stagedAddon -Env $sanitized.Env `
    -WorkDir $stagingSrc -TimeoutMs $ProbeTimeoutMs -ProbeFile (Join-Path $tempRoot "load-probe.cjs")
  Info ("functional probe passed: tempo=" + $probeResult.tempo + " peers=" + $probeResult.peers + " napi=" + $probeResult.napi)

  # Promote atomically
  $destination = Join-Path $ProjectRoot $script:DefaultDestRel
  $promo = Invoke-Promotion -StagedAddonPath $stagedAddon -DestinationAddonPath $destination `
    -NodeExe $toolchain.NodeExe -ProbeEnv $sanitized.Env -ProbeWorkDir $stagingSrc -ProbeTimeoutMs $ProbeTimeoutMs `
    -ProbeFile (Join-Path $tempRoot "load-probe-final.cjs") -DoLoadProbe:$true -Fixture:$false `
    -RequireHostImport:$true
  Info ("atomic promotion complete; old binary superseded (reclaimedBytes=" + $promo.ReclaimedOld + ")")

  $reportPath = Join-Path $StagingRoot "build-report.json"
  $report = [ordered]@{
    schema                = "rb-output.ableton-link.build-report/1"
    licenseMode           = $script:LicenseAllowed
    distributionNote      = "Ableton Link core remains dual-licensed (GPL-2.0-or-later or proprietary). No distribution authorization claimed."
    nodeVersion           = $toolchain.NodeVersion
    nodeArch              = $toolchain.NodeArch
    napiLevel             = $toolchain.NapiLevel
    nodeGypVersion        = $toolchain.NodeGypVersion
    msvcToolsVersion      = $script:MsvcToolsVersionPin
    warningCounts         = @{}
    pe                    = [ordered]@{
      machine        = "0x8664"
      format         = "PE32+ DLL"
      size           = $promo.Size
      sha256         = $promo.Sha256
      regularImports = $promo.PeRegularDeps
      delayImports   = $promo.PeDelayDeps
    }
    functionalProbe       = $probeResult
    previousBinarySha256  = $promo.PreviousSha
    reclaimedPreviousByte = $promo.ReclaimedOld
    stagingReclaimedByte  = $reclaimed
  }
  [IO.File]::WriteAllText($reportPath, (($report | ConvertTo-Json -Depth 6) + "`n"), (New-Object System.Text.UTF8Encoding($false)))

  Info ("OK sha256=" + $promo.Sha256 + " size=" + $promo.Size + " warnings=0")
  exit 0
}

if ($env:ALB_DOTSOURCE -ne "1") {
  try {
    Main
  } catch {
  $message = $_.Exception.Message
  if (-not $message.StartsWith("[ableton-link-build]")) {
    $message = "[ableton-link-build] " + $message
  }
  $origin = ""
  if ($null -ne $_.InvocationInfo -and $_.InvocationInfo.ScriptName -ieq $PSCommandPath) {
    $origin = " (at line " + $_.InvocationInfo.ScriptLineNumber + ")"
  }
  Write-Output ("ERROR: " + $message + $origin)
  exit 1
}
}
