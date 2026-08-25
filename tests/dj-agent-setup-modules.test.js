const test = require("node:test");
const assert = require("node:assert/strict");

const {
  enumerateMidiOutputs,
  normalizePortIndex,
  probeMidiOutputSelection,
  resolveMidiModule,
} = require("../server/dj-agent/midiPorts");
const {
  evaluateSetupReadiness,
  isSetupReady,
  RELEASE_MACRO_SEQUENCES,
  SETUP_GATE_NAMES,
  SYNDOCAL_ADAPTERS,
} = require("../server/dj-agent/setupChecklist");

function fakeOutput(names, { onOpen = null, onClose = null, onDestroy = null } = {}) {
  return {
    getPortCount() {
      return names.length;
    },
    getPortName(port) {
      return names[port];
    },
    openPort(port) {
      onOpen?.(port);
    },
    closePort() {
      onClose?.();
    },
    destroy() {
      onDestroy?.();
    },
  };
}

test("MIDI output enumeration reads names without opening or closing a port", () => {
  let opens = 0;
  let closes = 0;
  let destroys = 0;
  const result = enumerateMidiOutputs({
    outputFactory: () => fakeOutput(["Deck A", "Deck B"], {
      onOpen: () => { opens += 1; },
      onClose: () => { closes += 1; },
      onDestroy: () => { destroys += 1; },
    }),
  });

  assert.deepEqual(result, {
    ok: true,
    available: true,
    ports: [
      { port: 0, name: "Deck A" },
      { port: 1, name: "Deck B" },
    ],
    released: true,
  });
  assert.equal(opens, 0);
  assert.equal(closes, 0);
  assert.equal(destroys, 1);
});

test("MIDI enumeration fails closed when no optional MIDI module is available", () => {
  const result = enumerateMidiOutputs({
    midiModule: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.available, false);
  assert.equal(result.reason, "midi-unavailable");
  assert.deepEqual(result.ports, []);
  assert.equal(result.released, false);
});

test("MIDI enumeration fails closed when the native port count throws", () => {
  const result = enumerateMidiOutputs({
    outputFactory: () => ({
      getPortCount() {
        throw new Error("native enumeration failed");
      },
    }),
  });
  assert.deepEqual(result, {
    ok: false,
    available: false,
    ports: [],
    reason: "port-enumeration-unavailable",
    released: false,
  });
});

test("unsupported caller module names do not reach dynamic require", () => {
  assert.equal(resolveMidiModule("node:fs"), null);
});

test("MIDI port indexes accept only strict nonnegative integer representations", () => {
  assert.equal(normalizePortIndex(0), 0);
  assert.equal(normalizePortIndex("12"), 12);
  for (const value of ["", " 1 ", "01", "1.0", 1.5, true, {}, -1, "0x10", "1e2"]) {
    assert.equal(normalizePortIndex(value), null, `unexpectedly accepted ${String(value)}`);
  }
});

test("matching explicit MIDI selection opens and closes exactly once", () => {
  let opens = 0;
  let closes = 0;
  const result = probeMidiOutputSelection({
    selectedPort: 1,
    expectedName: "Deck B",
    outputFactory: () => fakeOutput(["Deck A", "Deck B"], {
      onOpen: (port) => {
        opens += 1;
        assert.equal(port, 1);
      },
      onClose: () => { closes += 1; },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.probed, true);
  assert.equal(result.opened, true);
  assert.equal(result.closed, true);
  assert.equal(result.nameVerified, true);
  assert.equal(result.released, true);
  assert.equal(opens, 1);
  assert.equal(closes, 1);
});

test("a selected-device mismatch is rejected before opening any port", () => {
  let opens = 0;
  let closes = 0;
  const result = probeMidiOutputSelection({
    selectedPort: 0,
    expectedName: "The other controller",
    outputFactory: () => fakeOutput(["Deck A"], {
      onOpen: () => { opens += 1; },
      onClose: () => { closes += 1; },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.probed, false);
  assert.equal(result.nameVerified, false);
  assert.equal(result.reason, "selected-device-mismatch");
  assert.equal(opens, 0);
  assert.equal(closes, 0);
});

test("a device identity change during the probe is rejected after the single lifecycle", () => {
  let opens = 0;
  let closes = 0;
  let name = "Deck A";
  const result = probeMidiOutputSelection({
    selectedPort: 0,
    expectedName: "Deck A",
    outputFactory: () => ({
      getPortCount: () => 1,
      getPortName: () => name,
      openPort: () => {
        opens += 1;
        name = "Different device";
      },
      closePort: () => {
        closes += 1;
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "probe-open-failed");
  assert.equal(result.nameVerified, false);
  assert.equal(opens, 1);
  assert.equal(closes, 1);
});

test("a failed open still has one deterministic close attempt and fails closed", () => {
  let opens = 0;
  let closes = 0;
  const result = probeMidiOutputSelection({
    selectedPort: 0,
    expectedName: "Deck A",
    outputFactory: () => ({
      ...fakeOutput(["Deck A"], {
        onOpen: () => { opens += 1; },
        onClose: () => { closes += 1; },
      }),
      openPort() {
        opens += 1;
        throw new Error("device busy");
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "probe-open-failed");
  assert.equal(result.closed, true);
  assert.equal(result.destroyed, true);
  assert.equal(result.released, true);
  assert.equal(opens, 1);
  assert.equal(closes, 1);
});

test("a close refusal fails the selection probe after one open and one close", () => {
  let opens = 0;
  let closes = 0;
  const result = probeMidiOutputSelection({
    selectedPort: 0,
    expectedName: "Deck A",
    outputFactory: () => ({
      ...fakeOutput(["Deck A"], {
        onOpen: () => { opens += 1; },
        onClose: () => { closes += 1; },
      }),
      closePort() {
        closes += 1;
        return false;
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "probe-close-failed");
  assert.equal(result.closed, false);
  assert.equal(result.destroyed, true);
  assert.equal(result.released, true);
  assert.equal(opens, 1);
  assert.equal(closes, 1);
});

test("an absent or invalid explicit selection never opens a MIDI port", () => {
  let opens = 0;
  const outputFactory = () => fakeOutput(["Deck A"], {
    onOpen: () => { opens += 1; },
  });

  const absent = probeMidiOutputSelection({ expectedName: "Deck A", outputFactory });
  const invalid = probeMidiOutputSelection({ expectedName: "Deck A", selectedPort: "not-a-port", outputFactory });

  assert.equal(absent.reason, "explicit-selection-required");
  assert.equal(invalid.reason, "explicit-selection-required");
  assert.equal(opens, 0);
});

test("probe requires an explicit expected device name", () => {
  let constructed = 0;
  const result = probeMidiOutputSelection({
    selectedPort: 0,
    outputFactory: () => {
      constructed += 1;
      return fakeOutput(["Deck A"]);
    },
  });
  assert.deepEqual(result, {
    ok: false,
    probed: false,
    nameVerified: false,
    reason: "expected-device-name-required",
  });
  assert.equal(constructed, 0);
});

test("enumeration destroys an unopen output and never calls closePort", () => {
  let closes = 0;
  let destroys = 0;
  const result = enumerateMidiOutputs({
    outputFactory: () => ({
      getPortCount: () => 0,
      closePort: () => { closes += 1; },
      destroy: () => { destroys += 1; },
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.released, true);
  assert.equal(closes, 0);
  assert.equal(destroys, 1);
});

test("probe does not read a port name after close", () => {
  let closed = false;
  let reads = 0;
  const result = probeMidiOutputSelection({
    selectedPort: 0,
    expectedName: "Deck A",
    outputFactory: () => ({
      getPortCount: () => 1,
      getPortName: () => {
        reads += 1;
        if (closed) {
          throw new Error("post-close read");
        }
        return "Deck A";
      },
      openPort: () => {},
      closePort: () => { closed = true; },
      destroy: () => {},
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.nameVerified, true);
  assert.equal(reads, 2);
});

test("setup readiness is pure, token-free, and allows only validated active gates", () => {
  const secret = "this-must-never-appear-in-readiness";
  const result = evaluateSetupReadiness({
    enabled: true,
    mapping: { ready: true },
    pedal: { enabled: true, ready: true },
    midi: { enabled: true, ready: true, selected: true, nameVerified: true },
    syndocal: { enabled: true, adapter: "generic-json", connected: true },
    macro: { enabled: true, sequence: "parallel", ready: true },
    token: secret,
    syndocalToken: secret,
  });

  assert.equal(result.state, "ready");
  assert.equal(result.ready, true);
  assert.equal(result.allowed, true);
  for (const name of SETUP_GATE_NAMES) {
    assert.equal(result.gates[name].state, "ready");
    assert.equal(result.gates[name].allowed, true);
  }
  assert.equal(result.actions.localMidi, true);
  assert.equal(result.actions.timeline, true);
  assert.equal(result.actions.releaseMacro, true);
  assert.equal(Object.hasOwn(result, "token"), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("mapping and probe result booleans can be consumed without copying payload data", () => {
  const result = evaluateSetupReadiness({
    enabled: true,
    mapping: { ok: true },
    pedal: { enabled: false },
    midi: { ok: true, probed: true, nameVerified: true },
    syndocal: { enabled: false },
    macro: { enabled: false },
  });

  assert.equal(result.gates.mapping.state, "ready");
  assert.equal(result.gates.midi.state, "ready");
  assert.equal(result.actions.localMidi, true);
});

test("a probe without verified device identity never enables the MIDI gate", () => {
  const result = evaluateSetupReadiness({
    enabled: true,
    mapping: { ready: true },
    pedal: { enabled: false },
    midi: { ok: true, probed: true, selected: true, nameVerified: false },
    syndocal: { enabled: false },
    macro: { enabled: false },
  });
  assert.equal(result.gates.midi.state, "blocked");
  assert.equal(result.gates.midi.reason, "midi-selection-required");
  assert.equal(result.actions.localMidi, false);
});

test("every explicitly disabled gate remains disabled and action-denied", () => {
  const result = evaluateSetupReadiness({
    enabled: true,
    mapping: { enabled: false, ready: true },
    pedal: { enabled: false, ready: true },
    midi: { enabled: false, ready: true, selected: true },
    syndocal: { enabled: false, adapter: SYNDOCAL_ADAPTERS[0], connected: true },
    macro: { enabled: false, sequence: RELEASE_MACRO_SEQUENCES[0], ready: true },
  });

  for (const name of SETUP_GATE_NAMES) {
    assert.equal(result.gates[name].state, "disabled");
    assert.equal(result.gates[name].allowed, false);
  }
  assert.equal(result.actions.localMidi, false);
  assert.equal(result.actions.timeline, false);
  assert.equal(result.actions.releaseMacro, false);
});

test("invalid adapter, macro sequence, and missing MIDI selection block setup", () => {
  const result = evaluateSetupReadiness({
    enabled: true,
    mapping: { ready: true },
    pedal: { enabled: false },
    midi: { enabled: true, ready: true, selected: false },
    syndocal: { enabled: true, adapter: "untrusted-adapter", connected: true },
    macro: { enabled: true, sequence: "best-effort", ready: true },
  });

  assert.equal(result.state, "blocked");
  assert.equal(result.ready, false);
  assert.equal(result.gates.midi.reason, "midi-selection-invalid");
  assert.equal(result.gates.syndocal.reason, "syndocal-adapter-invalid");
  assert.equal(Object.hasOwn(result.gates.syndocal, "adapter"), false);
  assert.equal(result.gates.macro.reason, "macro-sequence-invalid");
  assert.equal(result.actions.localMidi, false);
  assert.equal(result.actions.timeline, false);
  assert.equal(result.actions.releaseMacro, false);
});

test("missing active facts fail closed while the opt-in macro defaults disabled", () => {
  const result = evaluateSetupReadiness({
    enabled: true,
    mapping: {},
    pedal: { enabled: true },
    midi: { enabled: true },
    syndocal: { enabled: true, adapter: SYNDOCAL_ADAPTERS[1] },
  });

  assert.equal(result.state, "blocked");
  assert.equal(result.gates.mapping.reason, "mapping-not-ready");
  assert.equal(result.gates.pedal.reason, "pedal-not-ready");
  assert.equal(result.gates.midi.reason, "midi-not-ready");
  assert.equal(result.gates.syndocal.reason, "syndocal-not-ready");
  assert.equal(result.gates.macro.state, "disabled");
  assert.equal(isSetupReady(result), false);
});

test("a listening pedal transport is not physical verification", () => {
  const result = evaluateSetupReadiness({
    enabled: true,
    mapping: { ready: true },
    pedal: { enabled: true, state: "listening", available: true },
    midi: { enabled: false },
    syndocal: { enabled: false },
    macro: { enabled: false },
  });

  assert.equal(result.gates.pedal.state, "blocked");
  assert.equal(result.gates.pedal.reason, "pedal-not-ready");
  assert.equal(result.gates.pedal.allowed, false);
});

test("malformed or contradictory gate records never become disabled or ready", () => {
  const result = evaluateSetupReadiness({
    enabled: true,
    mapping: null,
    pedal: { enabled: true, ready: true, available: false },
    midi: { enabled: true, ready: true, available: false, selected: true },
    syndocal: { enabled: true, adapter: "generic-json", connected: true, available: false },
    macro: { enabled: true, sequence: "parallel", ready: true, valid: false },
  });

  assert.equal(result.state, "blocked");
  assert.equal(result.gates.mapping.state, "blocked");
  assert.equal(result.gates.mapping.reason, "mapping-status-invalid");
  assert.equal(result.gates.pedal.state, "blocked");
  assert.equal(result.gates.midi.state, "blocked");
  assert.equal(result.gates.syndocal.state, "blocked");
  assert.equal(result.gates.macro.state, "blocked");
  assert.equal(result.ready, false);
});

test("a disabled root denies every gate without inspecting child readiness", () => {
  const result = evaluateSetupReadiness({
    enabled: false,
    mapping: { ready: true },
    pedal: { enabled: true, ready: true },
    midi: { enabled: true, ready: true, selected: true },
    syndocal: { enabled: true, adapter: "generic-json", connected: true },
    macro: { enabled: true, sequence: "parallel", ready: true },
  });

  assert.equal(result.state, "disabled");
  assert.equal(result.ready, false);
  assert.equal(result.allowed, false);
  for (const name of SETUP_GATE_NAMES) {
    assert.equal(result.gates[name].state, "disabled");
    assert.equal(result.gates[name].allowed, false);
  }
  assert.equal(isSetupReady({}), false);
});

test("macro and releaseMacro cannot be supplied simultaneously", () => {
  const result = evaluateSetupReadiness({
    enabled: true,
    mapping: { ready: true },
    pedal: { enabled: false },
    midi: { enabled: false },
    syndocal: { enabled: false },
    macro: { enabled: false },
    releaseMacro: { enabled: true, sequence: "parallel", ready: true },
  });
  assert.equal(result.gates.macro.state, "blocked");
  assert.equal(result.gates.macro.reason, "macro-configuration-conflict");
  assert.equal(result.actions.releaseMacro, false);
});
