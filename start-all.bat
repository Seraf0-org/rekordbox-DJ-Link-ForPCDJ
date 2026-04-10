@echo off
setlocal
cd /d "%~dp0"

echo [rb-output] starting...

if not exist "native\bin\rb_hook.dll" (
  echo [rb-output] rb_hook.dll not found. building...
  call npm run build:hook
  if errorlevel 1 (
    echo [rb-output] build failed.
    exit /b 1
  )
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo [rb-output] starting web server...
  start "rb-output-server" /min cmd /c "cd /d %~dp0 && node server\index.js"
  timeout /t 2 /nobreak >nul
) else (
  echo [rb-output] web server already running.
)

echo [rb-output] injecting hook...
python scripts\inject_hook.py
if errorlevel 1 (
  echo [rb-output] hook injection failed. ensure Rekordbox is running.
  exit /b 1
)

start "" "http://localhost:8787"
echo [rb-output] done.
exit /b 0
