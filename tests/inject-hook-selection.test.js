const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

test("injector target selection passes the executable-path behavior matrix", () => {
  const python = path.join(repoRoot, ".venv", "Scripts", "python.exe");
  const script = path.join(__dirname, "inject_hook_selection_test.py");
  const result = spawnSync(python, [script], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(
    result.status,
    0,
    `selection matrix failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stderr, /Ran 8 tests/);
  assert.match(result.stderr, /OK/);
});
