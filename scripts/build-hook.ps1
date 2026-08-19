param(
  [string]$ProjectRoot = "",
  [string]$OutputPath = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}

$thirdPartyRoot = Join-Path $ProjectRoot "native\third_party"
$minHookRoot = Join-Path $thirdPartyRoot "minhook"
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

Write-Host "Building hook DLL..."
$gxx = Get-Command "g++" -ErrorAction SilentlyContinue
if ($gxx) {
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
  & $gxx.Source $gxxArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Hook DLL build failed with g++"
  }
} else {
  $vsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vsWhere)) {
    throw "Neither g++ nor Visual Studio C++ Build Tools was found"
  }
  $vsInstall = (& $vsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
  if ([string]::IsNullOrWhiteSpace($vsInstall)) {
    throw "Visual Studio C++ Build Tools was not found"
  }
  $vcVars = Join-Path $vsInstall "VC\Auxiliary\Build\vcvars64.bat"
  if (-not (Test-Path $vcVars)) {
    throw "vcvars64.bat was not found: $vcVars"
  }

  $vcVarsCommand = 'call "' + $vcVars + '" >nul && set'
  $environmentLines = & $env:ComSpec /d /s /c $vcVarsCommand
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to initialize the Visual Studio build environment"
  }
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
    & cl.exe $clArgs
    if ($LASTEXITCODE -ne 0) {
      throw "Hook DLL build failed with Visual Studio C++ Build Tools"
    }
  } finally {
    Pop-Location
  }
}

Write-Host "Built: $dllOut"
