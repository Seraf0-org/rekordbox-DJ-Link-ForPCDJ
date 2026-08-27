"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { EventEmitter } = require("node:events");

const { createShowEventRouter } = require("../server/dj-agent/showEventRouter");
const { createTrackActivityDetector } = require("../server/dj-agent/trackActivityDetector");
const { createRekordboxMidi } = require("../server/dj-agent/rekordboxMidi");

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
      task.cleared = true;
    },
    runNext() {
      const task = tasks
        .filter((entry) => !entry.cleared)
        .sort((left, right) => left.delayMs - right.delayMs || left.order - right.order)[0];
      assert.ok(task, "expected one scheduled timer");
      task.cleared = true;
      task.callback();
    },
  };
}

function createManualIntervals() {
  const handles = [];
  return {
    setInterval(callback, delayMs) {
      const handle = { callback, delayMs, cleared: false };
      handles.push(handle);
      return handle;
    },
    clearInterval(handle) {
      handle.cleared = true;
    },
    onlyHandle() {
      assert.equal(handles.length, 1);
      return handles[0];
    },
  };
}

function admitCandidate(detector, client) {
  let candidate = null;
  const observe = (event) => {
    if (event.type === "DJ_TRACK_ACTIVE") candidate = event;
  };
  detector.on("event", observe);
  const snapshot = (isPlaying, positionRevision) => ({
    deckNowPlaying: [{ deck: 1, contentId: "filter-then-stop", title: "Filter Then Stop", artist: "Test" }],
    deckPlaybacks: [{
      deck: 1,
      isPlaying,
      bpm: 120,
      positionSec: positionRevision,
      positionRevision,
      positionObservedAt: new Date().toISOString(),
    }],
  });
  detector.onSnapshot(snapshot(false, 1));
  detector.onSnapshot(snapshot(true, 2));
  detector.off("event", observe);
  assert.ok(candidate, "expected a track candidate");
  client.emit("delivery", {
    eventId: candidate.eventId,
    type: "DJ_TRACK_ACTIVE",
    state: "acknowledged",
    ack: { outcome: "accepted" },
  });
  return candidate.payload;
}

function createClient(onEvent) {
  const client = new EventEmitter();
  let nextEventId = 0;
  client.sendEvent = (event) => {
    onEvent?.(event);
    const eventId = event.eventId || `filter-then-stop-event-${++nextEventId}`;
    return event.type === "DJ_RELEASE"
      ? { eventId: "filter-then-stop-release", type: event.type, sent: true, ok: false, state: "pending" }
      : { eventId, type: event.type, sent: true, ok: false, state: "pending" };
  };
  client.getStatus = () => ({ enabled: true, state: "connected" });
  client.start = () => {};
  client.stop = () => {};
  return client;
}

function createDetector() {
  return createTrackActivityDetector({ idFactory: () => "filter-then-stop-track" });
}

const FILTER = Object.freeze({ startValue: 64, endValue: 127, durationMs: 1000, updateIntervalMs: 50, resetValue: 64 });

test("filter-then-stop orders F13 as Filter ramp, planned Stop, one Release, then independent reset with no fade MIDI", () => {
  const timerApi = createManualTimer();
  const operations = [];
  const releases = [];
  const events = [];
  const midi = {
    resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: targetDeck }),
    startFilterRamp(options) {
      operations.push("filter-ramp");
      options.onComplete?.({ targetDeck: 1, targetChannel: 1 });
      return { started: true, ok: true, targetDeck: 1, targetChannel: 1 };
    },
    sendMapping(name, options) {
      operations.push(`${name}:${options?.value ?? ""}`);
      return true;
    },
    cancelFilterRamp() {},
    getStatus: () => ({ ok: true }),
    start() {},
    stop() {},
  };
  const client = createClient((event) => {
    events.push(event);
    if (event.type === "DJ_RELEASE") releases.push(event);
  });
  const detector = createDetector();
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
    timerApi,
    releaseMacro: { enabled: true, sequence: "filter-then-stop", filter: FILTER, resetAfterStop: true, resetDelayMs: 0 },
  });
  const owner = admitCandidate(detector, client);
  const pending = router.triggerAction("release");
  assert.equal(pending.sequence, "filter-then-stop");
  assert.equal(pending.phase, "filter-ramp");
  assert.deepEqual(operations, ["filter-ramp"]);
  assert.equal(releases.length, 0);

  timerApi.runNext();
  assert.deepEqual(operations, ["filter-ramp", "stop:"]);
  assert.equal(releases.length, 1);
  assert.equal(router.getStatus().mode, "handoff-pending");
  assert.equal(router.getStatus().lastAction.localFailure, null);
  assert.equal(router.getStatus().lastReleaseReset.state, "scheduled");

  client.emit("delivery", {
    eventId: "filter-then-stop-release",
    type: "DJ_RELEASE",
    state: "acknowledged",
    ok: true,
    ack: { outcome: "accepted" },
  });
  assert.equal(router.getStatus().mode, "handoff-pending", "ACK alone cannot enter Stage 2");
  assert.equal(releases.length, 1, "a delivery update must not route another physical release");

  client.emit("timeline-state", {
    type: "DJ_TIMELINE_STATE",
    state: "running",
    loopActive: false,
    timelineId: "filter-then-stop-timeline",
    positionBars: 16,
    playSessionId: owner.playSessionId,
    pedalOwner: "timeline",
    releaseEventId: "filter-then-stop-release",
  });
  assert.equal(router.getStatus().mode, "timeline-control");
  const midiCountBeforeStage2 = operations.length;
  assert.equal(router.triggerAction("release").ok, false, "Stage 2 delivery is pending in this deterministic client");
  assert.equal(router.triggerAction("loop-half").ok, false);
  assert.equal(router.triggerAction("filter-close").ok, false);
  assert.deepEqual(
    events.slice(-3).map((event) => event.type),
    ["DJ_TIMELINE_BEAT_JUMP", "DJ_TIMELINE_LOOP_SET", "DJ_TIMELINE_BEAT_JUMP"],
  );
  assert.equal(operations.length, midiCountBeforeStage2, "Stage 2 must send zero MIDI");

  timerApi.runNext();
  assert.deepEqual(operations, ["filter-ramp", "stop:", "filter:64"]);
  assert.equal(router.getStatus().lastReleaseReset.state, "completed");
  assert.equal(releases.length, 1);
  router.stop();
});

test("filter failure and Stop failure remain visible while planned Stop, one Release, ACK, and reset stay independent", () => {
  const timerApi = createManualTimer();
  const operations = [];
  const releases = [];
  let filterOptions = null;
  const midi = {
    resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: targetDeck }),
    startFilterRamp(options) {
      filterOptions = options;
      operations.push("filter-ramp");
      options.onError?.({ reason: "midi-send-failed" });
      return { started: false, ok: false, reason: "midi-send-failed", targetDeck: 1, targetChannel: 1 };
    },
    sendMapping(name, options) {
      operations.push(`${name}:${options?.value ?? ""}`);
      return false;
    },
    cancelFilterRamp() {},
    getStatus: () => ({ ok: false }),
    start() {},
    stop() {},
  };
  const client = createClient((event) => {
    if (event.type === "DJ_RELEASE") releases.push(event);
  });
  const detector = createDetector();
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
    timerApi,
    releaseMacro: { enabled: true, sequence: "filter-then-stop", filter: FILTER, resetAfterStop: true, resetDelayMs: 0 },
  });
  admitCandidate(detector, client);

  const pending = router.triggerAction("release");
  assert.equal(pending.pending, true);
  assert.equal(router.getStatus().releaseMacroPhase, "filter-failed-awaiting-completion");
  assert.equal(router.getStatus().releaseMacroReason, "release-filter-ramp-failed");
  assert.deepEqual(operations, ["filter-ramp"]);
  filterOptions.onComplete?.({ targetDeck: 1, targetChannel: 1 });

  timerApi.runNext();
  assert.deepEqual(operations, ["filter-ramp", "stop:"]);
  assert.equal(releases.length, 1);
  assert.equal(router.getStatus().lastAction.midiSent, false);
  assert.equal(router.getStatus().lastAction.localFailure, "release-filter-ramp-failed");
  assert.equal(router.getStatus().lastAction.ok, false);
  assert.equal(router.getStatus().mode, "handoff-pending");

  client.emit("delivery", {
    eventId: "filter-then-stop-release",
    type: "DJ_RELEASE",
    state: "acknowledged",
    ok: true,
    ack: { outcome: "accepted" },
  });
  assert.equal(router.getStatus().mode, "handoff-pending", "ACK cannot replace authoritative running state");
  assert.equal(router.getStatus().lastAction.reason, "release-filter-ramp-failed");
  assert.equal(router.getStatus().lastAction.ok, false);
  assert.equal(releases.length, 1, "failure and ACK handling must not duplicate DJ_RELEASE");

  timerApi.runNext();
  assert.deepEqual(operations, ["filter-ramp", "stop:", "filter:64"]);
  assert.equal(router.getStatus().lastReleaseReset.state, "failed");
  assert.equal(releases.length, 1);
  router.stop();
});

test("production MIDI interval cannot emit a stale Filter CC after planned Stop and DJ_RELEASE", () => {
  const timerApi = createManualTimer();
  const intervals = createManualIntervals();
  const messages = [];
  let clock = 0;
  const midi = createRekordboxMidi({
    enabled: true,
    device: "CustomMIDI1",
    port: 0,
    mappings: {
      loopHalf: { channel: 1, messageType: "noteOn", note: 36, value: 127 },
      stop: { channel: 1, messageType: "noteOn", note: 37, value: 127 },
      filter: { channel: 1, messageType: "controlChange", cc: 16 },
    },
    deckChannels: { 1: 1, 2: 2 },
    filter: FILTER,
    outputFactory: () => ({
      getPortCount: () => 1,
      getPortName: () => "CustomMIDI1",
      openPort: () => {},
      closePort: () => {},
      sendMessage: (message) => messages.push(message),
    }),
    now: () => clock,
    setIntervalImpl: intervals.setInterval,
    clearIntervalImpl: intervals.clearInterval,
  });
  midi.start();
  assert.equal(midi.getStatus().ok, true);

  const releases = [];
  const client = createClient((event) => {
    if (event.type === "DJ_RELEASE") releases.push(event);
  });
  const detector = createDetector();
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
    timerApi,
    releaseMacro: { enabled: true, sequence: "filter-then-stop", filter: FILTER, resetAfterStop: true, resetDelayMs: 0 },
  });
  admitCandidate(detector, client);
  router.triggerAction("release");
  const staleIntervalCallback = intervals.onlyHandle().callback;
  assert.deepEqual(messages, [[0xb0, 16, 64]]);

  clock = 1_000;
  timerApi.runNext();
  assert.deepEqual(messages, [[0xb0, 16, 64], [0x90, 37, 127]]);
  assert.equal(releases.length, 1);
  assert.equal(router.getStatus().lastAction.filterRamp.cancellation.state, "cancelled");

  // Simulate an interval callback already queued at exactly the deadline.
  // The production generation fence must make it a no-op after cancellation.
  staleIntervalCallback();
  assert.deepEqual(messages, [[0xb0, 16, 64], [0x90, 37, 127]]);
  assert.equal(releases.length, 1);
  router.stop();
});

test("Filter cancel exception is visible but cannot suppress planned Stop or DJ_RELEASE", () => {
  const timerApi = createManualTimer();
  const operations = [];
  const releases = [];
  const midi = {
    resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: targetDeck }),
    startFilterRamp: () => ({ started: true, ok: true, targetDeck: 1, targetChannel: 1 }),
    cancelFilterRamp() { throw new Error("test cancel failure"); },
    sendMapping(name) { operations.push(name); return true; },
    getStatus: () => ({ ok: true, rampActive: true }),
    start() {},
    stop() {},
  };
  const client = createClient((event) => {
    if (event.type === "DJ_RELEASE") releases.push(event);
  });
  const detector = createDetector();
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
    timerApi,
    releaseMacro: { enabled: true, sequence: "filter-then-stop", filter: FILTER, resetAfterStop: true, resetDelayMs: 0 },
  });
  admitCandidate(detector, client);
  router.triggerAction("release");
  timerApi.runNext();
  assert.deepEqual(operations, ["stop"]);
  assert.equal(releases.length, 1);
  assert.equal(router.getStatus().lastAction.localFailure, "release-filter-ramp-cancel-failed");
  assert.equal(router.getStatus().lastAction.filterRamp.cancellation.state, "failed");
  router.stop();
});

test("active Filter cancel false is visible but cannot suppress planned Stop or one DJ_RELEASE", () => {
  const timerApi = createManualTimer();
  const operations = [];
  const releases = [];
  const midi = {
    resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: targetDeck }),
    startFilterRamp: () => ({ started: true, ok: true, targetDeck: 1, targetChannel: 1 }),
    cancelFilterRamp: () => false,
    sendMapping(name) { operations.push(name); return true; },
    getStatus: () => ({ ok: true, rampActive: true }),
    start() {},
    stop() {},
  };
  const client = createClient((event) => {
    if (event.type === "DJ_RELEASE") releases.push(event);
  });
  const detector = createDetector();
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
    timerApi,
    releaseMacro: { enabled: true, sequence: "filter-then-stop", filter: FILTER, resetAfterStop: true, resetDelayMs: 0 },
  });
  admitCandidate(detector, client);
  router.triggerAction("release");
  timerApi.runNext();
  assert.deepEqual(operations, ["stop"]);
  assert.equal(releases.length, 1);
  assert.equal(router.getStatus().lastAction.localFailure, "release-filter-ramp-cancel-failed");
  assert.equal(router.getStatus().lastAction.filterRamp.cancellation.state, "failed");
  router.stop();
});
