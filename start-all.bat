@echo off
setlocal
cd /d "%~dp0"

echo [rb-output] starting...

if not exist ".venv\Scripts\python.exe" (
  echo.
  echo [ERROR] Python venv not found. Run the following first:
  echo   python -m venv .venv
  echo   .venv\Scripts\pip install -r python\requirements.txt
  echo.
  pause
  exit /b 1
)

if not exist "native\bin\rb_hook.dll" (
  echo [rb-output] rb_hook.dll not found. building...
  call npm run build:hook
  if errorlevel 1 (
    echo.
    echo [ERROR] DLL build failed. Is g++ installed and in PATH?
    echo.
    pause
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

start "" "http://localhost:8787"

echo [rb-output] injecting hook...
.venv\Scripts\python scripts\inject_hook.py
if errorlevel 1 (
  echo.
  echo [ERROR] Hook injection failed. Is Rekordbox 7.2.13 running?
  echo.
  pause
  exit /b 1
)

echo.
echo [rb-output] done.
pause
