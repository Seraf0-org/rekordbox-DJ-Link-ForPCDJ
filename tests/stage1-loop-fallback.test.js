"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  MAX_RESPONSE_WINDOW_MS,
  MIN_RESPONSE_WINDOW_MS,
  STAGE1_LOOP_LENGTH_PROFILE,
  createStage1LoopFallback,
} = require("../server/dj-agent/stage1LoopFallback");
const { createShowEventRouter } = require("../server/dj-agent/showEventRouter");
const {
  createSyndocalEnvelopeV3Adapter,
  resolveAdapter,
} = require("../server/dj-agent/syndocalClient");
const { loadDjAgentConfig } = require("../server/dj-agent/config");

const TOKEN = "0123456789abcdef0123456789abcdef";

function createTimers() {
  let nextId = 0;
  const pending = new Map();
  return {
    clearTimeout(id) {
      pending.delete(id);
    },
    setTimeout(callback, delayMs) {
      const id = ++nextId;
      pending.set(id, { callback, delayMs });
      return id;
    },
    runAll() {
      const due = [...pending.entries()];
      pending.clear();
      for (const [, item] of due) item.callback();
    },
    size() {
      return pending.size;
    },
  };
}

function identity() {
  return {
    deck: 1,
    deckId: "rekordbox-deck-1",
    masterDeckRevision: 3,
    playSessionId: "play-session-3",
  };
}

function measured(revision, lengthBeats, overrides = {}) {
  const active = overrides.active ?? true;
  return {
    type: "DJ_LOOP_STATE",
    payload: {
      ...identity(),
      active,
      startBeat: active ? 32 : null,
      endBeat: active ? 32 + lengthBeats : null,
      lengthBeats: active ? lengthBeats : null,
      revision,
      sampleAgeMs: 0,
      source: "rekordbox-hook-measured",
      ...overrides,
    },
  };
}

test("Stage 1 fallback profile is bounded only at 1/64 and handles measured races fail-closed", () => {
  const timers = createTimers();
  const emitted = [];
  const fallback = createStage1LoopFallback({
    responseWindowMs: 250,
    timerApi: timers,
    now: () => 10_000,
    onFallback: (payload) => emitted.push(payload),
  });

  const targets = [];
  for (let index = 0; index < STAGE1_LOOP_LENGTH_PROFILE.length; index += 1) {
    const intent = fallback.begin(identity());
    targets.push(intent.targetLengthBeats);
    fallback.clear("profile-test");
  }
  assert.deepEqual(targets, STAGE1_LOOP_LENGTH_PROFILE);
  assert.equal(targets.includes(2), true);
  assert.equal(targets.at(-1), 1 / 64);

  // New manager instances keep each race assertion independent.
  const matchingTimers = createTimers();
  const matching = createStage1LoopFallback({
    responseWindowMs: 250,
    timerApi: matchingTimers,
    onFallback: (payload) => emitted.push(payload),
  });
  matching.begin(identity());
  assert.equal(matching.observeMeasured(measured(1, 8)).state, "matched");
  matchingTimers.runAll();
  assert.equal(emitted.length, 0, "a matching fresh measurement cancels the fallback");

  const contradictionTimers = createTimers();
  const contradictory = createStage1LoopFallback({
    responseWindowMs: 250,
    timerApi: contradictionTimers,
    onFallback: (payload) => emitted.push(payload),
  });
  contradictory.begin(identity());
  assert.equal(contradictory.observeMeasured(measured(1, 2)).state, "contradictory");
  contradictionTimers.runAll();
  assert.equal(emitted.length, 0, "a contradictory fresh measurement fails closed");

  const loopOffTimers = createTimers();
  const loopOff = createStage1LoopFallback({
    responseWindowMs: 250,
    timerApi: loopOffTimers,
    onFallback: (payload) => emitted.push(payload),
  });
  loopOff.begin(identity());
  assert.equal(loopOff.observeMeasured(measured(1, null, { active: false })).state, "contradictory");
  loopOffTimers.runAll();
  assert.equal(emitted.length, 0, "a fresh measured loop-off also suppresses prediction");

  const invalidTimers = createTimers();
  const invalidResponses = [];
  const invalid = createStage1LoopFallback({
    responseWindowMs: 250,
    timerApi: invalidTimers,
    onFallback: (payload) => invalidResponses.push(payload),
  });
  invalid.begin(identity());
  const invalidOutcome = invalid.observeMeasured(measured(1, 8, { source: "pedal" }));
  assert.equal(invalidOutcome.accepted, false);
  assert.equal(invalidOutcome.fallbackSuppressed, true);
  invalidTimers.runAll();
  assert.equal(invalidResponses.length, 0, "an invalid response must fail closed instead of becoming no-response");

  const foreignTimers = createTimers();
  const foreignResponses = [];
  const foreignInvalid = createStage1LoopFallback({
    responseWindowMs: 250,
    timerApi: foreignTimers,
    onFallback: (payload) => foreignResponses.push(payload),
  });
  foreignInvalid.begin(identity());
  const foreignOutcome = foreignInvalid.observeMeasured(measured(1, 8, {
    deck: 2,
    deckId: "rekordbox-deck-2",
    source: "invalid-source",
  }));
  assert.equal(foreignOutcome.accepted, false);
  assert.equal(foreignOutcome.fallbackSuppressed, false);
  foreignTimers.runAll();
  assert.equal(
    foreignResponses.length,
    1,
    "an invalid response with a provably different lineage is not the pending intent's response",
  );

  const staleTimers = createTimers();
  const staleResponses = [];
  const stale = createStage1LoopFallback({
    responseWindowMs: 250,
    timerApi: staleTimers,
    onFallback: (payload) => staleResponses.push(payload),
  });
  assert.equal(stale.observeMeasured(measured(1, 8)).state, "observed");
  stale.begin(identity());
  const staleOutcome = stale.observeMeasured(measured(1, 8));
  assert.equal(staleOutcome.reason, "stale-measured-loop");
  assert.equal(staleOutcome.fallbackSuppressed, true);
  staleTimers.runAll();
  assert.equal(staleResponses.length, 0, "a stale response must also suppress prediction");

  const rapidTimers = createTimers();
  const rapidEmitted = [];
  const rapid = createStage1LoopFallback({
    responseWindowMs: 250,
    timerApi: rapidTimers,
    onFallback: (payload) => rapidEmitted.push(payload),
  });
  const first = rapid.begin(identity());
  const newest = rapid.begin(identity());
  assert.deepEqual([first.targetLengthBeats, newest.targetLengthBeats], [8, 4]);
  const partial = rapid.observeMeasured(measured(1, 8));
  assert.equal(partial.state, "partial-match");
  assert.equal(rapid.getState().pending.targetLengthBeats, 4);
  rapidTimers.runAll();
  assert.deepEqual(rapidEmitted, [{
    ...identity(),
    targetLengthBeats: 4,
    responseWindowMs: 250,
    source: "pedal-no-response-predicted",
  }]);

  const threePressTimers = createTimers();
  const threePressEmitted = [];
  const threePress = createStage1LoopFallback({
    responseWindowMs: 250,
    timerApi: threePressTimers,
    onFallback: (payload) => threePressEmitted.push(payload),
  });
  assert.equal(threePress.begin(identity()).targetLengthBeats, 8);
  threePressTimers.runAll();
  assert.equal(threePress.begin(identity()).targetLengthBeats, 4);
  assert.equal(threePress.begin(identity()).targetLengthBeats, 2);
  assert.equal(threePress.observeMeasured(measured(1, 8)).state, "late-partial-match");
  assert.equal(threePress.getState().pending.targetLengthBeats, 2);
  threePressTimers.runAll();
  assert.deepEqual(threePressEmitted.map((payload) => payload.targetLengthBeats), [8, 2]);

  const intermediateTimers = createTimers();
  const intermediateEmitted = [];
  const intermediate = createStage1LoopFallback({
    responseWindowMs: 250,
    timerApi: intermediateTimers,
    onFallback: (payload) => intermediateEmitted.push(payload),
  });
  assert.equal(intermediate.begin(identity()).targetLengthBeats, 8);
  intermediateTimers.runAll();
  assert.equal(intermediate.begin(identity()).targetLengthBeats, 4);
  assert.equal(intermediate.begin(identity()).targetLengthBeats, 2);
  const intermediateMatch = intermediate.observeMeasured(measured(1, 4));
  assert.equal(intermediateMatch.state, "late-partial-match");
  assert.equal(intermediateMatch.targetLengthBeats, 4);
  assert.equal(intermediate.getState().pending.targetLengthBeats, 2);
  intermediateTimers.runAll();
  assert.deepEqual(intermediateEmitted.map((payload) => payload.targetLengthBeats), [8, 2]);

  const currentAfterFallbackTimers = createTimers();
  const currentAfterFallbackEmitted = [];
  const currentAfterFallback = createStage1LoopFallback({
    responseWindowMs: 250,
    timerApi: currentAfterFallbackTimers,
    onFallback: (payload) => currentAfterFallbackEmitted.push(payload),
  });
  currentAfterFallback.begin(identity());
  currentAfterFallbackTimers.runAll();
  assert.equal(currentAfterFallback.begin(identity()).targetLengthBeats, 4);
  assert.equal(currentAfterFallback.observeMeasured(measured(1, 4)).state, "matched");
  currentAfterFallbackTimers.runAll();
  assert.deepEqual(currentAfterFallbackEmitted.map((payload) => payload.targetLengthBeats), [8]);

  const lateTimers = createTimers();
  const late = createStage1LoopFallback({ responseWindowMs: 250, timerApi: lateTimers });
  late.begin(identity());
  lateTimers.runAll();
  assert.equal(late.observeMeasured(measured(1, 2)).state, "late-measured");
  assert.equal(late.begin(identity()).targetLengthBeats, 1, "late measurement rebases the next intent");
});

test("v3 fallback wire payload is exact and v2 has no adapter shim", () => {
  assert.throws(
    () => createStage1LoopFallback({ responseWindowMs: MIN_RESPONSE_WINDOW_MS - 1 }),
    /50 to 1500/,
  );
  assert.throws(
    () => createStage1LoopFallback({ responseWindowMs: MAX_RESPONSE_WINDOW_MS + 1 }),
    /50 to 1500/,
  );
  assert.doesNotThrow(() => createStage1LoopFallback({ responseWindowMs: MIN_RESPONSE_WINDOW_MS }));
  assert.doesNotThrow(() => createStage1LoopFallback({ responseWindowMs: MAX_RESPONSE_WINDOW_MS }));
  assert.equal(loadDjAgentConfig({ env: {} }).syndocal.adapter, "syndocal-envelope-v3");
  const adapter = createSyndocalEnvelopeV3Adapter({ token: TOKEN });
  const payload = {
    ...identity(),
    targetLengthBeats: 1 / 4,
    responseWindowMs: 250,
    source: "pedal-no-response-predicted",
  };
  const frame = adapter.encodeEvent({
    type: "DJ_LOOP_FALLBACK",
    eventId: "fallback-1",
    sequence: 2,
    payload,
  });
  assert.equal(frame.v, 3);
  assert.equal(frame.type, "DJ_LOOP_FALLBACK");
  assert.deepEqual(frame.payload, payload);
  assert.equal(adapter.encodeEvent({
    type: "DJ_LOOP_FALLBACK",
    eventId: "fallback-extra",
    sequence: 3,
    payload: { ...payload, extra: true },
  }), null);
  assert.equal(resolveAdapter({ adapter: "syndocal-envelope-v2", token: TOKEN }).adapterObject, null);
  assert.equal(resolveAdapter({ adapter: "syndocal-envelope-v3", token: TOKEN }).adapterObject.name, "syndocal-envelope-v3");
});

test("F14 arms fallback before MIDI failure, while F13 routes release and clears it", () => {
  const timers = createTimers();
  const detector = new EventEmitter();
  detector.getState = () => ({
    currentMasterDeck: 1,
    masterDeckRevision: 3,
    decks: { 1: { playSessionId: "play-session-3" } },
  });
  const client = new EventEmitter();
  const sent = [];
  client.getStatus = () => ({ enabled: true, state: "connected" });
  client.sendEvent = (event) => {
    const eventId = `event-${sent.length + 1}`;
    sent.push({ ...event, eventId });
    return { eventId, type: event.type, sent: true, ok: true, state: "acknowledged", ackState: "acknowledged" };
  };
  client.start = () => {};
  client.stop = () => {};
  const midi = {
    getStatus: () => ({ ok: false }),
    resolveTarget: (_mapping, deck) => ({ targetDeck: deck, targetChannel: 1 }),
    sendMapping: () => false,
    start() {},
    stop() {},
  };
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { getStatus: () => ({}), start() {}, stop() {} },
    loopFallback: { responseWindowMs: 250, timerApi: timers },
  });
  detector.emit("event", {
    type: "DJ_MASTER_TRACK_ACTIVE",
    eventId: "active-1",
    payload: identity(),
  });

  const loop = router.triggerAction("loop-half");
  assert.equal(loop.midiSent, false);
  assert.equal(loop.targetLengthBeats, 8);
  assert.equal(loop.responseWindowMs, 250);
  assert.equal(timers.size(), 1);
  assert.equal(sent.some((event) => event.type === "DJ_LOOP_FALLBACK"), false);
  timers.runAll();
  assert.deepEqual(sent.find((event) => event.type === "DJ_LOOP_FALLBACK").payload, {
    ...identity(),
    targetLengthBeats: 8,
    responseWindowMs: 250,
    source: "pedal-no-response-predicted",
  });

  router.triggerAction("loop-half");
  assert.equal(timers.size(), 1);
  const release = router.triggerAction("release");
  assert.equal(release.midiSent, false);
  assert.equal(sent.filter((event) => event.type === "DJ_RELEASE").length, 1);
  timers.runAll();
  assert.equal(sent.filter((event) => event.type === "DJ_LOOP_FALLBACK").length, 1);
  router.stop();
});

test("stopping the router clears an armed F14 fallback before transport shutdown", () => {
  const timers = createTimers();
  const detector = new EventEmitter();
  detector.getState = () => ({
    currentMasterDeck: 1,
    masterDeckRevision: 3,
    decks: { 1: { playSessionId: "play-session-3" } },
  });
  const client = new EventEmitter();
  const sent = [];
  client.getStatus = () => ({ enabled: true, state: "connected" });
  client.sendEvent = (event) => {
    sent.push(event);
    return { eventId: `event-${sent.length}`, type: event.type, sent: true, ok: true, state: "acknowledged" };
  };
  client.start = () => {};
  client.stop = () => {};
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi: {
      getStatus: () => ({ ok: true }),
      resolveTarget: (_mapping, deck) => ({ targetDeck: deck, targetChannel: 1 }),
      sendMapping: () => true,
      start() {},
      stop() {},
    },
    pedal: { getStatus: () => ({}), start() {}, stop() {} },
    loopFallback: { responseWindowMs: 250, timerApi: timers },
  });
  router.triggerAction("loop-half");
  assert.equal(timers.size(), 1);
  router.stop();
  timers.runAll();
  assert.equal(sent.some((event) => event.type === "DJ_LOOP_FALLBACK"), false);
});

test("release macro preserves DJ_RELEASE delivery when its final Stop mapping fails", async () => {
  const detector = new EventEmitter();
  detector.getState = () => ({
    currentMasterDeck: 1,
    masterDeckRevision: 3,
    decks: { 1: { playSessionId: "play-session-3" } },
  });
  const client = new EventEmitter();
  const sent = [];
  client.getStatus = () => ({ enabled: true, state: "connected" });
  client.sendEvent = (event) => {
    const eventId = `event-${sent.length + 1}`;
    sent.push({ ...event, eventId });
    return { eventId, type: event.type, sent: true, ok: true, state: "acknowledged", ackState: "acknowledged" };
  };
  client.start = () => {};
  client.stop = () => {};
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi: {
      getStatus: () => ({ ok: false }),
      resolveTarget: (_mapping, deck) => ({ targetDeck: deck, targetChannel: 1 }),
      sendMapping: (mapping) => mapping !== "stop",
      startFilterRamp(options) {
        queueMicrotask(() => options.onComplete({ started: true, ok: true }));
        return { started: true, ok: true, targetDeck: options.targetDeck, targetChannel: 1 };
      },
      startReleaseFade(options) {
        queueMicrotask(() => options.onComplete({ started: true, ok: true }));
        return { started: true, ok: true, targetDeck: options.targetDeck, targetChannel: 1 };
      },
      start() {},
      stop() {},
    },
    pedal: { getStatus: () => ({}), start() {}, stop() {} },
    releaseMacro: { enabled: true, sequence: "parallel", filter: {} },
  });
  detector.emit("event", { type: "DJ_MASTER_TRACK_ACTIVE", eventId: "active-1", payload: identity() });
  router.triggerAction("release");
  await new Promise((resolve) => setImmediate(resolve));
  const release = sent.find((event) => event.type === "DJ_RELEASE");
  assert.ok(release);
  assert.equal(router.getStatus().lastAction.midiSent, false);
  assert.equal(router.getStatus().lastAction.delivery.eventId, release.eventId);
  router.stop();
});
