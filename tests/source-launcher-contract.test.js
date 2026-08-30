const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

const forbiddenShowEnv = new Set([
  "REKORDBOX_EXE_PATH",
  "DJ_AGENT_CONFIG",
  "DJ_AGENT_ENABLED",
  "DJ_AGENT_ALLOW_REMOTE_ACTIONS",
  "SYNDOCAL_ENABLED",
  "SYNDOCAL_HOST",
  "SYNDOCAL_PORT",
  "SYNDOCAL_PATH",
  "SYNDOCAL_NIC",
  "SYNDOCAL_TOKEN",
  "SYNDOCAL_WS_ADAPTER",
  "SYNDOCAL_HEARTBEAT_MS",
  "PEDAL_ENABLED",
  "PEDAL_MODULE",
  "MIDI_ENABLED",
  "MIDI_MODULE",
  "MIDI_DEVICE",
  "MIDI_PORT",
  "MIDI_RELEASE_FADE",
  "MIDI_RELEASE_MACRO",
  "MIDI_DECK_CHANNELS",
  "PORT",
  "RB_OUTPUT_HOST",
  "RB_OUTPUT_SETUP_MAPPING_PATH",
]);

function cleanShowEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (forbiddenShowEnv.has(key.toUpperCase()) || key.toUpperCase() === "DJ_AGENT_CONFIG_PATH") {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

function runLauncher(command, env) {
  const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
  return childProcess.spawnSync(comspec, ["/d", "/c", `call start-all.bat ${command}`], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
}

test("controlled show source launcher fails closed before rebuilding and injecting", () => {
  const source = fs.readFileSync(path.join(repoRoot, "start-all.bat"), "utf8");
  const retiredOverrideIndex = source.search(/call\s+:reject_retired_rekordbox_override/i);
  const configPreflightIndex = source.search(/call\s+:validate_show_config/i);
  const buildIndex = source.search(/call\s+npm\s+run\s+build:hook/i);
  const serverIndex = source.search(/scripts\\restart_source_server\.py/i);
  const injectIndex = source.search(/scripts\\inject_hook\.py/i);
  const browserIndex = source.search(/start\s+""\s+"http:\/\/localhost:8787"/i);

  assert.match(source, /CONTROLLED SOURCE-ACCEPTANCE launcher/);
  assert.match(source, /2026-08-30 DJ-PC source-acceptance exception only/);
  assert.ok(retiredOverrideIndex >= 0, "retired override preflight must be present");
  assert.ok(configPreflightIndex > retiredOverrideIndex, "show config preflight must follow the retired override check");
  assert.ok(buildIndex > configPreflightIndex, "no build may run before both fail-closed preflights");
  assert.ok(buildIndex >= 0, "source launcher must rebuild the hook");
  assert.ok(serverIndex > buildIndex, "server must start only after the hook build succeeds");
  assert.ok(injectIndex > serverIndex, "injection must follow the verified build and server start");
  assert.ok(browserIndex > injectIndex, "the browser must not open before successful hook injection");
  assert.match(source, /--launch-installed\s+--wait-seconds\s+60/i);
  assert.match(source, /Microsoft\.Win32\.Registry]::CurrentUser/);
  assert.match(source, /Microsoft\.Win32\.Registry]::LocalMachine/);
  assert.match(source, /GetValueNames\(\)/);
  assert.match(source, /set "_RB_REGISTRY_RESULT=%errorlevel%"/i);
  assert.match(source, /if "%_RB_REGISTRY_RESULT%"=="0" goto retired_registry_override_absent/i);
  assert.match(source, /if "%_RB_REGISTRY_RESULT%"=="1"/i);
  assert.match(source, /if not "%_RB_REGISTRY_RESULT%"=="0"/i);
  assert.match(source, /set "__APPDIR__="/i);
  assert.match(source, /"%__APPDIR__%WindowsPowerShell\\v1\.0\\powershell\.exe"/i);
  assert.doesNotMatch(source, /%SystemRoot%.*powershell\.exe/i);
  assert.match(source, /User\/Machine REKORDBOX_EXE_PATH state could not be verified conclusively/i);
  assert.doesNotMatch(source, /reg\s+query/i, "ambiguous reg.exe exit code must not decide absence");
  assert.match(source, /--preflight-only/i);
  assert.match(source, /--init-config/i);
  const initJumpIndex = source.search(/if "%_RB_INIT_CONFIG%"=="1" goto initialize_show_config/i);
  const initCommandIndex = source.search(/node scripts\\init-show-config\.js/i);
  assert.ok(initJumpIndex >= 0, "initializer dispatch must be present");
  assert.ok(initJumpIndex < retiredOverrideIndex, "initializer must bypass production preflight and show-side actions");
  assert.ok(initCommandIndex > browserIndex, "initializer implementation must remain outside the production launch path");
  assert.match(source, /strict source preflight passed; no show-side process or build action was taken/i);
  assert.match(source, /DJ_AGENT_CONFIG_PATH is required for the controlled source path/i);
  assert.match(source, /path\.isAbsolute\(raw\)/);
  assert.match(source, /fs\.lstatSync\(requested\)/);
  assert.match(source, /fs\.realpathSync\.native\(requested\)/);
  assert.match(source, /fs\.realpathSync\.native\(process\.cwd\(\)\)/);
  assert.match(source, /validateFilterThenFadeThenStopShowConfig\(source\)/);
  assert.match(source, /releaseMacro\.enabled=true, sequence=filter-then-fade-then-stop, CC16 HPF plus CC17 ChannelFader fade/i);
  assert.match(source, /exact production owner selection is required/i);
  assert.doesNotMatch(source, /web server already running/i);
  assert.doesNotMatch(
    source,
    /if\s+not\s+exist\s+"native\\bin\\rb_hook\.dll"/i,
    "a stale hook DLL must not bypass the build/provenance gate",
  );
});

test("local Rekordbox test admits only the fixed additional compiler root", () => {
  const source = fs.readFileSync(path.join(repoRoot, "start-all.bat"), "utf8");
  const buildBlock = source.match(
    /if\s+"%_RB_REKORDBOX_LOCAL_TEST_START%"=="1"\s*\([\s\S]*?\)\s*else\s*\([\s\S]*?\)/i,
  );
  assert.ok(buildBlock, "hook build must have an explicit local-test/production split");
  assert.match(
    buildBlock[0],
    /call\s+npm\s+run\s+build:hook\s+--\s+-AdditionalTrustedCompilerRoots\s+C:\\TDM-GCC-64/i,
  );
  assert.match(buildBlock[0], /else\s*\(\s*call\s+npm\s+run\s+build:hook\s*\)/i);
  assert.equal(
    (buildBlock[0].match(/-AdditionalTrustedCompilerRoots/gi) || []).length,
    1,
    "the production branch must not receive an additional trusted root",
  );
  assert.match(
    source,
    /AdditionalTrustedCompilerRoots C:\\TDM-GCC-64/i,
    "the fixed local-test root must remain explicit and reviewable",
  );
});

test("source server restart is limited to the exact checkout-owned listener", () => {
  const source = fs.readFileSync(
    path.join(repoRoot, "scripts", "restart_source_server.py"),
    "utf8",
  );
  assert.match(source, /process\.name\(\)\.lower\(\)\s*!=\s*"node\.exe"/);
  assert.match(source, /normalized_path\(cwd\)\s*!=\s*normalized_path\(PROJECT_ROOT\)/);
  assert.match(source, /len\(command\)\s*!=\s*2/);
  assert.match(source, /normalized_path\(script_argument\)\s*==\s*normalized_path\(SERVER_SCRIPT\)/);
  assert.match(source, /if not is_owned_source_server\(process\):/);
  assert.match(source, /process\.terminate\(\)/);
  assert.doesNotMatch(source, /process\.kill\(/);
  assert.match(source, /env=os\.environ\.copy\(\)/);
});

test("source injection auto-launch remains restricted to supported Rekordbox builds", () => {
  const source = fs.readFileSync(path.join(repoRoot, "scripts", "inject_hook.py"), "utf8");
  assert.match(source, /SUPPORTED_REKORDBOX_VERSIONS\s*=\s*\{\(7, 2, 13\), \(7, 2, 14\), \(7, 2, 18\)\}/);
  assert.match(source, /re\.fullmatch\(r"rekordbox\\s\+\(\\d\+\)\\\.\(\\d\+\)\\\.\(\\d\+\)"/);
  assert.match(source, /version not in SUPPORTED_REKORDBOX_VERSIONS/);
  assert.match(source, /--launch-path and --launch-installed are mutually exclusive/);
  assert.match(source, /if not exe_path or _norm_path\(exe_path\) != preferred_exe_norm:/);
  assert.match(source, /pid, launch_path = find_running_supported_rekordbox\(args\.process_name\)/);
  assert.match(source, /unsupported or differently installed Rekordbox process is running/);
  assert.match(source, /no supported Rekordbox installation was found/);
  assert.match(source, /supported_explicit_launch_path\(args\.launch_path\)/);
  assert.match(source, /REKORDBOX_EXE_PATH is retired; remove it and use a validated --launch-path/);
  assert.match(source, /for _, installed in installed_supported_rekordbox\(\):/);
  assert.match(source, /_norm_path\(str\(installed\)\) == candidate_norm/);
});

test(
  "cmd launcher executes strict preflight branches without show-side actions",
  { skip: process.platform !== "win32" },
  () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-output-launcher-"));
    const validPath = path.join(tempRoot, "valid.json");
    const macroPath = path.join(tempRoot, "fade-enabled.json");
    const missingPolicyPath = path.join(tempRoot, "missing-owner-policy.json");
    const valid = {
      version: "1.1.11",
      enabled: true,
      syndocal: {
        enabled: true,
        host: "192.168.50.1",
        port: 9100,
        path: "/dj-link",
        nic: "192.168.50.2",
        token: "0123456789abcdef0123456789abcdef",
        adapter: "syndocal-envelope-v3",
        heartbeatMs: 5000,
      },
      pedal: { enabled: true, bindings: { release: "F13", loopHalf: "F14", filterClose: "F15" } },
      trackActivity: {
        ownerSelection: {
          mode: "titleContains",
          titleNeedle: "人生オーバー",
          deck1MetadataWaitMs: 1400,
        },
      },
      midi: {
        enabled: true,
        device: "CustomMIDI1",
        port: 1,
        mappings: {
          loopHalf: { channel: 1, messageType: "noteOn", note: 36, value: 127 },
          stop: { channel: 1, messageType: "noteOn", note: 37, value: 127 },
          filter: { channel: 1, messageType: "controlChange", cc: 16 },
          releaseFade: { channel: 1, messageType: "controlChange", cc: 17 },
        },
        deckChannels: { 1: 1, 2: 2 },
        filter: { startValue: 64, endValue: 127, durationMs: 1000, updateIntervalMs: 50 },
        releaseFade: {
          enabled: true,
          mapping: "releaseFade",
          target: "deck",
          startValue: 127,
          endValue: 0,
          durationMs: 1000,
          updateIntervalMs: 50,
          resetAfterStop: true,
          resetValue: 127,
          resetDelayMs: 0,
        },
        releaseMacro: {
          enabled: true,
          sequence: "filter-then-fade-then-stop",
          filter: { startValue: 64, endValue: 127, durationMs: 1000, updateIntervalMs: 50, resetValue: 64 },
          resetAfterStop: true,
          resetDelayMs: 0,
        },
      },
    };
    fs.writeFileSync(validPath, JSON.stringify(valid), "utf8");
    fs.writeFileSync(
      macroPath,
      JSON.stringify({
        ...valid,
        midi: { ...valid.midi, releaseFade: { enabled: true } },
      }),
      "utf8",
    );
    fs.writeFileSync(
      missingPolicyPath,
      JSON.stringify(Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "trackActivity"))),
      "utf8",
    );

    try {
      const unknown = runLauncher("--preflight-onyl", cleanShowEnv());
      assert.equal(unknown.status, 64, unknown.stdout + unknown.stderr);
      assert.match(unknown.stdout, /Unknown launcher argument/i);

      const extra = runLauncher("--preflight-only unexpected", cleanShowEnv());
      assert.equal(extra.status, 64, extra.stdout + extra.stderr);
      assert.match(extra.stdout, /Unexpected launcher arguments/i);

      const initExtra = runLauncher("--init-config unexpected", cleanShowEnv());
      assert.equal(initExtra.status, 64, initExtra.stdout + initExtra.stderr);
      assert.match(initExtra.stdout, /Unexpected launcher arguments/i);

      const caseVariantFlag = runLauncher("--PREFLIGHT-ONLY", cleanShowEnv());
      assert.equal(caseVariantFlag.status, 64, caseVariantFlag.stdout + caseVariantFlag.stderr);
      assert.match(caseVariantFlag.stdout, /Unknown launcher argument/i);

      const initCaseVariant = runLauncher("--INIT-CONFIG", cleanShowEnv());
      assert.equal(initCaseVariant.status, 64, initCaseVariant.stdout + initCaseVariant.stderr);
      assert.match(initCaseVariant.stdout, /Unknown launcher argument/i);

      const hiddenThird = runLauncher('\"\" \"\" unexpected', cleanShowEnv());
      assert.equal(hiddenThird.status, 64, hiddenThird.stdout + hiddenThird.stderr);
      assert.match(hiddenThird.stdout, /Unknown launcher argument/i);

      const processOverride = runLauncher(
        "--preflight-only",
        cleanShowEnv({ REKORDBOX_EXE_PATH: "retired-value" }),
      );
      assert.equal(processOverride.status, 1, processOverride.stdout + processOverride.stderr);
      assert.match(processOverride.stdout, /remains in Process scope/i);

      const missingConfig = runLauncher("--preflight-only", cleanShowEnv());
      assert.equal(missingConfig.status, 1, missingConfig.stdout + missingConfig.stderr);
      assert.match(missingConfig.stdout, /DJ_AGENT_CONFIG_PATH is required/i);

      const pseudoAppDirTamper = runLauncher(
        "--preflight-only",
        cleanShowEnv({
          DJ_AGENT_CONFIG_PATH: validPath,
          __APPDIR__: `${tempRoot}${path.sep}`,
        }),
      );
      assert.equal(pseudoAppDirTamper.status, 0, pseudoAppDirTamper.stdout + pseudoAppDirTamper.stderr);
      assert.match(pseudoAppDirTamper.stdout, /strict source preflight passed/i);

      const macroEnabled = runLauncher(
        "--preflight-only",
        cleanShowEnv({ DJ_AGENT_CONFIG_PATH: macroPath }),
      );
      assert.equal(macroEnabled.status, 1, macroEnabled.stdout + macroEnabled.stderr);
      assert.match(macroEnabled.stdout, /failed strict readiness validation/i);

      const missingPolicy = runLauncher(
        "--preflight-only",
        cleanShowEnv({ DJ_AGENT_CONFIG_PATH: missingPolicyPath }),
      );
      assert.equal(missingPolicy.status, 1, missingPolicy.stdout + missingPolicy.stderr);
      assert.match(missingPolicy.stdout, /exact production owner selection is required/i);

      const caseVariantOverride = runLauncher(
        "--preflight-only",
        cleanShowEnv({
          DJ_AGENT_CONFIG_PATH: validPath,
          syndocal_host: "192.168.50.1",
        }),
      );
      assert.equal(caseVariantOverride.status, 1, caseVariantOverride.stdout + caseVariantOverride.stderr);
      assert.match(caseVariantOverride.stdout, /failed strict readiness validation/i);

      const accepted = runLauncher(
        "--preflight-only",
        cleanShowEnv({ DJ_AGENT_CONFIG_PATH: validPath }),
      );
      assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
      assert.match(accepted.stdout, /strict source preflight passed/i);

      for (const result of [
        unknown,
        extra,
        initExtra,
        caseVariantFlag,
        initCaseVariant,
        hiddenThird,
        processOverride,
        missingConfig,
        pseudoAppDirTamper,
        macroEnabled,
        missingPolicy,
        caseVariantOverride,
        accepted,
      ]) {
        assert.doesNotMatch(
          result.stdout + result.stderr,
          /venv not found|rebuilding and verifying rb_hook\.dll|restarting the source server|injecting hook/i,
        );
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);
