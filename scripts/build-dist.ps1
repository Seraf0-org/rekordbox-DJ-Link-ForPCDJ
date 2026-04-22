param(
  [string]$ProjectRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

Set-Location $ProjectRoot

if (Test-Path "dist") {
  Remove-Item -Recurse -Force "dist"
}
New-Item -ItemType Directory "dist" | Out-Null

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  throw "Python venv not found. Run: python -m venv .venv && .venv\Scripts\pip install -r python\requirements.txt"
}

$pip = ".venv\Scripts\pip.exe"
$pyinstaller = ".venv\Scripts\pyinstaller.exe"

& $pip show pyinstaller 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Installing PyInstaller..."
  & $pip install pyinstaller
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller install failed" }
}

Write-Host "Building inject_hook.exe..."
& $pyinstaller `
  --onefile `
  --name inject_hook `
  --distpath dist `
  --workpath "dist\_build\inject_hook" `
  --specpath "dist\_build" `
  --collect-all psutil `
  scripts\inject_hook.py
if ($LASTEXITCODE -ne 0) { throw "inject_hook build failed" }

Write-Host "Building content_lookup.exe..."
& $pyinstaller `
  --onefile `
  --name content_lookup `
  --distpath dist `
  --workpath "dist\_build\content_lookup" `
  --specpath "dist\_build" `
  --collect-all pyrekordbox `
  python\content_lookup.py
if ($LASTEXITCODE -ne 0) { throw "content_lookup build failed" }

Write-Host "Building server.exe..."
& npx --yes @yao-pkg/pkg . --targets node18-win-x64 --output dist\server.exe
if ($LASTEXITCODE -ne 0) { throw "server.exe build failed" }

Write-Host "Copying assets..."
Copy-Item -Recurse server\public dist\public
New-Item -ItemType Directory "dist\native\bin" -Force | Out-Null
Copy-Item native\bin\rb_hook.dll dist\native\bin\
Copy-Item start-rb.bat dist\

$iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe"
if (-not (Test-Path $iscc)) {
  $iscc = "${env:ProgramFiles}\Inno Setup 6\ISCC.exe"
}
if (Test-Path $iscc) {
  Write-Host "Building installer..."
  & $iscc installer.iss
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup build failed" }
  Write-Host "Done: dist\rb-output-setup.exe"
} else {
  Write-Host "Inno Setup not found — skipping installer."
  Write-Host "Install from https://jrsoftware.org/isdl.php and re-run, or use the files in dist\ directly."
}
