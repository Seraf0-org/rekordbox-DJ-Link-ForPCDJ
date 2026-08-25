@echo off
setlocal
cd /d "%~dp0"

echo [rb-output] CONTROLLED SOURCE-ACCEPTANCE launcher
echo [rb-output] This is the 2026-08-30 DJ-PC source-acceptance exception only.
echo [rb-output] Do not substitute an installer or shortcut for this source path.
echo [rb-output] starting...

rem Clear any inherited environment variable with this name so cmd.exe exposes
rem its own trusted executable-directory pseudo-variable on the next line.
set "__APPDIR__="
set "_RB_PREFLIGHT_ONLY=0"
if "%1"=="" goto launcher_arguments_validated
if not "%~1"=="--preflight-only" (
  echo [ERROR] Unknown launcher argument. Use no arguments or exactly --preflight-only.
  exit /b 64
)
set "_RB_PREFLIGHT_ONLY=1"
shift
if not "%1"=="" (
  echo [ERROR] Unexpected launcher arguments. Use no arguments or exactly --preflight-only.
  exit /b 64
)

:launcher_arguments_validated

call :reject_retired_rekordbox_override
if errorlevel 1 (
  exit /b 1
)

call :validate_show_config
if errorlevel 1 (
  exit /b 1
)

if "%_RB_PREFLIGHT_ONLY%"=="1" (
  echo [rb-output] strict source preflight passed; no show-side process or build action was taken.
  exit /b 0
)

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

echo [rb-output] restarting the source server with the current environment...
.venv\Scripts\python scripts\restart_source_server.py
if errorlevel 1 (
  echo.
  echo [ERROR] Source server restart failed.
  echo         Port 8787 is only stopped automatically when it belongs to
  echo         this checkout's node server\index.js process.
  echo.
  pause
  exit /b 1
)

echo [rb-output] injecting hook...
.venv\Scripts\python scripts\inject_hook.py --launch-installed --wait-seconds 60
if errorlevel 1 (
  echo.
  echo [ERROR] Hook injection failed.
  echo   - Is a supported Rekordbox version ^(7.2.13, 7.2.14, or 7.2.18^) installed or running?
  echo   - Try running this script as Administrator
  echo   - Antivirus may be blocking DLL injection
  echo.
  pause
  exit /b 1
)

start "" "http://localhost:8787"

echo.
echo [rb-output] done.
pause
exit /b 0

:reject_retired_rekordbox_override
rem REKORDBOX_EXE_PATH is a retired launch override.  A configured value in any
rem scope is ambiguous, so the controlled source path refuses to launch.
if defined REKORDBOX_EXE_PATH (
  echo.
  echo [ERROR] REKORDBOX_EXE_PATH remains in Process scope.
  echo         Clear the retired override, open a new PowerShell, then rerun start-all.bat.
  echo.
  exit /b 1
)

"%__APPDIR__%WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "try{$checks=@(@([Microsoft.Win32.Registry]::CurrentUser,'Environment'),@([Microsoft.Win32.Registry]::LocalMachine,'SYSTEM\CurrentControlSet\Control\Session Manager\Environment'));foreach($entry in $checks){$key=$entry[0].OpenSubKey($entry[1],$false);if($null -eq $key){exit 2};try{foreach($name in $key.GetValueNames()){if([string]::Equals($name,'REKORDBOX_EXE_PATH',[StringComparison]::OrdinalIgnoreCase)){exit 1}}}finally{$key.Dispose()}};exit 0}catch{exit 2}" >nul 2>&1
set "_RB_REGISTRY_RESULT=%errorlevel%"
if "%_RB_REGISTRY_RESULT%"=="0" goto retired_registry_override_absent
if "%_RB_REGISTRY_RESULT%"=="1" (
  echo.
  echo [ERROR] REKORDBOX_EXE_PATH remains in User or Machine scope.
  echo         Clear the retired override, open a new PowerShell, then rerun start-all.bat.
  echo.
  exit /b 1
)
if not "%_RB_REGISTRY_RESULT%"=="0" (
  echo.
  echo [ERROR] User/Machine REKORDBOX_EXE_PATH state could not be verified conclusively.
  echo         The controlled source path will not continue on a missing key, access error,
  echo         registry API failure, or any result other than two readable absent values.
  echo.
  exit /b 1
)

:retired_registry_override_absent
exit /b 0

:validate_show_config
rem The show exception requires one explicit checkout-external JSON.  Validate
rem the non-secret readiness contract before creating a venv, building, starting
rem the server, launching Rekordbox, or injecting the hook.
if not defined DJ_AGENT_CONFIG_PATH (
  echo.
  echo [ERROR] DJ_AGENT_CONFIG_PATH is required for the controlled source path.
  echo         Set it to the checkout-external show JSON in this same PowerShell.
  echo.
  exit /b 1
)

node -e "const fs=require('node:fs'),path=require('node:path');try{const forbidden=new Set(['DJ_AGENT_CONFIG','DJ_AGENT_ENABLED','DJ_AGENT_ALLOW_REMOTE_ACTIONS','SYNDOCAL_ENABLED','SYNDOCAL_HOST','SYNDOCAL_PORT','SYNDOCAL_PATH','SYNDOCAL_NIC','SYNDOCAL_TOKEN','SYNDOCAL_WS_ADAPTER','SYNDOCAL_HEARTBEAT_MS','PEDAL_ENABLED','PEDAL_MODULE','MIDI_ENABLED','MIDI_MODULE','MIDI_DEVICE','MIDI_PORT','MIDI_RELEASE_FADE','MIDI_RELEASE_MACRO','MIDI_DECK_CHANNELS','PORT','RB_OUTPUT_HOST','RB_OUTPUT_SETUP_MAPPING_PATH']);if(Object.keys(process.env).some(k=>forbidden.has(k.toUpperCase())))process.exit(2);const raw=process.env.DJ_AGENT_CONFIG_PATH||'';if(!path.isAbsolute(raw))process.exit(3);const requested=path.resolve(raw),stat=fs.lstatSync(requested);if(!stat.isFile()||stat.isSymbolicLink())process.exit(4);const file=fs.realpathSync.native(requested),root=fs.realpathSync.native(process.cwd())+path.sep;if(file.toLowerCase().startsWith(root.toLowerCase()))process.exit(5);const {loadDjAgentConfig}=require('./server/dj-agent/config');const c=loadDjAgentConfig();const tokenBytes=Buffer.byteLength(c.syndocal.token||'','utf8');if(c.warning||!c.enabled||!c.syndocal.enabled||!c.pedal.enabled||!c.midi.enabled||c.syndocal.host!=='192.168.50.1'||c.syndocal.port!==9100||c.syndocal.path!=='/dj-link'||c.syndocal.nic!=='192.168.50.2'||c.syndocal.adapter!=='syndocal-envelope-v2'||tokenBytes<32||tokenBytes>256||c.midi.device!=='CustomMIDI1'||!Number.isInteger(c.midi.port)||c.midi.releaseMacro.enabled)process.exit(6);process.exit(0)}catch{process.exit(7)}"
if errorlevel 1 (
  echo.
  echo [ERROR] The checkout-external DJ Agent show config failed strict readiness validation.
  echo         Require enabled DJ/Syndocal/pedal/MIDI, exact adapter syndocal-envelope-v2,
  echo         192.168.50.1:9100/dj-link via NIC 192.168.50.2, a 32..256-byte token,
  echo         CustomMIDI1 name+port, releaseMacro.enabled=false, and no env overrides.
  echo         No config content is printed.
  echo.
  exit /b 1
)

exit /b 0
