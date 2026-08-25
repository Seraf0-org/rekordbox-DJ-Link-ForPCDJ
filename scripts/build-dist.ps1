param(
  [string]$ProjectRoot = "",
  [switch]$ValidateAbletonLinkOnly,
  [string]$IsccPath = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = Join-Path $PSScriptRoot ".."
}
$ProjectRoot = [IO.Path]::GetFullPath($ProjectRoot)
$projectRootItem = Get-Item -LiteralPath $ProjectRoot -Force -ErrorAction Stop
if (($projectRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Project root is a symbolic link or junction (reparse points are not allowed): $($projectRootItem.FullName)"
}
if (-not $projectRootItem.PSIsContainer) {
  throw "Project root is not a directory: $ProjectRoot"
}
$ProjectRoot = $projectRootItem.FullName

Set-Location $ProjectRoot
. (Join-Path $PSScriptRoot "invoke-packaging-probe.ps1")

# Provenance order is fail-closed and explicit:
#   0. preflight (clean tree, full SHA, HEAD == ANNOTATED tag object, version triple) BEFORE anything is deleted
#   1. build PyInstaller payloads
#   2. generate canonical core identity + embedded commitment module into
#      server\embedded-commitment.js (gitignored; the literal require in
#      server\buildIdentity.js plus the pkg.scripts glob "server/**/*.js" both
#      guarantee it is compiled into server.exe)
#   3. package server.exe with the LOCAL PINNED pkg (commitment is compiled in)
#   4. bind measured exe hash into the sidecar (post-package)
#   5. stage install-manifest.json next to the finalized payloads
#   6. package ZIP (always) and installer (only with the pinned Inno Setup
#      6.7.3 compiler; a compiler that exists but fails any pin aborts)
#   7. finalize external dist\release-manifest.json binding artifact hashes

function Assert-NoReparseTree {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$Label is a symbolic link or junction (reparse points are not allowed): $($item.FullName)"
  }
  if ($item.PSIsContainer) {
    foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force -ErrorAction Stop) {
      Assert-NoReparseTree -Path $child.FullName -Label $Label
    }
  }
}

function Assert-NoReparsePathChain {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )

  try {
    $current = [IO.Path]::GetFullPath($Path)
  } catch {
    throw "$Label path is invalid"
  }
  while ($true) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) {
      throw "$Label is missing or inaccessible"
    }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label contains a symbolic link or junction"
    }
    $parentInfo = [IO.Directory]::GetParent($current)
    $parent = if ($null -eq $parentInfo) { "" } else { $parentInfo.FullName }
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent.Equals($current, [System.StringComparison]::OrdinalIgnoreCase)) {
      break
    }
    $current = $parent
  }
}

function Assert-AbletonLinkNativeAddon {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectRoot
  )

  $label = "Ableton Link native addon"
  $addonPath = Join-Path $ProjectRoot "node_modules\@ktamas77\abletonlink\build\Release\abletonlink.node"
  Assert-NoReparsePathChain -Path $addonPath -Label $label
  $addonItem = Get-Item -LiteralPath $addonPath -Force -ErrorAction SilentlyContinue
  if ($null -eq $addonItem -or $addonItem.PSIsContainer) {
    throw "$label is not a regular file"
  }
  if (($addonItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$label contains a symbolic link or junction"
  }

  try {
    $bytes = [IO.File]::ReadAllBytes($addonItem.FullName)
  } catch {
    throw "$label could not be read"
  }
  if ($bytes.Length -lt 0x100) {
    throw "$label is truncated"
  }
  if ($bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
    throw "$label is not a Windows PE image (missing MZ signature)"
  }

  $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
  if ($peOffset -lt 0 -or $peOffset -gt ($bytes.Length - 24)) {
    throw "$label has an invalid PE header offset"
  }
  if ($bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset + 1] -ne 0x45 -or $bytes[$peOffset + 2] -ne 0x00 -or $bytes[$peOffset + 3] -ne 0x00) {
    throw "$label is not a Windows PE image (missing PE signature)"
  }

  $machine = [BitConverter]::ToUInt16($bytes, $peOffset + 4)
  if ($machine -ne 0x8664) {
    throw "$label has unsupported machine 0x$('{0:X4}' -f $machine); expected Windows x64"
  }
  $optionalHeaderSize = [BitConverter]::ToUInt16($bytes, $peOffset + 20)
  $optionalHeaderOffset = $peOffset + 24
  if ($optionalHeaderSize -lt 72 -or $optionalHeaderOffset -gt ($bytes.Length - $optionalHeaderSize)) {
    throw "$label has an invalid optional PE header"
  }
  $optionalMagic = [BitConverter]::ToUInt16($bytes, $optionalHeaderOffset)
  if ($optionalMagic -ne 0x20B) {
    throw "$label is not a PE32+ image"
  }
  $coffCharacteristics = [BitConverter]::ToUInt16($bytes, $peOffset + 22)
  if (($coffCharacteristics -band 0x2000) -eq 0) {
    throw "$label is not marked as a DLL"
  }
  $dllCharacteristics = [BitConverter]::ToUInt16($bytes, $optionalHeaderOffset + 70)

  # Recheck the path after reading. A changed file or reparse point must not
  # be handed to pkg after the header was inspected.
  Assert-NoReparsePathChain -Path $addonPath -Label $label
  $afterRead = Get-Item -LiteralPath $addonPath -Force -ErrorAction SilentlyContinue
  if ($null -eq $afterRead -or $afterRead.PSIsContainer -or $afterRead.Length -ne $bytes.Length) {
    throw "$label changed during validation"
  }
  if (($afterRead.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "$label contains a symbolic link or junction"
  }

  # Keep native loader diagnostics out of release logs. Only the fixed result
  # is surfaced; stderr may contain absolute paths and is intentionally never
  # reflected in an error.
  $probeSource = 'require("@ktamas77/abletonlink"); process.stdout.write("loaded");'
  try {
    $probe = Invoke-NodePackagingProbeProcess `
      -ProjectRoot $ProjectRoot `
      -ProbeSource $probeSource `
      -TimeoutMs 15000
  } catch {
    throw "$label could not be loaded by the packaging Node runtime"
  }
  if ($probe.ExitCode -ne 0 -or $probe.Stdout -cne "loaded" -or -not [string]::IsNullOrEmpty($probe.Stderr)) {
    throw "$label could not be loaded by the packaging Node runtime"
  }

  Write-Host ("Ableton Link native addon validated: Windows x64 PE32+ DLL (DLL characteristics {0})" -f ('0x{0:X4}' -f $dllCharacteristics))
}

# Fail-closed, reproducible Inno Setup compiler selection.
#
# Provenance order:
#   1. explicit -IsccPath parameter,
#   2. RB_OUTPUT_ISCC_PATH environment variable,
#   3. the per-user install location derived from the OS
#      (LocalApplicationData\Programs\Inno Setup 6\ISCC.exe).
# ProgramFiles-style environment discovery is deliberately NOT supported:
# those variables are caller-spoofable process environment values, while
# LocalApplicationData comes from the operating system shell API.
#
# Pinning rules, all mandatory whenever a candidate exists:
#   - every component of the full path must exist without any reparse point in
#     the chain (symbolic links and junctions are rejected),
#   - the leaf must be exactly the file ISCC.exe; wrappers or renamed
#     launchers are rejected,
#   - SHA256 must equal the pinned value,
#   - Authenticode status must be Valid and the signer subject must identify
#     the expected publisher,
#   - ProductVersion/FileVersion must equal the pinned version whenever the
#     binary declares one. Blank, whitespace-only, and the exact trimmed
#     literal 0.0.0.0 count as UNDECLARED placeholders: genuine 6.7.3
#     ISCC.exe builds carry those zero strings instead of real versions
#     (confirmed live on the Authenticode-valid pinned install), so they are
#     not mismatches. Any other nonempty value must still match the pin
#     exactly; prefixes, suffixes, commas, and other zero-like values are
#     never normalized into a match.
#
# An explicit candidate that is missing or fails any pin aborts the release.
# A discovered candidate that exists but fails any pin also aborts the
# release; ONLY total absence of any compiler returns null, which leaves the
# installer out while the ZIP still ships (documented distribution policy).
function Resolve-PinnedInnoSetupCompiler {
  param(
    [Parameter(Mandatory = $true)][string]$RequiredVersion,
    [Parameter(Mandatory = $true)][string]$RequiredIsccSha256,
    [Parameter(Mandatory = $true)][string]$RequiredSignerSubjectFragment,
    [Parameter(Mandatory = $true)][string]$DiscoveredRelativePath,
    [Parameter(Mandatory = $true)][string]$DiscoveredBaseDirectory,
    [AllowEmptyString()][string]$ExplicitPath = "",
    # Seams for deterministic synthetic-fixture tests; production uses the
    # real cmdlets and never weakens the checks they perform.
    [scriptblock]$AuthenticodeReader = { param($LiteralPath) Get-AuthenticodeSignature -LiteralPath $LiteralPath },
    [scriptblock]$VersionInfoReader = { param($LiteralPath) (Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop).VersionInfo }
  )

  function Test-Candidate {
    param(
      [Parameter(Mandatory = $true)][string]$CandidatePath,
      [Parameter(Mandatory = $true)][string]$Origin
    )

    try {
      $fullPath = [IO.Path]::GetFullPath($CandidatePath)
    } catch {
      throw "$Origin Inno Setup compiler path is invalid"
    }

    # Walk every component from the leaf up to the root. Anything existing must
    # be free of reparse points; intermediate components must be directories.
    $chain = New-Object System.Collections.Generic.List[string]
    $current = $fullPath
    while ($true) {
      $chain.Add($current)
      $parentInfo = [IO.Directory]::GetParent($current)
      if ($null -eq $parentInfo) { break }
      $parentFullName = $parentInfo.FullName
      if ([string]::IsNullOrWhiteSpace($parentFullName) -or $parentFullName.Equals($current, [System.StringComparison]::OrdinalIgnoreCase)) { break }
      $current = $parentFullName
    }
    for ($index = $chain.Count - 1; $index -ge 0; $index--) {
      $item = Get-Item -LiteralPath $chain[$index] -Force -ErrorAction SilentlyContinue
      if ($null -eq $item) {
        # A gap anywhere along the chain means the candidate simply is not
        # installed there. Anything that DOES exist was already checked above
        # (walking root-first), so reparse points hiding under the gap are
        # still rejected before this branch is reached.
        if ($Origin -ceq "explicit") {
          throw "explicit Inno Setup compiler does not exist: $fullPath"
        }
        return $null
      }
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Origin Inno Setup compiler path contains a symbolic link or junction (reparse points are not allowed): $($item.FullName)"
      }
      if ($index -gt 0 -and -not $item.PSIsContainer) {
        throw "$Origin Inno Setup compiler path has a non-directory intermediate component: $($item.FullName)"
      }
    }

    $leafItem = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    if ($leafItem.PSIsContainer) {
      throw "$Origin Inno Setup compiler is a directory, not the ISCC.exe file: $fullPath"
    }
    if (-not $leafItem.Name.Equals("ISCC.exe", [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "$Origin Inno Setup compiler must be the exact file ISCC.exe; wrappers or renamed launchers are not allowed: $($leafItem.Name)"
    }

    $actualSha256 = (Get-FileHash -LiteralPath $leafItem.FullName -Algorithm SHA256 -ErrorAction Stop).Hash
    if (-not $actualSha256.Equals($RequiredIsccSha256.Trim(), [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "$Origin Inno Setup compiler sha256 mismatch for $($leafItem.FullName): expected $($RequiredIsccSha256.Trim()), got $actualSha256"
    }

    $signature = & $AuthenticodeReader -LiteralPath $leafItem.FullName
    if ($null -eq $signature) {
      throw "$Origin Inno Setup compiler Authenticode signature could not be read: $($leafItem.FullName)"
    }
    if ([string]$signature.Status -cne "Valid") {
      throw "$Origin Inno Setup compiler Authenticode status must be Valid, got '$($signature.Status)' for $($leafItem.FullName)"
    }
    $signerSubject = ""
    if ($null -ne $signature.SignerCertificate) {
      $signerSubject = [string]$signature.SignerCertificate.Subject
    }
    if ($signerSubject.IndexOf($RequiredSignerSubjectFragment, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
      throw "$Origin Inno Setup compiler signer subject must contain '$RequiredSignerSubjectFragment', got '$signerSubject'"
    }

    $declaredProductVersion = ""
    $declaredFileVersion = ""
    $versionInfo = & $VersionInfoReader -LiteralPath $leafItem.FullName
    if ($null -ne $versionInfo) {
      $declaredProductVersion = [string]$versionInfo.ProductVersion
      $declaredFileVersion = [string]$versionInfo.FileVersion
    }
    foreach ($declared in @(@("ProductVersion", $declaredProductVersion), @("FileVersion", $declaredFileVersion))) {
      $declaredValue = [string]$declared[1]
      # Fail-closed placeholder rule: only blank/whitespace or the exact
      # trimmed literal 0.0.0.0 is "undeclared". Everything else declared
      # must equal the pin exactly after trimming; no prefix/suffix/comma
      # normalization and no other zero-like value is accepted.
      $trimmedDeclaredValue = $declaredValue.Trim()
      if ((-not [string]::IsNullOrWhiteSpace($declaredValue)) -and ($trimmedDeclaredValue -cne "0.0.0.0") -and ($trimmedDeclaredValue -cne $RequiredVersion)) {
        throw "$Origin Inno Setup compiler $($declared[0]) must be exactly $RequiredVersion, got '$declaredValue'"
      }
    }

    # A placeholder product field carries no declared version and is surfaced
    # as empty evidence rather than the literal placeholder text.
    $productVersionDeclared = ""
    if ((-not [string]::IsNullOrWhiteSpace($declaredProductVersion)) -and ($declaredProductVersion.Trim() -cne "0.0.0.0")) {
      $productVersionDeclared = $declaredProductVersion.Trim()
    }

    return [pscustomobject]@{
      Path = $leafItem.FullName
      Origin = $Origin
      Sha256 = $actualSha256.ToLowerInvariant()
      SignerSubject = $signerSubject
      ProductVersionDeclared = $productVersionDeclared
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
    return Test-Candidate -CandidatePath $ExplicitPath -Origin "explicit"
  }
  $discoveredPath = Join-Path $DiscoveredBaseDirectory $DiscoveredRelativePath
  return Test-Candidate -CandidatePath $discoveredPath -Origin "discovered"
}

# Fail-closed bridge between the initial pinning decision and the actual
# ISCC.exe invocation. Production re-runs Resolve-PinnedInnoSetupCompiler
# immediately before Step 6 packaging and passes both results here: a null
# revalidation means the compiler that was pinned earlier vanished mid-build,
# which aborts instead of degrading into the documented absent-skip path, and
# every evidence field must still describe the exact same binary. The helper
# performs no filesystem, registry, network, or process operations; it is pure
# comparison, so the window between it and the invocation holds only
# assignments and logging.
function Assert-InnoCompilerRevalidated {
  param(
    [Parameter(Mandatory = $true)][psobject]$Resolved,
    [Parameter(Mandatory = $true)][AllowNull()][psobject]$Revalidated
  )
  if ($null -eq $Resolved) {
    throw "Pinned Inno Setup compiler stability check invoked without an initial resolution"
  }
  if ($null -eq $Revalidated) {
    throw ("Pinned Inno Setup compiler vanished between the initial resolution and packaging ({0}, {1}); refusing to invoke ISCC.exe" -f $Resolved.Path, $Resolved.Origin)
  }
  foreach ($fieldName in @("Path", "Origin", "Sha256", "SignerSubject", "ProductVersionDeclared")) {
    $initialValue = [string]$Resolved.PSObject.Properties[$fieldName].Value
    $againValue = [string]$Revalidated.PSObject.Properties[$fieldName].Value
    if (-not $initialValue.Equals($againValue, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw ("Pinned Inno Setup compiler {0} drifted between the initial resolution and packaging ('{1}' vs '{2}'); refusing to invoke ISCC.exe" -f $fieldName, $initialValue, $againValue)
    }
  }
}

if ($ValidateAbletonLinkOnly) {
  Assert-AbletonLinkNativeAddon -ProjectRoot $ProjectRoot
  exit 0
}

Write-Host "Step 0/7: release preflight..."
node scripts\preflight.js --project-root "$ProjectRoot"
if ($LASTEXITCODE -ne 0) { throw "Release preflight failed; nothing was built or deleted." }

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  throw "Python venv not found. Run: python -m venv .venv && .venv\Scripts\pip install -r python\requirements.txt"
}

$pip = ".venv\Scripts\pip.exe"
$pyinstaller = ".venv\Scripts\pyinstaller.exe"

# Toolchain identity is established before any output is removed or any payload
# is built. npm ci must provide the exact lockfile-pinned local pkg binary; no
# ephemeral npm install/no-save or npx resolution is permitted.
$pkgVersion = "6.22.0"
$pyinstallerRequiredVersion = "6.22.2"
$pyinstallerMatch = Select-String -Path "python\requirements.txt" -Pattern '^pyinstaller==(.+?)\s*$'
if ($pyinstallerMatch.Matches.Count -ne 1) {
  throw "python\\requirements.txt must declare exactly one pyinstaller==<version> pin"
}
$pyinstallerExpected = $pyinstallerMatch.Matches[0].Groups[1].Value
if ($pyinstallerExpected -cne $pyinstallerRequiredVersion) {
  throw "python\\requirements.txt pyinstaller pin must be exactly $pyinstallerRequiredVersion, got '$pyinstallerExpected'"
}
$packagingMetadata = Get-PackagingMetadata `
  -ProjectRoot $ProjectRoot `
  -PkgVersion $pkgVersion `
  -TimeoutMs 30000
$productVersion = $packagingMetadata.ProductVersion
$declaredPkg = $packagingMetadata.DeclaredPkg
$lockedPkgRoot = $packagingMetadata.LockedPkgRoot
$lockedPkgNode = $packagingMetadata.LockedPkgNode
$pkgBin = Join-Path $ProjectRoot "node_modules\.bin\pkg.cmd"
if (-not (Test-Path $pkgBin -PathType Leaf)) {
  throw "Local @yao-pkg/pkg is missing. Run npm ci; no npx or npm install --no-save fallback is allowed"
}
if (-not (Test-Path $pyinstaller -PathType Leaf)) {
  throw "pyinstaller not found in .venv; run $pip install -r python\\requirements.txt"
}
Write-Host "Validating Ableton Link native addon before packaging..."
Assert-AbletonLinkNativeAddon -ProjectRoot $ProjectRoot
Write-Host "Checking exact local packaging toolchain..."
& $pip check
if ($LASTEXITCODE -ne 0) { throw ".venv dependency check failed" }
$pkgActual = (& $pkgBin --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $pkgActual -cne $pkgVersion) {
  throw "Local pkg --version must be exactly $pkgVersion, got '$pkgActual'"
}
$pyinstallerVersion = (& $pyinstaller --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $pyinstallerVersion -cne $pyinstallerRequiredVersion) {
  throw "Local PyInstaller --version must be exactly $pyinstallerRequiredVersion, got '$pyinstallerVersion'"
}

# Inno Setup compiler pinning: the installer may only be built with an exact
# ISCC.exe build (see Resolve-PinnedInnoSetupCompiler for the full rules).
# Resolution happens BEFORE anything in dist is removed so an invalid or
# tampered compiler aborts before any artifact work.
$innoSetupRequiredVersion = "6.7.3"
$innoSetupIsccRequiredSha256 = "0A8757031B33777E4C9CBFFEE40F11A5062B36D25CBE144C1DB73B6102B80AD7"
$innoSetupRequiredSignerSubjectFragment = "Pyrsys B.V."
$innoSetupDiscoveredRelativePath = "Programs\Inno Setup 6\ISCC.exe"

$explicitIsccPath = $IsccPath
if ([string]::IsNullOrWhiteSpace($explicitIsccPath)) {
  $explicitIsccPath = $env:RB_OUTPUT_ISCC_PATH
}
$osLocalApplicationData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
if ([string]::IsNullOrWhiteSpace($osLocalApplicationData)) {
  throw "OS-derived LocalApplicationData is empty; cannot resolve the pinned Inno Setup compiler location"
}
$innoCompiler = Resolve-PinnedInnoSetupCompiler `
  -RequiredVersion $innoSetupRequiredVersion `
  -RequiredIsccSha256 $innoSetupIsccRequiredSha256 `
  -RequiredSignerSubjectFragment $innoSetupRequiredSignerSubjectFragment `
  -DiscoveredRelativePath $innoSetupDiscoveredRelativePath `
  -DiscoveredBaseDirectory $osLocalApplicationData `
  -ExplicitPath $explicitIsccPath
if ($null -ne $innoCompiler) {
  Write-Host ("Pinned Inno Setup {0} compiler resolved from the {1} location: {2}" -f $innoSetupRequiredVersion, $innoCompiler.Origin, $innoCompiler.Path)
} else {
  Write-Host "No Inno Setup 6.7.3 compiler found; installer will be skipped (ZIP still ships)"
}
# Build evidence: record the pinned Inno version (and compiler SHA when a
# compiler resolved) in build identity and release manifest tool entries.
$innoSetupToolVersion = "absent"
if ($null -ne $innoCompiler) {
  $innoSetupToolVersion = $innoSetupRequiredVersion
}
$innoIdentityArgs = @("--tool", "inno-setup=$innoSetupToolVersion")
if ($null -ne $innoCompiler) {
  $innoIdentityArgs += @("--tool", "inno-setup-iscc-sha256=$($innoCompiler.Sha256)")
}

# Only after provenance and exact toolchain checks pass may previous outputs be
# removed. Verify the entire deletion candidate has no reparse point before
# calling Remove-Item; dist\_build is preserved across builds.
if (Test-Path "dist") {
  Assert-NoReparseTree -Path (Join-Path $ProjectRoot "dist") -Label "dist cleanup boundary"
  Get-ChildItem -LiteralPath "dist" -Force | Where-Object { $_.Name -ne "_build" } | ForEach-Object {
    Assert-NoReparseTree -Path $_.FullName -Label "dist cleanup boundary"
    Remove-Item -LiteralPath $_.FullName -Recurse -Force
  }
}
New-Item -ItemType Directory -Force "dist" | Out-Null

Write-Host "Step 1/7: building PyInstaller payloads..."
& $pyinstaller `
  --onefile `
  --name inject_hook `
  --distpath dist `
  --workpath "dist\_build\inject_hook" `
  --specpath "dist\_build" `
  --collect-all psutil `
  scripts\inject_hook.py
if ($LASTEXITCODE -ne 0) { throw "inject_hook build failed" }

& $pyinstaller `
  --onefile `
  --name content_lookup `
  --distpath dist `
  --workpath "dist\_build\content_lookup" `
  --specpath "dist\_build" `
  --collect-all pyrekordbox `
  python\content_lookup.py
if ($LASTEXITCODE -ne 0) { throw "content_lookup build failed" }

Write-Host "Step 2/7: generating canonical core identity + embedded commitment module..."
node scripts\generate-build-identity.js --project-root "$ProjectRoot" --out "dist\build-identity.json" `
  --emit-module "server\embedded-commitment.js" `
  --tool "pkg=$pkgActual" `
  --tool "pyinstaller=$pyinstallerVersion" `
  @innoIdentityArgs
if ($LASTEXITCODE -ne 0) { throw "Build identity generation failed." }

Write-Host "Step 3/7: packaging server.exe (local pinned pkg@$pkgVersion)..."
& $pkgBin server/index.js --targets node22-win-x64 --output dist\server.exe
if ($LASTEXITCODE -ne 0) { throw "server.exe build failed" }

Write-Host "Copying assets..."
Copy-Item -Recurse server\public dist\public
New-Item -ItemType Directory "dist\native\bin" -Force | Out-Null
Copy-Item native\bin\rb_hook.dll dist\native\bin\
Copy-Item start-rb.bat dist\

Write-Host "Step 4/7: binding measured exe hash into the sidecar..."
node scripts\bind-executable.js --project-root "$ProjectRoot" --dist "dist" --exe "dist\server.exe"
if ($LASTEXITCODE -ne 0) { throw "Executable binding failed." }

Write-Host "Step 5/7: staging install-manifest.json..."
node scripts\write-install-manifest.js --project-root "$ProjectRoot" --dist "dist" `
  --payload "server.exe" `
  --payload "inject_hook.exe" `
  --payload "content_lookup.exe" `
  --payload "native/bin/rb_hook.dll" `
  --payload "public" `
  --payload "start-rb.bat" `
  --payload "build-identity.json"
if ($LASTEXITCODE -ne 0) { throw "Install manifest generation failed." }

$releaseArtifacts = @()

# The ZIP ships in every release so QA can verify without running an admin
# installer; its name pins the product version for deterministic references.
$zipPath = "dist\rb-output-$productVersion.zip"

Write-Host "Step 6/7: packaging artifacts..."
if ($null -ne $innoCompiler) {
  Write-Host "Building installer with pinned Inno Setup $innoSetupRequiredVersion compiler..."
  # TOCTOU revalidation: the compiler was pinned before dist was cleaned and
  # the payloads were built. Re-run the EXACT same resolver with the SAME
  # captured explicit input (never a fresh environment read) and the SAME
  # OS-derived discovery inputs immediately before the pinned binary is
  # invoked, then require identical evidence. A compiler that vanished or was
  # substituted after the initial pin aborts here instead of building the
  # installer from an unverified binary.
  $innoCompilerRevalidated = Resolve-PinnedInnoSetupCompiler `
    -RequiredVersion $innoSetupRequiredVersion `
    -RequiredIsccSha256 $innoSetupIsccRequiredSha256 `
    -RequiredSignerSubjectFragment $innoSetupRequiredSignerSubjectFragment `
    -DiscoveredRelativePath $innoSetupDiscoveredRelativePath `
    -DiscoveredBaseDirectory $osLocalApplicationData `
    -ExplicitPath $explicitIsccPath
  Assert-InnoCompilerRevalidated -Resolved $innoCompiler -Revalidated $innoCompilerRevalidated
  # Bind the invocation target and all later tool evidence to the revalidated values.
  $innoCompiler = $innoCompilerRevalidated
  Write-Host ("Pinned Inno Setup compiler revalidated before invocation: {0} ({1})" -f $innoCompiler.Path, $innoCompiler.Origin)
  $iscc = $innoCompiler.Path
  & $iscc installer.iss
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup build failed" }
  $setupExe = "dist\DJLinkForPCDJ-setup.exe"
  if (-not (Test-Path $setupExe)) { throw "Installer output missing: $setupExe" }
  $releaseArtifacts += $setupExe
  Write-Host "Done: $setupExe"
} else {
  Write-Host "Pinned Inno Setup compiler absent - skipping installer; the ZIP still ships (install Inno Setup 6.7.3 from https://jrsoftware.org/isdl.php or pass -IsccPath/RB_OUTPUT_ISCC_PATH pointing at an exact ISCC.exe)"
}
Compress-Archive -Path dist\server.exe, dist\inject_hook.exe, dist\content_lookup.exe, dist\native, dist\public, dist\start-rb.bat, dist\build-identity.json, dist\install-manifest.json -DestinationPath $zipPath -Force
if (-not (Test-Path $zipPath)) { throw "ZIP output missing: $zipPath" }
$releaseArtifacts += $zipPath
Write-Host "Done: $zipPath"

Write-Host "Step 7/7: finalizing external dist\release-manifest.json..."
$releaseArgs = @("scripts\write-release-manifest.js", "--project-root", "$ProjectRoot", "--install-manifest", "dist\install-manifest.json")
foreach ($artifact in $releaseArtifacts) {
  $releaseArgs += "--artifact"
  $releaseArgs += $artifact
  $releaseArgs += "--expect-artifact"
  $releaseArgs += $artifact
}
$releaseArgs += "--tool"
$releaseArgs += "inno-setup=$innoSetupToolVersion"
if ($null -ne $innoCompiler) {
  $releaseArgs += "--tool"
  $releaseArgs += "inno-setup-iscc-sha256=$($innoCompiler.Sha256)"
}
node @releaseArgs
if ($LASTEXITCODE -ne 0) { throw "Release manifest finalization failed." }

Write-Host "Provenance chain complete: embedded-commitment(in exe via server\embedded-commitment.js) -> dist\build-identity.json (sidecar + exeSha256) -> dist\install-manifest.json -> dist\release-manifest.json"
