param(
  [string]$ProjectRoot = ""
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
#   6. package ZIP (always) and installer (when Inno Setup exists)
#   7. finalize external dist\release-manifest.json binding artifact hashes

Write-Host "Step 0/7: release preflight..."
node scripts\preflight.js --project-root "$ProjectRoot"
if ($LASTEXITCODE -ne 0) { throw "Release preflight failed; nothing was built or deleted." }

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  throw "Python venv not found. Run: python -m venv .venv && .venv\Scripts\pip install -r python\requirements.txt"
}

$pip = ".venv\Scripts\pip.exe"
$pyinstaller = ".venv\Scripts\pyinstaller.exe"

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
$packageManifest = Get-Content -Raw package.json | ConvertFrom-Json
$packageLock = Get-Content -Raw package-lock.json | ConvertFrom-Json
$declaredPkg = $packageManifest.devDependencies.'@yao-pkg/pkg'
$lockedPkgRootEntry = $packageLock.packages.PSObject.Properties[''].Value
$lockedPkgNodeEntry = $packageLock.packages.PSObject.Properties['node_modules/@yao-pkg/pkg'].Value
$lockedPkgRoot = $lockedPkgRootEntry.devDependencies.'@yao-pkg/pkg'
$lockedPkgNode = $lockedPkgNodeEntry.version
if ($declaredPkg -cne $pkgVersion -or $lockedPkgRoot -cne $pkgVersion -or $lockedPkgNode -cne $pkgVersion) {
  throw "@yao-pkg/pkg must be exactly $pkgVersion in package.json and package-lock.json; run npm ci after restoring the tracked lockfile"
}
$pkgBin = Join-Path $ProjectRoot "node_modules\.bin\pkg.cmd"
if (-not (Test-Path $pkgBin -PathType Leaf)) {
  throw "Local @yao-pkg/pkg is missing. Run npm ci; no npx or npm install --no-save fallback is allowed"
}
if (-not (Test-Path $pyinstaller -PathType Leaf)) {
  throw "pyinstaller not found in .venv; run $pip install -r python\\requirements.txt"
}
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

$productVersion = (Get-Content -Raw package.json | ConvertFrom-Json).version

Write-Host "Step 2/7: generating canonical core identity + embedded commitment module..."
node scripts\generate-build-identity.js --project-root "$ProjectRoot" --out "dist\build-identity.json" `
  --emit-module "server\embedded-commitment.js" `
  --tool "pkg=$pkgActual" `
  --tool "pyinstaller=$pyinstallerVersion"
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

$iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $iscc)) {
  $iscc = "${env:ProgramFiles}\Inno Setup 6\ISCC.exe"
}
$releaseArtifacts = @()

# The ZIP ships in every release so QA can verify without running an admin
# installer; its name pins the product version for deterministic references.
$zipPath = "dist\rb-output-$productVersion.zip"

Write-Host "Step 6/7: packaging artifacts..."
if (Test-Path $iscc) {
  Write-Host "Building installer..."
  & $iscc installer.iss
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup build failed" }
  $setupExe = "dist\DJLinkForPCDJ-setup.exe"
  if (-not (Test-Path $setupExe)) { throw "Installer output missing: $setupExe" }
  $releaseArtifacts += $setupExe
  Write-Host "Done: $setupExe"
} else {
  Write-Host "Inno Setup not found - skipping installer (install Inno Setup 6 from https://jrsoftware.org/isdl.php)"
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
node @releaseArgs
if ($LASTEXITCODE -ne 0) { throw "Release manifest finalization failed." }

Write-Host "Provenance chain complete: embedded-commitment(in exe via server\embedded-commitment.js) -> dist\build-identity.json (sidecar + exeSha256) -> dist\install-manifest.json -> dist\release-manifest.json"
