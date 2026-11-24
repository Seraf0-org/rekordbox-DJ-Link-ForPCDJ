const test = require("node:test");
const assert = require("node:assert/strict");

const {
  exactMidiPort,
  strictPort,
  verifyRuntimeMidiSelection,
} = require("../server/dj-agent/setupSelection");
const {
  enumerateMidiOutputs,
  probeMidiOutputSelection,
} = require("../server/dj-agent/midiPorts");

const PORTS = [
  { port: 0, name: "Microsoft GS Wavetable Synth" },
  { port: 1, name: "CustomMIDI1" },
];

function countingOutput({ names, onOpen = null, onClose = null, onDestroy = null, nameError = false } = {}) {
  const counters = { opens: 0, closes: 0, destroys: 0 };
  const output = {
    getPortCount() { return names.length; },
    getPortName(port) {
      if (nameError) {
        throw new Error("native name read failed");
      }
      return names[port];
    },
    openPort() { counters.opens += 1; onOpen?.(); },
    closePort() { counters.closes += 1; onClose?.(); },
    destroy() { counters.destroys += 1; onDestroy?.(); },
  };
  return { output, counters };
}

test("runtime MIDI readiness requires exact config/runtime/enumeration identity", () => {
  assert.deepEqual(verifyRuntimeMidiSelection({
    config: { port: 1, device: "CustomMIDI1" },
    runtime: { ok: true, available: true, port: 1, device: "CustomMIDI1" },
    ports: PORTS,
  }), {
    configured: true,
    nameVerified: true,
    ready: true,
    port: 1,
    device: "CustomMIDI1",
  });
});

test("implicit port zero and every stale identity fail closed", () => {
  for (const config of [
    { port: null, device: "" },
    { port: "0", device: "Microsoft GS Wavetable Synth" },
    { port: 0, device: "" },
    { port: true, device: "CustomMIDI1" },
    { port: 1, device: "Wrong device" },
  ]) {
    assert.equal(verifyRuntimeMidiSelection({
      config,
      runtime: { ok: true, available: true, port: 1, device: "CustomMIDI1" },
      ports: PORTS,
    }).ready, false, JSON.stringify(config));
  }
  assert.equal(strictPort("0"), null);
  assert.equal(strictPort(true), null);
});

test("runtime drift, enumeration drift, and duplicate identities fail closed", () => {
  const config = { port: 1, device: "CustomMIDI1" };
  assert.equal(verifyRuntimeMidiSelection({
    config,
    runtime: { ok: true, available: true, port: 0, device: "CustomMIDI1" },
    ports: PORTS,
  }).ready, false);
  assert.equal(verifyRuntimeMidiSelection({
    config,
    runtime: { ok: true, available: true, port: 1, device: "CustomMIDI1" },
    ports: [{ port: 1, name: "Renamed port" }],
  }).ready, false);
  assert.equal(exactMidiPort([...PORTS, { port: 1, name: "CustomMIDI1" }], 1, "CustomMIDI1"), null);
});

test("setup probe rejects duplicate identical device names before opening", () => {
  const { output, counters } = countingOutput({ names: ["CustomMIDI1", "CustomMIDI1"] });
  const result = probeMidiOutputSelection({
    selectedPort: 1,
    expectedName: "CustomMIDI1",
    outputFactory: () => output,
  });
  assert.equal(result.ok, false);
  assert.equal(result.probed, false);
  assert.equal(result.nameVerified, false);
  assert.equal(result.reason, "duplicate-device-name");
  assert.equal(counters.opens, 0);
  assert.equal(counters.closes, 0);
  assert.equal(counters.destroys, 1);
});

test("setup enumeration and probing fail closed without transport fallback", () => {
  assert.deepEqual(enumerateMidiOutputs({ moduleName: "rb-output-test-missing-midi" }), {
    ok: false,
    available: false,
    ports: [],
    reason: "midi-unavailable",
    released: false,
  });
  const probe = probeMidiOutputSelection({
    moduleName: "rb-output-test-missing-midi",
    selectedPort: 0,
    expectedName: "CustomMIDI1",
  });
  assert.deepEqual(probe, {
    ok: false,
    probed: false,
    nameVerified: false,
    reason: "midi-unavailable",
  });
});

test("a native port-name read failure rejects the setup selection before opening", () => {
  const { output, counters } = countingOutput({ names: ["CustomMIDI1"], nameError: true });
  const result = probeMidiOutputSelection({
    selectedPort: 0,
    expectedName: "CustomMIDI1",
    outputFactory: () => output,
  });
  assert.equal(result.ok, false);
  assert.equal(result.probed, false);
  assert.equal(result.nameVerified, false);
  assert.equal(result.reason, "selected-device-mismatch");
  assert.equal(counters.opens, 0);
  assert.equal(counters.closes, 0);
  assert.equal(counters.destroys, 1);
  assert.equal(JSON.stringify(result).includes("native name read failed"), false);
});

test("a thrown setup open gets exactly one close attempt and one destroy with fixed codes only", () => {
  const secret = "C:\\Users\\alice\\probe-secret";
  let opens = 0;
  const counters = { closes: 0, destroys: 0 };
  const result = probeMidiOutputSelection({
    selectedPort: 0,
    expectedName: "CustomMIDI1",
    outputFactory: () => ({
      getPortCount() { return 1; },
      getPortName() { return "CustomMIDI1"; },
      openPort() {
        opens += 1;
        throw new Error(`driver refused: ${secret}`);
      },
      closePort() { counters.closes += 1; },
      destroy() { counters.destroys += 1; },
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.probed, true);
  assert.equal(result.reason, "probe-open-failed");
  assert.equal(result.closeAttempted, true);
  assert.equal(result.closed, true);
  assert.equal(result.destroyed, true);
  assert.equal(result.released, true);
  assert.equal(opens, 1);
  assert.equal(counters.closes, 1);
  assert.equal(counters.destroys, 1);
  assert.equal(Object.hasOwn(result, "error"), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});
