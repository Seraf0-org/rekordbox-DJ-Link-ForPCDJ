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
const { validateFilterThenFadeThenStopShowConfig } = require("../server/dj-agent/config");

test("bundled v1.1.8 template is token-free and matches the strict filter-then-fade-then-stop contract", () => {
  const raw = fs.readFileSync(TEMPLATE_PATH, "utf8");
  const config = parseAndValidateTemplate(raw);

  assert.equal(config.syndocal.token, TOKEN_PLACEHOLDER);
  assert.equal(raw.includes(TOKEN_PLACEHOLDER), true);
  assert.equal(raw.includes("syndocal-envelope-v3"), true);
  assert.equal(config.syndocal.host, "192.168.50.1");
  assert.equal(config.syndocal.nic, "192.168.50.2");
  assert.equal(config.midi.device, "CustomMIDI1");
  assert.equal(config.version, "1.1.8");
  assert.equal(config.midi.releaseMacro.enabled, true);
  assert.equal(config.midi.releaseMacro.sequence, "filter-then-fade-then-stop");
  assert.equal(config.midi.releaseFade.enabled, true);
  assert.equal(config.midi.mappings.releaseFade.cc, 17);
  assert.deepEqual(config.trackActivity.ownerSelection, {
    mode: "titleContains",
    titleNeedle: "人生オーバー",
    deck1MetadataWaitMs: 1400,
  });
  assert.equal(TARGET_PATH, String.raw`C:\SyndocalShow\dj-agent-v1.1.8.json`);
});

test("strict v1.1.8 validator rejects every retired sequence or mapping alternative", () => {
  const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, "utf8"));
  const invalidConfigurations = [
    (config) => { config.midi.releaseFade.enabled = false; },
    (config) => { config.midi.mappings.channelFader = { channel: 1, messageType: "controlChange", cc: 17 }; },
    (config) => { config.midi.releaseMacro.sequence = "filter-then-fade"; },
    (config) => { config.midi.releaseMacro.filter.durationMs = 999; },
    (config) => { config.midi.releaseMacro.filter.endValue = 126; },
    (config) => { config.midi.mappings.stop.note = 38; },
    (config) => { config.midi.deckChannels[2] = 3; },
    (config) => { config.trackActivity.ownerSelection.titleNeedle = "人生オーバー "; },
    (config) => { config.trackActivity.ownerSelection.deck1MetadataWaitMs = 1399; },
  ];

  assert.equal(validateFilterThenFadeThenStopShowConfig(template, { allowTokenPlaceholder: true }), true);
  for (const mutate of invalidConfigurations) {
    const candidate = JSON.parse(JSON.stringify(template));
    mutate(candidate);
    assert.equal(validateFilterThenFadeThenStopShowConfig(candidate, { allowTokenPlaceholder: true }), false);
  }
});

test("initializer creates the external file exactly once without mutating the template", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-output-show-config-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const targetPath = path.join(tempRoot, "external", "dj-agent-v1.1.8.json");
  const templateBefore = fs.readFileSync(TEMPLATE_PATH);

  const result = initializeShowConfig({ targetPath });

  assert.equal(result.targetPath, path.resolve(targetPath));
  assert.deepEqual(fs.readFileSync(targetPath), templateBefore);
  assert.deepEqual(fs.readFileSync(TEMPLATE_PATH), templateBefore);
});

test("initializer refuses to overwrite any existing target, including invalid JSON", (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-output-show-config-existing-"));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const targetPath = path.join(tempRoot, "dj-agent-v1.1.8.json");
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
  const targetPath = path.join(tempRoot, "external", "dj-agent-v1.1.8.json");
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
