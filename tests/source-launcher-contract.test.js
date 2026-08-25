const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

test("source launcher is explicit development-only and always rebuilds the hook", () => {
  const source = fs.readFileSync(path.join(repoRoot, "start-all.bat"), "utf8");
  const buildIndex = source.search(/call\s+npm\s+run\s+build:hook/i);
  const serverIndex = source.search(/scripts\\restart_source_server\.py/i);
  const injectIndex = source.search(/scripts\\inject_hook\.py/i);

  assert.match(source, /SOURCE DEVELOPMENT launcher/);
  assert.match(source, /Installed\/live operation must use the DJLinkForPCDJ shortcut/);
  assert.ok(buildIndex >= 0, "source launcher must rebuild the hook");
  assert.ok(serverIndex > buildIndex, "server must start only after the hook build succeeds");
  assert.ok(injectIndex > serverIndex, "injection must follow the verified build and server start");
  assert.match(source, /--launch-installed\s+--wait-seconds\s+60/i);
  assert.doesNotMatch(source, /web server already running/i);
  assert.doesNotMatch(
    source,
    /if\s+not\s+exist\s+"native\\bin\\rb_hook\.dll"/i,
    "a stale hook DLL must not bypass the build/provenance gate",
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
