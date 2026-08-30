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
set "_RB_INIT_CONFIG=0"
set "_RB_UPGRADE_CONFIG=0"
set "_RB_REKORDBOX_LOCAL_TEST_PREFLIGHT=0"
set "_RB_REKORDBOX_LOCAL_TEST_INIT=0"
set "_RB_REKORDBOX_LOCAL_TEST_START=0"
if "%1"=="" goto launcher_arguments_validated
if "%~1"=="--preflight-only" (
  set "_RB_PREFLIGHT_ONLY=1"
  goto launcher_argument_accepted
)
if "%~1"=="--init-config" (
  set "_RB_INIT_CONFIG=1"
  goto launcher_argument_accepted
)
if "%~1"=="--upgrade-config" (
  set "_RB_UPGRADE_CONFIG=1"
  goto launcher_argument_accepted
)
if "%~1"=="--preflight-rekordbox-local-test" (
  set "_RB_REKORDBOX_LOCAL_TEST_PREFLIGHT=1"
  goto launcher_argument_accepted
)
if "%~1"=="--init-rekordbox-local-test" (
  set "_RB_REKORDBOX_LOCAL_TEST_INIT=1"
  goto launcher_argument_accepted
)
if "%~1"=="--rekordbox-local-test" (
  set "_RB_REKORDBOX_LOCAL_TEST_START=1"
  goto launcher_argument_accepted
)
echo [ERROR] Unknown launcher argument. Use no arguments, --preflight-only, --init-config, --upgrade-config, --preflight-rekordbox-local-test, --init-rekordbox-local-test, or --rekordbox-local-test.
exit /b 64

:launcher_argument_accepted
shift
if not "%1"=="" (
  echo [ERROR] Unexpected launcher arguments. Use one supported argument only; Rekordbox local test flags cannot be combined with production flags.
  exit /b 64
)

:launcher_arguments_validated

if "%_RB_UPGRADE_CONFIG%"=="1" goto upgrade_show_config
if "%_RB_INIT_CONFIG%"=="1" goto initialize_show_config
if "%_RB_REKORDBOX_LOCAL_TEST_INIT%"=="1" goto initialize_rekordbox_local_test
if "%_RB_REKORDBOX_LOCAL_TEST_PREFLIGHT%"=="1" goto preflight_rekordbox_local_test
if "%_RB_REKORDBOX_LOCAL_TEST_START%"=="1" goto start_rekordbox_local_test

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

:source_runtime_build
if "%_RB_REKORDBOX_LOCAL_TEST_START%"=="1" (
  echo [rb-output] REKORDBOX LOCAL TEST / NO SYNDOCAL
  echo [rb-output] full existing Hook/Rekordbox candidate, MIDI, pedal, and router flow is selected; Syndocal is not applicable.
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
if "%_RB_REKORDBOX_LOCAL_TEST_START%"=="1" (
  .venv\Scripts\python scripts\restart_source_server.py --rekordbox-local-test
) else (
  .venv\Scripts\python scripts\restart_source_server.py
)
if errorlevel 1 (
  echo.
  echo [ERROR] Source server restart failed.
  echo         An active opposite-mode source server is never stopped automatically.
  echo         Stop it explicitly, then retry the same mode.
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

if "%_RB_REKORDBOX_LOCAL_TEST_START%"=="1" (
  start "" "http://127.0.0.1:8787"
) else (
  start "" "http://localhost:8787"
)

echo.
echo [rb-output] done.
pause
exit /b 0

:initialize_show_config
node scripts\init-show-config.js
exit /b %errorlevel%

:initialize_rekordbox_local_test
node scripts\init-rekordbox-local-test-config.js
exit /b %errorlevel%

:preflight_rekordbox_local_test
call :reject_retired_rekordbox_override
if errorlevel 1 (
  exit /b 1
)
node scripts\validate-rekordbox-local-test-config.js
if errorlevel 1 (
  exit /b 1
)
echo [rb-output] REKORDBOX LOCAL TEST / NO SYNDOCAL preflight passed; no show-side process, build, server, Rekordbox, hook, MIDI, or pedal action was taken.
exit /b 0

:start_rekordbox_local_test
call :reject_retired_rekordbox_override
if errorlevel 1 (
  exit /b 1
)
node scripts\validate-rekordbox-local-test-config.js
if errorlevel 1 (
  exit /b 1
)
goto source_runtime_build

:upgrade_show_config
rem The one-way migration creates the current external config and then checks
rem that same target through the production strict preflight. It never enters
rem the source build/server/injection path in this invocation.
call :reject_retired_rekordbox_override
if errorlevel 1 (
  exit /b 1
)

node scripts\upgrade-show-config.js
if errorlevel 1 (
  exit /b 1
)

set "DJ_AGENT_CONFIG_PATH=C:\SyndocalShow\dj-agent-v1.1.11.json"
call :validate_show_config
if errorlevel 1 (
  exit /b 1
)

echo [rb-output] strict current v1.1.11 preflight passed; no show-side process or build action was taken.
echo [rb-output] Next PowerShell command:
echo $env:DJ_AGENT_CONFIG_PATH = 'C:\SyndocalShow\dj-agent-v1.1.11.json'
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

node -e "const fs=require('node:fs'),path=require('node:path');try{const forbidden=new Set(['DJ_AGENT_CONFIG','DJ_AGENT_ENABLED','DJ_AGENT_ALLOW_REMOTE_ACTIONS','SYNDOCAL_ENABLED','SYNDOCAL_HOST','SYNDOCAL_PORT','SYNDOCAL_PATH','SYNDOCAL_NIC','SYNDOCAL_TOKEN','SYNDOCAL_WS_ADAPTER','SYNDOCAL_HEARTBEAT_MS','PEDAL_ENABLED','PEDAL_MODULE','MIDI_ENABLED','MIDI_MODULE','MIDI_DEVICE','MIDI_PORT','MIDI_RELEASE_FADE','MIDI_RELEASE_MACRO','MIDI_DECK_CHANNELS','PORT','RB_OUTPUT_HOST','RB_OUTPUT_SETUP_MAPPING_PATH']);if(Object.keys(process.env).some(k=>forbidden.has(k.toUpperCase())))process.exit(2);const raw=process.env.DJ_AGENT_CONFIG_PATH||'';if(!path.isAbsolute(raw))process.exit(3);const requested=path.resolve(raw),stat=fs.lstatSync(requested);if(!stat.isFile()||stat.isSymbolicLink())process.exit(4);const file=fs.realpathSync.native(requested),root=fs.realpathSync.native(process.cwd())+path.sep;if(file.toLowerCase().startsWith(root.toLowerCase()))process.exit(5);const source=JSON.parse(fs.readFileSync(file,'utf8'));const {loadDjAgentConfig,validateFilterThenFadeThenStopShowConfig}=require('./server/dj-agent/config');const c=loadDjAgentConfig();if(c.warning||!validateFilterThenFadeThenStopShowConfig(source))process.exit(6);process.exit(0)}catch{process.exit(7)}"
if errorlevel 1 (
  echo.
  echo [ERROR] The checkout-external v1.1.11 DJ Agent show config failed strict readiness validation: exact production owner selection is required.
  echo         Require enabled DJ/Syndocal/pedal/MIDI, exact adapter syndocal-envelope-v3,
  echo         192.168.50.1:9100/dj-link via NIC 192.168.50.2, heartbeat 5000 ms, a 32..256-byte token,
  echo         CustomMIDI1 strict Filter/Cue mappings with deck 1/2 channels, 1000 ms 64-to-127 Filter,
  echo         releaseMacro.enabled=true, sequence=filter-then-fade-then-stop, CC16 HPF plus CC17 ChannelFader fade,
  echo         exact trackActivity.ownerSelection for 人生オーバー with 1400 ms Deck 1 fallback, and no env overrides.
  echo         No config content is printed.
  echo.
  exit /b 1
)

exit /b 0
