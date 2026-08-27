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
  resolveAdapter,
  resolveWebSocketImplementation,
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
const TEST_TOKEN = "0123456789abcdef0123456789abcdef";

function exactReleaseMacro() {
  return {
    enabled: true,
    sequence: "filter-then-fade-then-stop",
    filter: { startValue: 64, endValue: 127, durationMs: 1000, updateIntervalMs: 50, resetValue: 64 },
    resetAfterStop: true,
    resetDelayMs: 0,
  };
}

function exactReleaseFade() {
  return {
    enabled: true,
    mappingName: "releaseFade",
    target: "deck",
    startValue: 127,
    endValue: 0,
    durationMs: 1000,
    updateIntervalMs: 50,
    resetAfterStop: true,
    resetValue: 127,
    resetDelayMs: 0,
  };
}

function createReleaseTimers() {
  const pending = [];
  return {
    timerApi: {
      setTimeout(callback, delayMs) { pending.push({ callback, delayMs }); return callback; },
      clearTimeout(callback) {
        const index = pending.findIndex((pendingTimer) => pendingTimer.callback === callback);
        if (index >= 0) pending.splice(index, 1);
      },
    },
    runPlannedCompletion() {
      let completed = false;
      // A current release has two planned one-second boundaries (HPF then
      // ChannelFader) followed by the zero-delay reset. Drain that bounded
      // local tail so callers can inspect the terminal action deterministically.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const index = pending.findIndex((pendingTimer) => pendingTimer.delayMs === 1000);
        if (index < 0) break;
        const completion = pending.splice(index, 1)[0]?.callback;
        if (typeof completion === "function") {
          completed = true;
          completion();
        }
      }
      const resetIndex = pending.findIndex((pendingTimer) => pendingTimer.delayMs === 0);
      if (resetIndex >= 0) {
        const reset = pending.splice(resetIndex, 1)[0]?.callback;
        if (typeof reset === "function") reset();
      }
      assert.ok(completed, "release macro must schedule its planned completion");
    },
  };
}

function assertStrictV3Frame(frame, type = frame?.type) {
  assert.ok(frame && typeof frame === "object" && !Array.isArray(frame));
  assert.deepEqual(
    Object.keys(frame).sort(),
    ["v", "type", "agentId", "sessionId", "sequence", "eventId", "payload"].sort(),
  );
  assert.equal(frame.v, 3);
  assert.equal(frame.type, type);
  assert.equal(frame.agentId, "rb-output-dj-agent");
  assert.equal(typeof frame.sessionId, "string");
  assert.ok(frame.sessionId.length > 0);
  assert.equal(Number.isSafeInteger(frame.sequence), true);
  assert.ok(frame.sequence > 0);
  assert.equal(typeof frame.eventId, "string");
  assert.ok(frame.eventId.length > 0);
  return frame;
}

function strictV3TrackPayload(overrides = {}) {
  return {
    deck: 1,
    deckId: "rekordbox-deck-1",
    contentId: "42",
    trackBpm: 120,
    positionAtSendSec: 12.5,
    effectiveBpm: 120,
    positionRevision: 1,
    sampleAgeMs: 0,
    isPlaying: true,
    startedAt: "2026-08-25T00:00:00.000Z",
    playSessionId: "play-session-1",
    loop: null,
    ...overrides,
  };
}

function strictV3LoopPayload(overrides = {}) {
  return {
    deck: 1,
    deckId: "rekordbox-deck-1",
    playSessionId: "play-session-1",
    active: true,
    startBeat: 32,
    endBeat: 40,
    lengthBeats: 8,
    revision: 1,
    sampleAgeMs: 0,
    source: "rekordbox-hook-measured",
    ...overrides,
  };
}

function strictV3ReleasePayload(overrides = {}) {
  return { state: "released", timelineId: "life-over", playSessionId: "play-session-1", ...overrides };
}

function strictV3Ack(frame, outcome = "accepted", overrides = {}) {
  return {
    v: 3,
    type: "ACK",
    eventId: frame.eventId,
    sequence: frame.sequence,
    outcome,
    code: null,
    stateGeneration: 1,
    ...overrides,
  };
}

function strictDetectorPlayback(deck, positionRevision, overrides = {}) {
  return {
    deck,
    isPlaying: true,
    bpm: 120,
    positionSec: positionRevision,
    positionRevision,
    positionObservedAt: new Date().toISOString(),
    ...overrides,
  };
}

let admittedCandidateCounter = 0;
function admitCandidate(detector, client, { deck = 1 } = {}) {
  assert.equal(typeof detector.onSnapshot, "function");
  assert.equal(typeof detector.on, "function");
  assert.equal(typeof detector.off, "function");
  assert.equal(typeof client.emit, "function");
  const sequence = ++admittedCandidateCounter;
  let candidate = null;
  const observe = (event) => {
    if (event.type === "DJ_TRACK_ACTIVE" && event.payload.deck === deck) candidate = event;
  };
  detector.on("event", observe);
  const snapshot = (isPlaying, positionRevision) => ({
    deckNowPlaying: [{
      deck,
      contentId: `admitted-content-${sequence}`,
      title: `Admitted ${sequence}`,
      artist: "Test",
      trackBpm: 120,
    }],
    deckPlaybacks: [{
      deck,
      isPlaying,
      bpm: 120,
      positionSec: positionRevision,
      positionRevision,
      positionObservedAt: new Date().toISOString(),
    }],
  });
  detector.onSnapshot(snapshot(false, sequence * 10 + 1));
  detector.onSnapshot(snapshot(true, sequence * 10 + 2));
  detector.off("event", observe);
  assert.ok(candidate, "a fresh false-to-true sample must emit a candidate");
  client.emit("delivery", {
    eventId: candidate.eventId,
    type: "DJ_TRACK_ACTIVE",
    state: "acknowledged",
    ack: { outcome: "accepted" },
  });
  return candidate.payload;
}

function asEventedClient(client) {
  client.on = EventEmitter.prototype.on;
  client.off = EventEmitter.prototype.off;
  client.emit = EventEmitter.prototype.emit;
  return client;
}

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

test("hook udp provider normalizes native mixer fader state", async (t) => {
  const port = 44_000 + Math.floor(Math.random() * 500);
  const provider = createHookUdpProvider({ enabled: true, port });
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
  const mixerEvent = new Promise((resolve) => {
    let handled = false;
    provider.on("mixer-state", (event) => {
      if (!handled) {
        handled = true;
        resolve(event);
      }
    });
  });
  provider.start();
  await started;

  const sender = dgram.createSocket("udp4");
  t.after(() => sender.close());
  const body = Buffer.from(JSON.stringify({
    type: "mixer_state",
    crossfader: 1.2,
    channelFaders: [-0.1, 0.75],
  }));
  await new Promise((resolve, reject) => {
    sender.send(body, port, "127.0.0.1", (error) => error ? reject(error) : resolve());
  });
  const event = await mixerEvent;
  assert.equal(event.crossfader, 1);
  assert.deepEqual(event.channelFaders, [0, 0.75]);
  assert.equal(event.source, "rekordbox-hook-7.2.18");
  assert.match(event.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
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

test("unknown loop activity clears stale active state while retaining the configured range", () => {
  const active = normalizeLoopState({
    deck: 1,
    active: true,
    activeKnown: true,
    startMs: 27_513,
    endMs: 28_513,
  });
  const rangeOnly = normalizeLoopState({
    deck: 1,
    activeKnown: false,
    startMs: 37_513,
    endMs: 38_513,
  });
  const merged = mergeLoopState(active, rangeOnly);
  assert.equal(merged.active, null);
  assert.equal(merged.activeKnown, false);
  assert.equal(merged.startMs, 37_513);
  assert.equal(merged.endMs, 38_513);
});

test("cleared or inverted loop boundaries are not treated as a configured range", () => {
  const cleared = normalizeLoopState({ deck: 1, activeKnown: false, startMs: 0, endMs: 0 });
  assert.equal(cleared.startMs, null);
  assert.equal(cleared.endMs, null);

  const inverted = normalizeLoopState({ deck: 2, startBeat: 32, endBeat: 16 });
  assert.equal(inverted.startBeat, null);
  assert.equal(inverted.endBeat, null);
});

test("DJ Agent configuration remains off without an exact external show configuration", () => {
  const config = loadDjAgentConfig({ env: {} });
  assert.equal(config.enabled, false);
  assert.equal(config.syndocal.enabled, false);
  assert.equal(config.pedal.enabled, false);
  assert.equal(config.midi.enabled, false);
  assert.equal(config.syndocal.adapter, "syndocal-envelope-v3");
});

test("MIDI port primitives preserve explicit numeric zero without enabling the DJ Agent", () => {
  assert.equal(asNumber(null, 7), 7);
  assert.equal(asNumber(undefined, 7), 7);
  assert.equal(asNumber("", 7), 7);

  const openedNamed = [];
  const namedMidi = createRekordboxMidi({
    enabled: true,
    device: "CustomMIDI1",
    port: null,
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
  assert.deepEqual(openedNamed, []);
  assert.equal(namedMidi.getStatus().ok, false);
  namedMidi.stop();

  const openedZero = [];
  const zeroMidi = createRekordboxMidi({
    enabled: true,
    device: "CustomMIDI1",
    port: 0,
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
  assert.deepEqual(openedZero, []);
  assert.equal(zeroMidi.getStatus().ok, false);
  zeroMidi.stop();
});

test("deck MIDI channels override mapping channels and filter ramp messages", async () => {
  assert.deepEqual(normalizeDeckChannels({ "1": 1, "2": "2", bad: 0, "3": 17 }), {
    "1": 1,
    "2": 2,
  });
  const deckChannels = { "1": 1, "2": 2 };

  const messages = [];
  const sent = [];
  const midi = createRekordboxMidi({
    enabled: true,
    device: "Test MIDI",
    port: 0,
    deckChannels,
    mappings: {
      loopHalf: { channel: 1, messageType: "noteOn", note: 36, value: 127 },
      stop: { channel: 1, messageType: "noteOn", note: 37, value: 127 },
      filter: { channel: 1, messageType: "controlChange", cc: 16 },
    },
    filter: { startValue: 127, endValue: 0, durationMs: 20, updateIntervalMs: 5 },
    midiModule: {
      Output: class {
        getPortCount() { return 1; }
        getPortName() { return "Test MIDI"; }
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

  midi.stop();
});

test("router sends Stage 1 MIDI to the acknowledged candidate deck", () => {
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
  const client = new EventEmitter();
  client.sendEvent = (event) => ({
    sent: true,
    ok: true,
    state: "acknowledged",
    eventId: event.eventId || `midi-event-${++eventId}`,
  });
  client.getStatus = () => ({ enabled: true, state: "connected" });
  client.start = () => {};
  client.stop = () => {};
  const pedal = { start() {}, stop() {}, getStatus: () => ({ ok: true }) };
  const router = createShowEventRouter({ detector, syndocalClient: client, midi, pedal });
  admitCandidate(detector, client, { deck: 2 });

  const loop = router.triggerAction("loop-half");
  assert.deepEqual(midiCalls[0], { name: "loopHalf", options: { targetDeck: 2 } });
  assert.equal(loop.targetDeck, 2);
  assert.equal(loop.targetChannel, 2);
  assert.equal(loop.delivery, null);

  const filter = router.triggerAction("filter-close");
  assert.equal(filter.ignored, true);
  assert.equal(filter.state, "inactive");
  assert.equal(midiCalls.length, 1);

  const release = router.triggerAction("release");
  assert.equal(release.reason, "release-macro-unavailable");
  assert.equal(midiCalls.length, 1, "no direct-Stop fallback may remain reachable");
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
  const timers = [];
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
    timerApi: {
      setTimeout(callback) { timers.push(callback); return callback; },
      clearTimeout() {},
    },
    releaseMacro: {
      enabled: true,
      sequence: "filter-then-fade-then-stop",
      filter: { startValue: 64, endValue: 127, durationMs: 1000, updateIntervalMs: 50, resetValue: 64 },
      resetAfterStop: true,
      resetDelayMs: 0,
    },
    releaseFade: exactReleaseFade(),
  });

  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date().toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "42", title: "Life Over", artist: "DSF", trackBpm: 120 }],
    deckPlaybacks: [strictDetectorPlayback(1, 1)],
  });
  const timelineSession = admitCandidate(detector, client).playSessionId;
  client.emit("timeline-state", {
    type: "DJ_TIMELINE_STATE",
    state: "running",
    loopActive: false,
    timelineId: "show-1",
    positionBars: 32,
    playSessionId: timelineSession,
    pedalOwner: "dj",
    releaseEventId: null,
  });
  router.triggerAction("release");
  timers.shift()();
  const stage1Release = router.getStatus().lastAction;
  assert.equal(router.getStatus().mode, "handoff-pending");
  client.emit("timeline-state", {
    type: "DJ_TIMELINE_STATE",
    state: "running",
    loopActive: false,
    timelineId: "show-1",
    positionBars: 32,
    playSessionId: timelineSession,
    pedalOwner: "timeline",
    releaseEventId: stage1Release.delivery.eventId,
  });
  assert.equal(router.getStatus().mode, "timeline-control");
  midiCalls.length = 0;
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
    playSessionId: timelineSession,
    pedalOwner: "timeline",
    releaseEventId: stage1Release.delivery.eventId,
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

function createStage2TimelineFixture({ sendState = "acknowledged" } = {}) {
  let identityCounter = 0;
  const releaseTimers = createReleaseTimers();
  const detector = createTrackActivityDetector({
    idFactory: () => `stage2-identity-${++identityCounter}`,
  });
  const midiCalls = [];
  const midi = {
    sendMapping: (name) => { midiCalls.push(name); return true; },
    startFilterRamp: () => ({ started: true, ok: true }),
    resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: 1 }),
    start() {},
    stop() {},
    getStatus: () => ({ ok: true }),
  };
  let connection = { enabled: true, state: "connected" };
  const setConnection = (state) => {
    connection = { enabled: true, state };
  };
  let nextEventId = 0;
  const sent = [];
  const client = new EventEmitter();
  client.sendEvent = (event) => {
    const eventId = `stage2-event-${++nextEventId}`;
    sent.push({ ...event, eventId });
    const connected = connection.state === "connected";
    const state = connected ? sendState : "send-failed";
    return {
      eventId,
      type: event.type,
      sent: connected,
      ok: state === "acknowledged",
      state,
      ackState: state,
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
    releaseFade: exactReleaseFade(),
    releaseMacro: exactReleaseMacro(),
    timerApi: releaseTimers.timerApi,
  });
  router.on("warning", () => {});
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date().toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "42", title: "Life Over", artist: "DSF", trackBpm: 120 }],
    deckPlaybacks: [strictDetectorPlayback(1, 1)],
  });
  const sessionA = admitCandidate(detector, client).playSessionId;
  client.emit("timeline-state", {
    type: "DJ_TIMELINE_STATE",
    state: "running",
    loopActive: false,
    timelineId: "show-1",
    positionBars: 32,
    playSessionId: sessionA,
    pedalOwner: "dj",
    releaseEventId: null,
  });
  router.triggerAction("release");
  releaseTimers.runPlannedCompletion();
  const stage1Release = router.getStatus().lastAction;
  const handoffEventId = stage1Release.delivery.eventId;
  client.emit("timeline-state", {
    type: "DJ_TIMELINE_STATE",
    state: "running",
    loopActive: false,
    timelineId: "show-1",
    positionBars: 32,
    playSessionId: sessionA,
    pedalOwner: "timeline",
    releaseEventId: handoffEventId,
  });
  assert.equal(router.getStatus().mode, "timeline-control");
  const replaceSession = (contentId) => {
    detector.onTrackLoaded({ deck: 1, contentId, title: "Next Track", artist: "DSF" });
    detector.onSnapshot({
      explicitMasterDeck: 1,
      explicitMasterUpdatedAt: new Date().toISOString(),
      deckNowPlaying: [{ deck: 1, contentId, title: "Next Track", artist: "DSF", trackBpm: 120 }],
      deckPlaybacks: [strictDetectorPlayback(1, 1_000, { isPlaying: false })],
    });
    detector.onSnapshot({
      explicitMasterDeck: 1,
      explicitMasterUpdatedAt: new Date().toISOString(),
      deckNowPlaying: [{ deck: 1, contentId, title: "Next Track", artist: "DSF", trackBpm: 120 }],
      deckPlaybacks: [strictDetectorPlayback(1, 1_001)],
    });
    return detector.getState().decks[1].playSessionId;
  };
  return {
    router,
    client,
    detector,
    sent,
    midiCalls,
    sessionA,
    handoffEventId,
    setConnection,
    replaceSession,
  };
}

test("stage2 timeline actions stamp the exact current authoritative playSessionId", () => {
  const { router, sent, sessionA } = createStage2TimelineFixture();
  const jump = router.triggerAction("release");
  assert.equal(jump.ok, true);
  assert.deepEqual(sent.find((event) => event.type === "DJ_TIMELINE_BEAT_JUMP").payload, {
    bars: -4,
    timelineId: "show-1",
    playSessionId: sessionA,
    source: "pedal",
  });
  const loop = router.triggerAction("loop-half");
  assert.equal(loop.ok, true);
  assert.deepEqual(sent.find((event) => event.type === "DJ_TIMELINE_LOOP_SET").payload, {
    active: true,
    timelineId: "show-1",
    playSessionId: sessionA,
    source: "pedal",
  });
  assert.deepEqual(
    sent.filter((event) => event.type.startsWith("DJ_TIMELINE_")).map((event) => event.type),
    ["DJ_TIMELINE_BEAT_JUMP", "DJ_TIMELINE_LOOP_SET"],
  );
  router.stop();
});

test("an unacknowledged replacement cannot take a released Stage 2 owner", () => {
  const { router, client, sent, midiCalls, sessionA, replaceSession } = createStage2TimelineFixture();
  const sessionB = replaceSession("next-b");
  assert.notEqual(sessionB, sessionA);
  const replacement = sent.filter((event) => event.type === "DJ_TRACK_ACTIVE").at(-1);
  assert.equal(replacement.payload.playSessionId, sessionB);
  const stillOwnedByA = router.triggerAction("release");
  assert.equal(stillOwnedByA.ok, true);
  assert.equal(sent.find((event) => event.type === "DJ_TIMELINE_BEAT_JUMP").payload.playSessionId, sessionA);
  client.emit("timeline-state", {
    type: "DJ_TIMELINE_STATE",
    state: "running",
    loopActive: false,
    timelineId: "show-1",
    positionBars: 40,
    playSessionId: sessionB,
    pedalOwner: "dj",
    releaseEventId: null,
  });
  assert.equal(router.getStatus().mode, "handoff-pending");
  const blocked = router.triggerAction("loop-half");
  assert.equal(blocked.reason, "handoff-pending");
  assert.equal(blocked.midiSent, false);
  assert.deepEqual(midiCalls.filter((name) => name === "stop"), ["stop"]);
  assert.equal(midiCalls.filter((name) => name === "filter").length, 1, "completed release resets HPF");
  router.stop();
});

test("a queued stage2 command keeps its original playSessionId when the session is replaced mid-flight", () => {
  const { router, client, sent, sessionA, replaceSession } = createStage2TimelineFixture({ sendState: "pending" });
  const queuedResult = router.triggerAction("filter-close");
  assert.equal(queuedResult.delivery.state, "pending");
  const queuedEvent = sent.find((event) => event.type === "DJ_TIMELINE_BEAT_JUMP");
  assert.deepEqual(queuedEvent.payload, {
    bars: 4,
    timelineId: "show-1",
    playSessionId: sessionA,
    source: "pedal",
  });
  const sessionC = replaceSession("next-c");
  assert.notEqual(sessionC, sessionA);
  assert.deepEqual(
    sent.filter((event) => event.type.startsWith("DJ_TIMELINE_")),
    [queuedEvent],
  );
  client.emit("delivery", {
    eventId: queuedEvent.eventId,
    type: "DJ_TIMELINE_BEAT_JUMP",
    state: "acknowledged",
    ackState: "acknowledged",
    ok: true,
  });
  assert.equal(router.getStatus().lastTimelineAction.ok, true);
  assert.equal(sent.filter((event) => event.type.startsWith("DJ_TIMELINE_")).length, 1);
  const nextCommand = router.triggerAction("release");
  assert.equal(nextCommand.delivery.state, "pending");
  assert.equal(sent.filter((event) => event.type === "DJ_TIMELINE_BEAT_JUMP").at(-1).payload.playSessionId, sessionA);
  assert.deepEqual(queuedEvent.payload, {
    bars: 4,
    timelineId: "show-1",
    playSessionId: sessionA,
    source: "pedal",
  });
  assert.equal(sent.filter((event) => event.type.startsWith("DJ_TIMELINE_")).length, 2);
  router.stop();
});

test("reconnect requires a fresh authoritative snapshot before stage2 sends resume", () => {
  const { router, client, sent, sessionA, handoffEventId, setConnection } = createStage2TimelineFixture();
  setConnection("disconnected");
  client.emit("status", { enabled: true, state: "disconnected" });
  let blocked = router.triggerAction("filter-close");
  assert.equal(blocked.reason, "timeline-network-disconnected");
  assert.equal(sent.some((event) => event.type.startsWith("DJ_TIMELINE_")), false);

  setConnection("connected");
  client.emit("status", { enabled: true, state: "connected" });
  blocked = router.triggerAction("filter-close");
  assert.equal(blocked.reason, "timeline-state-pending");
  assert.equal(sent.some((event) => event.type.startsWith("DJ_TIMELINE_")), false);

  client.emit("timeline-state", {
    type: "DJ_TIMELINE_STATE",
    state: "running",
    loopActive: false,
    timelineId: "show-1",
    positionBars: 48,
    playSessionId: sessionA,
    pedalOwner: "timeline",
    releaseEventId: handoffEventId,
  });
  const resumed = router.triggerAction("filter-close");
  assert.equal(resumed.ok, true);
  assert.deepEqual(sent.find((event) => event.type === "DJ_TIMELINE_BEAT_JUMP").payload, {
    bars: 4,
    timelineId: "show-1",
    playSessionId: sessionA,
    source: "pedal",
  });
  assert.equal(
    sent.filter((event) => event.type.startsWith("DJ_TIMELINE_")).length,
    1,
  );
  router.stop();
});

test("terminal LOOP_SET outcomes clear the pending latch immediately and stay retryable", () => {
  const releaseTimers = createReleaseTimers();
  const detector = createTrackActivityDetector({ idFactory: (() => {
    let id = 0;
    return () => `loop-latch-${++id}`;
  })() });
  const client = new EventEmitter();
  const sent = [];
  let scriptedDelivery = null;
  let nextEventId = 0;
  client.sendEvent = (event) => {
    const eventId = `latch-event-${++nextEventId}`;
    sent.push({ ...event, eventId });
    if (!scriptedDelivery) {
      return { eventId, type: event.type, sent: true, ok: true, state: "acknowledged", ackState: "acknowledged" };
    }
    return { eventId, type: event.type, ...scriptedDelivery() };
  };
  client.getStatus = () => ({ enabled: true, state: "connected" });
  client.start = () => {};
  client.stop = () => {};
  const midi = {
    sendMapping: () => true,
    startFilterRamp: () => ({ started: true, ok: true }),
    resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: 1 }),
    start() {},
    stop() {},
    getStatus: () => ({ ok: true }),
  };
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
    releaseFade: exactReleaseFade(),
    releaseMacro: exactReleaseMacro(),
    timerApi: releaseTimers.timerApi,
  });
  router.on("warning", () => {});
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date().toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "42", title: "Life Over", artist: "DSF", trackBpm: 120 }],
    deckPlaybacks: [strictDetectorPlayback(1, 1)],
  });
  const session = admitCandidate(detector, client).playSessionId;
  client.emit("timeline-state", {
    type: "DJ_TIMELINE_STATE",
    state: "running",
    loopActive: false,
    timelineId: "show-1",
    positionBars: 8,
    playSessionId: session,
    pedalOwner: "dj",
    releaseEventId: null,
  });
  router.triggerAction("release");
  releaseTimers.runPlannedCompletion();
  const stage1Release = router.getStatus().lastAction;
  const handoffEventId = stage1Release.delivery.eventId;
  client.emit("timeline-state", {
    type: "DJ_TIMELINE_STATE",
    state: "running",
    loopActive: false,
    timelineId: "show-1",
    positionBars: 8,
    playSessionId: session,
    pedalOwner: "timeline",
    releaseEventId: handoffEventId,
  });
  assert.equal(router.getStatus().mode, "timeline-control");
  const loopSends = () => sent.filter((event) => event.type === "DJ_TIMELINE_LOOP_SET");

  // A skipped result is terminal and will never publish a delivery update.
  // It must not wedge the latch: the action reports truthful no-send and the
  // very next pedal press retries instead of being blocked forever.
  scriptedDelivery = () => ({
    sent: false,
    ok: false,
    skipped: true,
    state: "skipped",
    ackState: "skipped",
    reason: "invalid-payload",
  });
  const skipped = router.triggerAction("loop-half");
  assert.equal(skipped.ok, false);
  assert.equal(skipped.delivery.state, "skipped");
  assert.equal(skipped.delivery.sent, false);
  const retryable = router.triggerAction("loop-half");
  assert.notEqual(retryable.reason, "timeline-loop-action-pending");
  assert.equal(retryable.delivery.state, "skipped");
  assert.equal(loopSends().length, 2);
  assert.equal(loopSends().every((event) => event.payload.active === true), true);

  // Pending still holds the exact latch against double-fire.
  scriptedDelivery = () => ({ sent: true, ok: false, state: "pending", ackState: "pending" });
  const held = router.triggerAction("loop-half");
  assert.equal(held.delivery.state, "pending");
  const blockedWhilePending = router.triggerAction("loop-half");
  assert.equal(blockedWhilePending.ok, false);
  assert.equal(blockedWhilePending.reason, "timeline-loop-action-pending");
  assert.equal(blockedWhilePending.delivery, null);
  assert.equal(loopSends().length, 3);

  // A late terminal delivery update releases the latch immediately.
  client.emit("delivery", {
    eventId: held.delivery.eventId,
    type: "DJ_TIMELINE_LOOP_SET",
    state: "timed-out",
    ackState: "timed-out",
    ok: false,
    reason: "ack-timeout",
  });
  const retriedAfterTimeout = router.triggerAction("loop-half");
  assert.notEqual(retriedAfterTimeout.reason, "timeline-loop-action-pending");
  assert.equal(retriedAfterTimeout.delivery.state, "pending");
  assert.equal(loopSends().length, 4);

  // An ACK alone never unblocks the latch; only the authoritative broadcast
  // may release it. ACKed/pending behavior is unchanged.
  client.emit("delivery", {
    eventId: retriedAfterTimeout.delivery.eventId,
    type: "DJ_TIMELINE_LOOP_SET",
    state: "acknowledged",
    ackState: "acknowledged",
    ok: true,
  });
  assert.equal(router.triggerAction("loop-half").reason, "timeline-loop-action-pending");
  assert.equal(loopSends().length, 4);

  // A terminal rejection also releases, and the retry recomputes desired
  // from the last authoritative truth (still inactive -> active).
  client.emit("delivery", {
    eventId: retriedAfterTimeout.delivery.eventId,
    type: "DJ_TIMELINE_LOOP_SET",
    state: "rejected",
    ackState: "rejected",
    ok: false,
    reason: "denied",
  });
  scriptedDelivery = null;
  const afterReject = router.triggerAction("loop-half");
  assert.equal(afterReject.ok, true);
  assert.equal(afterReject.delivery.state, "acknowledged");
  assert.equal(sent.at(-1).payload.active, true);
  assert.equal(loopSends().length, 5);

  // The authoritative broadcast clears the latch and flips the next desired.
  client.emit("timeline-state", {
    type: "DJ_TIMELINE_STATE",
    state: "running",
    loopActive: true,
    timelineId: "show-1",
    positionBars: 16,
    playSessionId: session,
    pedalOwner: "timeline",
    releaseEventId: handoffEventId,
  });
  const flipped = router.triggerAction("loop-half");
  assert.equal(flipped.ok, true);
  assert.equal(sent.at(-1).payload.active, false);
  assert.equal(loopSends().length, 6);
  router.stop();
});

test("same-session stale DJ_TIMELINE_STATE duplicates cannot mutate router state", async (t) => {
  class FenceWebSocket extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.readyState = 0;
      this.sent = [];
      FenceWebSocket.instances.push(this);
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
    }
  }

  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: FenceWebSocket,
    heartbeatMs: 60_000,
    reconnectMinMs: 10,
    reconnectMaxMs: 20,
    stateSyncProvider: () => ({ released: false, ownerDeck: 1, ownerDeckId: "rekordbox-deck-1", activePlaySessionId: "play-session-1" }),
  });
  t.after(() => client.stop());
  const detector = createTrackActivityDetector({ idFactory: (() => {
    let id = 0;
    return () => `fence-detector-${++id}`;
  })() });
  const midi = {
    sendMapping: () => true,
    resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: 1 }),
    start() {},
    stop() {},
    getStatus: () => ({ ok: true }),
  };
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
  });
  t.after(() => router.stop());
  const warnings = [];
  router.on("warning", (warning) => warnings.push(warning.message));
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const socket = FenceWebSocket.instances.at(-1);
  const stateMessage = ({ sequence, eventId, sessionId = "syndocal-session", ...overrides }) => JSON.stringify({
    v: 3,
    type: "DJ_TIMELINE_STATE",
    agentId: "syndocal",
    sessionId,
    sequence,
    eventId,
    payload: {
      state: "running",
      loopActive: false,
      timelineId: "show-1",
      positionBars: 16,
      playSessionId: "play-session-1",
      pedalOwner: "dj",
      releaseEventId: null,
      ...overrides,
    },
  });

  socket.emit("message", stateMessage({ sequence: 5, eventId: "fence-5" }));
  const applied = router.getStateSync();
  assert.equal(applied.timelinePositionBars, 16);
  assert.equal(applied.timelineSnapshotReady, true);

  // Equal-sequence duplicate and stale replay are provably rejectable: no
  // mutation of any router state, including the freshness timestamp.
  socket.emit("message", stateMessage({ sequence: 5, eventId: "fence-5-duplicate" }));
  socket.emit("message", stateMessage({ sequence: 4, eventId: "fence-4-stale", positionBars: 99 }));
  const afterReplays = router.getStateSync();
  assert.equal(afterReplays.timelinePositionBars, applied.timelinePositionBars);
  assert.equal(afterReplays.timelineStateUpdatedAt, applied.timelineStateUpdatedAt);
  assert.equal(warnings.filter((message) => message === "Stale duplicate DJ_TIMELINE_STATE ignored").length, 2);

  // A strictly newer sequence applies normally.
  socket.emit("message", stateMessage({ sequence: 6, eventId: "fence-6", positionBars: 20 }));
  assert.equal(router.getStateSync().timelinePositionBars, 20);

  // A replacement session owns its own sequence space: the fence re-keys and
  // applies it, then fences replays inside the new session too.
  socket.emit("message", stateMessage({
    sequence: 2,
    eventId: "fence-replacement-2",
    sessionId: "syndocal-session-replacement",
    positionBars: 24,
  }));
  assert.equal(router.getStateSync().timelinePositionBars, 24);
  socket.emit("message", stateMessage({
    sequence: 2,
    eventId: "fence-replacement-dup",
    sessionId: "syndocal-session-replacement",
    positionBars: 31,
  }));
  assert.equal(router.getStateSync().timelinePositionBars, 24);
  assert.equal(warnings.filter((message) => message === "Stale duplicate DJ_TIMELINE_STATE ignored").length, 3);

  // Connection replacement resets the fence: after a real reconnect, the
  // next identified frame is judged on its own merits even at a sequence far
  // below the previous session's high-water mark.
  const generationBefore = client.getStatus().connectionGeneration;
  assert.ok(generationBefore >= 1);
  const reconnected = new Promise((resolve) => {
    const listener = (event) => {
      if (event?.generation > generationBefore) {
        client.off("connected", listener);
        resolve(event);
      }
    };
    client.on("connected", listener);
  });
  socket.readyState = 3;
  socket.emit("close", 1006, "fence-reconnect");
  await reconnected;
  const replacement = FenceWebSocket.instances.at(-1);
  assert.notEqual(replacement, socket);
  replacement.emit("message", stateMessage({ sequence: 1, eventId: "fence-post-reset", positionBars: 28 }));
  assert.equal(router.getStateSync().timelinePositionBars, 28);
  // The post-reset frame was accepted, not rejected as stale.
  assert.equal(warnings.filter((message) => message === "Stale duplicate DJ_TIMELINE_STATE ignored").length, 3);
});

test("Stage 1 actions fail closed without an acknowledged candidate", () => {
  const detector = createTrackActivityDetector({ idFactory: () => "snapshot-gate-id" });
  const client = new EventEmitter();
  let connection = { enabled: true, state: "disconnected" };
  const sent = [];
  client.getStatus = () => ({ ...connection });
  client.sendEvent = (event) => {
    const eventId = `gate-${sent.length + 1}`;
    sent.push({ ...event, eventId });
    const connected = connection.state === "connected";
    return {
      eventId,
      type: event.type,
      sent: connected,
      ok: connected,
      state: connected ? "acknowledged" : "send-failed",
      ackState: connected ? "acknowledged" : "send-failed",
      reason: connected ? null : "disconnected",
    };
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

  const release = router.triggerAction("release");
  assert.equal(release.midiSent, false);
  assert.equal(release.ok, false);
  assert.equal(release.reason, "no-admitted-track-candidate");
  const loop = router.triggerAction("loop-half");
  assert.equal(loop.midiSent, false);
  // This fixture has no acknowledged identity/session, so local Stage 1 MIDI
  // must not be emitted and no v3 fallback can be armed.
  assert.equal(loop.ok, false);
  assert.equal(loop.reason, "no-admitted-track-candidate");
  assert.equal(router.triggerAction("filter-close").ignored, true);
  assert.deepEqual(midiCalls, []);

  connection = { enabled: true, state: "connected" };
  client.emit("status", connection);
  assert.equal(router.triggerAction("loop-half").midiSent, false);
  assert.deepEqual(midiCalls, []);

  client.emit("timeline-state", { state: "idle", loopActive: false });
  assert.equal(router.getStatus().mode, "dj-control");
  assert.equal(router.triggerAction("loop-half").midiSent, false);
  assert.deepEqual(midiCalls, []);

  connection = { enabled: true, state: "disconnected" };
  client.emit("status", connection);
  assert.equal(router.triggerAction("release").midiSent, false);
  assert.deepEqual(midiCalls, []);
  connection = { enabled: true, state: "connected" };
  client.emit("status", connection);
  assert.equal(router.triggerAction("loop-half").midiSent, false);
  assert.deepEqual(midiCalls, []);

  client.emit("timeline-state", { state: "stopped", loopActive: false });
  assert.equal(router.triggerAction("filter-close").ignored, true);
  assert.deepEqual(midiCalls, []);
  router.stop();
});

test("release handoff failures never stick in handoff-pending and running wins the late-failure race", () => {
  const releaseTimers = createReleaseTimers();
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
    startFilterRamp: () => ({ started: true, ok: true }),
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
    releaseFade: exactReleaseFade(),
    releaseMacro: exactReleaseMacro(),
    timerApi: releaseTimers.timerApi,
  });
  router.on("warning", () => {});
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date().toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "42", title: "Life Over", artist: "DSF", trackBpm: 120 }],
    deckPlaybacks: [strictDetectorPlayback(1, 1)],
  });
  const handoffSession = admitCandidate(detector, client).playSessionId;
  client.emit("timeline-state", {
    state: "running",
    loopActive: false,
    timelineId: "show-1",
    positionBars: 0,
    playSessionId: handoffSession,
    pedalOwner: "dj",
    releaseEventId: null,
  });

  router.triggerAction("release");
  releaseTimers.runPlannedCompletion();
  const first = router.getStatus().lastAction;
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

  router.triggerAction("release");
  releaseTimers.runPlannedCompletion();
  const second = router.getStatus().lastAction;
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

  router.triggerAction("release");
  releaseTimers.runPlannedCompletion();
  const third = router.getStatus().lastAction;
  assert.equal(router.getStatus().mode, "handoff-pending");
  client.emit("timeline-state", {
    state: "running",
    loopActive: false,
    timelineId: "show-1",
    positionBars: 0,
    playSessionId: handoffSession,
    pedalOwner: "timeline",
    releaseEventId: third.delivery.eventId,
  });
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
  assert.deepEqual(midiCalls.filter((name) => name === "stop"), ["stop", "stop", "stop"]);
  assert.equal(midiCalls.filter((name) => name === "filter").length, 3, "each completed release resets HPF");
  router.stop();
});

test("synchronous DJ_RELEASE send failure returns to dj-control and remains retryable", () => {
  const releaseTimers = createReleaseTimers();
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
      startFilterRamp: () => ({ started: true, ok: true }),
      resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: 1 }),
      getStatus: () => ({ ok: true }),
      start() {},
      stop() {},
    },
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
    releaseFade: exactReleaseFade(),
    releaseMacro: exactReleaseMacro(),
    timerApi: releaseTimers.timerApi,
  });
  admitCandidate(detector, client);
  client.emit("timeline-state", { state: "idle", loopActive: false });
  router.triggerAction("release");
  releaseTimers.runPlannedCompletion();
  const first = router.getStatus().lastAction;
  assert.equal(first.delivery.state, "send-failed");
  assert.equal(router.getStatus().mode, "dj-control");
  assert.equal(router.getStatus().releaseMacroPhase, "failed");
  assert.equal(router.getStatus().releaseMacroReason, "not-sent");
  assert.equal(router.getStatus().lastAction.phase, "failed");
  assert.equal(stops, 1);
  router.triggerAction("release");
  releaseTimers.runPlannedCompletion();
  const second = router.getStatus().lastAction;
  assert.equal(second.delivery.state, "send-failed");
  assert.equal(router.getStatus().mode, "dj-control");
  assert.equal(stops, 2);
  router.stop();
});

test("Stage 1 release routes physical DJ_RELEASE when planned Stop MIDI fails", () => {
  const releaseTimers = createReleaseTimers();
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
      startFilterRamp: () => ({ started: true, ok: true }),
      resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: 1 }),
      getStatus: () => ({ ok: false }),
      start() {},
      stop() {},
    },
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
    releaseFade: exactReleaseFade(),
    releaseMacro: exactReleaseMacro(),
    timerApi: releaseTimers.timerApi,
  });
  admitCandidate(detector, client);
  client.emit("timeline-state", { state: "idle", loopActive: false });
  router.triggerAction("release");
  releaseTimers.runPlannedCompletion();
  const result = router.getStatus().lastAction;
  assert.equal(result.reason, result.localFailure);
  assert.ok(result.localFailure, "the first local ramp/stop failure remains visible");
  assert.equal(result.midiSent, false);
  assert.equal(result.ok, false);
  assert.equal(result.delivery.state, "acknowledged");
  assert.equal(router.getStatus().mode, "handoff-pending");
  assert.deepEqual(sent.filter((event) => event.type === "DJ_RELEASE").map((event) => event.type), ["DJ_RELEASE"]);
  router.stop();
});

test("track activity does not make a track load a master timeline event", () => {
  let id = 0;
  const detector = createTrackActivityDetector({ idFactory: () => `id-${++id}` });
  const events = [];
  detector.on("event", (event) => events.push(event));

  detector.onTrackLoaded({ deck: 1, contentId: "track-a" });
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date().toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "track-a", title: "A", artist: "Artist" }],
    deckPlaybacks: [strictDetectorPlayback(1, 1, { isPlaying: false, positionSec: 0 })],
  });
  assert.deepEqual(events.map((event) => event.type), ["DJ_TRACK_LOADED"]);

  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date().toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "track-a", title: "A", artist: "Artist" }],
    deckPlaybacks: [strictDetectorPlayback(1, 2, { positionSec: 0.1 })],
  });
  assert.deepEqual(events.map((event) => event.type), [
    "DJ_TRACK_LOADED",
    "DJ_TRACK_PLAY_STARTED",
    "DJ_TRACK_ACTIVE",
  ]);
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date().toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "track-a", title: "A", artist: "Artist" }],
    deckPlaybacks: [strictDetectorPlayback(1, 3, { positionSec: 0.2 })],
  });
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 1);
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
      strictDetectorPlayback(1, 1, { isPlaying: false, positionSec: 0 }),
      strictDetectorPlayback(2, 1, { positionSec: 4 }),
    ],
  });
  const authorityAt = new Date().toISOString();
  detector.onMasterChange({ deck: 2, explicitMasterUpdatedAt: authorityAt });
  detector.onMasterChange({ deck: 2, explicitMasterUpdatedAt: authorityAt });
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_CHANGED").length, 0);
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 1);
  assert.equal(events.find((event) => event.type === "DJ_TRACK_ACTIVE").payload.contentId, "b");
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
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date(time).toISOString(),
    deckNowPlaying: [{ deck: 1, title: "Fallback Track", artist: "Artist" }],
    deckPlaybacks: [strictDetectorPlayback(1, 1, {
      positionObservedAt: new Date(time).toISOString(),
    })],
  });
  const firstActive = events.find((event) => event.type === "DJ_TRACK_ACTIVE");
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
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date(time).toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "content-42", title: "Fallback Track", artist: "Artist" }],
    deckPlaybacks: [strictDetectorPlayback(1, 2, {
      positionObservedAt: new Date(time).toISOString(),
    })],
  });

  const state = detector.getState().decks[1];
  assert.equal(finiteNumber(null), null);
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 1);
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
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date(time).toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "old", title: "Old", artist: "Artist" }],
    deckPlaybacks: [strictDetectorPlayback(1, 1, { positionObservedAt: new Date(time).toISOString() })],
  });
  const previous = detector.getState().decks[1];
  time = 11_000;
  detector.onTrackLoaded({ deck: 1, contentId: "new", title: "New", artist: "Artist" });
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 1);

  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date(time).toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "new", title: "New", artist: "Artist" }],
    deckPlaybacks: [strictDetectorPlayback(1, 2, { positionObservedAt: new Date(time).toISOString() })],
  });
  const preloaded = detector.getState().decks[1];
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 1);
  assert.equal(preloaded.playSessionId, null);
  assert.equal(preloaded.awaitingPlayConfirmation, true);

  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date(time).toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "new", title: "New", artist: "Artist" }],
    deckPlaybacks: [strictDetectorPlayback(1, 3, {
      isPlaying: false,
      positionObservedAt: new Date(time).toISOString(),
    })],
  });
  time = 12_000;
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date(time).toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "new", title: "New", artist: "Artist" }],
    deckPlaybacks: [strictDetectorPlayback(1, 4, { positionObservedAt: new Date(time).toISOString() })],
  });
  const next = detector.getState().decks[1];
  assert.notEqual(next.playSessionId, previous.playSessionId);
  assert.equal(next.startedAt, new Date(time).toISOString());
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 2);
});

test("master_change waits for a fresh position/BPM sample before activating", () => {
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
  const authorityAt = new Date().toISOString();
  detector.onMasterChange({ deck: 2, explicitMasterUpdatedAt: authorityAt });
  detector.onMasterChange({ deck: 2, explicitMasterUpdatedAt: authorityAt });
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 0);
  detector.onSnapshot({
    explicitMasterDeck: 2,
    explicitMasterUpdatedAt: authorityAt,
    deckNowPlaying: [{ deck: 2, contentId: "b", title: "B", artist: "Two" }],
    deckPlaybacks: [strictDetectorPlayback(2, 1, { positionSec: 4 })],
  });
  const activeEvents = events.filter((event) => event.type === "DJ_TRACK_ACTIVE");
  assert.equal(activeEvents.length, 1);
  assert.equal(activeEvents[0].payload.positionAtSendSec, 4);
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
  await send({ type: "olvc", deck: 1, name: "@OriginalBPM", value: 12_000 });
  await send({ type: "olvc", deck: 1, name: "@BPM", value: 12_000 });
  await send({ type: "olvc", deck: 1, name: "@CurrentTime", value: 1_000 });
  await send({ type: "olvc", deck: 1, name: "@IsPlaying", value: 1 });
  await send({ type: "track_load", deck: 1, contentId: 42 });
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 1);
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_LOADED").length, 2);
  assert.equal(detector.getState().decks[1].track.contentId, "42");
});

test("playback fallback is diagnostic only and does not suppress a valid per-deck candidate", async (t) => {
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
  await send({ type: "olvc", deck: 1, name: "@OriginalBPM", value: 12_000 });
  await send({ type: "olvc", deck: 1, name: "@BPM", value: 12_000 });
  await send({ type: "olvc", deck: 1, name: "@CurrentTime", value: 1_000 });
  await send({ type: "olvc", deck: 1, name: "@IsPlaying", value: 1 });
  await send({ type: "track_meta", deck: 2, title: "Preload", artist: "Other" });
  await send({ type: "olvc", deck: 2, name: "@IsPlaying", value: 0 });
  await send({ type: "olvc", deck: 2, name: "@CurrentTime", value: 5000 });
  await send({ type: "track_meta", deck: 1, title: "Beat Me", artist: "Artist" });
  await send({ type: "track_load", deck: 1, contentId: 46913811 });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 1);
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.masterDeck)).size, 1);
  assert.equal(snapshots.at(-1).masterDeck, 1);
  assert.equal(snapshots.at(-1).source, "playback-fallback");

  // A later explicit master change may announce deck 2 independently because
  // its title+artist metadata is also an exact candidate identity.
  await send({ type: "olvc", deck: 2, name: "@OriginalBPM", value: 12_000 });
  await send({ type: "olvc", deck: 2, name: "@BPM", value: 12_000 });
  await send({ type: "olvc", deck: 2, name: "@CurrentTime", value: 5_100 });
  await send({ type: "olvc", deck: 2, name: "@IsPlaying", value: 1 });
  await send({ type: "master_change", deck: 2 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 2);
  assert.equal(snapshots.at(-1).masterDeck, 2);
  assert.equal(snapshots.at(-1).source, "explicit-master-change");
});

test("hook snapshots retain valid original BPM across transient zero packets", async (t) => {
  const port = 47_000 + Math.floor(Math.random() * 1_000);
  const provider = createHookUdpProvider({ enabled: true, port });
  const snapshots = [];
  provider.on("snapshot", (snapshot) => snapshots.push(snapshot));
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

  await send({ type: "track_meta", deck: 1, title: "Stable BPM", artist: "Artist", trackBpm: 12_800 });
  await send({ type: "olvc", deck: 1, name: "@CurrentTime", value: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const observedAt = snapshots.at(-1).deckPlaybacks[0].positionObservedAt;

  await send({ type: "olvc", deck: 1, name: "@OriginalBPM", value: 0 });
  await send({ type: "olvc", deck: 1, name: "@BPM", value: 12_800 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(snapshots.at(-1).deckNowPlaying[0].trackBpm, 128);
  assert.equal(snapshots.at(-1).deckPlaybacks[0].positionObservedAt, observedAt);

  await send({ type: "olvc", deck: 1, name: "@OriginalBPM", value: 13_000 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(snapshots.at(-1).deckNowPlaying[0].trackBpm, 130);
});

test("hook preserves measured loop activity while inferred playback state remains separately observable", async (t) => {
  const port = 48_000 + Math.floor(Math.random() * 1_000);
  const provider = createHookUdpProvider({ enabled: true, port });
  const loopEvents = [];
  const snapshots = [];
  provider.on("loop-state", (loop) => loopEvents.push(loop));
  provider.on("snapshot", (snapshot) => snapshots.push(snapshot));
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

  await send({ type: "olvc", deck: 1, name: "@CurrentTime", value: 42_280 });
  await send({
    type: "loop_state",
    deck: 1,
    active: true,
    activeKnown: true,
    startMs: 27_513,
    endMs: 28_513,
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(loopEvents.at(-1).active, true);
  assert.equal(loopEvents.at(-1).activeSource, null);
  assert.equal(loopEvents.at(-1).source, "rekordbox-hook");
  assert.equal(snapshots.at(-1).loopStates[0].active, true);

  await send({ type: "olvc", deck: 1, name: "@CurrentTime", value: 28_450 });
  await send({
    type: "loop_state",
    deck: 1,
    activeKnown: false,
    startMs: 27_513,
    endMs: 28_513,
  });
  await send({ type: "olvc", deck: 1, name: "@CurrentTime", value: 27_520 });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(loopEvents.at(-1).active, true);
  assert.equal(loopEvents.at(-1).activeSource, "playhead-loop-wrap");
  assert.equal(snapshots.at(-1).loopStates[0].active, true);
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
  assert.equal(resolveAdapter({ adapter: "syndocal-envelope-v3", token: TEST_TOKEN }).adapterObject.name, "syndocal-envelope-v3");
  assert.equal(resolveAdapter({ adapter: "generic-json", token: TEST_TOKEN }).adapterObject, null);
  assert.equal(resolveAdapter({ adapter: "syndocal-envelope-v1", token: TEST_TOKEN }).adapterObject, null);
  assert.equal(resolveAdapter({ adapter: "syndocal-envelope-v2", token: TEST_TOKEN }).adapterObject, null);
  assert.equal(resolveAdapter({ adapter: "" }).adapterObject, null);
  assert.match(resolveAdapter({ adapter: "kdmx-private" }).error, /v3|required|retired/);
  const client = createSyndocalClient({ enabled: true, adapter: "unknown-adapter" });
  assert.equal(client.getStatus().state, "unavailable");
  client.start();
  assert.equal(client.getStatus().state, "unavailable");
  client.stop();
});

test("real router getStateSync is encoded as a strict v3 State Sync frame", async (t) => {
  class StateSyncWebSocket extends EventEmitter {
    static instances = [];

    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      StateSyncWebSocket.instances.push(this);
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

  const detector = createTrackActivityDetector({ idFactory: (() => {
    let id = 0;
    return () => `state-sync-${++id}`;
  })() });
  let router = null;
  const client = createSyndocalClient({
    enabled: true,
    token: "0123456789abcdef0123456789abcdef",
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: StateSyncWebSocket,
    heartbeatMs: 60_000,
    stateSyncProvider: () => router?.getStateSync() || {},
  });
  const midi = {
    sendMapping: () => true,
    resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: 1 }),
    getStatus: () => ({ ok: true }),
    start() {},
    stop() {},
  };
  router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
  });
  t.after(() => router.stop());
  router.onSnapshot({
    masterDeck: 2,
    deckNowPlaying: [{ deck: 2, contentId: "content-2", title: "Track 2", artist: "Artist 2", trackBpm: 126 }],
    deckPlaybacks: [{ deck: 2, isPlaying: true, positionSec: 12.5 }],
  });
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const socket = StateSyncWebSocket.instances.at(-1);
  assert.equal(socket.url, "ws://127.0.0.1:9100/dj-link");
  assertStrictV3Frame(socket.sent[0], "DJ_AGENT_HELLO");
  assertStrictV3Frame(socket.sent[1], "DJ_STATE_SYNC");
  assertStrictV3Frame(socket.sent[2], "DJ_TIMELINE_STATE_REQUEST");
  assert.equal(socket.sent[1].type, "DJ_STATE_SYNC");
  assert.deepEqual(socket.sent[1].payload, {
    released: false,
  });

  socket.emit("message", JSON.stringify({
    v: 3,
    type: "DJ_TIMELINE_STATE",
    agentId: "syndocal",
    sessionId: "syndocal-session",
    eventId: "timeline-router-valid",
    sequence: 7,
    payload: {
      state: "running",
      loopActive: false,
      timelineId: "show-1",
      positionBars: 16,
      playSessionId: "play-session-1",
      pedalOwner: "dj",
      releaseEventId: null,
    },
  }));
  assert.equal(router.getStatus().mode, "dj-control");
  socket.emit("message", JSON.stringify({
    v: 3,
    type: "DJ_TIMELINE_STATE",
    agentId: "syndocal",
    sessionId: "syndocal-session",
    eventId: "timeline-router-invalid",
    sequence: 8,
    payload: {
      state: "running",
      loopActive: false,
      timelineId: "show-1",
      positionBars: 16,
      playSessionId: "play-session-1",
      pedalOwner: "dj",
      releaseEventId: null,
      extra: true,
    },
  }));
  assert.equal(router.getStatus().mode, "dj-control");
});

test("Busy ACK retries the same eventId/sequence/shape and terminal rejection does not retry", async (t) => {
  class BusyWebSocket extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.readyState = 0;
      this.sent = [];
      BusyWebSocket.instances.push(this);
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
    token: "0123456789abcdef0123456789abcdef",
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: BusyWebSocket,
    heartbeatMs: 60_000,
    ackTimeoutMs: 100,
    busyRetryMaxAttempts: 3,
    busyRetryBaseMs: 2,
    busyRetryMaxMs: 4,
  });
  t.after(() => client.stop());
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const socket = BusyWebSocket.instances.at(-1);

  const retried = client.sendEvent({
    type: "DJ_LOOP_STATE",
    eventId: "same-event",
    sequence: 77,
    payload: strictV3LoopPayload(),
  });
  const firstFrame = socket.sent.at(-1);
  assert.equal(retried.state, "pending");
  assertStrictV3Frame(firstFrame, "DJ_LOOP_STATE");
  socket.emit("message", JSON.stringify(strictV3Ack(firstFrame, "busy", { code: "BUSY" })));
  await new Promise((resolve) => setTimeout(resolve, 12));
  const eventFrames = socket.sent.filter((frame) => frame.type === "DJ_LOOP_STATE");
  assert.equal(eventFrames.length, 2);
  assert.deepEqual(eventFrames[1], firstFrame);
  assert.equal(client.getStatus().lastDelivery.state, "pending");
  socket.emit("message", JSON.stringify(strictV3Ack(firstFrame)));
  assert.equal(client.getStatus().lastDelivery.state, "acknowledged");

  const terminalReject = client.sendEvent({ type: "DJ_RELEASE", payload: strictV3ReleasePayload() });
  const terminalFrame = socket.sent.find((frame) => frame.eventId === terminalReject.eventId);
  const rejectCount = socket.sent.filter((frame) => frame.eventId === terminalReject.eventId).length;
  socket.emit("message", JSON.stringify(strictV3Ack(terminalFrame, "rejected", { code: "REJECTED" })));
  await new Promise((resolve) => setTimeout(resolve, 12));
  assert.equal(socket.sent.filter((frame) => frame.eventId === terminalReject.eventId).length, rejectCount);
  assert.equal(client.getStatus().lastDelivery.state, "rejected");
});

test("Syndocal defaults use /dj-link, strict v3, five-second heartbeat, ws, and bounded history", async (t) => {
  const config = loadDjAgentConfig({
    env: {},
  });
  assert.equal(config.syndocal.path, "/dj-link");
  assert.equal(config.syndocal.adapter, "syndocal-envelope-v3");
  assert.equal(config.syndocal.heartbeatMs, 5_000);
  assert.equal(resolveWebSocketImplementation("ws"), require("ws"));

  class HistoryWebSocket extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.readyState = 0;
      this.sent = [];
      HistoryWebSocket.instances.push(this);
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
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: HistoryWebSocket,
    heartbeatMs: 60_000,
    deliveryHistoryMax: 3,
  });
  t.after(() => client.stop());
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const socket = HistoryWebSocket.instances.at(-1);
  const sentBeforeUnknown = socket.sent.length;
  const unknown = client.sendEvent({
    type: "DJ_TRACK_PLAY_STARTED",
    payload: { deck: 1, arbitrary: "must-not-cross-wire" },
  });
  assert.equal(unknown.skipped, true);
  assert.equal(unknown.reason, "unsupported-type");
  assert.equal(socket.sent.length, sentBeforeUnknown);
  const retiredMasterChanged = client.sendEvent({
    type: "DJ_MASTER_CHANGED",
    payload: { deck: 1, source: "must-not-cross-wire" },
  });
  assert.equal(retiredMasterChanged.skipped, true);
  assert.equal(retiredMasterChanged.reason, "unsupported-type");
  assert.equal(socket.sent.some((frame) => frame.type === "DJ_MASTER_CHANGED"), false);
  for (let index = 0; index < 8; index += 1) {
    client.sendEvent({
      type: "DJ_TIMELINE_BEAT_JUMP",
      payload: { bars: index % 2 === 0 ? -4 : 4, timelineId: "history-bound", playSessionId: "play-session-1" },
    });
  }
  assert.equal(client.getStatus().deliveryHistoryMax, 3);
  assert.equal(client.getStatus().deliveryHistorySize, 3);
  assert.equal(client.getStatus().lastDelivery.type, "DJ_TIMELINE_BEAT_JUMP");
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
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: AckWebSocket,
    heartbeatMs: 60_000,
    ackTimeoutMs: 25,
    reconnectMinMs: 1_000,
  });
  t.after(() => client.stop());
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const socket = AckWebSocket.instances.at(-1);

  const rejected = client.sendEvent({ type: "DJ_RELEASE", payload: strictV3ReleasePayload() });
  assert.equal(rejected.sent, true);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ackState, "pending");
  assert.equal(client.getStatus().lastDelivery.state, "pending");
  const rejectedFrame = socket.sent.find((frame) => frame.eventId === rejected.eventId);
  socket.emit("message", JSON.stringify(strictV3Ack(rejectedFrame, "rejected", { code: "REJECTED" })));
  assert.equal(client.getStatus().lastDelivery.state, "rejected");
  assert.equal(client.getStatus().lastAckResult.ok, false);

  const timedOut = client.sendEvent({ type: "DJ_LOOP_STATE", payload: strictV3LoopPayload() });
  assert.equal(timedOut.ackState, "pending");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(client.getStatus().lastDelivery.state, "timed-out");
  assert.equal(client.getStatus().lastAckResult.state, "timed-out");

  client.stop();
  const unsent = client.sendEvent({ type: "DJ_RELEASE", payload: strictV3ReleasePayload() });
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
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
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

test("strict v3 token preflight rejects bad credentials before opening a socket", () => {
  let opens = 0;
  class ShouldNotOpenWebSocket {
    constructor() {
      opens += 1;
    }
  }
  for (const token of ["", "short", "x".repeat(257), "x".repeat(31), "x".repeat(32) + " ", "x".repeat(32) + "\u2028"]) {
    const client = createSyndocalClient({
      enabled: true,
      adapter: "syndocal-envelope-v3",
      token,
      WebSocketImpl: ShouldNotOpenWebSocket,
    });
    client.start();
    assert.equal(client.getStatus().state, "unavailable");
    assert.doesNotMatch(client.getStatus().message, /x{8}/);
    client.stop();
  }
  assert.equal(opens, 0);
});

test("Syndocal ACK identity is single-use, sequence-fenced, typed, and capacity-bounded", async (t) => {
  class IdentityWebSocket extends EventEmitter {
    static instances = [];

    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.readyState = 0;
      this.sent = [];
      IdentityWebSocket.instances.push(this);
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
    }
  }

  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: IdentityWebSocket,
    heartbeatMs: 60_000,
    ackTimeoutMs: 1_000,
    maxPendingAcks: 1,
  });
  t.after(() => client.stop());
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const socket = IdentityWebSocket.instances.at(-1);
  const first = client.sendEvent({
    type: "DJ_RELEASE",
    eventId: "single-use",
    payload: strictV3ReleasePayload(),
  });
  assert.equal(first.state, "pending");
  const firstFrame = socket.sent.find((frame) => frame.eventId === first.eventId);
  const beforeWrongAck = client.getStatus().lastDelivery.updatedAt;
  socket.emit("message", JSON.stringify(strictV3Ack({
    eventId: first.eventId,
    sequence: first.sequence + 1,
  })));
  socket.emit("message", JSON.stringify(strictV3Ack({
    eventId: "unknown-event",
    sequence: first.sequence,
  })));
  assert.equal(client.getStatus().lastDelivery.state, "pending");
  assert.equal(client.getStatus().lastDelivery.updatedAt, beforeWrongAck);
  assert.equal(client.getStatus().lastAckAt, null);
  socket.emit("message", JSON.stringify(strictV3Ack(firstFrame)));
  assert.equal(client.getStatus().lastDelivery.state, "acknowledged");
  const reused = client.sendEvent({
    type: "DJ_RELEASE",
    eventId: first.eventId,
    payload: strictV3ReleasePayload(),
  });
  assert.equal(reused.reason, "event-id-reused");

  const terminal = client.sendEvent({
    type: "DJ_RELEASE",
    eventId: "terminal-single-use",
    payload: strictV3ReleasePayload(),
  });
  const terminalFrame = socket.sent.find((frame) => frame.eventId === terminal.eventId);
  socket.emit("message", JSON.stringify(strictV3Ack(terminalFrame, "rejected", { code: "NO_MAPPING" })));
  assert.equal(client.getStatus().lastDelivery.state, "rejected");
  assert.equal(client.sendEvent({
    type: "DJ_RELEASE",
    eventId: terminal.eventId,
    payload: strictV3ReleasePayload(),
  }).reason, "event-id-reused");

  const saturated = client.sendEvent({
    type: "DJ_RELEASE",
    eventId: "saturated",
    payload: strictV3ReleasePayload(),
  });
  const rejectedByCapacity = client.sendEvent({
    type: "DJ_LOOP_STATE",
    eventId: "capacity-rejected",
    payload: { division: 1 },
  });
  assert.equal(saturated.state, "pending");
  assert.equal(rejectedByCapacity.reason, "pending-ack-limit");
  assert.equal(client.getStatus().pendingAcks, 1);
  socket.emit("message", JSON.stringify({
    ...strictV3Ack(socket.sent.find((frame) => frame.eventId === saturated.eventId)),
  }));
  const recovered = client.sendEvent({
    type: "DJ_LOOP_STATE",
    eventId: "capacity-recovered",
    payload: strictV3LoopPayload({ revision: 2, lengthBeats: 4, endBeat: 36 }),
  });
  assert.equal(recovered.sent, true);
  assert.equal(client.getStatus().pendingAcks, 1);
});

test("every physical event waits for typed ACK outcomes and retired DJ_MASTER_CHANGED cannot be queued, delivered, or retried", async (t) => {
  class PhysicalAckWebSocket extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.readyState = 0;
      this.sent = [];
      PhysicalAckWebSocket.instances.push(this);
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
    }
  }

  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: PhysicalAckWebSocket,
    heartbeatMs: 60_000,
    ackTimeoutMs: 25,
    busyRetryMaxAttempts: 2,
    busyRetryBaseMs: 2,
    busyRetryMaxMs: 2,
  });
  t.after(() => client.stop());
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const socket = PhysicalAckWebSocket.instances.at(-1);
  const ack = (result, outcome) => {
    const frame = socket.sent.find((candidate) => candidate.eventId === result.eventId);
    socket.emit("message", JSON.stringify(strictV3Ack(
      frame,
      outcome,
      { code: ["accepted", "duplicate"].includes(outcome) ? null : outcome.toUpperCase() },
    )));
  };

  const retiredMaster = client.sendEvent({
    type: "DJ_MASTER_CHANGED",
    eventId: "retired-master-changed",
    payload: { deck: 2, isPlaying: true, master: true },
  });
  assert.equal(retiredMaster.sent, false);
  assert.equal(retiredMaster.ok, false);
  assert.equal(retiredMaster.skipped, true);
  assert.equal(retiredMaster.reason, "unsupported-type");
  assert.equal(client.getStatus().pendingAcks, 0);
  assert.equal(client.getStatus().deliveryHistorySize, 0);
  assert.equal(client.getStatus().lastDelivery, null);
  assert.equal(socket.sent.some((frame) => frame.type === "DJ_MASTER_CHANGED"), false);

  const rejectedTrack = client.sendEvent({
    type: "DJ_TRACK_ACTIVE",
    payload: strictV3TrackPayload({
      deck: 2,
      deckId: "rekordbox-deck-2",
      playSessionId: "session-1",
    }),
  });
  assert.equal(rejectedTrack.state, "pending");
  ack(rejectedTrack, "rejected");
  assert.equal(client.getStatus().lastDelivery.state, "rejected");

  const noMappingLoop = client.sendEvent({
    type: "DJ_LOOP_STATE",
    payload: strictV3LoopPayload(),
  });
  assert.equal(noMappingLoop.state, "pending");
  ack(noMappingLoop, "no_mapping");
  assert.equal(client.getStatus().lastDelivery.state, "rejected");

  const busyRelease = client.sendEvent({
    type: "DJ_RELEASE",
    payload: strictV3ReleasePayload(),
  });
  const firstReleaseFrame = socket.sent.at(-1);
  ack(busyRelease, "busy");
  await new Promise((resolve) => setTimeout(resolve, 8));
  const retryReleaseFrame = socket.sent.at(-1);
  assert.deepEqual(retryReleaseFrame, firstReleaseFrame);
  ack(busyRelease, "duplicate");
  assert.equal(client.getStatus().lastDelivery.state, "acknowledged");

  const timedOutTimeline = client.sendEvent({
    type: "DJ_TIMELINE_BEAT_JUMP",
    payload: { bars: -4, timelineId: "timeline-1", playSessionId: "play-session-1" },
  });
  assert.equal(timedOutTimeline.state, "pending");
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(client.getStatus().lastDelivery.state, "timed-out");

  const acceptedTimelineLoop = client.sendEvent({
    type: "DJ_TIMELINE_LOOP_SET",
    payload: { active: true, timelineId: "timeline-1", playSessionId: "play-session-1" },
  });
  assert.equal(acceptedTimelineLoop.state, "pending");
  ack(acceptedTimelineLoop, "accepted");
  assert.equal(client.getStatus().lastDelivery.state, "acknowledged");
});

test("invalid State Sync snapshots never send or request timeline, then recover on reconnect", async (t) => {
  class StateRecoveryWebSocket extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.readyState = 0;
      this.sent = [];
      StateRecoveryWebSocket.instances.push(this);
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
    }
  }

  let mode = "throw";
  const errors = [];
  const failures = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: StateRecoveryWebSocket,
    heartbeatMs: 60_000,
    reconnectMinMs: 50,
    reconnectMaxMs: 100,
    stateSyncProvider: () => {
      if (mode === "throw") throw new Error("provider failure");
      if (mode === "null") return null;
      if (mode === "undefined") return undefined;
      if (mode === "invalid") return { loopDivision: "bad" };
      return { released: false };
    },
  });
  client.on("state-sync-error", (failure) => errors.push(failure));
  client.on("send-failed", (failure) => {
    if (failure.kind === "state-sync") failures.push(failure);
  });
  t.after(() => client.stop());
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const first = StateRecoveryWebSocket.instances[0];
  assert.deepEqual(first.sent.map((frame) => frame.type), ["DJ_AGENT_HELLO"]);

  for (const invalidMode of ["null", "undefined", "invalid"]) {
    mode = invalidMode;
    const sequenceBeforeAttempt = client.getStatus().wireSequence;
    assert.equal(client.sendStateSync(), false);
    assert.equal(first.sent.some((frame) => frame.type === "DJ_STATE_SYNC"), false);
    assert.equal(first.sent.some((frame) => frame.type === "DJ_TIMELINE_STATE_REQUEST"), false);
    assert.equal(
      client.getStatus().wireSequence,
      sequenceBeforeAttempt + (invalidMode === "invalid" ? 1 : 0),
    );
  }
  assert.equal(errors.length, 4);
  assert.equal(failures.length, 4);
  assert.equal(client.getStatus().stateSync, "error");

  mode = "valid";
  first.emit("close", 1006, "retry");
  await new Promise((resolve) => setTimeout(resolve, 80));
  const recovered = StateRecoveryWebSocket.instances.at(-1);
  assert.notEqual(recovered, first);
  assert.deepEqual(recovered.sent.map((frame) => frame.type), [
    "DJ_AGENT_HELLO",
    "DJ_STATE_SYNC",
    "DJ_TIMELINE_STATE_REQUEST",
  ]);
  assert.equal(client.getStatus().stateSync, "sent");
});

test("physical IDs and sequences fail closed before reservation while controls outlive the physical cap", async (t) => {
  function createManualIntervalClock() {
    const active = new Set();
    const started = [];
    const cleared = [];
    return {
      started,
      cleared,
      get activeCount() {
        return active.size;
      },
      intervalApi: {
        setInterval(callback, intervalMs) {
          const handle = { id: started.length + 1, callback, intervalMs };
          started.push(handle);
          active.add(handle);
          return handle;
        },
        clearInterval(handle) {
          if (!active.has(handle)) {
            return false;
          }
          cleared.push(handle);
          active.delete(handle);
          return true;
        },
      },
      tick(count) {
        for (let index = 0; index < count; index += 1) {
          for (const handle of [...active]) {
            handle.callback();
          }
        }
      },
    };
  }

  class IdentityCapWebSocket extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.readyState = 0;
      this.sent = [];
      IdentityCapWebSocket.instances.push(this);
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
    }
  }

  const heartbeatClock = createManualIntervalClock();
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: IdentityCapWebSocket,
    intervalApi: heartbeatClock.intervalApi,
    heartbeatMs: 60_000,
    maxPendingAcks: 8,
    eventIdRegistryMax: 5,
    ackTimeoutMs: 1_000,
  });
  t.after(() => client.stop());
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.getStatus().eventIdRegistrySize, 0);
  assert.equal(client.sendEvent({ type: " DJ_RELEASE ", payload: strictV3ReleasePayload() }).reason, "unsupported-type");
  assert.equal(client.sendEvent({ type: "DJ_RELEASE", payload: null }).reason, "invalid-payload");
  assert.equal(client.sendEvent({ type: "DJ_RELEASE", payload: { state: {} } }).reason, "invalid-payload");
  assert.equal(client.getStatus().eventIdRegistrySize, 0);

  const first = client.sendEvent({
    type: "DJ_RELEASE",
    eventId: "physical-first",
    sequence: 4,
    payload: strictV3ReleasePayload(),
  });
  assert.equal(first.state, "pending");
  assert.equal(client.sendEvent({
    type: "DJ_RELEASE",
    eventId: "rollback-equal",
    sequence: 4,
    payload: strictV3ReleasePayload(),
  }).reason, "sequence-rollback");
  assert.equal(client.sendEvent({
    type: "DJ_RELEASE",
    eventId: "rollback-lower",
    sequence: 3,
    payload: strictV3ReleasePayload(),
  }).reason, "sequence-rollback");
  assert.equal(client.sendEvent({
    type: "DJ_RELEASE",
    eventId: "rollback-fraction",
    sequence: 4.5,
    payload: strictV3ReleasePayload(),
  }).reason, "invalid-sequence");
  assert.equal(client.getStatus().eventIdRegistrySize, 1);

  const second = client.sendEvent({
    type: "DJ_RELEASE",
    eventId: "physical-second",
    payload: strictV3ReleasePayload(),
  });
  assert.equal(second.sequence, 5);
  const high = client.sendEvent({
    type: "DJ_RELEASE",
    eventId: "physical-high",
    sequence: Number.MAX_SAFE_INTEGER,
    payload: strictV3ReleasePayload(),
  });
  assert.equal(high.state, "pending");
  assert.equal(client.sendEvent({ type: "DJ_RELEASE", payload: strictV3ReleasePayload() }).reason, "sequence-overflow");
  assert.equal(client.sendEvent({
    type: "DJ_RELEASE",
    eventId: "physical-first",
    payload: strictV3ReleasePayload(),
  }).reason, "event-id-reused");
  assert.equal(client.getStatus().eventIdRegistrySize, 3);

  const capClock = createManualIntervalClock();
  const capClient = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: IdentityCapWebSocket,
    intervalApi: capClock.intervalApi,
    heartbeatMs: 1,
    reconnectMinMs: 50,
    reconnectMaxMs: 100,
    maxPendingAcks: 4,
    eventIdRegistryMax: 1,
    ackTimeoutMs: 10_000,
  });
  t.after(() => capClient.stop());
  capClient.start();
  await new Promise((resolve) => setImmediate(resolve));
  const capSocket = IdentityCapWebSocket.instances.at(-1);
  assert.equal(capClock.activeCount, 1);
  const controlId = capSocket.sent.find((frame) => frame.type === "DJ_AGENT_HELLO").eventId;
  const controlSequenceBeforeCallerId = capClient.getStatus().wireSequence;
  const callerControl = capClient.sendEvent({
    type: "DJ_TIMELINE_STATE_REQUEST",
    eventId: "caller-supplied-control",
  });
  assert.equal(callerControl.reason, "control-event-id-not-accepted");
  assert.equal(capClient.getStatus().wireSequence, controlSequenceBeforeCallerId);
  assert.equal(capSocket.sent.some((frame) => frame.type === "DJ_TIMELINE_STATE_REQUEST" && frame.eventId === "caller-supplied-control"), false);
  const capped = capClient.sendEvent({ type: "DJ_RELEASE", payload: strictV3ReleasePayload() });
  assert.equal(capped.state, "pending");
  assert.equal(capClient.sendEvent({
    type: "DJ_RELEASE",
    eventId: controlId,
    payload: strictV3ReleasePayload(),
  }).reason, "event-id-conflicts-with-control");
  assert.equal(capClient.getStatus().physicalEventIdLatched, true);
  assert.equal(capClient.sendEvent({ type: "DJ_RELEASE", payload: strictV3ReleasePayload() }).reason, "event-id-admission-limit");
  capClock.tick(4_097);
  const controlFrames = capSocket.sent.filter((frame) => [
    "DJ_AGENT_HELLO",
    "DJ_STATE_SYNC",
    "DJ_TIMELINE_STATE_REQUEST",
    "DJ_HEARTBEAT",
  ].includes(frame.type));
  assert.ok(capSocket.sent.filter((frame) => frame.type === "DJ_HEARTBEAT").length > 4_096);
  assert.equal(new Set(controlFrames.map((frame) => frame.eventId)).size, controlFrames.length);
  assert.ok(capClient.getStatus().wireSequence > 4_096);
  const oldControlIds = new Set(controlFrames.map((frame) => frame.eventId));
  capSocket.emit("close", 1006, "reconnect");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(IdentityCapWebSocket.instances.length >= 3);
  assert.equal(capClock.activeCount, 1);
  const reconnectSocket = IdentityCapWebSocket.instances.at(-1);
  const reconnectHello = reconnectSocket.sent.find((frame) => frame.type === "DJ_AGENT_HELLO");
  assert.ok(reconnectHello.eventId.startsWith("control-"));
  assert.equal(oldControlIds.has(reconnectHello.eventId), false);
  const cappedReplay = reconnectSocket.sent.find((frame) => frame.eventId === capped.eventId);
  assertStrictV3Frame(cappedReplay, "DJ_RELEASE");
  assert.notEqual(cappedReplay.sessionId, capSocket.sent.find((frame) => frame.eventId === capped.eventId).sessionId);
  assert.deepEqual(cappedReplay.payload, strictV3ReleasePayload());

  const recreatedClock = createManualIntervalClock();
  const recreatedClient = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: IdentityCapWebSocket,
    intervalApi: recreatedClock.intervalApi,
    heartbeatMs: 60_000,
  });
  t.after(() => recreatedClient.stop());
  recreatedClient.start();
  await new Promise((resolve) => setImmediate(resolve));
  const recreatedSocket = IdentityCapWebSocket.instances.at(-1);
  const recreatedHello = recreatedSocket.sent.find((frame) => frame.type === "DJ_AGENT_HELLO");
  assert.ok(recreatedHello.eventId.startsWith("control-"));
  assert.notEqual(recreatedHello.eventId, reconnectHello.eventId);
  assert.equal(recreatedClient.sendEvent({
    type: "DJ_RELEASE",
    eventId: controlId,
    payload: strictV3ReleasePayload(),
  }).reason, "event-id-conflicts-with-control");

  client.stop();
  capClient.stop();
  recreatedClient.stop();
  const expectedHeartbeatMs = new Map([
    [heartbeatClock, 60_000],
    [capClock, 1],
    [recreatedClock, 60_000],
  ]);
  for (const [clock, heartbeatMs] of expectedHeartbeatMs) {
    assert.ok(clock.started.length > 0);
    for (const handle of clock.started) {
      assert.equal(handle.intervalMs, heartbeatMs);
    }
    assert.equal(clock.activeCount, 0);
    assert.equal(clock.cleared.length, clock.started.length);
    const clearedCounts = new Map();
    for (const handle of clock.cleared) {
      clearedCounts.set(handle, (clearedCounts.get(handle) || 0) + 1);
    }
    for (const handle of clock.started) {
      assert.equal(clearedCounts.get(handle), 1);
    }
  }
});

test("Syndocal interval seam accepts class-instance clocks and keeps invalid adapters fail-fast", async (t) => {
  class ManualHeartbeatClock {
    constructor() {
      this.started = [];
      this.cleared = [];
      this.active = new Set();
    }

    setInterval(callback, intervalMs) {
      const handle = { callback, intervalMs };
      this.started.push(handle);
      this.active.add(handle);
      return handle;
    }

    clearInterval(handle) {
      if (!this.active.has(handle)) {
        return false;
      }
      this.cleared.push(handle);
      this.active.delete(handle);
      return true;
    }
  }

  class HeartbeatProbeWebSocket extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.readyState = 0;
      this.sent = [];
      HeartbeatProbeWebSocket.instances.push(this);
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
    }
  }

  const clock = new ManualHeartbeatClock();
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: HeartbeatProbeWebSocket,
    intervalApi: clock,
    heartbeatMs: 250,
  });
  t.after(() => client.stop());
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const socket = HeartbeatProbeWebSocket.instances.at(-1);
  assert.equal(socket.sent.some((frame) => frame.type === "DJ_HEARTBEAT"), false);
  const tickHandles = [...clock.active];
  for (const handle of tickHandles) {
    handle.callback();
  }
  assert.equal(socket.sent.filter((frame) => frame.type === "DJ_HEARTBEAT").length, tickHandles.length);
  assert.equal(clock.started.length, tickHandles.length);
  for (const handle of clock.started) {
    assert.equal(handle.intervalMs, 250);
  }
  client.stop();
  assert.equal(clock.active.size, 0);
  assert.equal(clock.cleared.length, clock.started.length);
  const clearedCounts = new Map();
  for (const handle of clock.cleared) {
    clearedCounts.set(handle, (clearedCounts.get(handle) || 0) + 1);
  }
  for (const handle of clock.started) {
    assert.equal(clearedCounts.get(handle), 1);
  }

  class MethodlessClock {}
  assert.throws(
    () => createSyndocalClient({
      enabled: true,
      token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
      intervalApi: new MethodlessClock(),
    }),
    TypeError,
  );
  assert.throws(
    () => createSyndocalClient({
      enabled: true,
      token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
      intervalApi: "setInterval-string",
    }),
    TypeError,
  );
});

test("Syndocal heartbeat seam treats numeric 0 as a valid opaque interval handle", async (t) => {
  class ZeroFirstClock {
    constructor() {
      this.started = [];
      this.cleared = [];
      this.active = new Set();
    }

    setInterval(callback, intervalMs) {
      const handle = this.started.length;
      this.started.push({ handle, callback, intervalMs });
      this.active.add(handle);
      return handle;
    }

    clearInterval(handle) {
      if (!this.active.has(handle)) {
        return false;
      }
      this.cleared.push(handle);
      this.active.delete(handle);
      return true;
    }
  }

  class ZeroHandleProbeWebSocket extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.readyState = 0;
      this.sent = [];
      ZeroHandleProbeWebSocket.instances.push(this);
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
    }
  }

  const clock = new ZeroFirstClock();
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: ZeroHandleProbeWebSocket,
    intervalApi: clock,
    heartbeatMs: 60_000,
  });
  t.after(() => client.stop());
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clock.started.length, 1);
  assert.equal(clock.started[0].handle, 0);
  const socket = ZeroHandleProbeWebSocket.instances.at(-1);
  clock.started[0].callback();
  assert.equal(socket.sent.filter((frame) => frame.type === "DJ_HEARTBEAT").length, 1);
  client.stop();
  assert.deepEqual(clock.cleared, [0]);
  assert.equal(clock.active.size, 0);

  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const restartedSocket = ZeroHandleProbeWebSocket.instances.at(-1);
  assert.notEqual(restartedSocket, socket);
  assert.equal(clock.started.length, 2);
  assert.equal(clock.started[1].handle, 1);
  assert.deepEqual(clock.cleared, [0]);
  restartedSocket.emit("open");
  assert.deepEqual(clock.cleared, [0, 1]);
  assert.equal(clock.active.size, 1);
  assert.ok(clock.active.has(2));
  client.stop();
  assert.deepEqual(clock.cleared, [0, 1, 2]);
  assert.equal(clock.active.size, 0);
  const clearedCounts = new Map();
  for (const handle of clock.cleared) {
    clearedCounts.set(handle, (clearedCounts.get(handle) || 0) + 1);
  }
  for (const entry of clock.started) {
    assert.equal(entry.intervalMs, 60_000);
    assert.equal(clearedCounts.get(entry.handle), 1);
  }
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

test("router keeps identity-unproven Stage 1 actions off the disconnected network", () => {
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
  assert.equal(result.midiSent, false);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no-admitted-track-candidate");
  assert.equal(result.delivery, null);
  assert.deepEqual(midiCalls, []);
  assert.deepEqual(sent, []);
  assert.deepEqual(routedEvents, []);
  const releaseResult = router.triggerAction("release");
  assert.equal(releaseResult.ok, false);
  assert.equal(releaseResult.reason, "no-admitted-track-candidate");
  assert.deepEqual(routedEvents, []);
  router.stop();
});

test("router correlates release timeout back to the same action event", async (t) => {
  const releaseTimers = createReleaseTimers();
  class ActionWebSocket extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.readyState = 0;
      this.sent = [];
      ActionWebSocket.instances.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }

    send(value) { this.sent.push(JSON.parse(value)); }

    close() {
      this.readyState = 3;
      this.emit("close", 1000, "test");
    }
  }

  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
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
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal,
    releaseFade: exactReleaseFade(),
    releaseMacro: exactReleaseMacro(),
    timerApi: releaseTimers.timerApi,
  });
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
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date().toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "42", title: "Life Over", artist: "DSF", trackBpm: 120 }],
    deckPlaybacks: [strictDetectorPlayback(1, 1)],
  });
  const activeFrame = socket.sent.find((frame) => frame.type === "DJ_TRACK_ACTIVE");
  assert.ok(activeFrame);
  socket.emit("message", JSON.stringify(strictV3Ack(activeFrame, "accepted")));
  const actionSessionId = detector.getState().decks[1].playSessionId;
  socket.emit("message", JSON.stringify({
    v: 3,
    type: "DJ_TIMELINE_STATE",
    agentId: "syndocal",
    sessionId: "syndocal-session",
    sequence: 1,
    eventId: "action-timeline-state",
    payload: {
      state: "running",
      loopActive: false,
      timelineId: "life-over",
      positionBars: 0,
      playSessionId: actionSessionId,
      pedalOwner: "dj",
      releaseEventId: null,
    },
  }));

  router.triggerAction("release");
  releaseTimers.runPlannedCompletion();
  const release = router.getStatus().lastAction;
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
  assert.equal(socket.sent.filter((frame) => frame.type === "DJ_RELEASE").length, 1);
});

test("native optional dependency and pkg asset configuration keep source/packaged resolution explicit", () => {
  assert.equal(resolveMidiModule("rb-output-test-missing-midi"), null);
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.match(packageJson.optionalDependencies["@julusian/midi"], /^\^3\.8\./);
  assert.match(packageJson.optionalDependencies["uiohook-napi"], /^\^1\.5\./);
  assert.match(packageJson.optionalDependencies.ws, /^\^8\./);
  assert.equal(packageJson.pkg.scripts.some((script) => script.includes("node_modules/ws")), true);
  assert.equal(packageJson.pkg.assets.some((asset) => asset.includes("node_modules/ws")), true);
  assert.equal(packageJson.pkg.assets.some((asset) => asset.includes("@julusian/midi")), true);
  assert.equal(packageJson.pkg.assets.some((asset) => asset.includes("uiohook-napi")), true);
  const clientSource = fs.readFileSync(path.join(__dirname, "..", "server", "dj-agent", "syndocalClient.js"), "utf8");
  assert.match(clientSource, /require\("ws"\)/);
  assert.equal(resolveWebSocketImplementation("rb-output-test-missing-ws"), null);
});

test("web server does not monitor or automatically launch Rekordbox", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
  assert.doesNotMatch(serverSource, /tryRecoverHook|hookRuntime|HOOK_INJECT_SCRIPT|REKORDBOX_EXE_PATH/);
  assert.doesNotMatch(serverSource, /process\.kill\([^)]*,\s*0\)/);

  const injectorSource = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "inject_hook.py"),
    "utf8",
  );
  assert.match(injectorSource, /"--handoff-seconds"[\s\S]*?default=0/);
});

test("DJ Agent status carries and renders a separate admitted owner diagnostic", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");
  const appSource = fs.readFileSync(path.join(__dirname, "..", "server", "public", "app.js"), "utf8");
  const htmlSource = fs.readFileSync(path.join(__dirname, "..", "server", "public", "index.html"), "utf8");

  for (const field of ["ownerDeck", "ownerDeckId", "activePlaySessionId", "ownerTrack"]) {
    assert.match(serverSource, new RegExp(`${field}: routerStatus\\.${field}`));
  }
  assert.match(serverSource, /ownerWireIdentity: routerStatus\.ownerWireIdentity/);
  assert.match(htmlSource, /id="djAgentOwnerRow" class="row" hidden/);
  assert.match(htmlSource, /id="djAgentOwner" class="dj-agent-value dj-agent-owner"/);
  assert.match(appSource, /function formatAdmittedOwner\(agent\)/);
  assert.match(appSource, /djAgentOwnerRowEl\.hidden = admittedOwner === null/);
  assert.match(appSource, /djAgentOwnerEl\.textContent = admittedOwner/);
  assert.match(appSource, /agent\?\.released === true/);
  assert.match(appSource, /deckId !== `rekordbox-deck-\$\{deck\}`/);
  const ownerRenderer = appSource.slice(
    appSource.indexOf("function formatAdmittedOwner"),
    appSource.indexOf("function isLocalDjAgentHost"),
  );
  assert.doesNotMatch(ownerRenderer, /master/i, "owner diagnostics must not be rendered as MASTER diagnostics");
});
