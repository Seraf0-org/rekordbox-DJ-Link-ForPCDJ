const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createPythonBridge } = require("../server/providers/pythonBridge");
const { createAbletonLinkProvider } = require("../server/providers/abletonLinkProvider");
const { createHookUdpProvider } = require("../server/providers/hookUdpProvider");
const {
  normalizeLoopState,
  mergeLoopState,
  upsertLoopState,
} = require("../server/loopState");
const {
  findLatestRekordboxExe,
  parseVersionFromDirectory,
  resolveRekordboxExePath,
} = require("../server/rekordboxInstall");

test("python bridge factory returns lifecycle methods", () => {
  const bridge = createPythonBridge({
    pythonBin: "python",
    scriptPath: "python/bridge_stream.py",
    args: [],
  });
  assert.equal(typeof bridge.start, "function");
  assert.equal(typeof bridge.stop, "function");
  assert.equal(typeof bridge.on, "function");
});

test("ableton link provider can be created disabled", () => {
  const provider = createAbletonLinkProvider({ enabled: false });
  assert.equal(typeof provider.start, "function");
  assert.equal(typeof provider.stop, "function");
  assert.equal(typeof provider.on, "function");
});

test("hook udp provider can be created disabled", () => {
  const provider = createHookUdpProvider({ enabled: false });
  assert.equal(typeof provider.start, "function");
  assert.equal(typeof provider.stop, "function");
  assert.equal(typeof provider.on, "function");
});

test("rekordbox install directory versions are parsed strictly", () => {
  assert.deepEqual(parseVersionFromDirectory("rekordbox 7.2.18"), [7, 2, 18]);
  assert.deepEqual(parseVersionFromDirectory("Rekordbox 7.2.13"), [7, 2, 13]);
  assert.equal(parseVersionFromDirectory("rekordbox 7.2"), null);
  assert.equal(parseVersionFromDirectory("rekordbox 7.2.18 backup"), null);
});

test("latest installed rekordbox is selected without removing legacy support", (t) => {
  const programFiles = fs.mkdtempSync(path.join(os.tmpdir(), "rb-install-test-"));
  t.after(() => fs.rmSync(programFiles, { recursive: true, force: true }));

  const installRoot = path.join(programFiles, "rekordbox");
  const versions = ["rekordbox 7.2.13", "rekordbox 7.2.18", "rekordbox 7.2.14"];
  for (const version of versions) {
    const directory = path.join(installRoot, version);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "rekordbox.exe"), "");
  }

  assert.equal(
    findLatestRekordboxExe(programFiles),
    path.join(installRoot, "rekordbox 7.2.18", "rekordbox.exe"),
  );
});

test("explicit rekordbox executable path takes precedence", () => {
  assert.equal(resolveRekordboxExePath("D:\\DJ\\rekordbox.exe"), "D:\\DJ\\rekordbox.exe");
});

test("loop_state packets normalize beat boundaries and aliases", () => {
  const normalized = normalizeLoopState({
    type: "loop_state",
    deck: 1,
    active: true,
    start_beat: 16,
    length_beats: 4,
    start_ms: 32_000,
  }, { maxDeck: 2, source: "test" });
  assert.equal(normalized.deck, 1);
  assert.equal(normalized.active, true);
  assert.equal(normalized.startMs, 32_000);
  assert.equal(normalized.endMs, null);
  assert.equal(normalized.startBeat, 16);
  assert.equal(normalized.endBeat, 20);
  assert.equal(normalized.lengthBeats, 4);
  assert.match(normalized.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(normalized.source, "test");
});

test("loop state updates preserve boundaries when native hook only sends inactive", () => {
  const active = normalizeLoopState({ deck: 2, active: true, startBeat: 8, endBeat: 12 });
  const inactive = normalizeLoopState({ deck: 2, active: false });
  const merged = mergeLoopState(active, inactive);
  assert.equal(merged.active, false);
  assert.equal(merged.startBeat, 8);
  assert.equal(merged.endBeat, 12);
  assert.deepEqual(upsertLoopState([], merged), [merged]);
});
