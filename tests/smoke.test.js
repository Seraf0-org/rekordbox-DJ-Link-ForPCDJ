const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const dgram = require("node:dgram");
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
const {
  asNumber,
  loadDjAgentConfig,
  normalizeDeckChannels,
} = require("../server/dj-agent/config");
const {
  createTrackActivityDetector,
  finiteNumber,
} = require("../server/dj-agent/trackActivityDetector");
const {
  createSyndocalClient,
  normalizeTimelineState,
  resolveAdapter,
} = require("../server/dj-agent/syndocalClient");
const { createRekordboxMidi, resolveMidiModule } = require("../server/dj-agent/rekordboxMidi");
const {
  createPedalController,
  keyFromUiohookEvent,
} = require("../server/dj-agent/pedalController");
const { createShowEventRouter } = require("../server/dj-agent/showEventRouter");
const {
  isLoopbackAddress,
  isLoopbackRequest,
  normalizeIp,
} = require("../server/dj-agent/httpSecurity");

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

test("DJ Agent configuration remains off without an explicit gate", () => {
  const config = loadDjAgentConfig({
    env: {
      DJ_AGENT_ENABLED: "",
      DJ_AGENT_CONFIG_PATH: "",
      DJ_AGENT_CONFIG: "",
    },
  });
  assert.equal(config.enabled, false);
  assert.equal(config.syndocal.enabled, false);
  assert.equal(config.pedal.enabled, false);
  assert.equal(config.midi.enabled, false);
  assert.equal(config.syndocal.adapter, "");
});

test("release macro is opt-in and keeps the documented Filter and ChannelFader defaults", () => {
  const baseEnv = {
    DJ_AGENT_ENABLED: "true",
    MIDI_ENABLED: "true",
    DJ_AGENT_CONFIG: JSON.stringify({
      midi: {
        mappings: {
          filter: { channel: 1, messageType: "controlChange", cc: 16 },
          releaseFade: { channel: 1, messageType: "controlChange", cc: 17 },
        },
      },
    }),
  };
  const legacy = loadDjAgentConfig({ env: baseEnv });
  assert.equal(legacy.midi.releaseMacro.enabled, false);
  assert.equal(legacy.midi.releaseMacro.sequence, "parallel");
  const macro = loadDjAgentConfig({
    env: {
      ...baseEnv,
      DJ_AGENT_CONFIG: JSON.stringify({
        midi: {
          mappings: {
            filter: { channel: 1, messageType: "controlChange", cc: 16 },
            releaseFade: { channel: 1, messageType: "controlChange", cc: 17 },
          },
          releaseMacro: { enabled: true, sequence: "filter-then-fade" },
        },
      }),
    },
  });
  assert.equal(macro.midi.releaseMacro.enabled, true);
  assert.equal(macro.midi.releaseMacro.sequence, "filter-then-fade");
  assert.deepEqual(macro.midi.releaseMacro.filter, {
    startValue: 64,
    endValue: 127,
    durationMs: 1000,
    updateIntervalMs: 50,
    resetValue: 64,
  });
  assert.equal(macro.midi.releaseMacro.resetAfterStop, true);
});

test("MIDI port config keeps missing values unset and honors device or explicit port zero", () => {
  assert.equal(asNumber(null, 7), 7);
  assert.equal(asNumber(undefined, 7), 7);
  assert.equal(asNumber("", 7), 7);

  const namedConfig = loadDjAgentConfig({
    env: {
      DJ_AGENT_ENABLED: "true",
      MIDI_ENABLED: "true",
      MIDI_DEVICE: "CustomMIDI1",
    },
  });
  assert.equal(namedConfig.midi.port, null);
  assert.equal(namedConfig.midi.device, "CustomMIDI1");

  const zeroConfig = loadDjAgentConfig({
    env: {
      DJ_AGENT_ENABLED: "true",
      MIDI_ENABLED: "true",
      MIDI_DEVICE: "CustomMIDI1",
      MIDI_PORT: "0",
    },
  });
  assert.equal(zeroConfig.midi.port, 0);
  const zeroNumberConfig = loadDjAgentConfig({
    env: {
      DJ_AGENT_ENABLED: "true",
      MIDI_ENABLED: "true",
      MIDI_PORT: 0,
    },
  });
  assert.equal(zeroNumberConfig.midi.port, 0);

  const openedNamed = [];
  const namedMidi = createRekordboxMidi({
    enabled: true,
    device: namedConfig.midi.device,
    port: namedConfig.midi.port,
    midiModule: {
      Output: class {
        getPortCount() { return 2; }
        getPortName(index) { return ["Microsoft GS Wavetable Synth", "CustomMIDI1"][index]; }
        openPort(index) { openedNamed.push(index); }
        closePort() {}
      },
    },
  });
  namedMidi.start();
  assert.deepEqual(openedNamed, [1]);
  namedMidi.stop();

  const openedZero = [];
  const zeroMidi = createRekordboxMidi({
    enabled: true,
    device: zeroConfig.midi.device,
    port: zeroConfig.midi.port,
    midiModule: {
      Output: class {
        getPortCount() { return 2; }
        getPortName(index) { return ["Microsoft GS Wavetable Synth", "CustomMIDI1"][index]; }
        openPort(index) { openedZero.push(index); }
        closePort() {}
      },
    },
  });
  zeroMidi.start();
  assert.deepEqual(openedZero, [0]);
  zeroMidi.stop();
});

test("deck MIDI channels override mapping channels and filter ramp messages", async () => {
  assert.deepEqual(normalizeDeckChannels({ "1": 1, "2": "2", bad: 0, "3": 17 }), {
    "1": 1,
    "2": 2,
  });
  const config = loadDjAgentConfig({
    env: {
      DJ_AGENT_ENABLED: "true",
      MIDI_ENABLED: "true",
      MIDI_DECK_CHANNELS: '{"1":1,"2":2,"3":17}',
    },
  });
  assert.deepEqual(config.midi.deckChannels, { "1": 1, "2": 2 });

  const messages = [];
  const sent = [];
  const midi = createRekordboxMidi({
    enabled: true,
    deckChannels: config.midi.deckChannels,
    mappings: {
      loopHalf: { channel: 1, messageType: "noteOn", note: 36, value: 127 },
      stop: { channel: 1, messageType: "noteOn", note: 37, value: 127 },
      filter: { channel: 1, messageType: "controlChange", cc: 16 },
      releaseFade: { channel: 1, messageType: "controlChange", cc: 17 },
    },
    filter: { startValue: 127, endValue: 0, durationMs: 20, updateIntervalMs: 5 },
    releaseFade: {
      enabled: true,
      mappingName: "releaseFade",
      target: "deck",
      startValue: 127,
      endValue: 0,
      durationMs: 20,
      updateIntervalMs: 5,
      resetValue: 127,
    },
    midiModule: {
      Output: class {
        getPortCount() { return 1; }
        openPort() {}
        closePort() {}
        sendMessage(message) { messages.push([...message]); }
      },
    },
  });
  midi.on("sent", (event) => sent.push(event));
  midi.start();

  assert.deepEqual(midi.resolveTarget("loopHalf", 2), { targetDeck: 2, targetChannel: 2 });
  assert.equal(midi.sendMapping("loopHalf", { targetDeck: 2 }), true);
  assert.deepEqual(messages[0], [0x91, 36, 127]);
  assert.deepEqual(sent[0], {
    message: [0x91, 36, 127],
    mapping: "loopHalf",
    targetDeck: 2,
    targetChannel: 2,
  });

  assert.equal(midi.sendMapping("stop", { targetDeck: 2 }), true);
  assert.deepEqual(messages[1], [0x91, 37, 127]);

  const ramp = midi.startFilterRamp({ targetDeck: 2, durationMs: 20, updateIntervalMs: 5 });
  assert.equal(ramp.started, true);
  assert.equal(ramp.targetDeck, 2);
  assert.equal(ramp.targetChannel, 2);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.ok(messages.length >= 3);
  assert.equal(messages.slice(2).every((message) => (message[0] & 0xf0) === 0xb0 && (message[0] & 0x0f) === 1), true);

  const fade = midi.startReleaseFade({ targetDeck: 2 });
  assert.equal(fade.started, true);
  assert.equal(fade.targetDeck, 2);
  assert.equal(fade.targetChannel, 2);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(messages.slice(-5).every((message) => (message[0] & 0xf0) === 0xb0 && (message[0] & 0x0f) === 1), true);
  const reset = midi.resetReleaseFade({ targetDeck: 2 });
  assert.equal(reset.ok, true);
  assert.equal((messages.at(-1)[0] & 0x0f), 1);

  // An unmapped deck preserves the mapping's configured channel.
  assert.equal(midi.sendMapping("loopHalf", { targetDeck: 3 }), true);
  assert.deepEqual(messages.at(-1), [0x90, 36, 127]);
  midi.stop();
});

test("router sends pedal MIDI to the detector current master deck", () => {
  const detector = createTrackActivityDetector({ idFactory: () => "master-midi-id" });
  detector.onSnapshot({
    masterDeck: 2,
    deckNowPlaying: [{ deck: 2, contentId: "deck-2", title: "Deck 2", artist: "Artist" }],
    deckPlaybacks: [{ deck: 2, isPlaying: true }],
  });
  const midiCalls = [];
  const midi = {
    resolveTarget(name, targetDeck) {
      return { targetDeck, targetChannel: targetDeck === 2 ? 2 : 1 };
    },
    sendMapping(name, options) {
      midiCalls.push({ name, options });
      return true;
    },
    startFilterRamp(options) {
      midiCalls.push({ name: "filter", options });
      return { started: true, ok: true, targetDeck: options.targetDeck, targetChannel: 2 };
    },
    getStatus: () => ({ ok: true }),
    start() {},
    stop() {},
  };
  let eventId = 0;
  const client = {
    sendEvent(event) {
      return { sent: true, ok: true, state: "acknowledged", eventId: event.eventId || `midi-event-${++eventId}` };
    },
    getStatus: () => ({ state: "connected" }),
    start() {},
    stop() {},
  };
  const pedal = { start() {}, stop() {}, getStatus: () => ({ ok: true }) };
  const router = createShowEventRouter({ detector, syndocalClient: client, midi, pedal });
  const events = [];
  router.on("event", (event) => events.push(event));

  const loop = router.triggerAction("loop-half");
  assert.deepEqual(midiCalls[0], { name: "loopHalf", options: { targetDeck: 2 } });
  assert.equal(loop.targetDeck, 2);
  assert.equal(loop.targetChannel, 2);
  assert.equal(events[0].payload.targetDeck, 2);
  assert.equal(events[0].payload.targetChannel, 2);

  const filter = router.triggerAction("filter-close");
  assert.equal(filter.ignored, true);
  assert.equal(filter.state, "inactive");
  assert.equal(midiCalls.length, 1);

  const release = router.triggerAction("release");
  assert.deepEqual(midiCalls[1], { name: "stop", options: { targetDeck: 2 } });
  assert.equal(release.targetDeck, 2);
  assert.equal(release.targetChannel, 2);
  assert.equal(events.at(-1).payload.targetDeck, 2);
  assert.equal(events.at(-1).payload.targetChannel, 2);
  router.stop();
});

test("stage 1 release macro runs filter and channel fader in parallel before stop and release", async (t) => {
  const detector = createTrackActivityDetector({ idFactory: () => "macro-track-id" });
  detector.onSnapshot({
    masterDeck: 1,
    deckNowPlaying: [{ deck: 1, contentId: "macro-track", title: "Macro", artist: "Artist" }],
    deckPlaybacks: [{ deck: 1, isPlaying: true, positionSec: 12 }],
  });
  const midiCalls = [];
  const midi = {
    resolveTarget(_name, targetDeck) {
      return { targetDeck, targetChannel: targetDeck === 1 ? 1 : null };
    },
    hasReleaseFade: () => true,
    sendMapping(name, options) {
      midiCalls.push({ name, options });
      return true;
    },
    startFilterRamp(options) {
      midiCalls.push({ name: "filter-ramp", options });
      setTimeout(() => options.onComplete?.({ targetChannel: 1, startValue: 64, endValue: 127 }), 5);
      return { started: true, ok: true, targetDeck: 1, targetChannel: 1 };
    },
    startReleaseFade(options) {
      midiCalls.push({ name: "fade-ramp", options });
      setTimeout(() => options.onComplete?.({ targetChannel: 1, resetValue: 127 }), 5);
      return { started: true, ok: true, targetDeck: 1, targetChannel: 1, resetValue: 127 };
    },
    resetReleaseFade(options) {
      midiCalls.push({ name: "fade-reset", options });
      return { ok: true, targetChannel: 1 };
    },
    cancelFilterRamp: () => {},
    cancelReleaseFade: () => {},
    getStatus: () => ({ ok: true }),
    start() {},
    stop() {},
  };
  const client = {
    sendEvent(event) {
      return {
        eventId: event.eventId || "macro-release-event",
        type: event.type,
        sent: true,
        ok: true,
        state: "acknowledged",
        ackState: "acknowledged",
      };
    },
    getStatus: () => ({ enabled: false, state: "disabled" }),
    start() {},
    stop() {},
  };
  const pedal = { start() {}, stop() {}, getStatus: () => ({ ok: true }) };
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal,
    releaseMacro: {
      enabled: true,
      filter: { startValue: 64, endValue: 127, durationMs: 10, updateIntervalMs: 5, resetValue: 64 },
      resetAfterStop: true,
      resetDelayMs: 0,
    },
  });
  t.after(() => router.stop());

  const inactive = router.triggerAction("filter-close");
  assert.equal(inactive.ignored, true);
  assert.equal(midiCalls.length, 0);

  const pending = router.triggerAction("release");
  assert.equal(pending.pending, true);
  assert.deepEqual(midiCalls.slice(0, 2).map((call) => call.name), ["filter-ramp", "fade-ramp"]);
  assert.equal(router.triggerAction("release").reason, "release-macro-in-progress");
  assert.equal(midiCalls.some((call) => call.name === "stop"), false);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(midiCalls.map((call) => call.name), [
    "filter-ramp",
    "fade-ramp",
    "stop",
    "filter",
    "fade-reset",
  ]);
  assert.equal(midiCalls[2].options.targetDeck, 1);
  assert.equal(midiCalls[3].options.value, 64);
  assert.equal(midiCalls[4].options.value, 127);
});

test("filter-then-fade release macro waits for Filter completion before any fade MIDI", async (t) => {
  const detector = createTrackActivityDetector({ idFactory: () => "serial-macro-id" });
  detector.onSnapshot({
    masterDeck: 1,
    deckNowPlaying: [{ deck: 1, contentId: "serial-track" }],
    deckPlaybacks: [{ deck: 1, isPlaying: true }],
  });
  const calls = [];
  let filterOptions = null;
  let fadeOptions = null;
  const midi = {
    resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: 1 }),
    sendMapping(name, options) {
      calls.push({ name, value: options?.value ?? null });
      return true;
    },
    startFilterRamp(options) {
      filterOptions = options;
      calls.push({ name: "filter-start" });
      return { started: true, ok: true, targetDeck: 1, targetChannel: 1 };
    },
    startReleaseFade(options) {
      fadeOptions = options;
      calls.push({ name: "fade-start" });
      return { started: true, ok: true, targetDeck: 1, targetChannel: 1, resetValue: 127 };
    },
    resetReleaseFade() {
      calls.push({ name: "fade-reset" });
      return { ok: true };
    },
    cancelFilterRamp: () => {},
    cancelReleaseFade: () => {},
    getStatus: () => ({ ok: true }),
    start() {},
    stop() {},
  };
  const client = {
    sendEvent: (event) => ({ eventId: "serial-release", type: event.type, ok: true, state: "acknowledged" }),
    getStatus: () => ({ enabled: false, state: "disabled" }),
    start() {},
    stop() {},
  };
  const actions = [];
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
    releaseMacro: {
      enabled: true,
      sequence: "filter-then-fade",
      filter: { startValue: 64, endValue: 127, durationMs: 1000, updateIntervalMs: 50, resetValue: 64 },
      resetAfterStop: true,
      resetDelayMs: 0,
    },
  });
  router.on("action", (action) => actions.push(action));
  t.after(() => router.stop());

  const pending = router.triggerAction("release");
  assert.equal(pending.sequence, "filter-then-fade");
  assert.equal(pending.phase, "filter-ramp");
  assert.deepEqual(calls, [{ name: "filter-start" }]);
  assert.equal(fadeOptions, null);

  filterOptions.onComplete({ targetChannel: 1, startValue: 64, endValue: 127 });
  assert.deepEqual(calls, [{ name: "filter-start" }, { name: "fade-start" }]);
  assert.equal(router.getStatus().releaseMacroPhase, "fade-ramp");
  assert.equal(fadeOptions != null, true);
  assert.equal(calls.some((call) => call.name === "stop"), false);

  fadeOptions.onComplete({ targetChannel: 1, startValue: 127, endValue: 0, resetValue: 127 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls.map((call) => call.name), [
    "filter-start",
    "fade-start",
    "stop",
    "filter",
    "fade-reset",
  ]);
  assert.equal(actions.at(-1).sequence, "filter-then-fade");
  assert.equal(actions.at(-1).phase, "complete");
});

test("filter-then-fade failures never start the next phase or Stop/Release", () => {
  const makeRouter = ({ filterFailure = false } = {}) => {
    const detector = createTrackActivityDetector({ idFactory: () => `serial-failure-${filterFailure}` });
    detector.onSnapshot({
      masterDeck: 1,
      deckNowPlaying: [{ deck: 1, contentId: "serial-failure-track" }],
      deckPlaybacks: [{ deck: 1, isPlaying: true }],
    });
    const calls = [];
    let filterOptions = null;
    let fadeOptions = null;
    const midi = {
      resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: 1 }),
      sendMapping: (name) => { calls.push(name); return true; },
      startFilterRamp: (options) => {
        filterOptions = options;
        calls.push("filter-start");
        return { started: true, ok: true, targetChannel: 1 };
      },
      startReleaseFade: (options) => {
        fadeOptions = options;
        calls.push("fade-start");
        return { started: true, ok: true, targetChannel: 1, resetValue: 127 };
      },
      resetReleaseFade: () => { calls.push("fade-reset"); return { ok: true }; },
      cancelFilterRamp: () => {},
      cancelReleaseFade: () => {},
      getStatus: () => ({ ok: true }),
      start() {},
      stop() {},
    };
    const sent = [];
    const client = {
      sendEvent: (event) => { sent.push(event); return { eventId: "must-not-release", ok: true, state: "acknowledged" }; },
      getStatus: () => ({ enabled: false, state: "disabled" }),
      start() {},
      stop() {},
    };
    const router = createShowEventRouter({
      detector,
      syndocalClient: client,
      midi,
      pedal: { start() {}, stop() {}, getStatus: () => ({}) },
      releaseMacro: {
        enabled: true,
        sequence: "filter-then-fade",
        filter: { startValue: 64, endValue: 127, resetValue: 64 },
        resetAfterStop: true,
      },
    });
    return { router, calls, filterOptions, fadeOptions, client, sent, getFilter: () => filterOptions, getFade: () => fadeOptions };
  };

  const filterCase = makeRouter({ filterFailure: true });
  filterCase.router.triggerAction("release");
  filterCase.getFilter().onError({ reason: "filter-failed" });
  assert.deepEqual(filterCase.calls, ["filter-start"]);
  assert.deepEqual(filterCase.sent, []);
  filterCase.router.stop();

  const fadeCase = makeRouter();
  fadeCase.router.triggerAction("release");
  fadeCase.getFilter().onComplete({ targetChannel: 1 });
  fadeCase.getFade().onError({ reason: "fade-failed" });
  assert.deepEqual(fadeCase.calls, ["filter-start", "fade-start", "filter"]);
  assert.deepEqual(fadeCase.sent, []);
  assert.equal(fadeCase.router.getStatus().releaseMacroPhase, "failed");
  fadeCase.router.stop();
});

test("serial fade synchronous first-CC failure resets Filter exactly once", () => {
  const detector = createTrackActivityDetector({ idFactory: () => "serial-sync-failure-id" });
  detector.onSnapshot({
    masterDeck: 1,
    deckNowPlaying: [{ deck: 1, contentId: "serial-sync-failure-track" }],
    deckPlaybacks: [{ deck: 1, isPlaying: true }],
  });
  const midiCalls = [];
  let filterOptions = null;
  const midi = {
    resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: 1 }),
    sendMapping: (name, options) => {
      midiCalls.push({ name, value: options?.value ?? null });
      return true;
    },
    startFilterRamp: (options) => {
      filterOptions = options;
      return { started: true, ok: true, targetChannel: 1 };
    },
    startReleaseFade: (options) => {
      options.onError({ reason: "first-cc-failed" });
      return { started: true, ok: true, targetChannel: 1, resetValue: 127 };
    },
    cancelFilterRamp: () => {},
    cancelReleaseFade: () => {},
    getStatus: () => ({ ok: false }),
    start() {},
    stop() {},
  };
  const sent = [];
  const client = {
    sendEvent: (event) => {
      sent.push(event);
      return { eventId: "must-not-release", type: event.type, ok: true, state: "acknowledged" };
    },
    getStatus: () => ({ enabled: false, state: "disabled" }),
    start() {},
    stop() {},
  };
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
    releaseMacro: {
      enabled: true,
      sequence: "filter-then-fade",
      filter: { startValue: 64, endValue: 127, resetValue: 64 },
    },
  });
  const pending = router.triggerAction("release");
  assert.equal(pending.pending, true);
  filterOptions.onComplete({ targetChannel: 1 });

  const status = router.getStatus();
  assert.equal(status.releaseMacroPhase, "failed");
  assert.equal(status.releaseMacroReason, "release-fade-ramp-failed");
  assert.equal(status.lastAction.phase, "failed");
  assert.equal(midiCalls.filter((call) => call.name === "filter" && call.value === 64).length, 1);
  assert.equal(midiCalls.some((call) => call.name === "stop"), false);
  assert.deepEqual(sent, []);
  router.stop();
});

test("release macro failure is truthful and never advances to stop or DJ_RELEASE", () => {
  const detector = createTrackActivityDetector({ idFactory: () => "macro-failure-id" });
  detector.onSnapshot({
    masterDeck: 1,
    deckNowPlaying: [{ deck: 1, contentId: "failure-track" }],
    deckPlaybacks: [{ deck: 1, isPlaying: true }],
  });
  const midiCalls = [];
  const midi = {
    resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: 1 }),
    hasReleaseFade: () => true,
    sendMapping: (name) => { midiCalls.push(name); return true; },
    startFilterRamp: () => ({ started: true, ok: true }),
    startReleaseFade: () => ({ started: false, ok: false, reason: "midi-not-connected" }),
    cancelFilterRamp: () => {},
    cancelReleaseFade: () => {},
    getStatus: () => ({ ok: false }),
    start() {},
    stop() {},
  };
  const sent = [];
  const client = {
    sendEvent: (event) => { sent.push(event); return { eventId: "unused", ok: true, state: "acknowledged" }; },
    getStatus: () => ({ enabled: false, state: "disabled" }),
    start() {},
    stop() {},
  };
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
    releaseMacro: { enabled: true, filter: { startValue: 64, endValue: 127 } },
  });
  const result = router.triggerAction("release");
  assert.equal(result.ok, false);
  assert.match(result.reason, /release-fade|midi-not-connected/);
  assert.deepEqual(midiCalls, ["filter"]);
  assert.deepEqual(sent, []);
  router.stop();
});

test("timeline-control maps pedals to ACKed timeline actions without MIDI and fails closed on disconnect", () => {
  const detector = createTrackActivityDetector({ idFactory: () => "timeline-id" });
  const midiCalls = [];
  const midi = {
    sendMapping: (name) => { midiCalls.push(name); return true; },
    startFilterRamp: () => { midiCalls.push("filter-ramp"); return { started: true }; },
    start() {},
    stop() {},
    getStatus: () => ({ ok: true }),
  };
  const client = new EventEmitter();
  let connection = { enabled: true, state: "connected" };
  let nextEventId = 0;
  const sent = [];
  client.sendEvent = (event) => {
    const eventId = `timeline-event-${++nextEventId}`;
    sent.push({ ...event, eventId });
    return {
      eventId,
      type: event.type,
      sent: true,
      ok: true,
      state: "acknowledged",
      ackState: "acknowledged",
    };
  };
  client.getStatus = () => ({ ...connection });
  client.start = () => {};
  client.stop = () => {};
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
  });

  client.emit("timeline-state", {
    type: "DJ_TIMELINE_STATE",
    state: "running",
    loopActive: false,
    timelineId: "show-1",
    positionBars: 32,
  });
  assert.equal(router.getStatus().mode, "timeline-control");
  const minus = router.triggerAction("release");
  assert.equal(minus.ok, true);
  assert.equal(sent.at(-1).type, "DJ_TIMELINE_BEAT_JUMP");
  assert.equal(sent.at(-1).payload.bars, -4);
  client.emit("delivery", {
    eventId: sent.at(-1).eventId,
    type: "DJ_TIMELINE_BEAT_JUMP",
    state: "rejected",
    ackState: "rejected",
    ok: false,
    reason: "timeline denied",
  });
  assert.equal(router.getStatus().lastTimelineAction.delivery.state, "rejected");
  assert.equal(router.getStatus().lastTimelineAction.ok, false);
  const loop = router.triggerAction("loop-half");
  assert.equal(loop.ok, true);
  assert.equal(sent.at(-1).type, "DJ_TIMELINE_LOOP_SET");
  assert.equal(sent.at(-1).payload.active, true);
  assert.deepEqual(midiCalls, []);

  // An ACK does not invent authoritative state; the next broadcast releases
  // the idempotence guard and supplies the next absolute loop value.
  client.emit("timeline-state", {
    type: "DJ_TIMELINE_STATE",
    state: "running",
    loopActive: true,
    timelineId: "show-1",
    positionBars: 32,
  });
  const plus = router.triggerAction("filter-close");
  assert.equal(plus.ok, true);
  assert.equal(sent.at(-1).type, "DJ_TIMELINE_BEAT_JUMP");
  assert.equal(sent.at(-1).payload.bars, 4);
  client.emit("delivery", {
    eventId: sent.at(-1).eventId,
    type: "DJ_TIMELINE_BEAT_JUMP",
    state: "timed-out",
    ackState: "timed-out",
    ok: false,
    reason: "ack-timeout",
  });
  assert.equal(router.getStatus().lastTimelineAction.delivery.state, "timed-out");
  assert.equal(router.getStatus().lastTimelineAction.ok, false);
  const loopOff = router.triggerAction("loop-half");
  assert.equal(loopOff.ok, true);
  assert.equal(sent.at(-1).payload.active, false);

  connection = { enabled: true, state: "disconnected" };
  client.emit("status", connection);
  const blocked = router.triggerAction("release");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "timeline-network-disconnected");
  assert.deepEqual(midiCalls, []);
  connection = { enabled: true, state: "connected" };
  client.emit("status", connection);
  assert.equal(router.getStatus().mode, "timeline-control");
  assert.equal(router.triggerAction("release").reason, "timeline-state-pending");
  client.emit("timeline-state", { state: "ended", loopActive: false, timelineId: "show-1" });
  assert.equal(router.getStatus().mode, "dj-control");
  router.stop();
});

test("Syndocal enabled gates every Stage 1 pedal until a non-running snapshot, including reconnect", () => {
  const detector = createTrackActivityDetector({ idFactory: () => "snapshot-gate-id" });
  const client = new EventEmitter();
  let connection = { enabled: true, state: "disconnected" };
  const sent = [];
  client.getStatus = () => ({ ...connection });
  client.sendEvent = (event) => {
    const eventId = `gate-${sent.length + 1}`;
    sent.push({ ...event, eventId });
    return { eventId, type: event.type, sent: true, ok: true, state: "acknowledged", ackState: "acknowledged" };
  };
  client.start = () => {};
  client.stop = () => {};
  const midiCalls = [];
  const midi = {
    sendMapping: (name) => { midiCalls.push(name); return true; },
    resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: 1 }),
    getStatus: () => ({ ok: true }),
    start() {},
    stop() {},
  };
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
  });

  assert.equal(router.triggerAction("release").reason, "timeline-state-pending");
  assert.equal(router.triggerAction("loop-half").reason, "timeline-state-pending");
  assert.equal(router.triggerAction("filter-close").reason, "timeline-state-pending");
  assert.deepEqual(midiCalls, []);

  connection = { enabled: true, state: "connected" };
  client.emit("status", connection);
  assert.equal(router.triggerAction("loop-half").reason, "timeline-state-pending");
  assert.deepEqual(midiCalls, []);

  client.emit("timeline-state", { state: "idle", loopActive: false });
  assert.equal(router.getStatus().mode, "dj-control");
  assert.equal(router.triggerAction("loop-half").midiSent, true);
  assert.deepEqual(midiCalls, ["loopHalf"]);

  connection = { enabled: true, state: "disconnected" };
  client.emit("status", connection);
  assert.equal(router.triggerAction("release").reason, "timeline-state-pending");
  assert.deepEqual(midiCalls, ["loopHalf"]);
  connection = { enabled: true, state: "connected" };
  client.emit("status", connection);
  assert.equal(router.triggerAction("loop-half").reason, "timeline-state-pending");
  assert.deepEqual(midiCalls, ["loopHalf"]);

  client.emit("timeline-state", { state: "stopped", loopActive: false });
  assert.equal(router.triggerAction("filter-close").ignored, true);
  assert.deepEqual(midiCalls, ["loopHalf"]);
  router.stop();
});

test("release handoff failures never stick in handoff-pending and running wins the late-failure race", () => {
  const detector = createTrackActivityDetector({ idFactory: () => "handoff-lifecycle-id" });
  const client = new EventEmitter();
  const connection = { enabled: true, state: "connected" };
  const sent = [];
  client.getStatus = () => ({ ...connection });
  client.sendEvent = (event) => {
    const eventId = `release-${sent.length + 1}`;
    sent.push({ ...event, eventId });
    return { eventId, type: event.type, sent: true, ok: false, state: "pending", ackState: "pending" };
  };
  client.start = () => {};
  client.stop = () => {};
  const midiCalls = [];
  const midi = {
    sendMapping: (name) => { midiCalls.push(name); return true; },
    resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: 1 }),
    getStatus: () => ({ ok: true }),
    start() {},
    stop() {},
  };
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
  });
  router.on("warning", () => {});
  client.emit("timeline-state", { state: "idle", loopActive: false });

  const first = router.triggerAction("release");
  assert.equal(first.delivery.state, "pending");
  assert.equal(router.getStatus().mode, "handoff-pending");
  client.emit("delivery", {
    eventId: first.delivery.eventId,
    type: "DJ_RELEASE",
    state: "rejected",
    ackState: "rejected",
    ok: false,
    reason: "denied",
  });
  assert.equal(router.getStatus().mode, "dj-control");
  assert.equal(router.getStatus().releaseMacroPhase, "failed");
  assert.equal(router.getStatus().releaseMacroReason, "denied");
  assert.equal(router.getStatus().lastAction.phase, "failed");
  assert.equal(router.getStatus().lastAction.reason, "denied");

  const second = router.triggerAction("release");
  assert.equal(second.delivery.state, "pending");
  client.emit("delivery", {
    eventId: second.delivery.eventId,
    type: "DJ_RELEASE",
    state: "timed-out",
    ackState: "timed-out",
    ok: false,
    reason: "ack-timeout",
  });
  assert.equal(router.getStatus().mode, "dj-control");
  assert.equal(router.getStatus().releaseMacroPhase, "failed");
  assert.equal(router.getStatus().releaseMacroReason, "ack-timeout");
  assert.equal(router.getStatus().lastAction.phase, "failed");
  assert.equal(router.getStatus().lastAction.reason, "ack-timeout");

  const third = router.triggerAction("release");
  assert.equal(router.getStatus().mode, "handoff-pending");
  client.emit("timeline-state", { state: "running", loopActive: false, timelineId: "show-1" });
  assert.equal(router.getStatus().mode, "timeline-control");
  assert.equal(router.getStatus().releaseMacroPhase, "complete");
  assert.equal(router.getStatus().lastAction.phase, "complete");
  assert.equal(router.getStatus().lastAction.mode, "timeline-control");
  client.emit("delivery", {
    eventId: third.delivery.eventId,
    type: "DJ_RELEASE",
    state: "rejected",
    ackState: "rejected",
    ok: false,
    reason: "late-denied",
  });
  assert.equal(router.getStatus().mode, "timeline-control");
  assert.equal(router.getStatus().releaseMacroPhase, "complete");
  assert.equal(router.getStatus().lastAction.phase, "complete");
  assert.deepEqual(midiCalls, ["stop", "stop", "stop"]);
  router.stop();
});

test("synchronous DJ_RELEASE send failure returns to dj-control and remains retryable", () => {
  const detector = createTrackActivityDetector({ idFactory: () => "sync-release-failure-id" });
  const client = new EventEmitter();
  client.getStatus = () => ({ enabled: true, state: "connected" });
  client.sendEvent = (event) => ({
    eventId: "sync-release-failed",
    type: event.type,
    sent: false,
    ok: false,
    state: "send-failed",
    ackState: "send-failed",
    reason: "not-sent",
  });
  client.start = () => {};
  client.stop = () => {};
  let stops = 0;
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi: {
      sendMapping: (name) => { if (name === "stop") stops += 1; return true; },
      resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: 1 }),
      getStatus: () => ({ ok: true }),
      start() {},
      stop() {},
    },
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
  });
  client.emit("timeline-state", { state: "idle", loopActive: false });
  const first = router.triggerAction("release");
  assert.equal(first.delivery.state, "send-failed");
  assert.equal(router.getStatus().mode, "dj-control");
  assert.equal(router.getStatus().releaseMacroPhase, "failed");
  assert.equal(router.getStatus().releaseMacroReason, "not-sent");
  assert.equal(router.getStatus().lastAction.phase, "failed");
  assert.equal(stops, 1);
  const second = router.triggerAction("release");
  assert.equal(second.delivery.state, "send-failed");
  assert.equal(router.getStatus().mode, "dj-control");
  assert.equal(stops, 2);
  router.stop();
});

test("legacy release local MIDI failure sends no DJ_RELEASE and does not enter handoff", () => {
  const detector = createTrackActivityDetector({ idFactory: () => "legacy-failure-id" });
  const sent = [];
  const client = new EventEmitter();
  client.sendEvent = (event) => { sent.push(event); return { eventId: "should-not-send", ok: true, state: "acknowledged" }; };
  client.getStatus = () => ({ enabled: true, state: "connected" });
  client.start = () => {};
  client.stop = () => {};
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi: {
      sendMapping: () => false,
      resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: 1 }),
      getStatus: () => ({ ok: false }),
      start() {},
      stop() {},
    },
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
  });
  client.emit("timeline-state", { state: "idle", loopActive: false });
  const result = router.triggerAction("release");
  assert.equal(result.reason, "local-midi-failed");
  assert.equal(router.getStatus().mode, "dj-control");
  assert.deepEqual(sent, []);
  router.stop();
});

test("track activity does not make a track load a master timeline event", () => {
  let id = 0;
  const detector = createTrackActivityDetector({ idFactory: () => `id-${++id}` });
  const events = [];
  detector.on("event", (event) => events.push(event));

  detector.onTrackLoaded({ deck: 1, contentId: "track-a" });
  detector.onSnapshot({
    masterDeck: 1,
    deckNowPlaying: [{ deck: 1, contentId: "track-a", title: "A", artist: "Artist" }],
    deckPlaybacks: [{ deck: 1, isPlaying: false, positionSec: 0 }],
  });
  assert.deepEqual(events.map((event) => event.type), ["DJ_TRACK_LOADED"]);

  detector.onSnapshot({
    masterDeck: 1,
    deckNowPlaying: [{ deck: 1, contentId: "track-a", title: "A", artist: "Artist" }],
    deckPlaybacks: [{ deck: 1, isPlaying: true, positionSec: 0.1 }],
  });
  assert.deepEqual(events.map((event) => event.type), [
    "DJ_TRACK_LOADED",
    "DJ_TRACK_PLAY_STARTED",
    "DJ_MASTER_TRACK_ACTIVE",
  ]);
  detector.onSnapshot({
    masterDeck: 1,
    deckNowPlaying: [{ deck: 1, contentId: "track-a", title: "A", artist: "Artist" }],
    deckPlaybacks: [{ deck: 1, isPlaying: true, positionSec: 0.2 }],
  });
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 1);
});

test("explicit master change activates an already-playing deck exactly once", () => {
  let id = 0;
  const detector = createTrackActivityDetector({ idFactory: () => `id-${++id}` });
  const events = [];
  detector.on("event", (event) => events.push(event));
  detector.onSnapshot({
    masterDeck: 1,
    deckNowPlaying: [
      { deck: 1, contentId: "a", title: "A", artist: "One" },
      { deck: 2, contentId: "b", title: "B", artist: "Two" },
    ],
    deckPlaybacks: [
      { deck: 1, isPlaying: false, positionSec: 0 },
      { deck: 2, isPlaying: true, positionSec: 4 },
    ],
  });
  detector.onMasterChange({ deck: 2 });
  detector.onMasterChange({ deck: 2 });
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_CHANGED").length, 1);
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 1);
  assert.equal(events.find((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").payload.contentId, "b");
});

test("contentId enrichment after fallback metadata does not duplicate one play session", () => {
  let id = 0;
  let time = 1_000;
  const detector = createTrackActivityDetector({
    idFactory: () => `id-${++id}`,
    now: () => time,
  });
  const events = [];
  detector.on("event", (event) => events.push(event));

  detector.onSnapshot({
    masterDeck: 1,
    deckNowPlaying: [{ deck: 1, title: "Fallback Track", artist: "Artist" }],
    deckPlaybacks: [{ deck: 1, isPlaying: true }],
  });
  const firstActive = events.find((event) => event.type === "DJ_MASTER_TRACK_ACTIVE");
  const firstState = detector.getState().decks[1];

  time = 2_000;
  detector.onTrackLoaded({
    logicalDeck: 1,
    contentId: "content-42",
    title: "Fallback Track",
    artist: "Artist",
  });
  time = 3_000;
  detector.onSnapshot({
    masterDeck: 1,
    deckNowPlaying: [{ deck: 1, contentId: "content-42", title: "Fallback Track", artist: "Artist" }],
    deckPlaybacks: [{ deck: 1, isPlaying: true }],
  });

  const state = detector.getState().decks[1];
  assert.equal(finiteNumber(null), null);
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 1);
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_LOADED").length, 1);
  assert.equal(firstActive.payload.playSessionId, state.playSessionId);
  assert.equal(firstActive.payload.startedAt, state.startedAt);
  assert.equal(state.track.contentId, "content-42");
  assert.equal(state.playSessionId, firstState.playSessionId);
  assert.equal(state.startedAt, firstState.startedAt);
});

test("a preloaded track with stale isPlaying waits for explicit play transition", () => {
  let id = 0;
  let time = 10_000;
  const detector = createTrackActivityDetector({
    idFactory: () => `change-id-${++id}`,
    now: () => time,
  });
  const events = [];
  detector.on("event", (event) => events.push(event));
  detector.onSnapshot({
    masterDeck: 1,
    deckNowPlaying: [{ deck: 1, contentId: "old", title: "Old", artist: "Artist" }],
    deckPlaybacks: [{ deck: 1, isPlaying: true }],
  });
  const previous = detector.getState().decks[1];
  time = 11_000;
  detector.onTrackLoaded({ deck: 1, contentId: "new", title: "New", artist: "Artist" });
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 1);

  detector.onSnapshot({
    masterDeck: 1,
    deckNowPlaying: [{ deck: 1, contentId: "new", title: "New", artist: "Artist" }],
    deckPlaybacks: [{ deck: 1, isPlaying: true }],
  });
  const preloaded = detector.getState().decks[1];
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 1);
  assert.equal(preloaded.playSessionId, null);
  assert.equal(preloaded.awaitingPlayConfirmation, true);

  detector.onSnapshot({
    masterDeck: 1,
    deckNowPlaying: [{ deck: 1, contentId: "new", title: "New", artist: "Artist" }],
    deckPlaybacks: [{ deck: 1, isPlaying: false }],
  });
  time = 12_000;
  detector.onSnapshot({
    masterDeck: 1,
    deckNowPlaying: [{ deck: 1, contentId: "new", title: "New", artist: "Artist" }],
    deckPlaybacks: [{ deck: 1, isPlaying: true }],
  });
  const next = detector.getState().decks[1];
  assert.notEqual(next.playSessionId, previous.playSessionId);
  assert.equal(next.startedAt, new Date(time).toISOString());
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 2);
});

test("master_change emits an already-playing deck with only an IsPlaying snapshot", () => {
  let id = 0;
  const detector = createTrackActivityDetector({ idFactory: () => `id-${++id}` });
  const events = [];
  detector.on("event", (event) => events.push(event));
  detector.onSnapshot({
    masterDeck: 1,
    deckNowPlaying: [
      { deck: 1, contentId: "a", title: "A", artist: "One" },
      { deck: 2, contentId: "b", title: "B", artist: "Two" },
    ],
    deckPlaybacks: [
      { deck: 1, isPlaying: false },
      { deck: 2, isPlaying: true },
    ],
  });
  detector.onMasterChange({ deck: 2 });
  detector.onMasterChange({ deck: 2 });
  const activeEvents = events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE");
  assert.equal(activeEvents.length, 1);
  assert.equal(activeEvents[0].payload.positionSec, null);
  assert.equal(activeEvents[0].payload.contentId, "b");
});

test("Hook provider order keeps fallback track active emission single", async (t) => {
  const port = 45_000 + Math.floor(Math.random() * 1_000);
  const provider = createHookUdpProvider({ enabled: true, port });
  const detector = createTrackActivityDetector({ idFactory: (() => {
    let id = 0;
    return () => `provider-id-${++id}`;
  })() });
  const events = [];
  detector.on("event", (event) => events.push(event));
  provider.on("master-change", (event) => detector.onMasterChange(event));
  provider.on("track-loaded", (event) => detector.onTrackLoaded(event));
  provider.on("snapshot", (snapshot) => detector.onSnapshot(snapshot));
  t.after(() => provider.stop());

  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Hook provider did not bind")), 1_000);
    provider.on("status", (status) => {
      if (status.message?.includes("listener started")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  provider.start();
  await started;

  const sender = dgram.createSocket("udp4");
  t.after(() => sender.close());
  const send = (packet) => new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(packet));
    sender.send(body, port, "127.0.0.1", (error) => (error ? reject(error) : resolve()));
  });
  await send({ type: "master_change", deck: 1 });
  await send({ type: "track_meta", deck: 1, title: "Fallback Track", artist: "Artist" });
  await send({ type: "olvc", deck: 1, name: "@IsPlaying", value: 1 });
  await send({ type: "track_load", deck: 1, contentId: 42 });
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 1);
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_LOADED").length, 1);
  assert.equal(detector.getState().decks[1].track.contentId, "42");
});

test("playback fallback stays stable across non-playing deck packets", async (t) => {
  const port = 46_000 + Math.floor(Math.random() * 1_000);
  const provider = createHookUdpProvider({ enabled: true, port });
  const detector = createTrackActivityDetector({ idFactory: (() => {
    let id = 0;
    return () => `stable-provider-id-${++id}`;
  })() });
  const events = [];
  const snapshots = [];
  detector.on("event", (event) => events.push(event));
  provider.on("track-loaded", (event) => detector.onTrackLoaded(event));
  provider.on("master-change", (event) => detector.onMasterChange(event));
  provider.on("snapshot", (snapshot) => {
    snapshots.push({ masterDeck: snapshot.masterDeck, source: snapshot.masterDeckSource });
    detector.onSnapshot(snapshot);
  });
  t.after(() => provider.stop());

  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Hook provider did not bind")), 1_000);
    provider.on("status", (status) => {
      if (status.message?.includes("listener started")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  provider.start();
  await started;

  const sender = dgram.createSocket("udp4");
  t.after(() => sender.close());
  const send = (packet) => new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(packet));
    sender.send(body, port, "127.0.0.1", (error) => (error ? reject(error) : resolve()));
  });

  await send({ type: "track_meta", deck: 1, title: "Beat Me", artist: "Artist" });
  await send({ type: "track_load", deck: 1, contentId: 46913811 });
  await send({ type: "olvc", deck: 1, name: "@IsPlaying", value: 1 });
  await send({ type: "track_meta", deck: 2, title: "Preload", artist: "Other" });
  await send({ type: "olvc", deck: 2, name: "@IsPlaying", value: 0 });
  await send({ type: "olvc", deck: 2, name: "@CurrentTime", value: 5000 });
  await send({ type: "track_meta", deck: 1, title: "Beat Me", artist: "Artist" });
  await send({ type: "track_load", deck: 1, contentId: 46913811 });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 1);
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.masterDeck)).size, 1);
  assert.equal(snapshots.at(-1).masterDeck, 1);
  assert.equal(snapshots.at(-1).source, "playback-fallback");

  // A real master change is explicit and must still activate the already-playing deck.
  await send({ type: "olvc", deck: 2, name: "@IsPlaying", value: 1 });
  await send({ type: "master_change", deck: 2 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 2);
  assert.equal(snapshots.at(-1).masterDeck, 2);
  assert.equal(snapshots.at(-1).source, "explicit-master-change");
});

test("action security normalizes IPv4, IPv4-mapped IPv6, and IPv6 loopback", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.22.4.9"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(normalizeIp("[::1]"), "::1");
  assert.equal(isLoopbackAddress("192.168.1.9"), false);
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: "10.0.0.2" } }), false);
});

test("Syndocal adapter selection is explicit and unknown names are unavailable", () => {
  assert.equal(resolveAdapter({ adapter: "generic-json" }).adapterObject.name, "generic-json");
  assert.equal(resolveAdapter({ adapter: "" }).adapterObject, null);
  assert.match(resolveAdapter({ adapter: "kdmx-private" }).error, /no silent generic fallback/);
  const client = createSyndocalClient({ enabled: true, adapter: "unknown-adapter" });
  assert.equal(client.getStatus().state, "unavailable");
  client.start();
  assert.equal(client.getStatus().state, "unavailable");
  client.stop();
});

test("Syndocal client uses generic JSON envelopes and state sync on connect", async (t) => {
  const EventEmitter = require("node:events");
  class FakeWebSocket extends EventEmitter {
    static instances = [];

    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      FakeWebSocket.instances.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }

    send(value) {
      this.sent.push(JSON.parse(value));
    }

    close() {
      this.readyState = 3;
      this.emit("close", 1000, "test");
    }
  }

  const client = createSyndocalClient({
    enabled: true,
    host: "10.0.0.5",
    port: 9999,
    adapter: "generic-json",
    WebSocketImpl: FakeWebSocket,
    heartbeatMs: 60_000,
    stateSyncProvider: () => ({ loopDivision: 2, released: false }),
  });
  t.after(() => client.stop());
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const socket = FakeWebSocket.instances.at(-1);
  assert.equal(socket.url, "ws://10.0.0.5:9999/ws");
  assert.equal(socket.sent[0].type, "DJ_AGENT_HELLO");
  assert.equal(socket.sent[1].type, "DJ_STATE_SYNC");
  assert.equal(socket.sent[2].type, "DJ_TIMELINE_STATE_REQUEST");
  const timelineStates = [];
  const warnings = [];
  client.on("timeline-state", (state) => timelineStates.push(state));
  client.on("warning", (warning) => warnings.push(warning));
  socket.emit("message", JSON.stringify({
    type: "DJ_TIMELINE_STATE",
    state: "running",
    loopActive: false,
    timelineId: "show-1",
    positionBars: 16,
  }));
  assert.deepEqual(timelineStates, [{
    type: "DJ_TIMELINE_STATE",
    state: "running",
    loopActive: false,
    timelineId: "show-1",
    positionBars: 16,
    eventId: null,
    sequence: null,
  }]);
  socket.emit("message", JSON.stringify({ type: "DJ_TIMELINE_STATE", state: "running", loopActive: "no" }));
  assert.match(warnings.at(-1).message, /Invalid DJ_TIMELINE_STATE/);
  assert.equal(normalizeTimelineState({ type: "DJ_TIMELINE_STATE", state: "unknown", loopActive: false }), null);
  const result = client.sendEvent({ type: "DJ_RELEASE", payload: { state: "released" } });
  assert.equal(result.sent, true);
  assert.equal(socket.sent.at(-1).type, "DJ_RELEASE");
  socket.emit("message", JSON.stringify({ type: "ACK", eventId: result.eventId }));
  assert.equal(client.getStatus().lastAckAt != null, true);
});

test("Syndocal delivery stays pending until ACK and records rejection/timeout", async (t) => {
  class AckWebSocket extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.readyState = 0;
      this.sent = [];
      AckWebSocket.instances.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }

    send(value) {
      this.sent.push(JSON.parse(value));
    }

    close() {
      this.readyState = 3;
      this.emit("close", 1000, "test");
    }
  }

  const client = createSyndocalClient({
    enabled: true,
    adapter: "generic-json",
    WebSocketImpl: AckWebSocket,
    heartbeatMs: 60_000,
    ackTimeoutMs: 25,
    reconnectMinMs: 1_000,
  });
  t.after(() => client.stop());
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const socket = AckWebSocket.instances.at(-1);

  const rejected = client.sendEvent({ type: "DJ_RELEASE", payload: { state: "released" } });
  assert.equal(rejected.sent, true);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ackState, "pending");
  assert.equal(client.getStatus().lastDelivery.state, "pending");
  socket.emit("message", JSON.stringify({ type: "ACK", eventId: rejected.eventId, ok: false, message: "denied" }));
  assert.equal(client.getStatus().lastDelivery.state, "rejected");
  assert.equal(client.getStatus().lastAckResult.ok, false);

  const timedOut = client.sendEvent({ type: "DJ_LOOP_STATE", payload: { division: 1 } });
  assert.equal(timedOut.ackState, "pending");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(client.getStatus().lastDelivery.state, "timed-out");
  assert.equal(client.getStatus().lastAckResult.state, "timed-out");

  client.stop();
  const unsent = client.sendEvent({ type: "DJ_RELEASE" });
  assert.equal(unsent.ok, false);
  assert.equal(unsent.ackState, "send-failed");
});

test("Syndocal reconnects after error-only sockets without double scheduling", async (t) => {
  class ErrorOnlyWebSocket extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.readyState = 0;
      ErrorOnlyWebSocket.instances.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }

    send() {}

    close() {
      this.readyState = 3;
      // Deliberately no close event: the client must recover from error alone.
    }
  }

  const client = createSyndocalClient({
    enabled: true,
    adapter: "generic-json",
    WebSocketImpl: ErrorOnlyWebSocket,
    heartbeatMs: 60_000,
    reconnectMinMs: 50,
    reconnectMaxMs: 200,
  });
  t.after(() => client.stop());
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const first = ErrorOnlyWebSocket.instances[0];
  first.emit("error", new Error("LAN vanished"));
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(ErrorOnlyWebSocket.instances.length, 2);
  assert.equal(client.getStatus().state, "connected");
});

test("uiohook F13-F24 keycodes use measured values and reject legacy ranges", () => {
  assert.equal(keyFromUiohookEvent({ keycode: 91 }), "F13");
  assert.equal(keyFromUiohookEvent({ keycode: 92 }), "F14");
  assert.equal(keyFromUiohookEvent({ keycode: 93 }), "F15");
  assert.equal(keyFromUiohookEvent({ keycode: 102 }), "F24");
  assert.equal(keyFromUiohookEvent({ key: "f14" }), "F14");

  assert.equal(keyFromUiohookEvent({ keycode: 104 }), "");
  assert.equal(keyFromUiohookEvent({ keycode: 115 }), "");
  assert.equal(keyFromUiohookEvent({ keycode: 124 }), "");
  assert.equal(keyFromUiohookEvent({ keycode: 135 }), "");
});

test("pedal keydown repeat stays held-gated and cooldown applies to every action", () => {
  const hook = new EventEmitter();
  hook.start = () => {};
  hook.stop = () => {};
  const actions = [];
  let now = 10_000;
  const pedal = createPedalController({
    enabled: true,
    platform: "win32",
    keyboardAdapter: { kind: "uiohook", module: hook },
    actionSink: (action) => actions.push(action),
    now: () => now,
  });

  pedal.start();
  assert.equal(hook.listenerCount("keydown"), 1);
  assert.equal(hook.listenerCount("keyup"), 1);

  hook.emit("keydown", { keycode: 93 });
  now += 2_000;
  hook.emit("keydown", { keycode: 93 });
  assert.deepEqual(actions, ["filter-close"]);

  hook.emit("keyup", { keycode: 93 });
  now += 500;
  hook.emit("keydown", { keycode: 93 });
  assert.deepEqual(actions, ["filter-close", "filter-close"]);
  hook.emit("keyup", { keycode: 93 });

  // The default one-second cooldown applies even after a keyup and across
  // different pedal bindings; the next action is allowed at the boundary.
  now += 500;
  hook.emit("keydown", { keycode: 92 });
  assert.deepEqual(actions, ["filter-close", "filter-close"]);
  hook.emit("keyup", { keycode: 92 });
  now += 500;
  hook.emit("keydown", { keycode: 92 });
  assert.deepEqual(actions, ["filter-close", "filter-close", "loop-half"]);

  pedal.stop();
  assert.equal(hook.listenerCount("keydown"), 0);
  assert.equal(hook.listenerCount("keyup"), 0);
  hook.emit("keydown", { keycode: 92 });
  assert.deepEqual(actions, ["filter-close", "filter-close", "loop-half"]);
});

test("global-key-listener down=false clears held pedal keys", () => {
  let listener = null;
  const keyboard = {
    addListener(callback) {
      listener = callback;
    },
    removeListener(callback) {
      if (listener === callback) {
        listener = null;
      }
    },
  };
  const actions = [];
  const pedal = createPedalController({
    enabled: true,
    platform: "win32",
    debounceMs: 0,
    keyboardAdapter: { kind: "global-key-listener", module: keyboard },
    actionSink: (action) => actions.push(action),
  });

  pedal.start();
  listener({ name: "F15" }, true);
  listener({ name: "F15" }, true);
  listener({ name: "F15" }, false);
  listener({ name: "F15" }, true);
  assert.deepEqual(actions, ["filter-close", "filter-close"]);

  pedal.stop();
  assert.equal(listener, null);
});

test("MIDI and pedal adapters stay safe when optional hardware is absent", () => {
  const midi = createRekordboxMidi({ enabled: true, midiModule: null, moduleName: "missing-midi-package" });
  midi.start();
  assert.equal(midi.getStatus().ok, false);
  assert.equal(midi.sendMapping("stop"), false);
  midi.stop();

  const disconnectedFilter = createRekordboxMidi({
    enabled: true,
    midiModule: { Output: class { getPortCount() { return 0; } } },
    mappings: { filter: { channel: 1, messageType: "controlChange", cc: 16 } },
  });
  disconnectedFilter.start();
  assert.deepEqual(disconnectedFilter.startFilterRamp(), {
    started: false,
    ok: false,
    reason: "midi-not-connected",
    targetDeck: null,
    targetChannel: 1,
  });
  disconnectedFilter.stop();

  const actions = [];
  const pedal = createPedalController({
    enabled: true,
    platform: "win32",
    keyboardAdapter: {
      kind: "uiohook",
      module: {
        on() {},
        off() {},
        start() {},
        stop() {},
      },
    },
    actionSink: (action) => actions.push(action),
  });
  pedal.start();
  pedal.trigger("F14");
  assert.deepEqual(actions, ["loop-half"]);
  pedal.stop();
});

test("router sends local loop action while preserving a disconnected network", () => {
  const sent = [];
  const detector = createTrackActivityDetector({ idFactory: () => "id" });
  const client = {
    sendEvent(event) {
      sent.push(event);
      return { sent: false, reason: "disconnected" };
    },
    getStatus() {
      return { state: "disconnected" };
    },
    start() {},
    stop() {},
  };
  const midiCalls = [];
  const midi = {
    sendMapping(name) {
      midiCalls.push(name);
      return true;
    },
    startFilterRamp() {
      return { started: true };
    },
    getStatus() {
      return { ok: true };
    },
    start() {},
    stop() {},
  };
  const pedal = { start() {}, stop() {}, getStatus: () => ({ ok: true }) };
  const router = createShowEventRouter({ detector, syndocalClient: client, midi, pedal });
  const routedEvents = [];
  router.on("event", (event) => routedEvents.push(event));
  const result = router.triggerAction("loop-half");
  assert.equal(result.midiSent, true);
  assert.equal(result.ok, false);
  assert.deepEqual(midiCalls, ["loopHalf"]);
  assert.equal(sent[0].type, "DJ_LOOP_STATE");
  assert.equal(routedEvents[0].type, "DJ_LOOP_STATE");
  assert.equal(routedEvents[0].source, "action");
  const releaseResult = router.triggerAction("release");
  assert.equal(releaseResult.ok, false);
  assert.equal(routedEvents.at(-1).type, "DJ_RELEASE");
  router.stop();
});

test("router correlates loop rejection and release timeout back to the same action event", async (t) => {
  class ActionWebSocket extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.readyState = 0;
      ActionWebSocket.instances.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }

    send() {}

    close() {
      this.readyState = 3;
      this.emit("close", 1000, "test");
    }
  }

  const client = createSyndocalClient({
    enabled: true,
    adapter: "generic-json",
    WebSocketImpl: ActionWebSocket,
    heartbeatMs: 60_000,
    ackTimeoutMs: 20,
    reconnectMinMs: 1_000,
  });
  const detector = createTrackActivityDetector({ idFactory: (() => {
    let id = 0;
    return () => `action-id-${++id}`;
  })() });
  const midi = {
    sendMapping: () => true,
    startFilterRamp: () => ({ started: true, ok: true }),
    getStatus: () => ({ ok: true }),
    start() {},
    stop() {},
  };
  const pedal = { getStatus: () => ({ ok: true }), start() {}, stop() {} };
  const router = createShowEventRouter({ detector, syndocalClient: client, midi, pedal });
  const routedEvents = [];
  const actions = [];
  let lastAction = null;
  router.on("event", (event) => {
    routedEvents.push(event);
    if (event.source === "action" && lastAction?.delivery?.eventId === event.eventId) {
      const state = event.delivery?.state;
      lastAction = {
        ...lastAction,
        delivery: event.delivery,
        ok: state === "acknowledged" && lastAction.midiSent !== false,
        reason: state === "acknowledged" ? null : event.delivery?.reason || state,
      };
    }
  });
  router.on("action", (result) => {
    actions.push(result);
    lastAction = result;
  });
  t.after(() => router.stop());
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const socket = ActionWebSocket.instances.at(-1);
  socket.emit("message", JSON.stringify({
    type: "DJ_TIMELINE_STATE",
    state: "idle",
    loopActive: false,
  }));

  const loop = router.triggerAction("loop-half");
  assert.equal(loop.ok, false);
  assert.equal(loop.delivery.state, "pending");
  socket.emit("message", JSON.stringify({
    type: "ACK",
    eventId: loop.delivery.eventId,
    ok: false,
    message: "loop denied",
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const loopFinal = routedEvents.find(
    (event) => event.eventId === loop.delivery.eventId && event.delivery?.state === "rejected",
  );
  assert.ok(loopFinal);
  assert.equal(loopFinal.source, "action");
  assert.equal(lastAction.delivery.state, "rejected");
  assert.equal(lastAction.ok, false);

  const release = router.triggerAction("release");
  assert.equal(release.ok, false);
  assert.equal(release.delivery.state, "pending");
  await new Promise((resolve) => setTimeout(resolve, 35));
  const releaseFinal = routedEvents.find(
    (event) => event.eventId === release.delivery.eventId && event.delivery?.state === "timed-out",
  );
  assert.ok(releaseFinal);
  assert.equal(releaseFinal.source, "action");
  assert.equal(lastAction.delivery.state, "timed-out");
  assert.equal(lastAction.ok, false);
  assert.equal(actions.length, 2);
});

test("native optional dependency and pkg asset configuration keep source/packaged resolution explicit", () => {
  assert.equal(resolveMidiModule("rb-output-test-missing-midi"), null);
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.match(packageJson.optionalDependencies["@julusian/midi"], /^\^3\.8\./);
  assert.match(packageJson.optionalDependencies["uiohook-napi"], /^\^1\.5\./);
  assert.equal(packageJson.pkg.assets.some((asset) => asset.includes("@julusian/midi")), true);
  assert.equal(packageJson.pkg.assets.some((asset) => asset.includes("uiohook-napi")), true);
});
