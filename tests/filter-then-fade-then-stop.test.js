"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const { createShowEventRouter } = require("../server/dj-agent/showEventRouter");
const { createTrackActivityDetector } = require("../server/dj-agent/trackActivityDetector");
const { createRekordboxMidi } = require("../server/dj-agent/rekordboxMidi");
const {
  validateFilterThenFadeThenStopShowConfig,
} = require("../server/dj-agent/config");

const FILTER = Object.freeze({
  startValue: 64,
  endValue: 127,
  durationMs: 1000,
  updateIntervalMs: 50,
  resetValue: 64,
});
const FADE = Object.freeze({
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
});
const MACRO = Object.freeze({
  enabled: true,
  sequence: "filter-then-fade-then-stop",
  filter: FILTER,
  resetAfterStop: true,
  resetDelayMs: 0,
});

function createManualTimer() {
  const tasks = [];
  let order = 0;
  return {
    setTimeout(callback, delayMs) {
      const task = { callback, delayMs, order: order += 1, cleared: false };
      tasks.push(task);
      return task;
    },
    clearTimeout(task) {
      if (task) task.cleared = true;
    },
    runNext() {
      const task = tasks
        .filter((entry) => !entry.cleared)
        .sort((left, right) => left.delayMs - right.delayMs || left.order - right.order)[0];
      assert.ok(task, "expected one scheduled timer");
      task.cleared = true;
      task.callback();
      return task;
    },
    pending() {
      return tasks.filter((entry) => !entry.cleared);
    },
  };
}

function createClient(sentEvents, { state = "pending", ok = false } = {}) {
  const client = new EventEmitter();
  let eventNumber = 0;
  client.sendEvent = (event) => {
    const eventId = event.eventId || `release-event-${++eventNumber}`;
    sentEvents.push({ ...event, eventId });
    return { eventId, type: event.type, sent: true, ok, state, ackState: state };
  };
  client.getStatus = () => ({ enabled: true, state: "connected" });
  client.start = () => {};
  client.stop = () => {};
  return client;
}

function admitCandidate(detector, client) {
  let candidate = null;
  const observer = (event) => {
    if (event.type === "DJ_TRACK_ACTIVE") candidate = event;
  };
  detector.on("event", observer);
  const observedAt = new Date().toISOString();
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: observedAt,
    deckNowPlaying: [{ deck: 1, contentId: "f13-track", title: "F13", artist: "Test" }],
    deckPlaybacks: [{ deck: 1, isPlaying: false, positionSec: 1, bpm: 120, positionRevision: 1, positionObservedAt: observedAt }],
  });
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: observedAt,
    deckNowPlaying: [{ deck: 1, contentId: "f13-track", title: "F13", artist: "Test" }],
    deckPlaybacks: [{ deck: 1, isPlaying: true, positionSec: 2, bpm: 120, positionRevision: 2, positionObservedAt: observedAt }],
  });
  detector.off("event", observer);
  assert.ok(candidate, "expected a track candidate");
  client.emit("delivery", {
    eventId: candidate.eventId,
    type: "DJ_TRACK_ACTIVE",
    state: "acknowledged",
    ack: { outcome: "accepted" },
  });
  return candidate.payload;
}

function createFixture({ midiOverrides = {}, clientOptions = {} } = {}) {
  const timer = createManualTimer();
  const sentEvents = [];
  const operations = [];
  let filterOptions = null;
  let fadeOptions = null;
  const midi = {
    resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: targetDeck }),
    startFilterRamp(options) {
      operations.push({ name: "filter-start", value: options.startValue });
      filterOptions = options;
      return { started: true, ok: true, targetDeck: 1, targetChannel: 1 };
    },
    startReleaseFade(options) {
      operations.push({ name: "fade-start", value: options.startValue });
      fadeOptions = options;
      return { started: true, ok: true, targetDeck: 1, targetChannel: 1, resetValue: 127 };
    },
    sendMapping(name, options) {
      operations.push({ name, value: options?.value ?? null });
      return true;
    },
    resetReleaseFade(options) {
      operations.push({ name: "fade-reset", value: options?.value ?? null });
      return { ok: true, value: options?.value ?? null };
    },
    cancelFilterRamp() { operations.push({ name: "filter-cancel" }); return true; },
    cancelReleaseFade() { operations.push({ name: "fade-cancel" }); return true; },
    getStatus: () => ({ ok: true }),
    start() {},
    stop() {},
    ...midiOverrides,
  };
  const client = createClient(sentEvents, clientOptions);
  const detector = createTrackActivityDetector({ idFactory: () => "f13-candidate" });
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
    releaseFade: FADE,
    releaseMacro: MACRO,
    timerApi: timer,
  });
  const owner = admitCandidate(detector, client);
  return { client, detector, fadeOptions: () => fadeOptions, filterOptions: () => filterOptions, operations, owner, router, sentEvents, timer };
}

test("F13 routes one DJ_RELEASE at the HPF edge, then performs HPF -> ChannelFader fade -> Stop -> resets", () => {
  const fixture = createFixture();
  const pending = fixture.router.triggerAction("release");

  assert.equal(pending.sequence, "filter-then-fade-then-stop");
  assert.equal(pending.pending, true);
  assert.deepEqual(fixture.operations, [{ name: "filter-start", value: 64 }]);
  assert.deepEqual(
    fixture.sentEvents.filter((event) => event.type === "DJ_RELEASE").map((event) => event.type),
    ["DJ_RELEASE"],
  );
  assert.equal(fixture.sentEvents[0].payload.playSessionId, fixture.owner.playSessionId);

  fixture.filterOptions().onComplete({ targetDeck: 1, targetChannel: 1 });
  assert.deepEqual(fixture.operations.slice(-1), [{ name: "fade-start", value: 127 }]);
  fixture.fadeOptions().onComplete({ targetDeck: 1, targetChannel: 1, resetValue: 127 });
  assert.deepEqual(
    fixture.operations.filter((entry) => !entry.name.endsWith("-cancel")).map((entry) => entry.name),
    ["filter-start", "fade-start", "stop"],
  );
  // The reset timer is deliberately separate from Stop and runs after it.
  fixture.timer.runNext();
  assert.deepEqual(fixture.operations.slice(-2).map((entry) => entry.name), ["filter", "fade-reset"]);
  assert.equal(fixture.sentEvents.filter((event) => event.type === "DJ_RELEASE").length, 1);
  assert.equal(fixture.router.getStatus().lastReleaseReset.state, "completed");
  fixture.router.stop();
});

test("router F13 release sends the complete non-Master deck 2 MIDI byte sequence through the real adapter", () => {
  const timer = createManualTimer();
  let nowMs = 0;
  const intervals = [];
  const messages = [];
  const sentEvents = [];
  const output = {
    getPortCount: () => 1,
    getPortName: () => "CustomMIDI1",
    openPort: () => true,
    closePort: () => {},
    destroy: () => {},
    sendMessage: (message) => messages.push([...message]),
  };
  const midi = createRekordboxMidi({
    enabled: true,
    device: "CustomMIDI1",
    port: 0,
    deckChannels: { "1": 1, "2": 2 },
    mappings: {
      filter: { channel: 1, messageType: "controlChange", cc: 16 },
      releaseFade: { channel: 1, messageType: "controlChange", cc: 17 },
      stop: { channel: 1, messageType: "noteOn", note: 37, value: 127 },
    },
    filter: FILTER,
    releaseFade: FADE,
    outputFactory: () => output,
    now: () => nowMs,
    setIntervalImpl: (callback, delayMs) => {
      const handle = { callback, delayMs, cleared: false };
      intervals.push(handle);
      return handle;
    },
    clearIntervalImpl: (handle) => { handle.cleared = true; },
  });
  const client = createClient(sentEvents);
  const detector = createTrackActivityDetector({ idFactory: () => "f13-deck-2-candidate" });
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
    releaseFade: FADE,
    releaseMacro: MACRO,
    timerApi: timer,
  });

  midi.start();
  assert.equal(midi.getStatus().ok, true);
  const observedAt = new Date().toISOString();
  let candidate = null;
  const observe = (event) => {
    if (event.type === "DJ_TRACK_ACTIVE" && event.payload.deck === 2) candidate = event;
  };
  detector.on("event", observe);
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: observedAt,
    deckNowPlaying: [{ deck: 2, contentId: "f13-deck-2", title: "F13", artist: "Test" }],
    deckPlaybacks: [{ deck: 2, isPlaying: false, positionSec: 1, bpm: 120, positionRevision: 1, positionObservedAt: observedAt }],
  });
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: observedAt,
    deckNowPlaying: [{ deck: 2, contentId: "f13-deck-2", title: "F13", artist: "Test" }],
    deckPlaybacks: [{ deck: 2, isPlaying: true, positionSec: 2, bpm: 120, positionRevision: 2, positionObservedAt: observedAt }],
  });
  detector.off("event", observe);
  assert.ok(candidate, "expected a deck-2 track candidate");
  assert.equal(detector.getState().explicitMasterDeck, 1);
  assert.equal(detector.getState().currentMasterDeck, 1);
  client.emit("delivery", {
    eventId: candidate.eventId,
    type: "DJ_TRACK_ACTIVE",
    state: "acknowledged",
    ack: { outcome: "accepted" },
  });

  const pending = router.triggerAction("release");
  assert.equal(pending.targetDeck, 2);
  assert.equal(sentEvents.filter((event) => event.type === "DJ_RELEASE").length, 1);

  nowMs = 1_000;
  intervals.at(-1).callback();
  nowMs = 2_000;
  intervals.at(-1).callback();
  timer.runNext();
  assert.deepEqual(messages, [
    [0xb1, 16, 64],
    [0xb1, 16, 127],
    [0xb1, 17, 127],
    [0xb1, 17, 0],
    [0x91, 37, 127],
    [0xb1, 16, 64],
    [0xb1, 17, 127],
  ]);
  assert.equal(router.getStatus().lastReleaseReset.state, "completed");
  router.stop();
});

test("Syndocal release delivery is independent of local MIDI failures and remains exactly once", () => {
  const fixture = createFixture({
    midiOverrides: {
      startFilterRamp(options) {
        return { started: false, ok: false, reason: "midi-not-connected" };
      },
      startReleaseFade: () => ({ started: false, ok: false, reason: "midi-not-connected" }),
      sendMapping: () => false,
      resetReleaseFade: () => ({ ok: false, reason: "midi-not-connected" }),
    },
  });
  assert.equal(fixture.sentEvents.filter((event) => event.type === "DJ_RELEASE").length, 0);
  const pending = fixture.router.triggerAction("release");
  assert.equal(pending.delivery.type, "DJ_RELEASE");
  assert.equal(fixture.sentEvents.filter((event) => event.type === "DJ_RELEASE").length, 1);
  assert.equal(pending.delivery.state, "pending");
  fixture.timer.runNext();
  assert.equal(fixture.sentEvents.filter((event) => event.type === "DJ_RELEASE").length, 1);
  assert.equal(fixture.router.getStatus().lastAction.localFailure !== null, true);
  fixture.router.stop();
});

test("release finalization re-reads early ACK and rejection during the local tail", () => {
  const accepted = createFixture();
  accepted.router.triggerAction("release");
  const acceptedEvent = accepted.sentEvents.find((event) => event.type === "DJ_RELEASE");
  accepted.client.emit("delivery", {
    eventId: acceptedEvent.eventId,
    type: "DJ_RELEASE",
    state: "acknowledged",
    ok: true,
    ack: { outcome: "accepted" },
  });
  accepted.filterOptions().onComplete({ targetDeck: 1, targetChannel: 1 });
  accepted.fadeOptions().onComplete({ targetDeck: 1, targetChannel: 1, resetValue: 127 });
  accepted.timer.runNext();
  assert.equal(accepted.router.getStatus().lastAction.delivery.state, "acknowledged");
  assert.equal(accepted.router.getStatus().lastAction.phase, "handoff-pending");
  accepted.router.stop();

  const rejected = createFixture();
  rejected.router.triggerAction("release");
  const rejectedEvent = rejected.sentEvents.find((event) => event.type === "DJ_RELEASE");
  rejected.client.emit("delivery", {
    eventId: rejectedEvent.eventId,
    type: "DJ_RELEASE",
    state: "rejected",
    ok: false,
    reason: "timeline-rejected",
    ack: { outcome: "rejected" },
  });
  rejected.filterOptions().onComplete({ targetDeck: 1, targetChannel: 1 });
  rejected.fadeOptions().onComplete({ targetDeck: 1, targetChannel: 1, resetValue: 127 });
  rejected.timer.runNext();
  assert.equal(rejected.router.getStatus().lastAction.delivery.state, "rejected");
  assert.equal(rejected.router.getStatus().lastAction.phase, "failed");
  assert.equal(rejected.router.getStatus().lastAction.reason, "timeline-rejected");
  rejected.router.stop();
});

test("finishStop records active cancellation false/throw without suppressing Stop or reset", () => {
  const fixture = createFixture({
    midiOverrides: {
      getStatus: () => ({ rampActive: true, releaseFadeActive: true }),
      cancelFilterRamp() {
        fixture.operations.push({ name: "filter-cancel-false" });
        return false;
      },
      cancelReleaseFade() {
        fixture.operations.push({ name: "fade-cancel-throw" });
        throw new Error("fade cancellation unavailable");
      },
    },
  });
  fixture.router.triggerAction("release");
  fixture.filterOptions().onComplete({ targetDeck: 1, targetChannel: 1 });
  fixture.fadeOptions().onComplete({ targetDeck: 1, targetChannel: 1, resetValue: 127 });
  fixture.timer.runNext();

  const action = fixture.router.getStatus().lastAction;
  assert.deepEqual(
    fixture.operations.filter((entry) => entry.name.includes("cancel")).map((entry) => entry.name),
    ["filter-cancel-false", "fade-cancel-throw"],
  );
  assert.equal(action.filterRamp.cancellation.state, "failed");
  assert.equal(action.filterRamp.cancellation.ok, false);
  assert.equal(action.fadeRamp.cancellation.state, "failed");
  assert.equal(action.fadeRamp.cancellation.ok, false);
  assert.equal(action.localFailure, "release-filter-ramp-cancel-failed");
  assert.equal(fixture.operations.filter((entry) => entry.name === "stop").length, 1);
  assert.deepEqual(fixture.operations.slice(-2).map((entry) => entry.name), ["filter", "fade-reset"]);
  fixture.router.stop();
});

test("completion callbacks, retry presses, and reset callbacks cannot duplicate release or Stop", () => {
  const fixture = createFixture();
  fixture.router.triggerAction("release");
  const filter = fixture.filterOptions();
  filter.onComplete({ targetDeck: 1, targetChannel: 1 });
  const fade = fixture.fadeOptions();
  fade.onComplete({ targetDeck: 1, targetChannel: 1, resetValue: 127 });
  const blocked = fixture.router.triggerAction("release");
  assert.equal(blocked.reason, "release-macro-in-progress");
  filter.onComplete({ targetDeck: 1, targetChannel: 1 });
  fade.onComplete({ targetDeck: 1, targetChannel: 1, resetValue: 127 });
  fixture.timer.runNext();
  assert.equal(fixture.sentEvents.filter((event) => event.type === "DJ_RELEASE").length, 1);
  assert.equal(fixture.operations.filter((entry) => entry.name === "stop").length, 1);
  fixture.router.stop();
});

test("router stop fences callbacks from a cancelled generation", () => {
  const fixture = createFixture();
  fixture.router.triggerAction("release");
  const filter = fixture.filterOptions();
  fixture.router.stop();
  filter.onComplete({ targetDeck: 1, targetChannel: 1 });
  assert.equal(fixture.operations.some((entry) => entry.name === "fade-start"), false);
  assert.equal(fixture.operations.some((entry) => entry.name === "stop"), false);
  assert.equal(fixture.sentEvents.filter((event) => event.type === "DJ_RELEASE").length, 1);
});

test("router stop independently cancels both ramps and clears stale public action state", () => {
  const fixture = createFixture({
    midiOverrides: {
      cancelFilterRamp() {
        fixture.operations.push({ name: "filter-cancel-throw" });
        throw new Error("filter cancellation unavailable");
      },
      cancelReleaseFade() {
        fixture.operations.push({ name: "fade-cancel-after-filter-throw" });
        return true;
      },
    },
  });
  const actionEvents = [];
  fixture.router.on("action", (action) => actionEvents.push(action));
  fixture.router.triggerAction("release");
  const filter = fixture.filterOptions();
  filter.onComplete({ targetDeck: 1, targetChannel: 1 });
  const fade = fixture.fadeOptions();
  const actionCountBeforeStop = actionEvents.length;
  const lastActionBeforeStop = structuredClone(fixture.router.getStatus().lastAction);

  fixture.router.stop();
  assert.deepEqual(
    fixture.operations.filter((entry) => entry.name.includes("cancel")).map((entry) => entry.name),
    ["filter-cancel-throw", "fade-cancel-after-filter-throw"],
  );
  assert.equal(fixture.router.getStatus().releaseMacroActive, false);
  assert.equal(fixture.router.getStatus().releaseMacroPhase, "idle");

  // Both callbacks represent the stopped generation. Neither may publish a
  // new action or mutate the last public action after activeReleaseAction was
  // cleared.
  filter.onComplete({ targetDeck: 1, targetChannel: 1 });
  fade.onComplete({ targetDeck: 1, targetChannel: 1, resetValue: 127 });
  assert.equal(actionEvents.length, actionCountBeforeStop);
  assert.deepEqual(fixture.router.getStatus().lastAction, lastActionBeforeStop);
  assert.equal(fixture.operations.some((entry) => entry.name === "stop"), false);
});

test("v1.1.9 strict config accepts CC17 fade and rejects v1.1.7/legacy sequences", () => {
  const fs = require("node:fs");
  const v119 = JSON.parse(fs.readFileSync(require("node:path").join(__dirname, "..", "config", "dj-agent-v1.1.9.example.json"), "utf8"));
  assert.equal(validateFilterThenFadeThenStopShowConfig(v119, { allowTokenPlaceholder: true }), true);
  const retired = structuredClone(v119);
  retired.version = "1.1.7";
  retired.midi.releaseFade = { enabled: false };
  retired.midi.releaseMacro.sequence = "filter-then-stop";
  retired.midi.mappings.releaseFade = undefined;
  delete retired.midi.mappings.releaseFade;
  assert.equal(validateFilterThenFadeThenStopShowConfig(retired, { allowTokenPlaceholder: true }), false);
  const legacy = structuredClone(v119);
  legacy.midi.releaseMacro.sequence = "filter-then-fade";
  assert.equal(validateFilterThenFadeThenStopShowConfig(legacy, { allowTokenPlaceholder: true }), false);
});
