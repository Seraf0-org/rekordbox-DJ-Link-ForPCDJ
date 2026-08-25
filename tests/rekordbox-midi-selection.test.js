const test = require("node:test");
const assert = require("node:assert/strict");

const { createRekordboxMidi, resolveMidiModule } = require("../server/dj-agent/rekordboxMidi");
const {
  DEFAULT_MIDI_MODULE_NAME,
  normalizeMidiModuleName,
} = require("../server/dj-agent/midiModuleResolver");

function createOutput(names, lifecycle = {}) {
  return class {
    constructor() {
      this.opened = false;
    }
    getPortCount() { return names.length; }
    getPortName(index) { return lifecycle.afterName?.(index, this.opened) ?? names[index]; }
    openPort(index) {
      lifecycle.opens?.push(index);
      if (lifecycle.openResult === false) return false;
      this.opened = true;
      return undefined;
    }
    closePort() { lifecycle.closes && (lifecycle.closes.count += 1); }
    destroy() { lifecycle.destroys && (lifecycle.destroys.count += 1); }
  };
}

test("runtime opens only an exact explicit MIDI name and port pair", () => {
  const opens = [];
  const midi = createRekordboxMidi({
    enabled: true,
    device: "CustomMIDI1",
    port: 1,
    midiModule: { Output: createOutput(["CustomMIDI1 Extra", "CustomMIDI1"], { opens }) },
  });
  midi.start();
  assert.deepEqual(opens, [1]);
  assert.deepEqual(
    { ok: midi.getStatus().ok, port: midi.getStatus().port, device: midi.getStatus().device },
    { ok: true, port: 1, device: "CustomMIDI1" }
  );
  midi.stop();
});

test("missing pair, substring, case drift, and implicit port zero never open", () => {
  for (const selection of [
    { device: "", port: null },
    { device: "CustomMIDI1", port: null },
    { device: "Custom", port: 1 },
    { device: "custommidi1", port: 1 },
    { device: "CustomMIDI1", port: "1" },
    { device: "", port: 0 },
  ]) {
    const opens = [];
    const midi = createRekordboxMidi({
      enabled: true,
      ...selection,
      midiModule: { Output: createOutput(["Microsoft GS Wavetable Synth", "CustomMIDI1"], { opens }) },
    });
    midi.start();
    assert.deepEqual(opens, [], JSON.stringify(selection));
    assert.equal(midi.getStatus().ok, false, JSON.stringify(selection));
    midi.stop();
  }
});

test("open refusal and post-open identity drift release the native output and fail closed", () => {
  for (const lifecycle of [
    { opens: [], closes: { count: 0 }, destroys: { count: 0 }, openResult: false },
    {
      opens: [],
      closes: { count: 0 },
      destroys: { count: 0 },
      afterName: (_index, opened) => opened ? "Different device" : "CustomMIDI1",
    },
  ]) {
    const midi = createRekordboxMidi({
      enabled: true,
      device: "CustomMIDI1",
      port: 0,
      midiModule: { Output: createOutput(["CustomMIDI1"], lifecycle) },
    });
    midi.start();
    assert.equal(midi.getStatus().ok, false);
    assert.equal(lifecycle.destroys.count, 1);
    assert.equal(lifecycle.closes.count, lifecycle.openResult === false ? 0 : 1);
  }
});

test("native error text is not reflected in public MIDI status", () => {
  const secret = "C:\\Users\\alice\\secret-token";
  const midi = createRekordboxMidi({
    enabled: true,
    device: "CustomMIDI1",
    port: 0,
    outputFactory() { throw new Error(secret); },
  });
  midi.start();
  assert.equal(midi.getStatus().message, "MIDI output error");
  assert.equal(JSON.stringify(midi.getStatus()).includes(secret), false);
});

test("runtime MIDI module resolver never dynamically requires caller input", () => {
  assert.equal(resolveMidiModule("node:fs"), null);
  assert.equal(resolveMidiModule("rb-output-test-missing-midi"), null);
});

test("module name normalization is exact, trimmed, defaulting, and case-sensitive", () => {
  assert.equal(DEFAULT_MIDI_MODULE_NAME, "@julusian/midi");
  for (const blank of [undefined, null, "", "   "]) {
    assert.equal(normalizeMidiModuleName(blank), "@julusian/midi", String(blank));
  }
  assert.equal(normalizeMidiModuleName(" midi "), "midi");
  assert.equal(normalizeMidiModuleName(" @julusian/midi\t"), "@julusian/midi");
  for (const rejected of [
    "MIDI",
    "@JULUSIAN/MIDI",
    "midi-hack",
    "node:fs",
    "./midi",
    "../midi",
    "midi/package.json",
    " @julusian/midi x",
    42,
    {},
    true,
  ]) {
    assert.equal(normalizeMidiModuleName(rejected), null, String(rejected));
  }
});

test("an unresolvable configured module fails closed without transport fallback", () => {
  const unavailable = [];
  const midi = createRekordboxMidi({
    enabled: true,
    moduleName: "rb-output-test-missing-midi",
    device: "CustomMIDI1",
    port: 0,
    midiModule: null,
  });
  midi.on("unavailable", (event) => unavailable.push(event));
  midi.start();
  assert.deepEqual(unavailable, [{ reason: "missing-midi-dependency" }]);
  assert.equal(midi.getStatus().ok, false);
  assert.equal(midi.getStatus().available, false);
  assert.equal(midi.sendMapping("stop"), false);
  midi.stop();
});

test("duplicate identical port names are ambiguous and never open", () => {
  for (const selectedPort of [0, 1]) {
    const opens = [];
    const destroys = { count: 0 };
    const midi = createRekordboxMidi({
      enabled: true,
      device: "CustomMIDI1",
      port: selectedPort,
      midiModule: {
        Output: createOutput(["CustomMIDI1", "CustomMIDI1"], { opens, destroys }),
      },
    });
    midi.start();
    assert.deepEqual(opens, [], `port ${selectedPort} must not open`);
    assert.equal(midi.getStatus().ok, false, `port ${selectedPort}`);
    assert.equal(destroys.count, 1, `port ${selectedPort} must release the output`);
    midi.stop();
  }
});

test("a thrown open performs one best-effort close and destroy without masking the failure", () => {
  const secret = "C:\\Users\\alice\\partial-open-secret";
  const lifecycle = { opens: [], closes: { count: 0 }, destroys: { count: 0 } };
  const adapterErrors = [];
  const midi = createRekordboxMidi({
    enabled: true,
    device: "CustomMIDI1",
    port: 0,
    midiModule: {
      Output: class {
        getPortCount() { return 1; }
        getPortName() { return "CustomMIDI1"; }
        openPort(index) {
          lifecycle.opens.push(index);
          throw new Error(`device busy: ${secret}`);
        }
        closePort() { lifecycle.closes.count += 1; }
        destroy() { lifecycle.destroys.count += 1; }
      },
    },
  });
  midi.on("adapter-error", (event) => adapterErrors.push(event));
  midi.start();
  assert.deepEqual(lifecycle.opens, [0]);
  assert.equal(lifecycle.closes.count, 1);
  assert.equal(lifecycle.destroys.count, 1);
  assert.equal(midi.getStatus().message, "MIDI output error");
  assert.deepEqual(adapterErrors, [{ code: "midi-open-failed", message: "MIDI output error" }]);
  assert.equal(JSON.stringify(adapterErrors).includes(secret), false);
  assert.equal(JSON.stringify(midi.getStatus()).includes(secret), false);
  midi.stop();
  assert.equal(lifecycle.closes.count, 1, "stop must not re-close a released output");
  assert.equal(lifecycle.destroys.count, 1, "stop must not double-destroy");
});

test("native port-name read failures fail closed without opening any port", () => {
  const opens = [];
  const destroys = { count: 0 };
  const midi = createRekordboxMidi({
    enabled: true,
    device: "CustomMIDI1",
    port: 0,
    midiModule: {
      Output: class {
        getPortCount() { return 2; }
        getPortName() { throw new Error("native name read failed"); }
        openPort(index) { opens.push(index); }
        closePort() {}
        destroy() { destroys.count += 1; }
      },
    },
  });
  midi.start();
  assert.deepEqual(opens, []);
  assert.equal(midi.getStatus().ok, false);
  assert.equal(midi.getStatus().available, true);
  assert.equal(midi.getStatus().message, "No configured MIDI output device found");
  assert.equal(destroys.count, 1);
  midi.stop();
});

test("disabled configuration keeps the documented unavailable status contract", () => {
  const midi = createRekordboxMidi({
    enabled: false,
    device: "CustomMIDI1",
    port: 0,
    midiModule: { Output: createOutput(["CustomMIDI1"]) },
  });
  const statuses = [];
  midi.on("status", (status) => statuses.push(status));
  midi.start();
  assert.equal(midi.getStatus().ok, false);
  assert.equal(midi.getStatus().available, false);
  assert.equal(midi.getStatus().message, "MIDI integration disabled by config");
  midi.stop();
  assert.equal(statuses.every((status) => status.enabled === false), true);
});

test("send failures emit fixed codes and never reflect native error text", () => {
  const secret = "C:\\Users\\alice\\send-secret";
  const sendFailures = [];
  const midi = createRekordboxMidi({
    enabled: true,
    device: "CustomMIDI1",
    port: 0,
    mappings: { stop: { channel: 1, messageType: "noteOn", note: 37 } },
    midiModule: {
      Output: class {
        getPortCount() { return 1; }
        getPortName() { return "CustomMIDI1"; }
        openPort() {}
        closePort() {}
        sendMessage() { throw new Error(`driver exploded: ${secret}`); }
      },
    },
  });
  midi.on("send-failed", (event) => sendFailures.push(event));
  midi.start();
  assert.equal(midi.sendMapping("stop"), false);
  assert.equal(sendFailures.length, 1);
  assert.equal(sendFailures[0].reason, "send-error");
  assert.equal(sendFailures[0].code, "midi-send-failed");
  assert.equal(Object.hasOwn(sendFailures[0], "error"), false);
  assert.equal(JSON.stringify(sendFailures).includes(secret), false);
  assert.equal(midi.getStatus().message, "MIDI send failed");
  midi.stop();
});
