@echo off
cd /d "%~dp0"
echo [DJLinkForPCDJ] starting server...
start /min "DJLinkForPCDJ Server" "%~dp0server.exe"
timeout /t 2 /nobreak >nul
start "" "http://localhost:8787"

echo [DJLinkForPCDJ] injecting hook (Rekordbox must be running)...
"%~dp0inject_hook.exe"

echo.
if errorlevel 1 (
  echo [ERROR] Hook injection failed. Is Rekordbox 7.2.13 running?
  echo         Antivirus software may also be blocking the injection.
) else (
  echo [OK] Done.
)
echo.
pause
