@echo off
setlocal
cd /d "%~dp0"

echo [rb-output] SOURCE DEVELOPMENT launcher
echo [rb-output] Installed/live operation must use the DJLinkForPCDJ shortcut.
echo [rb-output] starting...

if not exist ".venv\Scripts\python.exe" (
  echo [rb-output] venv not found. creating...
  python -m venv .venv
  if errorlevel 1 (
    echo.
    echo [ERROR] Failed to create venv. Is Python 3.11+ installed?
    echo.
    pause
    exit /b 1
  )
  echo [rb-output] installing dependencies...
  .venv\Scripts\pip install -r python\requirements.txt
  if errorlevel 1 (
    echo.
    echo [ERROR] pip install failed.
    echo.
    pause
    exit /b 1
  )
)

echo [rb-output] rebuilding and verifying rb_hook.dll...
call npm run build:hook
if errorlevel 1 (
  echo.
  echo [ERROR] DLL build or provenance verification failed.
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo [rb-output] starting web server...
  start "rb-output-server" /min cmd /c "cd /d %~dp0 && node server\index.js"
  timeout /t 2 /nobreak >nul
) else (
  echo [rb-output] web server already running.
)

start "" "http://localhost:8787"

echo [rb-output] injecting hook...
.venv\Scripts\python scripts\inject_hook.py
if errorlevel 1 (
  echo.
  echo [ERROR] Hook injection failed.
  echo   - Is a supported Rekordbox version ^(7.2.13, 7.2.14, or 7.2.18^) running?
  echo   - Try running this script as Administrator
  echo   - Antivirus may be blocking DLL injection
  echo.
  pause
  exit /b 1
)

echo.
echo [rb-output] done.
pause
