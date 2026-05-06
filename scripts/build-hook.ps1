param(
  [string]$ProjectRoot = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

$thirdPartyRoot = Join-Path $ProjectRoot "native\third_party"
$minHookRoot = Join-Path $thirdPartyRoot "minhook"
$outDir = Join-Path $ProjectRoot "native\bin"
$dllOut = Join-Path $outDir "rb_hook.dll"

if (-not (Test-Path $outDir)) {
  New-Item -ItemType Directory -Path $outDir | Out-Null
}

if (-not (Test-Path $minHookRoot)) {
  New-Item -ItemType Directory -Path $thirdPartyRoot -Force | Out-Null
  git clone --depth 1 https://github.com/TsudaKageyu/minhook $minHookRoot
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

$cmd = @(
  "g++",
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

Write-Host "Building hook DLL..."
& $cmd[0] $cmd[1..($cmd.Length - 1)]
if ($LASTEXITCODE -ne 0) {
  throw "Hook DLL build failed"
}

Write-Host "Built: $dllOut"
