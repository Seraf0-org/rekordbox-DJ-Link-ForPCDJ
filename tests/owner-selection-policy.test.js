"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  CONTENT_FIRST_OWNER_SELECTION,
  selectProductionOwnerCandidate,
} = require("../server/dj-agent/ownerSelectionPolicy");
const { createTrackActivityDetector } = require("../server/dj-agent/trackActivityDetector");
const { createShowEventRouter } = require("../server/dj-agent/showEventRouter");

const PRODUCTION_POLICY = {
  mode: "titleContains",
  titleNeedle: "人生オーバー",
  deck1MetadataWaitMs: 1_400,
};

function candidate(deck, overrides = {}) {
  return {
    deck,
    fresh: true,
    isPlaying: true,
    title: "人生オーバー Remix",
    artist: "Any Artist",
    contentId: `content-${deck}`,
    sessionAgeMs: 2_000,
    ...overrides,
  };
}

function playback(deck, revision, nowMs, overrides = {}) {
  return {
    deck,
    isPlaying: true,
    positionSec: revision,
    bpm: 128,
    positionObservedAt: new Date(nowMs).toISOString(),
    positionRevision: revision,
    ...overrides,
  };
}

function createTimerHarness(clock) {
  const timers = [];
  return {
    timers,
    api: {
      setTimeout(callback, delayMs) {
        const timer = { callback, delayMs, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout(timer) {
        timer.cleared = true;
      },
    },
    fire(timer, { ignoreClear = false, lateByMs = 0 } = {}) {
      if (timer.cleared && !ignoreClear) return;
      clock.value += timer.delayMs + lateByMs;
      timer.callback();
    },
  };
}

function productionDetector(clock, ownerSelectionTimerApi = undefined) {
  let id = 0;
  const detector = createTrackActivityDetector({
    now: () => clock.value,
    idFactory: () => `owner-policy-${++id}`,
    ownerSelectionPolicy: PRODUCTION_POLICY,
    ownerSelectionTimerApi,
  });
  const events = [];
  detector.on("event", (event) => events.push(event));
  return { detector, events };
}

function createTimelineControlFixture({ freshFallback = true } = {}) {
  const clock = { value: 1_000 };
  const timers = createTimerHarness(clock);
  let nextId = 0;
  const detector = createTrackActivityDetector({
    now: () => clock.value,
    idFactory: () => `operator-${++nextId}`,
    ownerSelectionPolicy: PRODUCTION_POLICY,
    ownerSelectionTimerApi: timers.api,
  });
  const detectorEvents = [];
  detector.on("event", (event) => detectorEvents.push(event));
  const sent = [];
  const client = new EventEmitter();
  let nextEventId = 0;
  let timelineStateRequests = 0;
  client.getStatus = () => ({ enabled: true, state: "connected" });
  client.sendEvent = (event) => {
    const eventId = event.eventId || `operator-event-${++nextEventId}`;
    sent.push({ ...event, eventId });
    return { eventId, type: event.type, sent: true, ok: false, state: "pending", ackState: "pending" };
  };
  client.sendTimelineStateRequest = () => {
    timelineStateRequests += 1;
    return true;
  };
  client.start = () => {};
  client.stop = () => {};
  const operations = [];
  let filterOptions = null;
  let fadeOptions = null;
  const midi = {
    resolveTarget: (_name, deck) => ({ targetDeck: deck, targetChannel: deck }),
    startFilterRamp(options) {
      filterOptions = options;
      operations.push("filter-start");
      return { started: true, ok: true, targetDeck: 1, targetChannel: 1 };
    },
    startReleaseFade(options) {
      fadeOptions = options;
      operations.push("fade-start");
      return { started: true, ok: true, targetDeck: 1, targetChannel: 1, resetValue: 127 };
    },
    sendMapping(name) {
      operations.push(name);
      return true;
    },
    resetReleaseFade() {
      operations.push("fade-reset");
      return { ok: true };
    },
    cancelFilterRamp: () => true,
    cancelReleaseFade: () => true,
    getStatus: () => ({ rampActive: false, releaseFadeActive: false }),
    start() {},
    stop() {},
  };
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
    releaseFade: {
      enabled: true,
      mappingName: "releaseFade",
      target: "deck",
      startValue: 127,
      endValue: 0,
      durationMs: 1_000,
      updateIntervalMs: 50,
      resetAfterStop: true,
      resetValue: 127,
      resetDelayMs: 0,
    },
    releaseMacro: {
      enabled: true,
      sequence: "filter-then-fade-then-stop",
      filter: {
        startValue: 64,
        endValue: 127,
        durationMs: 1_000,
        updateIntervalMs: 50,
        resetValue: 64,
      },
      resetAfterStop: true,
      resetDelayMs: 0,
    },
    timerApi: timers.api,
    now: () => clock.value,
  });

  detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, title: "人生オーバー Show", artist: "Show Artist" }],
    deckPlaybacks: [playback(1, 1, clock.value)],
  });
  const initial = detectorEvents.find((event) => event.type === "DJ_TRACK_ACTIVE");
  assert.ok(initial, "expected the initial selected production candidate");
  client.emit("delivery", {
    eventId: initial.eventId,
    type: "DJ_TRACK_ACTIVE",
    state: "acknowledged",
    ack: { outcome: "accepted" },
  });
  router.triggerAction("release");
  filterOptions.onComplete({ targetDeck: 1, targetChannel: 1 });
  fadeOptions.onComplete({ targetDeck: 1, targetChannel: 1, resetValue: 127 });
  const resetTimer = timers.timers.find((timer) => !timer.cleared && timer.delayMs === 0);
  assert.ok(resetTimer, "expected the post-Stop reset timer");
  timers.fire(resetTimer);
  resetTimer.cleared = true;
  const releaseEvent = sent.find((event) => event.type === "DJ_RELEASE");
  assert.ok(releaseEvent, "expected the initial DJ_RELEASE handoff");
  client.emit("timeline-state", {
    state: "running",
    loopActive: true,
    transitionHoldActive: false,
    timelineId: "operator-timeline",
    positionBars: 8,
    playSessionId: initial.payload.playSessionId,
    pedalOwner: "timeline",
    releaseEventId: releaseEvent.eventId,
    sessionId: "operator-timeline-session",
    sequence: 1,
  });
  assert.equal(router.getStatus().mode, "timeline-control");

  if (freshFallback) {
    clock.value = 2_500;
    detector.onSnapshot({
      deckNowPlaying: [{ deck: 1, title: "人生オーバー Show", artist: "Show Artist" }],
      deckPlaybacks: [playback(1, 2, clock.value, { isPlaying: false })],
    });
    clock.value = 3_000;
    detector.onSnapshot({
      deckNowPlaying: [{ deck: 1, contentId: "operator-demo", title: "Demo Track 2", artist: "Loopmasters" }],
      deckPlaybacks: [playback(1, 3, clock.value, { isPlaying: false })],
    });
    detector.onSnapshot({
      deckNowPlaying: [{ deck: 1, contentId: "operator-demo", title: "Demo Track 2", artist: "Loopmasters" }],
      deckPlaybacks: [playback(1, 4, clock.value, { isPlaying: true })],
    });
    clock.value = 4_400;
  } else {
    clock.value = 2_500;
    detector.onSnapshot({
      deckNowPlaying: [{ deck: 1, title: "人生オーバー Show", artist: "Show Artist" }],
      deckPlaybacks: [playback(1, 2, clock.value, { isPlaying: false })],
    });
  }
  return {
    clock,
    client,
    detector,
    operations,
    releaseEventId: releaseEvent.eventId,
    router,
    sent,
    get timelineStateRequests() {
      return timelineStateRequests;
    },
    timelineSessionId: initial.payload.playSessionId,
    timers,
  };
}

test("default owner selection remains content-first", () => {
  assert.deepEqual(selectProductionOwnerCandidate([candidate(1)], CONTENT_FIRST_OWNER_SELECTION), null);
  const clock = { value: 1_000 };
  const detector = createTrackActivityDetector({ now: () => clock.value, idFactory: () => "default-id" });
  const events = [];
  detector.on("event", (event) => events.push(event));
  detector.onSnapshot({
    deckNowPlaying: [{ deck: 2, contentId: "deck-two", title: "Not selected by production policy", artist: "Artist" }],
    deckPlaybacks: [playback(2, 1, clock.value)],
  });
  const active = events.find((event) => event.type === "DJ_TRACK_ACTIVE");
  assert.equal(active.payload.deck, 2);
  assert.equal(active.payload.contentId, "deck-two");
});

test("production selector matches title without artist but keeps artist-missing v3 admission fail-closed", () => {
  const selected = selectProductionOwnerCandidate([
    candidate(2, { title: "prefix 人生オーバー (Festival Remix)", artist: "" }),
  ], PRODUCTION_POLICY);
  assert.deepEqual(selected, { kind: "wait-for-text-identity", deck: 2 });
  const withArtist = selectProductionOwnerCandidate([
    candidate(2, { title: "prefix 人生オーバー (Festival Remix)", artist: "Different Artist" }),
  ], PRODUCTION_POLICY);
  assert.deepEqual(withArtist.wireIdentity, {
    title: "prefix 人生オーバー (Festival Remix)",
    artist: "Different Artist",
  });
  assert.equal(
    selectProductionOwnerCandidate([candidate(2, { title: "人生オーバー remix" })], {
      ...PRODUCTION_POLICY,
      titleNeedle: "Remix",
    }),
    null,
  );
});

test("multiple matching decks resolve to fresh Deck 1 even when it is nonmatching, otherwise lowest positive", () => {
  const deckOne = selectProductionOwnerCandidate([candidate(3), candidate(1), candidate(2)], PRODUCTION_POLICY);
  assert.equal(deckOne.deck, 1);
  const nonmatchingDeckOne = selectProductionOwnerCandidate([
    candidate(1, { title: "Temporary test track", artist: "Deck One" }),
    candidate(2),
    candidate(3),
  ], PRODUCTION_POLICY);
  assert.deepEqual(nonmatchingDeckOne, {
    kind: "deck1-ambiguity-fallback",
    deck: 1,
    wireIdentity: { title: "Temporary test track", artist: "Deck One" },
  });
  const lowest = selectProductionOwnerCandidate([candidate(3), candidate(2)], PRODUCTION_POLICY);
  assert.equal(lowest.deck, 2);
  const deckOneWithoutIdentity = selectProductionOwnerCandidate([
    candidate(1, { title: "人生オーバー Deck One", artist: null, contentId: "deck-one-content" }),
    candidate(2, { title: "人生オーバー Deck Two", artist: "Deck Two" }),
    candidate(3, { title: "人生オーバー Deck Three", artist: "Deck Three" }),
  ], PRODUCTION_POLICY);
  assert.deepEqual(deckOneWithoutIdentity, {
    kind: "text",
    deck: 2,
    wireIdentity: { title: "人生オーバー Deck Two", artist: "Deck Two" },
  });
});

test("zero title matches fall back to fresh Deck 1 after the explicit wait", () => {
  assert.equal(
    selectProductionOwnerCandidate([candidate(1, { title: "Different Song", sessionAgeMs: 1_399 })], PRODUCTION_POLICY),
    null,
  );
  assert.deepEqual(
    selectProductionOwnerCandidate([candidate(1, { title: "Different Song", artist: "Test Artist", sessionAgeMs: 1_400 })], PRODUCTION_POLICY),
    {
      kind: "deck1-fallback",
      deck: 1,
      wireIdentity: { title: "Different Song", artist: "Test Artist" },
    },
  );
});

test("Deck 1 fallback uses text when complete, otherwise content identity, and never uses Deck 2", () => {
  assert.equal(
    selectProductionOwnerCandidate([candidate(1, { title: null, sessionAgeMs: 1_399 })], PRODUCTION_POLICY),
    null,
  );
  assert.deepEqual(
    selectProductionOwnerCandidate([candidate(1, { title: null, sessionAgeMs: 1_400 })], PRODUCTION_POLICY),
    { kind: "deck1-fallback", deck: 1, wireIdentity: { contentId: "content-1" } },
  );
  assert.equal(
    selectProductionOwnerCandidate([candidate(2, { title: null, sessionAgeMs: 99_000 })], PRODUCTION_POLICY),
    null,
  );
  assert.equal(
    selectProductionOwnerCandidate([candidate(1, { title: null, fresh: false })], PRODUCTION_POLICY),
    null,
  );
  assert.equal(
    selectProductionOwnerCandidate([candidate(1, { title: null, isPlaying: false })], PRODUCTION_POLICY),
    null,
  );
});

test("production detector keeps an artist-missing sole positive Deck 1 fail-closed, then freezes text wire identity", () => {
  const clock = { value: 1_000 };
  const { detector, events } = productionDetector(clock);
  detector.onSnapshot({
    deckNowPlaying: [
      { deck: 1, title: "人生オーバー Remix" },
      { deck: 2, contentId: "two", title: "Other Track", artist: "Deck Two" },
    ],
    deckPlaybacks: [playback(1, 1, clock.value), playback(2, 1, clock.value)],
  });
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 0);

  clock.value = 1_100;
  detector.onSnapshot({
    deckNowPlaying: [
      { deck: 1, title: "人生オーバー Remix", artist: "Deck One" },
      { deck: 2, contentId: "two", title: "Other Track", artist: "Deck Two" },
    ],
    deckPlaybacks: [playback(1, 2, clock.value), playback(2, 2, clock.value)],
  });
  const active = events.find((event) => event.type === "DJ_TRACK_ACTIVE");
  assert.deepEqual(
    { deck: active.payload.deck, title: active.payload.title, artist: active.payload.artist, contentId: active.payload.contentId },
    { deck: 1, title: "人生オーバー Remix", artist: "Deck One", contentId: undefined },
  );

  clock.value = 1_200;
  detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, contentId: "late-content", title: "人生オーバー Remix", artist: "Deck One" }],
    deckPlaybacks: [playback(1, 3, clock.value)],
  });
  const sync = events.filter((event) => event.type === "DJ_TRACK_SYNC").at(-1);
  assert.deepEqual(
    { title: sync.payload.title, artist: sync.payload.artist, contentId: sync.payload.contentId },
    { title: "人生オーバー Remix", artist: "Deck One", contentId: undefined },
  );
  assert.equal(detector.getState().decks[1].track.contentId, "late-content");
});

test("production reconnect explicitly reannounces the currently selected frozen owner as ACTIVE", () => {
  const clock = { value: 1_000 };
  const { detector, events } = productionDetector(clock);
  detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, title: "人生オーバー Remix", artist: "Deck One" }],
    deckPlaybacks: [playback(1, 1, clock.value)],
  });
  const initial = events.find((event) => event.type === "DJ_TRACK_ACTIVE");
  // The same session may gain a contentId after the first text-identity
  // announcement. Reconnect must retain that first v3 identity rather than
  // silently changing the receiver's correlation key.
  clock.value = 1_100;
  detector.onSnapshot({
    deckNowPlaying: [{
      deck: 1,
      contentId: "late-content-id",
      title: "人生オーバー Remix",
      artist: "Deck One",
    }],
    deckPlaybacks: [playback(1, 2, clock.value)],
  });
  const reannounced = detector.requestCurrentTrackCandidates();
  assert.equal(reannounced.length, 1);
  assert.equal(reannounced[0].type, "DJ_TRACK_ACTIVE");
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 2);
  assert.deepEqual(
    {
      deck: reannounced[0].payload.deck,
      title: reannounced[0].payload.title,
      artist: reannounced[0].payload.artist,
      contentId: reannounced[0].payload.contentId,
      playSessionId: reannounced[0].payload.playSessionId,
    },
    {
      deck: initial.payload.deck,
      title: initial.payload.title,
      artist: initial.payload.artist,
      contentId: initial.payload.contentId,
      playSessionId: initial.payload.playSessionId,
    },
  );

  const beforeNormalDuplicate = events.length;
  detector.onSnapshot({
    deckNowPlaying: [{
      deck: 1,
      contentId: "late-content-id",
      title: "人生オーバー Remix",
      artist: "Deck One",
    }],
    deckPlaybacks: [playback(1, 2, clock.value)],
  });
  assert.equal(events.length, beforeNormalDuplicate, "ordinary same-revision snapshots remain deduplicated");
});

test("restart provenance is per deck: a fresh Deck 2 snapshot cannot revive stale Deck 1", () => {
  const clock = { value: 1_000 };
  const { detector, events } = productionDetector(clock);
  detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, title: "人生オーバー Remix", artist: "Deck One" }],
    deckPlaybacks: [playback(1, 1, clock.value)],
  });
  const initial = events.find((event) => event.type === "DJ_TRACK_ACTIVE");
  assert.equal(initial.payload.deck, 1);

  detector.stop();
  detector.start();
  clock.value = 1_100;
  detector.onSnapshot({
    deckNowPlaying: [{ deck: 2, title: "Other", artist: "Deck Two" }],
    deckPlaybacks: [playback(2, 1, clock.value)],
  });
  assert.deepEqual(detector.requestCurrentTrackCandidates(), []);
  assert.equal(
    events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length,
    1,
    "a different deck's current snapshot cannot reannounce the stale Deck 1 owner",
  );

  clock.value = 1_200;
  detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, title: "人生オーバー Remix", artist: "Deck One" }],
    deckPlaybacks: [playback(1, 2, clock.value)],
  });
  const reannounced = detector.requestCurrentTrackCandidates();
  assert.equal(reannounced.length, 1);
  assert.deepEqual(
    {
      deck: reannounced[0].payload.deck,
      title: reannounced[0].payload.title,
      artist: reannounced[0].payload.artist,
      playSessionId: reannounced[0].payload.playSessionId,
    },
    {
      deck: initial.payload.deck,
      title: initial.payload.title,
      artist: initial.payload.artist,
      playSessionId: initial.payload.playSessionId,
    },
  );
});

test("production detector timer admits Deck 1 after 1400 ms plus bounded dispatch jitter without another snapshot", () => {
  const clock = { value: 1_000 };
  const timers = createTimerHarness(clock);
  const { detector, events } = productionDetector(clock, timers.api);
  detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, contentId: "fallback-content" }],
    deckPlaybacks: [playback(1, 1, clock.value)],
  });
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 0);
  assert.equal(timers.timers.length, 1);
  assert.equal(timers.timers[0].delayMs, 1_400);
  timers.fire(timers.timers[0], { lateByMs: 50 });
  const active = events.find((event) => event.type === "DJ_TRACK_ACTIVE");
  assert.deepEqual(
    { deck: active.payload.deck, contentId: active.payload.contentId, sampleAgeMs: active.payload.sampleAgeMs },
    { deck: 1, contentId: "fallback-content", sampleAgeMs: 1_450 },
  );
});

test("production candidate read exposes a fresh Deck 1 fallback without emitting or reusing an ACK", () => {
  const clock = { value: 1_000 };
  const timers = createTimerHarness(clock);
  const { detector, events } = productionDetector(clock, timers.api);
  detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, contentId: "operator-fallback-content", title: "Temporary Track", artist: "Deck One" }],
    deckPlaybacks: [playback(1, 1, clock.value)],
  });
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 0);
  assert.equal(detector.getProductionCandidateStatus().stage, "waiting-for-1400ms");

  clock.value = 2_400;
  const beforeRead = events.length;
  const candidate = detector.getCurrentProductionCandidate();
  assert.deepEqual(
    {
      kind: candidate.kind,
      deck: candidate.deck,
      deckId: candidate.deckId,
      playSessionId: candidate.playSessionId,
      identity: candidate.identity,
      fresh: candidate.fresh,
      isPlaying: candidate.isPlaying,
      sessionAgeMs: candidate.sessionAgeMs,
    },
    {
      kind: "deck1-fallback",
      deck: 1,
      deckId: "rekordbox-deck-1",
      playSessionId: candidate.playSessionId,
      identity: "text:temporary track\u0000deck one",
      fresh: true,
      isPlaying: true,
      sessionAgeMs: 1_400,
    },
  );
  assert.equal(events.length, beforeRead, "read path must not emit DJ_TRACK_ACTIVE or reuse ACK state");
  assert.deepEqual(candidate.wireIdentity, { title: "Temporary Track", artist: "Deck One" });
  assert.equal(detector.getProductionCandidateStatus().stage, "candidate-ready");

  clock.value = 2_601;
  assert.equal(detector.getCurrentProductionCandidate(), null, "stale playback must fail closed");
  detector.stop();
});

test("equal-revision projected-position conflicts keep the Deck 1 fallback fail-closed until a newer revision", () => {
  const clock = { value: 1_000 };
  const timers = createTimerHarness(clock);
  const { detector, events } = productionDetector(clock, timers.api);
  const snapshot = (revision, positionSec, observedAt = clock.value) => ({
    deckNowPlaying: [{ deck: 1, contentId: "conflict-content", title: "Temporary Track", artist: "Deck One" }],
    deckPlaybacks: [{
      ...playback(1, revision, observedAt),
      positionSec,
    }],
  });

  detector.onSnapshot(snapshot(1, 1));
  assert.equal(timers.timers.length, 1);
  clock.value = 1_100;
  detector.onSnapshot(snapshot(1, 2));
  assert.equal(detector.getCurrentProductionCandidate(), null);
  assert.equal(detector.getProductionCandidateStatus().stage, "waiting-for-fresh-playback");
  assert.equal(events.some((event) => event.type === "DJ_TRACK_ACTIVE"), false);

  // A strictly newer playback revision restores transport provenance and
  // schedules the existing 1400ms fallback window; no freshness gate is
  // weakened to accept the conflicting same-revision projection.
  clock.value = 1_200;
  detector.onSnapshot(snapshot(2, 3));
  assert.equal(detector.getProductionCandidateStatus().stage, "waiting-for-1400ms");
  const recoveryTimer = timers.timers.at(-1);
  assert.equal(recoveryTimer.delayMs, 1_200);
  timers.fire(recoveryTimer);
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 1);
  assert.equal(detector.getCurrentProductionCandidate().kind, "deck1-fallback");
  detector.stop();
});

test("Deck 1 fallback freezes a content identity when later metadata enriches the same session", () => {
  const clock = { value: 1_000 };
  const timers = createTimerHarness(clock);
  const { detector, events } = productionDetector(clock, timers.api);
  detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, contentId: "frozen-fallback-content" }],
    deckPlaybacks: [playback(1, 1, clock.value)],
  });
  timers.fire(timers.timers[0]);

  clock.value = 2_450;
  detector.onSnapshot({
    deckNowPlaying: [{
      deck: 1,
      contentId: "frozen-fallback-content",
      title: "Demo Track 2",
      artist: "Loopmasters",
    }],
    deckPlaybacks: [playback(1, 2, clock.value)],
  });
  const sync = events.filter((event) => event.type === "DJ_TRACK_SYNC").at(-1);
  assert.deepEqual(
    { contentId: sync.payload.contentId, title: sync.payload.title, artist: sync.payload.artist },
    { contentId: "frozen-fallback-content", title: undefined, artist: undefined },
  );
});

test("same-session metadata enrichment reschedules the fallback timer without another snapshot", () => {
  const clock = { value: 1_000 };
  const timers = createTimerHarness(clock);
  const { detector, events } = productionDetector(clock, timers.api);
  detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, contentId: "enriched-content" }],
    deckPlaybacks: [playback(1, 1, clock.value)],
  });
  const originalTimer = timers.timers[0];
  clock.value = 1_100;
  detector.onTrackLoaded({ deck: 1, contentId: "enriched-content" });
  assert.equal(originalTimer.cleared, true);
  const enrichmentTimer = timers.timers[1];
  assert.equal(enrichmentTimer.delayMs, 1_300);
  timers.fire(enrichmentTimer);
  const active = events.find((event) => event.type === "DJ_TRACK_ACTIVE");
  assert.deepEqual(
    { deck: active.payload.deck, contentId: active.payload.contentId },
    { deck: 1, contentId: "enriched-content" },
  );
});

test("production detector makes a known nonmatching Deck 1 test track active after the wait", () => {
  const clock = { value: 1_000 };
  const { detector, events } = productionDetector(clock);
  detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, contentId: "demo-content", title: "Demo Track 2", artist: "Loopmasters" }],
    deckPlaybacks: [playback(1, 1, clock.value)],
  });
  assert.equal(events.some((event) => event.type === "DJ_TRACK_ACTIVE"), false);
  clock.value = 2_400;
  detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, contentId: "demo-content", title: "Demo Track 2", artist: "Loopmasters" }],
    deckPlaybacks: [playback(1, 2, clock.value)],
  });
  const active = events.find((event) => event.type === "DJ_TRACK_ACTIVE");
  assert.deepEqual(
    { deck: active.payload.deck, title: active.payload.title, artist: active.payload.artist, contentId: active.payload.contentId },
    { deck: 1, title: "Demo Track 2", artist: "Loopmasters", contentId: undefined },
  );
});

test("production timer fails closed rather than sending stale v3 identity after its 100 ms safety window", () => {
  const clock = { value: 1_000 };
  const timers = createTimerHarness(clock);
  const { detector, events } = productionDetector(clock, timers.api);
  detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, contentId: "late-fallback-content" }],
    deckPlaybacks: [playback(1, 1, clock.value)],
  });
  timers.fire(timers.timers[0], { lateByMs: 101 });
  assert.equal(events.some((event) => event.type === "DJ_TRACK_ACTIVE"), false);
});

test("replacement, reset, and router stop cancel and fence a pending fallback timer", () => {
  const replacementClock = { value: 1_000 };
  const replacementTimers = createTimerHarness(replacementClock);
  const replacement = productionDetector(replacementClock, replacementTimers.api);
  replacement.detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, contentId: "old-content" }],
    deckPlaybacks: [playback(1, 1, replacementClock.value)],
  });
  const replacementTimer = replacementTimers.timers[0];
  replacement.detector.onTrackLoaded({ deck: 1, contentId: "new-content" });
  assert.equal(replacementTimer.cleared, true);
  replacementTimers.fire(replacementTimer, { ignoreClear: true });
  assert.equal(replacement.events.some((event) => event.type === "DJ_TRACK_ACTIVE"), false);

  const resetClock = { value: 1_000 };
  const resetTimers = createTimerHarness(resetClock);
  const reset = productionDetector(resetClock, resetTimers.api);
  reset.detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, contentId: "reset-content" }],
    deckPlaybacks: [playback(1, 1, resetClock.value)],
  });
  const resetTimer = resetTimers.timers[0];
  reset.detector.reset();
  assert.equal(resetTimer.cleared, true);
  resetTimers.fire(resetTimer, { ignoreClear: true });
  assert.equal(reset.events.some((event) => event.type === "DJ_TRACK_ACTIVE"), false);

  const routerClock = { value: 1_000 };
  const routerTimers = createTimerHarness(routerClock);
  const detector = productionDetector(routerClock, routerTimers.api);
  const client = new EventEmitter();
  client.getStatus = () => ({ enabled: true, state: "connected" });
  client.sendEvent = () => ({ sent: true, state: "pending" });
  client.start = () => {};
  client.stop = () => {};
  const router = createShowEventRouter({
    detector: detector.detector,
    syndocalClient: client,
    midi: { getStatus: () => ({}), start() {}, stop() {} },
    pedal: { getStatus: () => ({}), start() {}, stop() {} },
  });
  router.onSnapshot({
    deckNowPlaying: [{ deck: 1, contentId: "router-stop-content" }],
    deckPlaybacks: [playback(1, 1, routerClock.value)],
  });
  const routerTimer = routerTimers.timers[0];
  router.stop();
  assert.equal(routerTimer.cleared, true);
  router.start();
  routerTimers.fire(routerTimer, { ignoreClear: true });
  assert.equal(detector.events.some((event) => event.type === "DJ_TRACK_ACTIVE"), false);
  assert.deepEqual(detector.detector.requestCurrentTrackCandidates(), []);

  routerClock.value = 1_100;
  router.onSnapshot({
    deckNowPlaying: [{ deck: 1, contentId: "router-stop-content" }],
    deckPlaybacks: [playback(1, 2, routerClock.value)],
  });
  const restartTimer = routerTimers.timers.at(-1);
  assert.notEqual(restartTimer, routerTimer);
  assert.equal(restartTimer.delayMs, 1_300);
  routerTimers.fire(restartTimer);
  const restartedActive = detector.events.find((event) => event.type === "DJ_TRACK_ACTIVE");
  assert.deepEqual(
    { deck: restartedActive.payload.deck, contentId: restartedActive.payload.contentId },
    { deck: 1, contentId: "router-stop-content" },
  );
  const restartedReannouncement = detector.detector.requestCurrentTrackCandidates();
  assert.equal(restartedReannouncement.length, 1);
  assert.deepEqual(
    {
      deck: restartedReannouncement[0].payload.deck,
      contentId: restartedReannouncement[0].payload.contentId,
      playSessionId: restartedReannouncement[0].payload.playSessionId,
    },
    {
      deck: restartedActive.payload.deck,
      contentId: restartedActive.payload.contentId,
      playSessionId: restartedActive.payload.playSessionId,
    },
  );
});

test("production detector rejects stopped and stale Deck 1 fallback samples", () => {
  const stoppedClock = { value: 1_000 };
  const stopped = productionDetector(stoppedClock);
  stopped.detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, contentId: "stopped-content" }],
    deckPlaybacks: [playback(1, 1, stoppedClock.value)],
  });
  stoppedClock.value = 2_400;
  stopped.detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, contentId: "stopped-content" }],
    deckPlaybacks: [playback(1, 2, stoppedClock.value, { isPlaying: false })],
  });
  assert.equal(stopped.events.some((event) => event.type === "DJ_TRACK_ACTIVE"), false);

  const staleClock = { value: 1_000 };
  const stale = productionDetector(staleClock);
  stale.detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, contentId: "stale-content" }],
    deckPlaybacks: [playback(1, 1, staleClock.value)],
  });
  staleClock.value = 2_501;
  stale.detector.onSnapshot({
    deckNowPlaying: [{ deck: 1, contentId: "stale-content" }],
    deckPlaybacks: [playback(1, 2, staleClock.value, { positionObservedAt: new Date(1_000).toISOString() })],
  });
  assert.equal(stale.events.some((event) => event.type === "DJ_TRACK_ACTIVE"), false);
});

test("timeline_not_playing ACK suspends stale Stage 2 commands without auto-return and recovers on idle state", () => {
  const fixture = createTimelineControlFixture({ freshFallback: false });
  const f13 = fixture.router.triggerAction("release");
  assert.equal(f13.action, "timeline-current-loop-toggle");
  assert.equal(fixture.router.getStatus().mode, "timeline-control");
  fixture.client.emit("delivery", {
    eventId: f13.delivery.eventId,
    type: "DJ_TIMELINE_LOOP_SET",
    state: "rejected",
    ackState: "rejected",
    ok: false,
    reason: "timeline_not_playing",
    ack: { code: "timeline_not_playing", outcome: "rejected" },
  });
  assert.equal(fixture.router.getStatus().mode, "timeline-control");
  assert.equal(fixture.router.getStatus().timelineSnapshotReady, false);
  assert.equal(fixture.timelineStateRequests, 1);
  assert.equal(fixture.router.triggerAction("release").reason, "timeline-state-pending");
  assert.equal(fixture.timelineStateRequests, 1);

  fixture.client.emit("timeline-state", {
    state: "idle",
    loopActive: false,
    transitionHoldActive: false,
    timelineId: null,
    positionBars: 0,
    playSessionId: null,
    pedalOwner: null,
    releaseEventId: null,
    sessionId: "operator-timeline-session",
    sequence: 2,
  });
  assert.equal(fixture.router.getStatus().mode, "dj-control");
  assert.equal(fixture.router.getStatus().timelineState, "idle");
  fixture.router.stop();
});

test("timeline pedals keep F13 absolute, halve active loops through dedicated F14, and preserve F15 plus-four", () => {
  const fixture = createTimelineControlFixture({ freshFallback: false });
  const operationsBeforeF14 = fixture.operations.slice();
  const f14 = fixture.router.triggerAction("loop-half");
  assert.equal(f14.ok, false);
  assert.equal(f14.action, "loop-half");
  assert.equal(f14.delivery.state, "pending");
  assert.equal(fixture.sent.at(-1).type, "DJ_TIMELINE_LOOP_HALF");
  assert.deepEqual(fixture.sent.at(-1).payload, {
    timelineId: "operator-timeline",
    playSessionId: fixture.timelineSessionId,
    source: "pedal",
  });
  assert.deepEqual(fixture.operations, operationsBeforeF14, "Stage 2 F14 must not emit Rekordbox MIDI");
  assert.equal(fixture.router.getStatus().pendingTimelineLoopHalf.eventId, f14.delivery.eventId);

  const f13 = fixture.router.triggerAction("release");
  assert.equal(f13.ok, false, "the fixture client leaves the F13 delivery pending");
  assert.equal(f13.action, "timeline-current-loop-toggle");
  assert.equal(fixture.sent.at(-1).type, "DJ_TIMELINE_LOOP_SET");
  assert.equal(fixture.sent.at(-1).payload.active, false);
  assert.equal(fixture.router.getStatus().pendingTimelineLoopHalf.eventId, f14.delivery.eventId, "F13 must not clear F14 latch");

  fixture.client.emit("timeline-state", {
    state: "running",
    loopActive: false,
    transitionHoldActive: false,
    timelineId: "operator-timeline",
    positionBars: 8,
    playSessionId: fixture.timelineSessionId,
    pedalOwner: "timeline",
    releaseEventId: fixture.releaseEventId,
  });
  assert.equal(fixture.router.getStatus().pendingTimelineLoopSet, null, "F13 latch clears only from its authoritative state");
  assert.equal(fixture.router.getStatus().pendingTimelineLoopHalf.eventId, f14.delivery.eventId, "F14 remains independently pending");

  fixture.client.emit("delivery", {
    eventId: f14.delivery.eventId,
    type: "DJ_TIMELINE_LOOP_HALF",
    state: "acknowledged",
    ack: { outcome: "accepted" },
  });
  assert.equal(fixture.router.getStatus().pendingTimelineLoopHalf, null, "F14 latch clears from its own terminal ACK");

  const f13On = fixture.router.triggerAction("release");
  assert.equal(f13On.ok, false, "the fixture client leaves the second F13 delivery pending");
  assert.equal(fixture.sent.at(-1).type, "DJ_TIMELINE_LOOP_SET");
  assert.equal(fixture.sent.at(-1).payload.active, true);

  const f15 = fixture.router.triggerAction("filter-close");
  assert.equal(f15.action, "beat-jump-plus-4");
  assert.equal(fixture.sent.at(-1).type, "DJ_TIMELINE_BEAT_JUMP");
  assert.equal(fixture.sent.at(-1).payload.bars, 4);

  const beforeInactive = fixture.sent.length;
  fixture.client.emit("timeline-state", {
    state: "running",
    loopActive: false,
    transitionHoldActive: false,
    timelineId: "operator-timeline",
    positionBars: 8,
    playSessionId: fixture.timelineSessionId,
    pedalOwner: "timeline",
    releaseEventId: fixture.releaseEventId,
  });
  const inactiveF14 = fixture.router.triggerAction("loop-half");
  assert.equal(inactiveF14.reason, "timeline-loop-inactive");
  assert.equal(fixture.sent.length, beforeInactive, "inactive F14 must not send a half command");
  fixture.router.stop();
});
