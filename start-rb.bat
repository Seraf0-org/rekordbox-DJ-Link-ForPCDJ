@echo off
cd /d "%~dp0"
echo [rb-output] starting server...
start /min "rb-output Server" "%~dp0server.exe"
timeout /t 2 /nobreak >nul
start "" "http://localhost:8787"
echo [rb-output] injecting hook (Rekordbox must be running)...
"%~dp0inject_hook.exe"
