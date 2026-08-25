param(
  [string]$ProjectRoot = "",
  [string]$OutputPath = "",
  # Explicit, operator-provided additional compiler installation roots
  # (for example a pinned toolchain directory used by the packaging probe).
  # This never relaxes the per-executable checks: candidates must still be
  # exact native .exe files with no reparse-point ancestors. Caller PATH
  # entries are still rejected unless they live under a trusted root.
  [string[]]$AdditionalTrustedCompilerRoots = @()
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

$thirdPartyRoot = Join-Path $ProjectRoot "native\third_party"
$minHookRoot = Join-Path $thirdPartyRoot "minhook"
$finalMinHookRoot = $minHookRoot
$bootstrapRoot = Join-Path $thirdPartyRoot "minhook.bootstrap"
$bootstrapStatePath = Join-Path $thirdPartyRoot "minhook.bootstrap.state"
$minHookRepo = "https://github.com/TsudaKageyu/minhook"
# Reviewed upstream release tag v1.3.4, resolved to this immutable commit.
# Never replace this with a moving branch name or an unqualified HEAD fetch.
$minHookTag = "v1.3.4"
$minHookCommit = "c3fcafdc10146beb5919319d0683e44e3c30d537"
$bootstrapStateContent = @(
  "rb-output-minhook-bootstrap-v1",
  "repo=$minHookRepo",
  "tag=$minHookTag",
  "commit=$minHookCommit"
) -join "`n"
$outDir = Join-Path $ProjectRoot "native\bin"
$dllOut = if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  Join-Path $outDir "rb_hook.dll"
} elseif ([System.IO.Path]::IsPathRooted($OutputPath)) {
  [System.IO.Path]::GetFullPath($OutputPath)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot $OutputPath))
}
$dllOutDir = Split-Path -Parent $dllOut

if (-not (Test-Path $outDir)) {
  New-Item -ItemType Directory -Path $outDir | Out-Null
}
if (-not (Test-Path $dllOutDir)) {
  New-Item -ItemType Directory -Path $dllOutDir -Force | Out-Null
}

function Invoke-GitAt {
  param(
    [Parameter(Mandatory)] [string]$WorkingDirectory,
    [Parameter(Mandatory)] [string[]]$Arguments,
    # Exit-code-only contract for probes that must distinguish specific Git
    # states (such as an unborn HEAD) without ever parsing localized text.
    [switch]$TolerateExitFailure
  )

  $previousErrorActionPreference = $ErrorActionPreference
  $previousNoReplaceObjects = $env:GIT_NO_REPLACE_OBJECTS
  $gitEnvironmentNames = @(
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES_RELATIVE",
    "GIT_INDEX_FILE",
    "GIT_CEILING_DIRECTORIES",
    "GIT_DISCOVERY_ACROSS_FILESYSTEM",
    "GIT_CONFIG",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_EXEC_PATH",
    "GIT_TEMPLATE_DIR",
    "GIT_EXTERNAL_DIFF",
    "GIT_DIFF_OPTS",
    "GIT_PAGER",
    "GIT_EDITOR",
    "GIT_SEQUENCE_EDITOR",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "GIT_PROXY_COMMAND",
    "GIT_ASKPASS",
    "SSH_ASKPASS",
    "GIT_TERMINAL_PROMPT",
    "GIT_TRACE",
    "GIT_TRACE_PACKET",
    "GIT_TRACE_PACKFILE",
    "GIT_TRACE_SETUP",
    "GIT_TRACE_PERFORMANCE",
    "GIT_TRACE_CURL",
    "GIT_TRACE_CURL_NO_DATA",
    "GIT_TRACE_FSMONITOR",
    "GIT_TRACE2",
    "GIT_TRACE2_EVENT",
    "GIT_TRACE2_PERF",
    "GIT_CURL_VERBOSE",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_MESSAGES"
  )
  $gitEnvironmentNames += @(
    Get-ChildItem Env: -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "^GIT_CONFIG_(?:KEY|VALUE)_\d+$" } |
      Select-Object -ExpandProperty Name
  )
  $previousGitEnvironment = @{}
  foreach ($name in ($gitEnvironmentNames | Sort-Object -Unique)) {
    $previousGitEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
  }
  try {
    # Do not allow Git replace refs to substitute a different object behind a
    # clean-looking cache. This is scoped to every child Git invocation and is
    # restored immediately afterwards so the caller's environment is intact.
    $env:GIT_NO_REPLACE_OBJECTS = "1"
    # Git writes progress and trace output to stderr even on success, and any
    # inherited GIT_TRACE*/GIT_CURL_VERBOSE variable can add locale- and
    # path-bearing noise there. Stderr is discarded outright: the exit code is
    # the only failure signal, so no stderr line can ever pollute parsed
    # stdout or become a terminating PowerShell NativeCommandError.
    $ErrorActionPreference = "Continue"
    foreach ($name in ($gitEnvironmentNames | Sort-Object -Unique)) {
      Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
    }
    # Disable machine/user config and inherited config injection while keeping
    # the checkout's own origin available. NUL is the Windows empty config.
    $env:GIT_CONFIG_NOSYSTEM = "1"
    $env:GIT_CONFIG_SYSTEM = "NUL"
    $env:GIT_CONFIG_GLOBAL = "NUL"
    # Pin the child Git process to silent, locale-stable operation so exit
    # codes are the only signal this script ever has to interpret.
    $env:GIT_TRACE = "0"
    $env:GIT_TRACE_PACKET = "0"
    $env:GIT_TRACE_SETUP = "0"
    $env:GIT_TRACE_PERFORMANCE = "0"
    $env:GIT_TRACE2 = "0"
    $env:GIT_CURL_VERBOSE = "0"
    $env:GIT_TERMINAL_PROMPT = "0"
    $env:LC_ALL = "C"
    $env:LANG = "C"
    $env:LC_MESSAGES = "C"
    $gitArguments = @(
      "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=$gitHooksPath",
      "-c", "core.autocrlf=false",
      "-c", "advice.detachedHead=false"
    ) + $Arguments
    if ([string]::IsNullOrWhiteSpace($gitExecutable)) {
      throw "Trusted Git executable was not resolved before invocation"
    }
    $output = & $gitExecutable -C $WorkingDirectory @gitArguments 2>$null
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
    if ($null -eq $previousNoReplaceObjects) {
      Remove-Item Env:GIT_NO_REPLACE_OBJECTS -ErrorAction SilentlyContinue
    } else {
      $env:GIT_NO_REPLACE_OBJECTS = $previousNoReplaceObjects
    }
    foreach ($name in ($gitEnvironmentNames | Sort-Object -Unique)) {
      $value = $previousGitEnvironment[$name]
      if ($null -eq $value) {
        Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue
      } else {
        Set-Item -LiteralPath "Env:$name" -Value $value
      }
    }
  }
  if ($TolerateExitFailure) {
    return [pscustomobject]@{
      ExitCode = [int]$exitCode
      Lines = @($output)
    }
  }
  if ($exitCode -ne 0) {
    # Never echo child Git stderr: it carries locale-dependent text and local
    # filesystem paths. The exit code plus a safe subcommand verb is the whole
    # diagnostic contract.
    $verb = "$($Arguments[0])"
    if ($verb -notmatch "^[a-z][a-z0-9-]*$") {
      $verb = "operation"
    }
    throw "git $verb failed with exit code $exitCode (diagnostic output and paths suppressed)"
  }
  return @($output)
}

function Assert-NotReparsePoint {
  param(
    [Parameter(Mandatory)] [string]$Path,
    [Parameter(Mandatory)] [string]$Label
  )

  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) {
    return
  }
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label is a reparse point; refusing to trust it: $Path"
  }
}

function Assert-NoReparsePathChain {
  param(
    [Parameter(Mandatory)] [string]$Path,
    [Parameter(Mandatory)] [string]$Label
  )

  $current = [System.IO.Path]::GetFullPath($Path)
  while ($true) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) {
      throw "$Label path is missing: $current"
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label path contains a reparse point; refusing to trust it: $current"
    }
    $parent = [System.IO.Path]::GetDirectoryName($current)
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent.Equals($current, [System.StringComparison]::OrdinalIgnoreCase)) {
      break
    }
    $current = $parent
  }
}

function Assert-RegularFile {
  param(
    [Parameter(Mandatory)] [string]$Path,
    [Parameter(Mandatory)] [string]$Label
  )

  Assert-NotReparsePoint -Path $Path -Label $Label
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -eq $item -or $item.PSIsContainer) {
    throw "$Label must be a regular file: $Path"
  }
}

function Invoke-TrustedNativeExecutable {
  # Runs an already trust-validated native executable while suppressing the
  # Windows PowerShell 5.1 behavior that turns redirected native stderr into
  # a terminating error. Only a genuine nonzero exit code fails the build,
  # and diagnostics are trimmed and size-capped before being reported.
  param(
    [Parameter(Mandatory)] [string]$Label,
    [Parameter(Mandatory)] [string]$ExecutablePath,
    [string[]]$ArgumentList = @()
  )

  if ([string]::IsNullOrWhiteSpace($ExecutablePath) -or -not (Test-Path -LiteralPath $ExecutablePath)) {
    throw "$Label executable was not resolved to an existing file"
  }
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $merged = & $ExecutablePath @ArgumentList 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  $standardOutputLines = @()
  $standardErrorLines = @()
  foreach ($entry in @($merged)) {
    if ($null -eq $entry) {
      continue
    }
    if ($entry -is [System.Management.Automation.ErrorRecord]) {
      $standardErrorLines += $entry.ToString()
    } else {
      $standardOutputLines += $entry.ToString()
    }
  }
  if ($null -eq $exitCode -or $exitCode -ne 0) {
    $diagnostics = (@($standardOutputLines) + @($standardErrorLines) |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join [Environment]::NewLine
    $diagnostics = $diagnostics.Trim()
    if ($diagnostics.Length -gt 4000) {
      $diagnostics = $diagnostics.Substring(0, 4000) + " [truncated]"
    }
    throw "$Label failed with exit code $exitCode; sanitized diagnostics follow: $diagnostics"
  }
  return [pscustomobject]@{
    StdOut = @($standardOutputLines)
    StdErr = @($standardErrorLines)
  }
}

function Get-ValidatedAdditionalCompilerRoots {
  # Operator-supplied roots must pass the same exactness, reparse-ancestry,
  # and real-directory rules as the OS-derived trusted roots before any
  # compiler or tool path may be accepted beneath them.
  param(
    [Parameter(Mandatory)] [AllowEmptyCollection()] [AllowEmptyString()] [string[]]$Roots
  )

  $validated = @()
  foreach ($root in $Roots) {
    if ([string]::IsNullOrWhiteSpace($root)) {
      throw "Additional trusted compiler root is empty"
    }
    $trimmed = $root.Trim()
    if (-not [System.IO.Path]::IsPathRooted($trimmed)) {
      throw "Additional trusted compiler root is not rooted; refusing relative additional trusted compiler root: $trimmed"
    }
    $full = [System.IO.Path]::GetFullPath($trimmed)
    $driveRoot = [System.IO.Path]::GetPathRoot($full)
    if ([string]::IsNullOrWhiteSpace($driveRoot) -or
        $full.TrimEnd("\").Equals($driveRoot.TrimEnd("\"), [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Additional trusted compiler root covers an entire drive; refusing overly broad additional trusted compiler root: $full"
    }
    Assert-NoReparsePathChain -Path $full -Label "Additional trusted compiler root"
    $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
    if ($null -eq $item -or -not $item.PSIsContainer) {
      throw "Additional trusted compiler root must be a real directory: $full"
    }
    $validated += $full.TrimEnd("\")
  }
  return @($validated | Select-Object -Unique)
}

function Get-TrustedGitInstallationRoots {
  # Trusted Git for Windows roots are derived only from machine-scope trust
  # anchors: the installer's HKLM registration and shell known-folder
  # locations. Caller-controlled strings such as the machine and wow64
  # Program Files environment variables must never decide which git.exe
  # installation is trusted, so they are not consulted.
  $roots = @()
  foreach ($registryPath in @(
    "HKLM:\SOFTWARE\GitForWindows",
    "HKLM:\SOFTWARE\WOW6432Node\GitForWindows"
  )) {
    $registered = Get-ItemProperty -LiteralPath $registryPath -Name InstallPath -ErrorAction SilentlyContinue
    if ($null -ne $registered -and -not [string]::IsNullOrWhiteSpace($registered.InstallPath)) {
      $roots += $registered.InstallPath
    }
  }
  $programFilesKnownFolder = [Environment]::GetFolderPath("ProgramFiles")
  if (-not [string]::IsNullOrWhiteSpace($programFilesKnownFolder)) {
    $roots += (Join-Path $programFilesKnownFolder "Git")
  }
  $programFilesX86KnownFolder = [Environment]::GetFolderPath("ProgramFilesX86")
  if (-not [string]::IsNullOrWhiteSpace($programFilesX86KnownFolder)) {
    $roots += (Join-Path $programFilesX86KnownFolder "Git")
  }
  return @(
    $roots |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      ForEach-Object { [System.IO.Path]::GetFullPath($_).TrimEnd("\") } |
      Select-Object -Unique
  )
}

function Resolve-TrustedGitExecutable {
  $commands = @(Get-Command git -All -ErrorAction SilentlyContinue)
  if ($commands.Count -eq 0) {
    throw "Git is required to obtain the pinned MinHook source"
  }

  # PowerShell resolves the first command exactly as a caller would invoke
  # `git`. A PATH-prepended .cmd/.bat, function, alias, or other shim must not
  # be bypassed by searching for a later git.exe: reject it before any Git call.
  $resolved = $commands[0]
  if ($resolved.CommandType -ne "Application") {
    throw "Caller Git command is not a native git.exe; refusing aliases/shims: $($resolved.Name)"
  }
  $candidatePath = $resolved.Source
  if ([string]::IsNullOrWhiteSpace($candidatePath)) {
    $candidatePath = $resolved.Path
  }
  if ([string]::IsNullOrWhiteSpace($candidatePath)) {
    throw "Caller Git command has no executable path"
  }
  $candidatePath = [System.IO.Path]::GetFullPath($candidatePath)
  $candidateItem = Get-Item -LiteralPath $candidatePath -Force -ErrorAction SilentlyContinue
  if ($null -eq $candidateItem -or $candidateItem.PSIsContainer -or
      $candidateItem.Name -cne "git.exe" -or [System.IO.Path]::GetExtension($candidatePath) -ine ".exe") {
    throw "Caller Git command is not the expected regular git.exe: $candidatePath"
  }
  Assert-NoReparsePathChain -Path $candidatePath -Label "Trusted Git executable"

  # Only roots that were derived from machine-scope OS APIs and the registry
  # above may accept the candidate; no caller environment value participates.
  $trusted = $false
  foreach ($root in (Get-TrustedGitInstallationRoots)) {
    $rootPath = [System.IO.Path]::GetFullPath($root).TrimEnd("\") + "\"
    if ($candidatePath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
      $trusted = $true
      break
    }
  }
  if (-not $trusted) {
    throw "Git executable is outside the trusted Git for Windows installation roots: $candidatePath"
  }
  return $candidatePath
}

function Get-TrustedCompilerInstallationRoots {
  # Compiler provenance is anchored only to machine-scope locations derived
  # from OS APIs: fixed, administrator-created MSYS2 directory names on the
  # system drive reported by the OS loader. Caller-controlled environment
  # values are never used as installation roots.
  $systemDirectory = [Environment]::SystemDirectory
  if ([string]::IsNullOrWhiteSpace($systemDirectory)) {
    return @()
  }
  $systemDrive = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($systemDirectory))
  if ([string]::IsNullOrWhiteSpace($systemDrive)) {
    return @()
  }
  return @(
    (Join-Path $systemDrive "msys64"),
    (Join-Path $systemDrive "msys32")
  ) | ForEach-Object { [System.IO.Path]::GetFullPath($_).TrimEnd("\") } |
    Select-Object -Unique
}

function Assert-TrustedNativeCompilerExecutable {
  param(
    [Parameter(Mandatory)] [string]$CommandName,
    [Parameter(Mandatory)] [string]$ExecutableFileName,
    [Parameter(Mandatory)] [AllowEmptyCollection()] [string[]]$TrustedRoots
  )

  $commands = @(Get-Command $CommandName -All -ErrorAction SilentlyContinue)
  if ($commands.Count -eq 0) {
    return $null
  }
  # The first PATH resolution is exactly what an invocation would execute,
  # so it must already be the exact native executable. Aliases, functions,
  # and .cmd/.bat wrappers fail closed before anything runs.
  $resolved = $commands[0]
  if ($resolved.CommandType -ne "Application") {
    throw "Caller $CommandName command is not a native compiler executable; refusing aliases/shims: $($resolved.Name)"
  }
  $candidatePath = $resolved.Source
  if ([string]::IsNullOrWhiteSpace($candidatePath)) {
    $candidatePath = $resolved.Path
  }
  if ([string]::IsNullOrWhiteSpace($candidatePath)) {
    throw "Caller $CommandName command has no executable path"
  }
  $candidatePath = [System.IO.Path]::GetFullPath($candidatePath)
  $candidateItem = Get-Item -LiteralPath $candidatePath -Force -ErrorAction SilentlyContinue
  if ($null -eq $candidateItem -or $candidateItem.PSIsContainer -or
      $candidateItem.Name -cne $ExecutableFileName -or
      [System.IO.Path]::GetExtension($candidatePath) -ine ".exe") {
    throw "Caller $CommandName command is not the expected regular ${ExecutableFileName}: $candidatePath"
  }
  Assert-NoReparsePathChain -Path $candidatePath -Label "Trusted compiler executable"

  $trusted = $false
  foreach ($root in $TrustedRoots) {
    $rootPath = [System.IO.Path]::GetFullPath($root).TrimEnd("\") + "\"
    if ($candidatePath.StartsWith($rootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
      $trusted = $true
      break
    }
  }
  if (-not $trusted) {
    throw "$CommandName executable is outside the trusted compiler installation roots: $candidatePath"
  }
  return $candidatePath
}

function Assert-MinHookConfig {
  param([switch]$AllowMissingOrigin)

  $configPath = Join-Path $minHookRoot ".git\config"
  Assert-RegularFile -Path $configPath -Label "MinHook local Git config"
  $configText = [System.IO.File]::ReadAllText($configPath)
  $section = $null
  $seen = @{}
  $originUrl = $null
  $originSectionSeen = $false
  foreach ($rawLine in ($configText -split "`r?`n")) {
    $line = $rawLine.Trim()
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#") -or $line.StartsWith(";")) {
      continue
    }
    if ($line -match "^\[(?<section>[^\]]+)\]$") {
      $section = $matches.section.Trim().ToLowerInvariant()
      if ($section -notin @('core', 'remote "origin"', 'branch "master"')) {
        throw "unsafe local Git config section rejected: [$section]"
      }
      if ($section -eq 'remote "origin"') {
        $originSectionSeen = $true
      }
      continue
    }
    if ($null -eq $section -or $line -notmatch "^(?<key>[A-Za-z][A-Za-z0-9.-]*)\s*=\s*(?<value>.*)$") {
      throw "malformed local Git config entry rejected: $line"
    }
    $key = $matches.key.ToLowerInvariant()
    $value = $matches.value.Trim()
    $entryId = "$section::$key"
    if ($seen.ContainsKey($entryId)) {
      throw "duplicate local Git config entry rejected: $entryId"
    }
    $seen[$entryId] = $true

    if ($section -eq 'core') {
      $safeValues = @{
        repositoryformatversion = @('0')
        filemode = @('true', 'false')
        bare = @('false')
        logallrefupdates = @('true', 'false')
        ignorecase = @('true', 'false')
        symlinks = @('true', 'false')
        autocrlf = @('false')
      }
      if (-not $safeValues.ContainsKey($key) -or $safeValues[$key] -notcontains $value.ToLowerInvariant()) {
        throw "unsafe local Git config key rejected: core.$key"
      }
    } elseif ($section -eq 'remote "origin"') {
      if ($key -eq 'url') {
        if ($value -cne $minHookRepo) {
          throw "MinHook origin URL is not the exact reviewed URL: $value"
        }
        $originUrl = $value
      } elseif ($key -eq 'fetch' -and $value -match '^\+refs/heads/(?:master|\*):refs/remotes/origin/(?:master|\*)$') {
        continue
      } else {
        throw "unsafe local Git remote config key rejected: remote.origin.$key"
      }
    } elseif ($section -eq 'branch "master"') {
      if ($key -eq 'remote' -and $value -ceq 'origin') {
        continue
      }
      if ($key -eq 'merge' -and $value -ceq 'refs/heads/master') {
        continue
      }
      throw "unsafe local Git branch config key rejected: branch.master.$key"
    }
  }
  if (-not $AllowMissingOrigin -and $originUrl -cne $minHookRepo) {
    throw "MinHook local Git config has no exact reviewed origin URL"
  }
  return [pscustomobject]@{
    OriginUrl = $originUrl
    OriginSectionSeen = $originSectionSeen
  }
}

function Assert-MinHookLocalMetadata {
  param([Parameter(Mandatory)] [string]$GitMetadataPath)

  $metadataPaths = @(
    @{ Path = (Join-Path $GitMetadataPath "info\attributes"); Label = "MinHook info attributes"; RequiredAbsent = $true },
    @{ Path = (Join-Path $GitMetadataPath "info\grafts"); Label = "MinHook grafts"; RequiredAbsent = $true },
    @{ Path = (Join-Path $GitMetadataPath "info\sparse-checkout"); Label = "MinHook sparse-checkout metadata"; RequiredAbsent = $true },
    @{ Path = (Join-Path $GitMetadataPath "objects\info\alternates"); Label = "MinHook alternates"; RequiredAbsent = $true },
    @{ Path = (Join-Path $GitMetadataPath "objects\info\http-alternates"); Label = "MinHook HTTP alternates"; RequiredAbsent = $true },
    @{ Path = (Join-Path $GitMetadataPath "config.worktree"); Label = "MinHook worktree config"; RequiredAbsent = $true },
    @{ Path = (Join-Path $GitMetadataPath "commondir"); Label = "MinHook common-dir metadata"; RequiredAbsent = $true },
    @{ Path = (Join-Path $GitMetadataPath "gitdir"); Label = "MinHook linked-worktree metadata"; RequiredAbsent = $true },
    @{ Path = (Join-Path $GitMetadataPath "worktrees"); Label = "MinHook linked worktrees"; RequiredAbsent = $true },
    @{ Path = (Join-Path $GitMetadataPath "refs\replace"); Label = "MinHook replace refs"; RequiredAbsent = $true }
  )
  foreach ($metadata in $metadataPaths) {
    $item = Get-Item -LiteralPath $metadata.Path -Force -ErrorAction SilentlyContinue
    if ($null -ne $item) {
      Assert-NotReparsePoint -Path $metadata.Path -Label $metadata.Label
      if ($metadata.RequiredAbsent) {
        throw "$($metadata.Label) is present; refusing local metadata injection: $($metadata.Path)"
      }
    }
  }

  $hooksPath = Join-Path $GitMetadataPath "hooks"
  if (Test-Path -LiteralPath $hooksPath) {
    Assert-NotReparsePoint -Path $hooksPath -Label "MinHook default hooks directory"
  }

  $excludePath = Join-Path $GitMetadataPath "info\exclude"
  if (Test-Path -LiteralPath $excludePath) {
    Assert-RegularFile -Path $excludePath -Label "MinHook info exclude"
    foreach ($rawLine in ([System.IO.File]::ReadAllText($excludePath) -split "`r?`n")) {
      $line = $rawLine.Trim()
      if (-not [string]::IsNullOrWhiteSpace($line) -and -not $line.StartsWith("#") -and -not $line.StartsWith(";")) {
        throw "non-default MinHook info exclude entry rejected: $line"
      }
    }
  }
}

function Assert-MinHookCheckout {
  Assert-NotReparsePoint -Path $minHookRoot -Label "MinHook checkout"
  $checkout = Get-Item -LiteralPath $minHookRoot -Force -ErrorAction SilentlyContinue
  if ($null -eq $checkout -or -not $checkout.PSIsContainer) {
    throw "MinHook checkout is missing or is not a directory: $minHookRoot"
  }

  $gitMetadataPath = Join-Path $minHookRoot ".git"
  Assert-NotReparsePoint -Path $gitMetadataPath -Label "MinHook git metadata"
  $gitMetadata = Get-Item -LiteralPath $gitMetadataPath -Force -ErrorAction SilentlyContinue
  if ($null -eq $gitMetadata -or -not $gitMetadata.PSIsContainer) {
    throw "MinHook checkout .git metadata must be a real directory: $gitMetadataPath"
  }

  Assert-MinHookConfig | Out-Null
  Assert-MinHookLocalMetadata -GitMetadataPath $gitMetadataPath

  $replaceRefs = @(Invoke-GitAt -WorkingDirectory $minHookRoot -Arguments @("replace", "-l")) |
    ForEach-Object { $_.ToString().Trim() } |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  if ($replaceRefs.Count -ne 0) {
    throw "MinHook checkout contains Git replace refs; refusing to trust it: $($replaceRefs -join '; ')"
  }

  $status = @(Invoke-GitAt -WorkingDirectory $minHookRoot -Arguments @("status", "--porcelain=1", "--untracked-files=all")) |
    ForEach-Object { $_.ToString() } |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  if ($status.Count -ne 0) {
    throw "MinHook checkout is dirty; refusing to overwrite local/cache contents: $($status.Count) changed or untracked entries (paths suppressed)"
  }
}

function Assert-MinHookBootstrapState {
  Assert-NoReparsePathChain -Path $bootstrapStatePath -Label "MinHook bootstrap state"
  Assert-RegularFile -Path $bootstrapStatePath -Label "MinHook bootstrap state"
  $state = [System.IO.File]::ReadAllText($bootstrapStatePath)
  if ($state -cne $bootstrapStateContent) {
    throw "MinHook bootstrap state is not the exact owned state; refusing recovery: $bootstrapStatePath"
  }
}

function Write-MinHookBootstrapState {
  if (Test-Path -LiteralPath $bootstrapStatePath) {
    Assert-MinHookBootstrapState
    return
  }
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($bootstrapStatePath, $bootstrapStateContent, $utf8NoBom)
  Assert-MinHookBootstrapState
}

function Assert-MinHookBootstrapRoot {
  Assert-NoReparsePathChain -Path $bootstrapRoot -Label "MinHook bootstrap directory"
  $bootstrapItem = Get-Item -LiteralPath $bootstrapRoot -Force -ErrorAction Stop
  if (-not $bootstrapItem.PSIsContainer) {
    throw "MinHook bootstrap path is not a directory: $bootstrapRoot"
  }
  foreach ($entry in @(Get-ChildItem -LiteralPath $bootstrapRoot -Force -ErrorAction Stop)) {
    if ($entry.Name -cne ".git") {
      throw "Unexpected MinHook bootstrap entry; refusing to delete or reuse it: $($entry.FullName)"
    }
    Assert-NotReparsePoint -Path $entry.FullName -Label "MinHook bootstrap Git metadata"
    if (-not $entry.PSIsContainer) {
      throw "MinHook bootstrap .git metadata is not a directory: $($entry.FullName)"
    }
  }
}

function Remove-MinHookBootstrapState {
  Assert-MinHookBootstrapState
  Remove-Item -LiteralPath $bootstrapStatePath -Force -ErrorAction Stop
}

function Remove-ExactDllOutput {
  if (-not (Test-Path -LiteralPath $dllOut)) {
    return
  }
  # The only deletable artifact is this one exact file, and its whole ancestry
  # must be reparse-free before removal is permitted.
  Assert-NoReparsePathChain -Path $dllOut -Label "Hook DLL output"
  $outputItem = Get-Item -LiteralPath $dllOut -Force -ErrorAction Stop
  if ($outputItem.PSIsContainer) {
    throw "Hook DLL output path is a directory; refusing to remove it: $dllOut"
  }
  Remove-Item -LiteralPath $dllOut -Force -ErrorAction Stop
}

function Get-MinHookHead {
  # Locale-independent HEAD resolution: decisions come only from Git exit
  # codes, never from localized stderr text. An unborn branch (rev-parse
  # fails, symbolic-ref succeeds) is the retryable interrupted-bootstrap
  # state; anything else is a fatal, unreadable repository.
  $verifyResult = Invoke-GitAt -WorkingDirectory $minHookRoot -TolerateExitFailure -Arguments @(
    "rev-parse", "--verify", "--quiet", "HEAD"
  )
  if ($verifyResult.ExitCode -ne 0) {
    $symbolicRefResult = Invoke-GitAt -WorkingDirectory $minHookRoot -TolerateExitFailure -Arguments @(
      "symbolic-ref", "--quiet", "HEAD"
    )
    if ($symbolicRefResult.ExitCode -eq 0) {
      throw "MinHook checkout has no resolvable HEAD"
    }
    throw "MinHook checkout HEAD is unreadable"
  }
  $commitLines = @($verifyResult.Lines)
  if ($commitLines.Count -eq 0) {
    throw "MinHook checkout has no resolvable HEAD"
  }
  $commit = $commitLines[$commitLines.Count - 1].ToString().Trim()
  $typeLines = @(Invoke-GitAt -WorkingDirectory $minHookRoot -Arguments @("cat-file", "-t", "HEAD"))
  if ($typeLines.Count -eq 0) {
    throw "MinHook checkout HEAD has no resolvable object type"
  }
  [pscustomobject]@{
    Commit = $commit
    ObjectType = $typeLines[$typeLines.Count - 1].ToString().Trim()
  }
}

function Assert-MinHookNoReparsePathChain {
  param([Parameter(Mandatory)] [string]$Path)

  $root = [System.IO.Path]::GetFullPath($minHookRoot).TrimEnd("\")
  $current = [System.IO.Path]::GetFullPath($Path)
  while ($true) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) {
      throw "MinHook worktree path is missing: $current"
    }
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "MinHook worktree reparse point rejected: $current"
    }
    if ($current.Equals($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      break
    }
    $parent = [System.IO.Path]::GetDirectoryName($current)
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent.Equals($current, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "MinHook worktree path escaped checkout root: $Path"
    }
    $current = $parent
  }
}

function Assert-MinHookTreeAndWorktree {
  param([Parameter(Mandatory)] [string]$Commit)

  $root = [System.IO.Path]::GetFullPath($minHookRoot).TrimEnd("\")
  $rootPrefix = "$root\"
  $gitMetadataPath = Join-Path $minHookRoot ".git"
  $treeLines = @(Invoke-GitAt -WorkingDirectory $minHookRoot -Arguments @(
    "ls-tree", "-r", "--full-tree", $Commit
  ))
  if ($treeLines.Count -eq 0) {
    throw "MinHook pinned commit has no tree entries: $Commit"
  }
  $expected = @{}
  $expectedModes = @{}
  foreach ($lineObject in $treeLines) {
    $line = $lineObject.ToString()
    $columns = $line -split "`t", 2
    if ($columns.Count -ne 2) {
      throw "Malformed MinHook tree entry: $line"
    }
    $header = $columns[0] -split "\s+", 3
    $path = $columns[1]
    if ($header.Count -ne 3 -or $header[0] -notmatch "^(100644|100755)$" -or $header[1] -cne "blob" -or $header[2] -notmatch "^[0-9a-f]{40}$") {
      throw "Unsupported MinHook tree entry mode/type: $line"
    }
    if ([string]::IsNullOrWhiteSpace($path) -or $path.Contains("\") -or $path.StartsWith("/") -or $path -match "(^|/)\.\.?($|/)") {
      throw "Unsafe MinHook tree path: $path"
    }
    $windowsRelative = $path.Replace("/", "\")
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $minHookRoot $windowsRelative))
    if (-not $candidate.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "MinHook tree path escaped checkout root: $path"
    }
    if ($expected.ContainsKey($path)) {
      throw "Duplicate MinHook tree path: $path"
    }
    $expected[$path] = $header[2]
    $expectedModes[$path] = $header[0]
  }

  $indexText = ((Invoke-GitAt -WorkingDirectory $minHookRoot -Arguments @("ls-files", "-v", "-z")) |
    ForEach-Object { $_.ToString() }) -join "`n"
  $indexRecords = @($indexText -split "`0" | Where-Object { -not [string]::IsNullOrEmpty($_) })
  $index = @{}
  foreach ($record in $indexRecords) {
    if ($record.Length -lt 3 -or $record[1] -cne " ") {
      throw "Malformed MinHook index entry"
    }
    if ($record[0] -cne "H") {
      throw "MinHook index assume-unchanged/skip-worktree flag rejected: $record"
    }
    $path = $record.Substring(2)
    if ($index.ContainsKey($path)) {
      throw "Duplicate MinHook index path: $path"
    }
    $index[$path] = $true
  }

  $stageText = ((Invoke-GitAt -WorkingDirectory $minHookRoot -Arguments @("ls-files", "--stage", "-z")) |
    ForEach-Object { $_.ToString() }) -join "`n"
  $stageRecords = @($stageText -split "`0" | Where-Object { -not [string]::IsNullOrEmpty($_) })
  $staged = @{}
  foreach ($record in $stageRecords) {
    $columns = $record -split "`t", 2
    if ($columns.Count -ne 2) {
      throw "Malformed MinHook staged index entry"
    }
    $stageHeader = $columns[0] -split "\s+", 3
    $path = $columns[1]
    if ($stageHeader.Count -ne 3 -or $stageHeader[0] -notmatch "^(100644|100755)$" -or $stageHeader[1] -notmatch "^[0-9a-f]{40}$" -or $stageHeader[2] -cne "0") {
      throw "MinHook staged index mode/blob/stage rejected: $record"
    }
    if ($staged.ContainsKey($path)) {
      throw "Duplicate MinHook staged index path: $path"
    }
    $staged[$path] = [pscustomobject]@{ Mode = $stageHeader[0]; Blob = $stageHeader[1] }
  }

  $actual = @{}
  $pending = New-Object 'System.Collections.Generic.Stack[object]'
  $pending.Push((Get-Item -LiteralPath $minHookRoot -Force -ErrorAction Stop))
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($item in @(Get-ChildItem -LiteralPath $directory.FullName -Force -ErrorAction Stop)) {
      $full = [System.IO.Path]::GetFullPath($item.FullName)
      if ($full.Equals([System.IO.Path]::GetFullPath($gitMetadataPath), [System.StringComparison]::OrdinalIgnoreCase)) {
        continue
      }
      if (-not $full.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "MinHook worktree path escaped checkout root: $full"
      }
      Assert-MinHookNoReparsePathChain -Path $full
      if ($item.PSIsContainer) {
        $pending.Push($item)
        continue
      }
      $relative = $full.Substring($rootPrefix.Length).Replace("\", "/")
      if ($actual.ContainsKey($relative)) {
        throw "Duplicate MinHook worktree path: $relative"
      }
      $actual[$relative] = $full
    }
  }

  foreach ($path in $expected.Keys) {
    if (-not $actual.ContainsKey($path)) {
      throw "MinHook pinned tree file is missing from worktree: $path"
    }
    $hashLines = @(Invoke-GitAt -WorkingDirectory $minHookRoot -Arguments @(
      "hash-object", "--no-filters", "--", $actual[$path]
    ))
    if ($hashLines.Count -eq 0 -or $hashLines[$hashLines.Count - 1].ToString().Trim() -cne $expected[$path]) {
      throw "MinHook raw worktree hash mismatch: $path"
    }
  }
  foreach ($path in $actual.Keys) {
    if (-not $expected.ContainsKey($path)) {
      throw "Unexpected MinHook worktree file: $path"
    }
  }
  foreach ($path in $expected.Keys) {
    if (-not $index.ContainsKey($path)) {
      throw "MinHook index file is missing pinned tree path: $path"
    }
    if (-not $staged.ContainsKey($path) -or $staged[$path].Mode -cne $expectedModes[$path] -or $staged[$path].Blob -cne $expected[$path]) {
      throw "MinHook staged index does not match pinned tree: $path"
    }
  }
  foreach ($path in $index.Keys) {
    if (-not $expected.ContainsKey($path)) {
      throw "Unexpected MinHook index path: $path"
    }
  }
  foreach ($path in $staged.Keys) {
    if (-not $expected.ContainsKey($path)) {
      throw "Unexpected MinHook staged index path: $path"
    }
  }
}

function Assert-MinHookRemoteTag {
  $tagRef = "refs/tags/$minHookTag"
  $peeledTagRef = "$tagRef^{}"
  $tagLines = @(Invoke-GitAt -WorkingDirectory $minHookRoot -Arguments @(
    "ls-remote", "--tags", $minHookRepo, $tagRef, $peeledTagRef
  ))
  $directSha = $null
  $peeledSha = $null
  foreach ($lineObject in $tagLines) {
    $line = $lineObject.ToString().Trim()
    if ([string]::IsNullOrWhiteSpace($line)) {
      continue
    }
    $parts = $line -split "\s+", 2
    if ($parts.Count -ne 2 -or $parts[0] -notmatch "^[0-9a-fA-F]{40}$") {
      throw "Unexpected MinHook tag lookup output: $line"
    }
    if ($parts[1] -eq $tagRef) {
      if ($null -ne $directSha) {
        throw "Duplicate MinHook tag ref in lookup output: $tagRef"
      }
      $directSha = $parts[0].ToLowerInvariant()
    } elseif ($parts[1] -eq $peeledTagRef) {
      if ($null -ne $peeledSha) {
        throw "Duplicate MinHook peeled tag ref in lookup output: $peeledTagRef"
      }
      $peeledSha = $parts[0].ToLowerInvariant()
    } else {
      throw "Unexpected MinHook tag ref in lookup output: $($parts[1])"
    }
  }

  $remoteTagCommit = $peeledSha
  if ($null -eq $remoteTagCommit) {
    $remoteTagCommit = $directSha
  }
  if ([string]::IsNullOrWhiteSpace($remoteTagCommit)) {
    throw "MinHook reviewed tag is missing remotely: $minHookTag"
  }
  if ($remoteTagCommit -cne $minHookCommit) {
    throw "MinHook tag $minHookTag resolves to $remoteTagCommit, expected $minHookCommit"
  }
}

# Operator-supplied roots are validated up front with exactly the rules an
# OS-derived trusted root must satisfy, before anything on disk or network is
# touched and before any compiler or tool path is accepted beneath them.
$validatedAdditionalCompilerRoots = @(Get-ValidatedAdditionalCompilerRoots -Roots $AdditionalTrustedCompilerRoots)

Assert-NotReparsePoint -Path $thirdPartyRoot -Label "native third-party cache"
if (-not (Test-Path -LiteralPath $thirdPartyRoot)) {
  New-Item -ItemType Directory -Path $thirdPartyRoot -Force | Out-Null
}

# Keep one deterministic, ignored, repository-local empty directory outside
# the MinHook checkout. Reusing it avoids leaving a new TEMP directory after
# every build while the real-directory and emptiness checks prevent a hostile
# hook from being accepted.
$gitHooksPath = Join-Path $thirdPartyRoot ".git-hooks-empty"
if (-not (Test-Path -LiteralPath $gitHooksPath)) {
  New-Item -ItemType Directory -Path $gitHooksPath -Force | Out-Null
}
Assert-NotReparsePoint -Path $gitHooksPath -Label "Git safety hooks directory"
$gitHooksItem = Get-Item -LiteralPath $gitHooksPath -Force -ErrorAction Stop
if (-not $gitHooksItem.PSIsContainer) {
  throw "Git safety hooks path is not a directory: $gitHooksPath"
}
$gitHookEntries = @(Get-ChildItem -LiteralPath $gitHooksPath -Force -ErrorAction Stop)
if ($gitHookEntries.Count -ne 0) {
  throw "Git safety hooks directory is not empty: $gitHooksPath"
}

$gitExecutable = Resolve-TrustedGitExecutable

$needsMinHookNetwork = $true
$bootstrapActive = $false
$minHookCheckout = Get-Item -LiteralPath $finalMinHookRoot -Force -ErrorAction SilentlyContinue
$bootstrapCheckout = Get-Item -LiteralPath $bootstrapRoot -Force -ErrorAction SilentlyContinue
$bootstrapStateExists = Test-Path -LiteralPath $bootstrapStatePath

if ($bootstrapStateExists) {
  Assert-MinHookBootstrapState
  if ($null -ne $minHookCheckout -and $null -ne $bootstrapCheckout) {
    throw "MinHook bootstrap destination and staging directory both exist; refusing ambiguous recovery"
  }
  if ($null -ne $minHookCheckout) {
    # A process may have been interrupted after the same-parent rename but
    # before the exact state file was removed. Verify the destination fully,
    # then remove only that owned marker.
    Assert-MinHookCheckout
    $completedHead = Get-MinHookHead
    if ($completedHead.ObjectType -cne "commit" -or $completedHead.Commit -cne $minHookCommit) {
      throw "Owned MinHook bootstrap state remains but destination is not the reviewed pin"
    }
    Assert-MinHookTreeAndWorktree -Commit $minHookCommit
    Remove-MinHookBootstrapState
    $bootstrapStateExists = $false
  } elseif ($null -eq $bootstrapCheckout) {
    throw "Owned MinHook bootstrap state has no staging directory; refusing recovery"
  }
} elseif ($null -ne $bootstrapCheckout) {
  throw "Unowned MinHook bootstrap staging directory exists; refusing to delete or reuse it: $bootstrapRoot"
}

if ($null -eq $minHookCheckout) {
  if (-not $bootstrapStateExists) {
    # Bootstrap is isolated in a same-parent staging directory. The marker is
    # written before Git is initialized so an interrupted, HEAD-less repo can
    # be retried without deleting arbitrary existing contents.
    New-Item -ItemType Directory -Path $bootstrapRoot -Force | Out-Null
    Assert-MinHookBootstrapRoot
    Write-MinHookBootstrapState
  } else {
    Assert-MinHookBootstrapRoot
  }
  $bootstrapActive = $true
  $minHookRoot = $bootstrapRoot
  Assert-MinHookBootstrapRoot

  $stageGit = Get-Item -LiteralPath (Join-Path $minHookRoot ".git") -Force -ErrorAction SilentlyContinue
  if ($null -eq $stageGit) {
    Invoke-GitAt -WorkingDirectory $minHookRoot -Arguments @("init", "--quiet") | Out-Null
  } else {
    Assert-NotReparsePoint -Path $stageGit.FullName -Label "MinHook bootstrap Git metadata"
    if (-not $stageGit.PSIsContainer) {
      throw "MinHook bootstrap .git metadata is not a directory: $($stageGit.FullName)"
    }
  }

  # Validate every existing local config entry before repairing only a missing
  # origin entry. This permits retry after an interrupted init/remote-add while
  # refusing malformed or hostile state.
  $bootstrapConfig = Assert-MinHookConfig -AllowMissingOrigin
  if ($null -eq $bootstrapConfig.OriginUrl) {
    if ($bootstrapConfig.OriginSectionSeen) {
      Invoke-GitAt -WorkingDirectory $minHookRoot -Arguments @(
        "config", "--local", "remote.origin.url", $minHookRepo
      ) | Out-Null
    } else {
      Invoke-GitAt -WorkingDirectory $minHookRoot -Arguments @(
        "remote", "add", "origin", $minHookRepo
      ) | Out-Null
    }
  }
} else {
  $minHookRoot = $finalMinHookRoot
  Assert-MinHookCheckout
  $cachedHead = Get-MinHookHead
  if ($cachedHead.ObjectType -cne "commit") {
    throw "MinHook cache HEAD is not a commit; refusing to refresh an untrusted checkout"
  }
  # A clean Git status is not enough: validate the exact old tree and raw
  # worktree before allowing a stale cache to be refreshed. This keeps an
  # assume-unchanged/skip-worktree or filter-smuggled modification fail-closed
  # instead of overwriting it during checkout.
  Assert-MinHookTreeAndWorktree -Commit $cachedHead.Commit
  if ($cachedHead.Commit -ceq $minHookCommit) {
    $needsMinHookNetwork = $false
    Write-Host "Using validated pinned MinHook cache offline: $minHookCommit"
  }
}

# The newly initialized or resumed cache must pass the same local-config and
# metadata checks before any remote operation is attempted. A bootstrap repo
# may still have an unborn HEAD; that state is handled below as retryable only
# while its exact owned marker is present.
Assert-MinHookCheckout
$cachedHead = $null
try {
  $cachedHead = Get-MinHookHead
} catch {
  if (-not $bootstrapActive -or $_.Exception.Message -notmatch "no resolvable HEAD") {
    throw
  }
}
if ($null -ne $cachedHead) {
  if ($cachedHead.ObjectType -cne "commit") {
    throw "MinHook cache HEAD is not a commit; refusing to refresh an untrusted checkout"
  }
  if (-not $bootstrapActive) {
    Assert-MinHookTreeAndWorktree -Commit $cachedHead.Commit
  }
  if ($cachedHead.Commit -ceq $minHookCommit) {
    $needsMinHookNetwork = $false
    Write-Host "Using validated pinned MinHook cache offline: $minHookCommit"
  }
}

# Only a missing, invalid, or stale cache needs network access. Before that
# first/update fetch, resolve the reviewed tag remotely and require its full
# SHA to match; never trust a moving branch or a local tag name by itself.
if ($needsMinHookNetwork) {
  Assert-MinHookRemoteTag
  Invoke-GitAt -WorkingDirectory $minHookRoot -Arguments @("fetch", "--depth", "1", "--no-tags", $minHookRepo, $minHookCommit) | Out-Null
  Invoke-GitAt -WorkingDirectory $minHookRoot -Arguments @("checkout", "--detach", "--force", $minHookCommit) | Out-Null
}
Assert-MinHookCheckout
$resolvedMinHook = Get-MinHookHead
$resolvedMinHookCommit = $resolvedMinHook.Commit
if ($resolvedMinHookCommit -cne $minHookCommit) {
  throw "MinHook identity mismatch: expected $minHookCommit ($minHookTag), got $resolvedMinHookCommit"
}
if ($resolvedMinHook.ObjectType -cne "commit") {
  throw "MinHook pin is not a commit object: $($resolvedMinHook.ObjectType)"
}
Assert-MinHookTreeAndWorktree -Commit $minHookCommit

if ($bootstrapActive) {
  if (Test-Path -LiteralPath $finalMinHookRoot) {
    throw "MinHook final cache appeared during bootstrap; refusing overwrite: $finalMinHookRoot"
  }
  # Both paths are siblings under the validated third_party directory. Rename
  # only the fully verified staging tree; no recursive delete is used.
  Move-Item -LiteralPath $bootstrapRoot -Destination $finalMinHookRoot -Force:$false
  $minHookRoot = $finalMinHookRoot
  Remove-MinHookBootstrapState
  Assert-MinHookCheckout
  $postRenameHead = Get-MinHookHead
  if ($postRenameHead.ObjectType -cne "commit" -or $postRenameHead.Commit -cne $minHookCommit) {
    throw "MinHook identity changed across bootstrap rename"
  }
  Assert-MinHookTreeAndWorktree -Commit $minHookCommit
}

$hookCpp = Join-Path $ProjectRoot "native\hookdll\hookdll.cpp"
$mhInclude = Join-Path $minHookRoot "include"
$mhSrc = Join-Path $minHookRoot "src"

$sources = @(
  $hookCpp,
  (Join-Path $mhSrc "buffer.c"),
  (Join-Path $mhSrc "hook.c"),
  (Join-Path $mhSrc "trampoline.c"),
  (Join-Path $mhSrc "hde\hde64.c")
)

Write-Host "Building hook DLL..."
$compilerInstallationRoots = @(Get-TrustedCompilerInstallationRoots) + $validatedAdditionalCompilerRoots
$gxxExecutable = Assert-TrustedNativeCompilerExecutable -CommandName "g++" -ExecutableFileName "g++.exe" -TrustedRoots $compilerInstallationRoots
if ($gxxExecutable) {
  $gxxArgs = @(
    "-std=gnu++17",
    "-O2",
    "-shared",
    "-s",
    "-static-libgcc",
    "-static-libstdc++",
    "-DWIN32_LEAN_AND_MEAN",
    "-I$mhInclude",
    "-I$mhSrc"
  ) + $sources + @(
    "-lws2_32",
    "-o",
    $dllOut
  )
  $gxxInvocation = Invoke-TrustedNativeExecutable -Label "g++" -ExecutablePath $gxxExecutable -ArgumentList $gxxArgs
  foreach ($line in (@($gxxInvocation.StdOut) + @($gxxInvocation.StdErr))) {
    if (-not [string]::IsNullOrWhiteSpace($line)) {
      Write-Host $line
    }
  }
} else {
  # Visual Studio tools are resolved only from machine-installed locations.
  # Caller PATH entries can never supply vswhere, cmd.exe, or cl.exe here.
  $programFilesX86KnownFolder = [Environment]::GetFolderPath("ProgramFilesX86")
  if ([string]::IsNullOrWhiteSpace($programFilesX86KnownFolder)) {
    throw "Neither g++ nor Visual Studio C++ Build Tools was found"
  }
  $vsWhere = Join-Path $programFilesX86KnownFolder "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path -LiteralPath $vsWhere)) {
    throw "Neither g++ nor Visual Studio C++ Build Tools was found"
  }
  Assert-RegularFile -Path $vsWhere -Label "vswhere"
  if ([System.IO.Path]::GetExtension($vsWhere) -ine ".exe") {
    throw "vswhere is not the expected executable file: $vsWhere"
  }
  Assert-NoReparsePathChain -Path $vsWhere -Label "vswhere"

  $vsInstallRaw = (Invoke-TrustedNativeExecutable -Label "vswhere" -ExecutablePath $vsWhere -ArgumentList @(
    "-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"
  )).StdOut | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace([string]$vsInstallRaw)) {
    throw "Visual Studio C++ Build Tools was not found"
  }
  $vsInstall = [System.IO.Path]::GetFullPath(([string]$vsInstallRaw).Trim())
  $vsInstallItem = Get-Item -LiteralPath $vsInstall -Force -ErrorAction SilentlyContinue
  if ($null -eq $vsInstallItem -or -not $vsInstallItem.PSIsContainer) {
    throw "Visual Studio installation path is not a real directory: $vsInstall"
  }
  Assert-NoReparsePathChain -Path $vsInstall -Label "Visual Studio installation"

  $vcVars = Join-Path $vsInstall "VC\Auxiliary\Build\vcvars64.bat"
  if (-not (Test-Path -LiteralPath $vcVars)) {
    throw "vcvars64.bat was not found: $vcVars"
  }
  Assert-RegularFile -Path $vcVars -Label "vcvars64"

  $clExecutable = $null
  $msvcToolsRoot = Join-Path $vsInstall "VC\Tools\MSVC"
  if (Test-Path -LiteralPath $msvcToolsRoot) {
    $msvcVersions = @(Get-ChildItem -LiteralPath $msvcToolsRoot -Directory -ErrorAction SilentlyContinue |
      Sort-Object -Property {
        $parsedVersion = $null
        [void][version]::TryParse($_.Name, [ref]$parsedVersion)
        if ($null -eq $parsedVersion) { [version]"0.0" } else { $parsedVersion }
      } -Descending)
    foreach ($msvcVersion in $msvcVersions) {
      $clCandidate = Join-Path $msvcVersion.FullName "bin\Hostx64\x64\cl.exe"
      if (Test-Path -LiteralPath $clCandidate) {
        Assert-RegularFile -Path $clCandidate -Label "cl"
        Assert-NoReparsePathChain -Path $clCandidate -Label "cl"
        $clExecutable = $clCandidate
        break
      }
    }
  }
  if ([string]::IsNullOrWhiteSpace($clExecutable)) {
    throw "Visual Studio C++ Build Tools were found but no Hostx64/x64 cl.exe was located: $vsInstall"
  }

  $commandComSpec = Join-Path ([Environment]::SystemDirectory) "cmd.exe"
  Assert-RegularFile -Path $commandComSpec -Label "cmd"
  $vcVarsCommand = 'call "' + $vcVars + '" >nul && set'
  $environmentLines = (Invoke-TrustedNativeExecutable -Label "Visual Studio build environment initialization" -ExecutablePath $commandComSpec -ArgumentList @(
    "/d", "/s", "/c", $vcVarsCommand
  )).StdOut
  foreach ($line in $environmentLines) {
    $separator = $line.IndexOf("=")
    if ($separator -gt 0) {
      $name = $line.Substring(0, $separator)
      $value = $line.Substring($separator + 1)
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }

  $objectDir = Join-Path $outDir "obj"
  if (-not (Test-Path $objectDir)) {
    New-Item -ItemType Directory -Path $objectDir | Out-Null
  }
  $importLibrary = Join-Path $outDir "rb_hook.lib"
  $clArgs = @(
    "/nologo",
    "/std:c++17",
    "/utf-8",
    "/O2",
    "/LD",
    "/EHsc",
    "/DWIN32_LEAN_AND_MEAN",
    "/I$mhInclude",
    "/I$mhSrc"
  ) + $sources + @(
    "/link",
    "/OUT:$dllOut",
    "/IMPLIB:$importLibrary",
    "ws2_32.lib"
  )
  Push-Location $objectDir
  try {
    # Immediately before cl.exe runs, prove that the exact MSVC link.exe
    # sitting beside the selected cl.exe is FIRST in linker resolution on the
    # effective build PATH. Otherwise a foreign linker such as Git
    # usr\bin\link.exe could be invoked instead of the pinned toolchain one.
    $clDirectory = [System.IO.Path]::GetDirectoryName($clExecutable)
    $expectedLinker = Join-Path $clDirectory "link.exe"
    Assert-RegularFile -Path $expectedLinker -Label "MSVC link"
    Assert-NoReparsePathChain -Path $expectedLinker -Label "MSVC link"
    $linkCommands = @(Get-Command link -All -ErrorAction SilentlyContinue)
    if ($linkCommands.Count -eq 0) {
      throw "No linker resolved on the effective build PATH; refusing to invoke cl.exe"
    }
    if ($linkCommands[0].CommandType -ne "Application") {
      throw "First resolved linker is not a native link.exe; refusing aliases/shims: $($linkCommands[0].Name)"
    }
    $firstLinkerPath = [System.IO.Path]::GetFullPath($linkCommands[0].Source)
    if (-not $firstLinkerPath.Equals([System.IO.Path]::GetFullPath($expectedLinker), [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "First linker on PATH is not the pinned MSVC link.exe beside cl.exe; refusing so Git usr\bin\link.exe can never win: $firstLinkerPath"
    }

    $clInvocation = Invoke-TrustedNativeExecutable -Label "cl" -ExecutablePath $clExecutable -ArgumentList $clArgs
    foreach ($line in (@($clInvocation.StdOut) + @($clInvocation.StdErr))) {
      if (-not [string]::IsNullOrWhiteSpace($line)) {
        Write-Host $line
      }
    }
  } finally {
    Pop-Location
  }
}

try {
  # Re-read config, object identity, tree modes/blob IDs, index flags, and raw
  # worktree hashes after the compiler returns. A source/config race during
  # compilation therefore cannot leave a DLL that was built from unverified
  # bytes; only the exact requested DLL output is removed on failure.
  Assert-MinHookCheckout
  $postCompileMinHook = Get-MinHookHead
  if ($postCompileMinHook.ObjectType -cne "commit" -or $postCompileMinHook.Commit -cne $minHookCommit) {
    throw "MinHook identity changed after compile"
  }
  Assert-MinHookTreeAndWorktree -Commit $minHookCommit
} catch {
  $postCompileError = $_.Exception.Message
  try {
    Remove-ExactDllOutput
  } catch {
    throw "MinHook post-compile verification failed ($postCompileError), and exact DLL cleanup failed: $($_.Exception.Message)"
  }
  throw "MinHook source/config changed or became unverifiable after compile; exact DLL output removed: $postCompileError"
}

Write-Host "Built: $dllOut"
