const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

test("source launcher is explicit development-only and always rebuilds the hook", () => {
  const source = fs.readFileSync(path.join(repoRoot, "start-all.bat"), "utf8");
  const buildIndex = source.search(/call\s+npm\s+run\s+build:hook/i);
  const serverIndex = source.search(/node\s+server\\index\.js/i);
  const injectIndex = source.search(/scripts\\inject_hook\.py/i);

  assert.match(source, /SOURCE DEVELOPMENT launcher/);
  assert.match(source, /Installed\/live operation must use the DJLinkForPCDJ shortcut/);
  assert.ok(buildIndex >= 0, "source launcher must rebuild the hook");
  assert.ok(serverIndex > buildIndex, "server must start only after the hook build succeeds");
  assert.ok(injectIndex > serverIndex, "injection must follow the verified build and server start");
  assert.doesNotMatch(
    source,
    /if\s+not\s+exist\s+"native\\bin\\rb_hook\.dll"/i,
    "a stale hook DLL must not bypass the build/provenance gate",
  );
});
