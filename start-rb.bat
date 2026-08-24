@echo off
cd /d "%~dp0"
echo [DJLinkForPCDJ] verifying installation...
"%~dp0server.exe" --verify-install
if errorlevel 1 (
  echo [ERROR] Installation verification failed. Provenance or payload files
  echo         are missing, tampered, or from a different release.
  echo         Reinstall DJLinkForPCDJ before starting.
  pause
  exit /b 1
)
echo [OK] Installation verified.
echo [DJLinkForPCDJ] starting server...
start /min "DJLinkForPCDJ Server" "%~dp0server.exe"
timeout /t 2 /nobreak >nul
start "" "http://localhost:8787"

echo [DJLinkForPCDJ] injecting hook (Rekordbox must be running)...
"%~dp0inject_hook.exe"

echo.
if errorlevel 1 (
  echo [ERROR] Hook injection failed. Is Rekordbox 7.2.13, 7.2.14, or 7.2.18 running?
  echo         Antivirus software may also be blocking the injection.
) else (
  echo [OK] Done.
)
echo.
pause
