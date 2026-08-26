const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  TARGET_PATH,
  TEMPLATE_PATH,
  TOKEN_PLACEHOLDER,
  ShowConfigInitializationError,
  initializeShowConfig,
  parseAndValidateTemplate,
} = require("../scripts/init-show-config");

test("bundled v1.1.6 template is token-free and matches the strict show contract", () => {
  const raw = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const config = parseAndValidateTemplate(raw);

  assert.equal(config.syndocal.token, TOKEN_PLACEHOLDER);
  assert.equal(raw.includes(TOKEN_PLACEHOLDER), true);
  assert.equal(raw.includes("syndocal-envelope-v3"), true);
  assert.equal(config.syndocal.host, "192.168.50.1");
  assert.equal(config.syndocal.nic, "192.168.50.2");
  assert.equal(config.midi.device, "CustomMIDI1");
  assert.equal(config.midi.releaseMacro.enabled, false);
  assert.equal(TARGET_PATH, String.raw`C:\SyndocalShow\dj-agent-v1.1.6.json`);
});

test("initializer creates the external file exactly once without mutating the template", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-output-show-config-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const targetPath = path.join(tempRoot, "external", "dj-agent-v1.1.6.json");
  const templateBefore = fs.readFileSync(TEMPLATE_PATH);

  const result = initializeShowConfig({ targetPath });

  assert.equal(result.targetPath, path.resolve(targetPath));
  assert.deepEqual(fs.readFileSync(targetPath), templateBefore);
  assert.deepEqual(fs.readFileSync(TEMPLATE_PATH), templateBefore);
});

test("initializer refuses to overwrite any existing target, including invalid JSON", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-output-show-config-existing-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const targetPath = path.join(tempRoot, "dj-agent-v1.1.6.json");
  const existing = "not-json-and-must-remain-byte-identical\n";
  fs.writeFileSync(targetPath, existing, "utf8");

  assert.throws(
    () => initializeShowConfig({ targetPath }),
    (error) => error instanceof ShowConfigInitializationError && error.code === "TARGET_EXISTS",
  );
  assert.equal(fs.readFileSync(targetPath, "utf8"), existing);
});

test("initializer rejects a template containing a substituted token before creating a target", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-output-show-config-hostile-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const templatePath = path.join(tempRoot, "hostile.json");
  const targetPath = path.join(tempRoot, "external", "dj-agent-v1.1.6.json");
  const hostile = fs.readFileSync(TEMPLATE_PATH, "utf8").replace(
    TOKEN_PLACEHOLDER,
    "0123456789abcdef0123456789abcdef",
  );
  fs.writeFileSync(templatePath, hostile, "utf8");

  assert.throws(
    () => initializeShowConfig({ templatePath, targetPath }),
    (error) => error instanceof ShowConfigInitializationError && error.code === "TEMPLATE_CONTRACT_MISMATCH",
  );
  assert.equal(fs.existsSync(targetPath), false);
});
