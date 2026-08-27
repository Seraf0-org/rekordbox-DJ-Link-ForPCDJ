const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const dgram = require("node:dgram");

const {
  createSyndocalClient,
  createSyndocalEnvelopeV3Adapter,
  decodeV3TimelineState,
  resolveAdapter,
  validateEnvelopeV3Ack,
} = require("../server/dj-agent/syndocalClient");
const { createTrackActivityDetector } = require("../server/dj-agent/trackActivityDetector");
const { createShowEventRouter } = require("../server/dj-agent/showEventRouter");
const { createHookUdpProvider } = require("../server/providers/hookUdpProvider");

const TEST_TOKEN = "0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-08-25T00:00:00.000Z");
const ENVELOPE_FIELDS = ["v", "type", "agentId", "sessionId", "sequence", "eventId", "payload"];
const EXACT_RELEASE_MACRO = Object.freeze({
  enabled: true,
  sequence: "filter-then-fade-then-stop",
  filter: Object.freeze({
    startValue: 64,
    endValue: 127,
    durationMs: 1_000,
    updateIntervalMs: 50,
    resetValue: 64,
  }),
  resetAfterStop: true,
  resetDelayMs: 0,
});
const EXACT_RELEASE_FADE = Object.freeze({
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
});

function assertV3Frame(frame, type) {
  assert.deepEqual(Object.keys(frame).sort(), [...ENVELOPE_FIELDS].sort());
  assert.equal(frame.v, 3);
  assert.equal(frame.type, type);
  assert.equal(frame.agentId, "rb-output-dj-agent");
  assert.equal(typeof frame.sessionId, "string");
  assert.ok(frame.sessionId.length > 0);
  assert.equal(Number.isSafeInteger(frame.sequence), true);
  assert.ok(frame.sequence > 0);
  assert.equal(typeof frame.eventId, "string");
  assert.ok(frame.eventId.length > 0);
}

function strictTrackPayload(overrides = {}) {
  return {
    deck: 1,
    deckId: "rekordbox-deck-1",
    contentId: "42",
    trackBpm: 120,
    positionAtSendSec: 12.5,
    effectiveBpm: 120.25,
    positionRevision: 8,
    sampleAgeMs: 10,
    isPlaying: true,
    startedAt: "2026-08-25T00:00:00.000Z",
    playSessionId: "play-session-1",
    loop: null,
    ...overrides,
  };
}

function strictCandidateTrackPayload(overrides = {}) {
  return {
    deck: 2,
    deckId: "rekordbox-deck-2",
    contentId: "candidate-42",
    trackBpm: 120,
    positionAtSendSec: 12.5,
    effectiveBpm: 120.25,
    positionRevision: 8,
    sampleAgeMs: 10,
    isPlaying: true,
    startedAt: "2026-08-25T00:00:00.000Z",
    playSessionId: "candidate-session-2",
    loop: null,
    ...overrides,
  };
}

function strictTimelineState(overrides = {}) {
  return {
    v: 3,
    type: "DJ_TIMELINE_STATE",
    agentId: "syndocal",
    sessionId: "syndocal-session",
    sequence: 1,
    eventId: "timeline-state-1",
    payload: {
      state: "running",
      loopActive: false,
      transitionHoldActive: false,
      timelineId: "life-over",
      positionBars: 8,
      playSessionId: "play-session-1",
      pedalOwner: "dj",
      releaseEventId: null,
      ...overrides,
    },
  };
}

test("production adapter is a strict v3 clean break and explicitly rejects retired v2", () => {
  const v3 = resolveAdapter({ adapter: "syndocal-envelope-v3", token: TEST_TOKEN });
  assert.equal(v3.error, null);
  assert.equal(v3.adapterObject.name, "syndocal-envelope-v3");
  for (const retired of ["generic-json", "syndocal-envelope-v1", "syndocal-envelope-v2", "", "envelope-v3"]) {
    const result = resolveAdapter({ adapter: retired, token: TEST_TOKEN });
    assert.equal(result.adapterObject, null);
    assert.match(result.error, /v3|required|retired/i);
  }
});

test("v3 generic active/sync payloads require exact identity, position, BPM, revision, and freshness", () => {
  const adapter = createSyndocalEnvelopeV3Adapter({ token: TEST_TOKEN });
  const hello = adapter.encodeHello({ eventId: "hello-1", sequence: 1 });
  assertV3Frame(hello, "DJ_AGENT_HELLO");
  assert.deepEqual(hello.payload.version, 3);
  assert.deepEqual(hello.payload.capabilities, [
    "DJ_TRACK_ACTIVE",
    "DJ_TRACK_SYNC",
    "DJ_LOOP_STATE",
    "DJ_LOOP_FALLBACK",
    "DJ_RELEASE",
    "DJ_TIMELINE_BEAT_JUMP",
    "DJ_TIMELINE_LOOP_SET",
    "DJ_TIMELINE_STATE_REQUEST",
    "DJ_STATE_SYNC",
  ]);

  const encoded = adapter.encodeEvent({
    type: "DJ_TRACK_ACTIVE",
    eventId: "active-1",
    sequence: 2,
    payload: strictTrackPayload(),
  });
  assertV3Frame(encoded, "DJ_TRACK_ACTIVE");
  assert.deepEqual(encoded.payload, strictTrackPayload());

  const invalid = [
    { playSessionId: null },
    { deckId: "deck-1" },
    { positionAtSendSec: null },
    { positionAtSendSec: Number.NaN },
    { effectiveBpm: Infinity },
    { positionRevision: 0 },
    { sampleAgeMs: 1_501 },
    { isPlaying: false },
    { master: false },
    { contentId: null, title: "Only title", artist: null },
    { contentId: " 42" },
  ];
  invalid.forEach((patch, index) => {
    assert.equal(adapter.encodeEvent({
      type: "DJ_TRACK_ACTIVE",
      eventId: `invalid-${index}`,
      sequence: index + 3,
      payload: strictTrackPayload(patch),
    }), null);
  });

  const titleArtistIdentity = adapter.encodeEvent({
    type: "DJ_TRACK_SYNC",
    eventId: "sync-text-identity",
    sequence: 30,
    payload: (() => {
      const payload = strictTrackPayload({ title: "Life Over", artist: "DSF" });
      delete payload.contentId;
      return payload;
    })(),
  });
  assertV3Frame(titleArtistIdentity, "DJ_TRACK_SYNC");
});

test("v3 per-deck candidates use exactly one identity form and exclude master-only fields", () => {
  const adapter = createSyndocalEnvelopeV3Adapter({ token: TEST_TOKEN });
  const hello = adapter.encodeHello({ eventId: "candidate-hello", sequence: 1 });
  assert.ok(hello.payload.capabilities.includes("DJ_TRACK_ACTIVE"));
  assert.ok(hello.payload.capabilities.includes("DJ_TRACK_SYNC"));
  assert.equal(hello.payload.capabilities.includes("DJ_MASTER_CHANGED"), false);

  const contentFrame = adapter.encodeEvent({
    type: "DJ_TRACK_ACTIVE",
    eventId: "candidate-content-active",
    sequence: 2,
    payload: strictCandidateTrackPayload(),
  });
  assertV3Frame(contentFrame, "DJ_TRACK_ACTIVE");
  assert.deepEqual(contentFrame.payload, strictCandidateTrackPayload());
  assert.equal(Object.hasOwn(contentFrame.payload, "title"), false);
  assert.equal(Object.hasOwn(contentFrame.payload, "artist"), false);
  assert.equal(Object.hasOwn(contentFrame.payload, "master"), false);
  assert.equal(Object.hasOwn(contentFrame.payload, "masterDeckRevision"), false);

  const nullOptionalFrame = adapter.encodeEvent({
    type: "DJ_TRACK_ACTIVE",
    eventId: "candidate-null-optionals",
    sequence: 21,
    payload: strictCandidateTrackPayload({ trackBpm: null, loop: null }),
  });
  assertV3Frame(nullOptionalFrame, "DJ_TRACK_ACTIVE");
  assert.equal(nullOptionalFrame.payload.trackBpm, null);
  assert.equal(nullOptionalFrame.payload.loop, null);

  const omittedPayload = strictCandidateTrackPayload();
  delete omittedPayload.trackBpm;
  delete omittedPayload.loop;
  const omittedOptionalFrame = adapter.encodeEvent({
    type: "DJ_TRACK_SYNC",
    eventId: "candidate-omitted-optionals",
    sequence: 22,
    payload: omittedPayload,
  });
  assertV3Frame(omittedOptionalFrame, "DJ_TRACK_SYNC");
  assert.equal(Object.hasOwn(omittedOptionalFrame.payload, "trackBpm"), false);
  assert.equal(Object.hasOwn(omittedOptionalFrame.payload, "loop"), false);

  const textPayload = strictCandidateTrackPayload({
    contentId: undefined,
    title: "Candidate title",
    artist: "Candidate artist",
    trackBpm: undefined,
  });
  delete textPayload.contentId;
  delete textPayload.trackBpm;
  const textFrame = adapter.encodeEvent({
    type: "DJ_TRACK_SYNC",
    eventId: "candidate-text-sync",
    sequence: 3,
    payload: textPayload,
  });
  assertV3Frame(textFrame, "DJ_TRACK_SYNC");
  assert.deepEqual(textFrame.payload, textPayload);

  for (const [index, patch] of [
    { title: "must-not-coexist", artist: "with-content" },
    { contentId: undefined, title: "title-only" },
    { master: true },
    { masterDeckRevision: 1 },
    { unknown: true },
  ].entries()) {
    const invalid = strictCandidateTrackPayload(patch);
    if (Object.hasOwn(patch, "contentId") && patch.contentId === undefined) delete invalid.contentId;
    assert.equal(adapter.encodeEvent({
      type: "DJ_TRACK_ACTIVE",
      eventId: `candidate-invalid-${index}`,
      sequence: 10 + index,
      payload: invalid,
    }), null);
  }
});

test("v3 loop and release encoders accept only measured/correlated state", () => {
  const adapter = createSyndocalEnvelopeV3Adapter({ token: TEST_TOKEN });
  adapter.encodeHello({ eventId: "hello", sequence: 1 });
  const loop = {
    deck: 1,
    deckId: "rekordbox-deck-1",
    playSessionId: "play-session-1",
    active: true,
    startBeat: 32,
    endBeat: 40,
    lengthBeats: 8,
    revision: 4,
    sampleAgeMs: 3,
    source: "rekordbox-hook-measured",
  };
  const encodedLoop = adapter.encodeEvent({ type: "DJ_LOOP_STATE", eventId: "loop-1", sequence: 2, payload: loop });
  assertV3Frame(encodedLoop, "DJ_LOOP_STATE");
  assert.deepEqual(encodedLoop.payload, {
    deck: 1,
    deckId: "rekordbox-deck-1",
    playSessionId: "play-session-1",
    loop: {
      active: true,
      startBeat: 32,
      endBeat: 40,
      lengthBeats: 8,
      revision: 4,
      sampleAgeMs: 3,
      source: "rekordbox-hook-measured",
    },
  });
  const inactiveLoop = {
    ...loop,
    active: false,
    startBeat: null,
    endBeat: null,
    lengthBeats: null,
    revision: 5,
  };
  assertV3Frame(adapter.encodeEvent({
    type: "DJ_LOOP_STATE",
    eventId: "loop-off",
    sequence: 3,
    payload: inactiveLoop,
  }), "DJ_LOOP_STATE");
  for (const patch of [
    { startBeat: 32 },
    { endBeat: 40 },
    { lengthBeats: 8 },
  ]) {
    assert.equal(adapter.encodeEvent({
      type: "DJ_LOOP_STATE",
      eventId: `bad-loop-off-${Object.keys(patch)[0]}`,
      sequence: 4,
      payload: { ...inactiveLoop, ...patch },
    }), null);
  }
  for (const patch of [
    { active: null },
    { lengthBeats: 4 },
    { revision: 0 },
    { sampleAgeMs: 1_501 },
    { source: "pedal" },
  ]) {
    assert.equal(adapter.encodeEvent({
      type: "DJ_LOOP_STATE",
      eventId: `bad-loop-${String(patch.source || patch.revision || patch.lengthBeats || "x")}`,
      sequence: 3,
      payload: { ...loop, ...patch },
    }), null);
  }
  for (const patch of [
    { masterDeckRevision: 4 },
    { master: true },
    { extra: "not-on-the-wire" },
  ]) {
    assert.equal(adapter.encodeEvent({
      type: "DJ_LOOP_STATE",
      eventId: `bad-loop-outer-${Object.keys(patch)[0]}`,
      sequence: 4,
      payload: { ...loop, ...patch },
    }), null);
  }
  assertV3Frame(adapter.encodeEvent({
    type: "DJ_RELEASE",
    eventId: "release-1",
    sequence: 4,
    payload: { state: "released", timelineId: "life-over", playSessionId: "play-session-1" },
  }), "DJ_RELEASE");
  assert.equal(adapter.encodeEvent({
    type: "DJ_RELEASE",
    eventId: "release-bad",
    sequence: 5,
    payload: { state: "released", timelineId: "life-over", playSessionId: null },
  }), null);
});

test("generic v3 State Sync emits owner correlation all-or-none", () => {
  const adapter = createSyndocalEnvelopeV3Adapter({ token: TEST_TOKEN });
  const noOwner = adapter.encodeStateSync({
    eventId: "state-no-owner",
    sequence: 1,
    state: { released: false, ownerDeck: null, ownerDeckId: null, activePlaySessionId: null },
  });
  assertV3Frame(noOwner, "DJ_STATE_SYNC");
  assert.deepEqual(noOwner.payload, { released: false });

  const owner = adapter.encodeStateSync({
    eventId: "state-owner",
    sequence: 2,
    state: {
      released: true,
      ownerDeck: 2,
      ownerDeckId: "rekordbox-deck-2",
      activePlaySessionId: "owner-session-2",
      ownerTrack: { contentId: "diagnostic-only" },
    },
  });
  assertV3Frame(owner, "DJ_STATE_SYNC");
  assert.deepEqual(owner.payload, {
    released: true,
    ownerDeck: 2,
    ownerDeckId: "rekordbox-deck-2",
    activePlaySessionId: "owner-session-2",
  });

  for (const state of [
    { released: false, ownerDeck: 2 },
    { released: false, ownerDeckId: "rekordbox-deck-2" },
    { released: false, activePlaySessionId: "owner-session-2" },
    { released: false, ownerDeck: 2, ownerDeckId: "rekordbox-deck-2" },
    { released: false, ownerDeck: 2, activePlaySessionId: "owner-session-2" },
    { released: false, ownerDeckId: "rekordbox-deck-2", activePlaySessionId: "owner-session-2" },
    { released: false, ownerDeck: 2, ownerDeckId: "rekordbox-deck-3", activePlaySessionId: "owner-session-2" },
    { released: false, ownerDeck: 2, ownerDeckId: "rekordbox-deck-2", activePlaySessionId: null },
  ]) {
    assert.equal(adapter.encodeStateSync({ eventId: "state-partial", sequence: 3, state }), null);
  }
});

test("v3 beat jump +4 and loop set encoders require a canonical playSessionId", () => {
  const adapter = createSyndocalEnvelopeV3Adapter({ token: TEST_TOKEN });
  adapter.encodeHello({ eventId: "hello-actions", sequence: 1 });
  const beatJump = { bars: 4, timelineId: "life-over", playSessionId: "play-session-1" };
  const loopSet = { active: true, timelineId: "life-over", playSessionId: "play-session-1" };
  const jumpFrame = adapter.encodeEvent({
    type: "DJ_TIMELINE_BEAT_JUMP",
    eventId: "jump-canonical",
    sequence: 2,
    payload: beatJump,
  });
  assertV3Frame(jumpFrame, "DJ_TIMELINE_BEAT_JUMP");
  assert.deepEqual(jumpFrame.payload, beatJump);
  assert.equal(adapter.encodeEvent({
    type: "DJ_TIMELINE_BEAT_JUMP",
    eventId: "jump-retired-minus-4",
    sequence: 200,
    payload: { ...beatJump, bars: -4 },
  }), null);
  const loopFrame = adapter.encodeEvent({
    type: "DJ_TIMELINE_LOOP_SET",
    eventId: "loop-canonical",
    sequence: 3,
    payload: loopSet,
  });
  assertV3Frame(loopFrame, "DJ_TIMELINE_LOOP_SET");
  assert.deepEqual(loopFrame.payload, loopSet);

  // The router's exact source="pedal" local-only metadata is accepted on
  // input and never emitted onto the wire.
  const jumpPedal = adapter.encodeEvent({
    type: "DJ_TIMELINE_BEAT_JUMP",
    eventId: "jump-pedal-source",
    sequence: 4,
    payload: { ...beatJump, source: "pedal" },
  });
  assertV3Frame(jumpPedal, "DJ_TIMELINE_BEAT_JUMP");
  assert.deepEqual(jumpPedal.payload, beatJump);
  const loopPedal = adapter.encodeEvent({
    type: "DJ_TIMELINE_LOOP_SET",
    eventId: "loop-pedal-source",
    sequence: 5,
    payload: { ...loopSet, source: "pedal" },
  });
  assertV3Frame(loopPedal, "DJ_TIMELINE_LOOP_SET");
  assert.deepEqual(loopPedal.payload, loopSet);

  // Hostile inputs are rejected, never silently stripped.
  for (const [type, canonical] of [
    ["DJ_TIMELINE_BEAT_JUMP", beatJump],
    ["DJ_TIMELINE_LOOP_SET", loopSet],
  ]) {
    let variant = 0;
    for (const patch of [
      { ignoredExtra: "must-reject" },
      { source: "dj" },
      { source: 42 },
      { source: null },
      { source: " pedal" },
      { extra: true, source: "pedal" },
    ]) {
      variant += 1;
      assert.equal(adapter.encodeEvent({
        type,
        eventId: `hostile-${variant}`,
        sequence: 40 + variant,
        payload: { ...canonical, ...patch },
      }), null, `${type} must reject ${JSON.stringify(patch)}`);
    }
    const symbolKeyed = { ...canonical };
    Object.defineProperty(symbolKeyed, Symbol.for("injected"), { value: "hostile", enumerable: true });
    assert.equal(adapter.encodeEvent({
      type,
      eventId: `hostile-symbol-${variant}`,
      sequence: 60 + variant,
      payload: symbolKeyed,
    }), null, `${type} must reject symbol keys`);
  }

  const invalidSessions = [
    { playSessionId: null },
    { playSessionId: "" },
    { playSessionId: "   " },
    { playSessionId: " pad" },
    { playSessionId: 42 },
    {},
  ];
  let variant = 0;
  for (const patch of invalidSessions) {
    variant += 1;
    assert.equal(adapter.encodeEvent({
      type: "DJ_TIMELINE_BEAT_JUMP",
      eventId: `jump-bad-${variant}`,
      sequence: 10 + variant,
      payload: { bars: 4, timelineId: "life-over", ...patch },
    }), null);
    assert.equal(adapter.encodeEvent({
      type: "DJ_TIMELINE_LOOP_SET",
      eventId: `loop-bad-${variant}`,
      sequence: 30 + variant,
      payload: { active: false, timelineId: "life-over", ...patch },
    }), null);
  }
});

test("detector delays active until complete, emits one active per session, and fences revisions/reorder/staleness", () => {
  let nextId = 0;
  let now = NOW;
  const detector = createTrackActivityDetector({ now: () => now, idFactory: () => `id-${++nextId}` });
  const events = [];
  detector.on("event", (event) => events.push(event));

  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date(now).toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "42", title: "Life Over", artist: "DSF", trackBpm: 120 }],
    deckPlaybacks: [{ deck: 1, isPlaying: true, bpm: 120 }],
  });
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 0);
  const playSessionId = detector.getState().decks[1].playSessionId;
  assert.ok(playSessionId);

  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date(now).toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "42", title: "Life Over", artist: "DSF", trackBpm: 120 }],
    deckPlaybacks: [{
      deck: 1,
      isPlaying: true,
      bpm: 120,
      positionSec: 1,
      positionRevision: 1,
      positionObservedAt: new Date(now).toISOString(),
    }],
  });
  const active = events.filter((event) => event.type === "DJ_TRACK_ACTIVE");
  assert.equal(active.length, 1);
  assert.equal(active[0].payload.playSessionId, playSessionId);

  const sample = (positionRevision, positionSec, observedAt = now) => detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date(now).toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "42", title: "Life Over", artist: "DSF", trackBpm: 120 }],
    deckPlaybacks: [{
      deck: 1,
      isPlaying: true,
      bpm: 120,
      positionSec,
      positionRevision,
      positionObservedAt: new Date(observedAt).toISOString(),
    }],
  });
  sample(1, 1);
  sample(2, 2);
  sample(1, 0.5);
  now += 2_000;
  sample(3, 3, NOW);
  assert.deepEqual(
    events.filter((event) => event.type === "DJ_TRACK_SYNC").map((event) => event.payload.positionRevision),
    [2],
  );
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 1);
});

test("detector emits exact per-deck candidates for simultaneous playback without master authority", () => {
  let nextId = 0;
  let now = NOW;
  const detector = createTrackActivityDetector({
    now: () => now,
    idFactory: () => `candidate-${++nextId}`,
  });
  const events = [];
  detector.on("event", (event) => events.push(event));
  const snapshot = (revision, observedAt = now) => detector.onSnapshot({
    // Deck 1 is only a fallback master. Deck 2 must still emit its mapped
    // candidate without any master_change packet.
    masterDeck: 1,
    masterDeckSource: "playback-fallback",
    deckNowPlaying: [
      { deck: 1, contentId: "deck-1", title: "Master candidate", artist: "Artist 1", trackBpm: 120 },
      { deck: 2, contentId: "mapped-deck-2", title: "Mapped candidate", artist: "Artist 2", trackBpm: 128 },
    ],
    deckPlaybacks: [
      {
        deck: 1,
        isPlaying: true,
        bpm: 120,
        positionSec: revision,
        positionRevision: revision,
        positionObservedAt: new Date(observedAt).toISOString(),
      },
      {
        deck: 2,
        isPlaying: true,
        bpm: 128,
        positionSec: revision + 10,
        positionRevision: revision,
        positionObservedAt: new Date(observedAt).toISOString(),
      },
    ],
  });

  snapshot(1);
  const active = events.filter((event) => event.type === "DJ_TRACK_ACTIVE");
  assert.deepEqual(active.map((event) => event.payload.deck), [1, 2]);
  const nonMaster = active.find((event) => event.payload.deck === 2);
  assert.equal(nonMaster.payload.contentId, "mapped-deck-2");
  assert.equal(Object.hasOwn(nonMaster.payload, "title"), false);
  assert.equal(Object.hasOwn(nonMaster.payload, "artist"), false);
  assert.equal(Object.hasOwn(nonMaster.payload, "master"), false);
  assert.equal(Object.hasOwn(nonMaster.payload, "masterDeckRevision"), false);

  // Equal revisions cannot duplicate a candidate ACTIVE or produce SYNC.
  snapshot(1);
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 2);
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_SYNC").length, 0);

  now += 1;
  snapshot(2);
  const sync = events.filter((event) => event.type === "DJ_TRACK_SYNC");
  assert.deepEqual(sync.map((event) => [event.payload.deck, event.payload.positionRevision]), [[1, 2], [2, 2]]);
  assert.equal(sync[1].payload.playSessionId, nonMaster.payload.playSessionId);

  // A newer but stale sample remains fail-closed for both concurrent decks.
  now += 1_501;
  snapshot(3, NOW);
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_SYNC").length, 2);
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 2);
});

test("detector reannounces only fresh, actually playing candidate sessions", () => {
  let now = NOW;
  let nextId = 0;
  const detector = createTrackActivityDetector({ now: () => now, idFactory: () => `reannounce-${++nextId}` });
  const events = [];
  detector.on("event", (event) => events.push(event));
  const snapshot = (isPlaying, revision, observedAt = now) => ({
    deckNowPlaying: [{ deck: 2, contentId: "reannounce-content", title: "Reannounce", artist: "DSF", trackBpm: 124 }],
    deckPlaybacks: [{
      deck: 2,
      isPlaying,
      bpm: 124,
      positionSec: revision,
      positionRevision: revision,
      positionObservedAt: new Date(observedAt).toISOString(),
    }],
  });
  detector.onSnapshot(snapshot(true, 1));
  const initial = events.find((event) => event.type === "DJ_TRACK_ACTIVE");
  assert.ok(initial);

  const reannounced = detector.requestCurrentTrackCandidates();
  assert.equal(reannounced.length, 1);
  assert.equal(reannounced[0].type, "DJ_TRACK_ACTIVE");
  assert.equal(reannounced[0].payload.playSessionId, initial.payload.playSessionId);
  assert.equal(reannounced[0].payload.positionRevision, initial.payload.positionRevision);

  now += 1_501;
  assert.deepEqual(detector.requestCurrentTrackCandidates(), []);
  detector.onSnapshot(snapshot(false, 2, now));
  assert.deepEqual(detector.requestCurrentTrackCandidates(), []);
});

test("a playing candidate emits once without MASTER and only newer samples SYNC", () => {
  let nextId = 0;
  let now = NOW;
  const detector = createTrackActivityDetector({
    now: () => now,
    idFactory: () => `master-switch-${++nextId}`,
  });
  const events = [];
  detector.on("event", (event) => events.push(event));
  const candidatePlayback = (positionRevision, positionSec) => ({
    deck: 2,
    isPlaying: true,
    bpm: 128,
    positionSec,
    positionRevision,
    positionObservedAt: new Date(now).toISOString(),
  });
  const snapshot = (playback) => detector.onSnapshot({
    explicitMasterDeck: 2,
    explicitMasterUpdatedAt: new Date(now).toISOString(),
    deckNowPlaying: [{
      deck: 2,
      contentId: "deck-2-content",
      title: "Incoming",
      artist: "DSF",
      trackBpm: 128,
    }],
    deckPlaybacks: [playback],
  });

  // A complete, fresh candidate activates without any master-change packet.
  detector.onSnapshot({
    masterDeck: 1,
    deckNowPlaying: [{
      deck: 2,
      contentId: "deck-2-content",
      title: "Incoming",
      artist: "DSF",
      trackBpm: 128,
    }],
    deckPlaybacks: [candidatePlayback(10, 32.5)],
  });
  assert.deepEqual(
    events.filter((event) => event.type === "DJ_TRACK_ACTIVE" || event.type === "DJ_TRACK_SYNC").map((event) => event.type),
    ["DJ_TRACK_ACTIVE"],
  );

  const authorityAt = new Date(now).toISOString();
  detector.onMasterChange({ deck: 2, explicitMasterUpdatedAt: authorityAt });
  detector.onMasterChange({ deck: 2, explicitMasterUpdatedAt: authorityAt });
  const activationEvents = () => events.filter(
    (event) => event.type === "DJ_TRACK_ACTIVE" || event.type === "DJ_TRACK_SYNC",
  );
  assert.deepEqual(activationEvents().map((event) => event.type), ["DJ_TRACK_ACTIVE"]);
  const active = activationEvents()[0];
  assert.equal(active.payload.deck, 2);
  assert.equal(active.payload.deckId, "rekordbox-deck-2");
  assert.equal(active.payload.contentId, "deck-2-content");
  assert.equal(active.payload.positionAtSendSec, 32.5);
  assert.equal(active.payload.effectiveBpm, 128);
  assert.equal(active.payload.positionRevision, 10);
  assert.equal(active.payload.sampleAgeMs, 0);
  assert.equal(active.payload.isPlaying, true);
  assert.equal(Object.hasOwn(active.payload, "master"), false);
  assert.ok(active.payload.playSessionId);
  const adapter = createSyndocalEnvelopeV3Adapter({ token: TEST_TOKEN });
  const activeFrame = adapter.encodeEvent({
    type: active.type,
    eventId: active.eventId,
    sequence: 1,
    payload: active.payload,
  });
  assertV3Frame(activeFrame, "DJ_TRACK_ACTIVE");
  assert.deepEqual(activeFrame.payload, active.payload);

  // Equal revision cannot duplicate either transition; only a strictly newer,
  // fresh sample may advance the active play session to SYNC.
  snapshot(candidatePlayback(10, 32.5));
  assert.deepEqual(activationEvents().map((event) => event.type), ["DJ_TRACK_ACTIVE"]);
  now += 1;
  snapshot(candidatePlayback(11, 33));
  assert.deepEqual(
    activationEvents().map((event) => event.type),
    ["DJ_TRACK_ACTIVE", "DJ_TRACK_SYNC"],
  );
  const sync = activationEvents()[1];
  assert.equal(sync.payload.playSessionId, active.payload.playSessionId);
  assert.equal(sync.payload.positionRevision, 11);
  assert.equal(sync.payload.positionAtSendSec, 33);
  assert.equal(sync.payload.sampleAgeMs, 0);
  const syncFrame = adapter.encodeEvent({
    type: sync.type,
    eventId: sync.eventId,
    sequence: 2,
    payload: sync.payload,
  });
  assertV3Frame(syncFrame, "DJ_TRACK_SYNC");
  assert.deepEqual(syncFrame.payload, sync.payload);
});

test("conflicting master diagnostics cannot duplicate a per-deck candidate session", () => {
  let nextId = 0;
  let now = NOW;
  const detector = createTrackActivityDetector({
    now: () => now,
    idFactory: () => `authority-${++nextId}`,
  });
  const events = [];
  detector.on("event", (event) => events.push(event));
  const transitions = () => events.filter(
    (event) => event.type === "DJ_TRACK_ACTIVE" || event.type === "DJ_TRACK_SYNC",
  );
  const deck2Playback = (positionRevision, positionSec) => ({
    deck: 2,
    isPlaying: true,
    bpm: 128,
    positionSec,
    positionRevision,
    positionObservedAt: new Date(now).toISOString(),
  });
  const deck2SnapshotFields = {
    deckNowPlaying: [{ deck: 2, contentId: "incoming", title: "Incoming", artist: "DSF", trackBpm: 128 }],
    deckPlaybacks: [deck2Playback(10, 32.5)],
  };

  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date(now).toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "outgoing", title: "Outgoing", artist: "DSF", trackBpm: 120 }],
    deckPlaybacks: [{
      deck: 1,
      isPlaying: true,
      bpm: 120,
      positionSec: 8,
      positionRevision: 5,
      positionObservedAt: new Date(now).toISOString(),
    }],
  });
  assert.deepEqual(
    transitions().map((event) => [event.type, event.payload.deck]),
    [["DJ_TRACK_ACTIVE", 1]],
  );
  const activeOne = transitions()[0];
  const outgoingSession = activeOne.payload.playSessionId;

  // A conflicting MASTER diagnostic cannot duplicate deck 1's candidate
  // session; deck 2 is nevertheless allowed to emit its own candidate.
  const beforeConflict = events.length;
  detector.onSnapshot({ masterDeck: 2, masterDeckSource: "snapshot", ...deck2SnapshotFields });
  assert.equal(detector.getState().explicitMasterDeck, 1);
  assert.equal(detector.getState().currentMasterDeck, 1);
  assert.equal(detector.getState().masterDeckSource, "explicit");
  assert.equal(events.slice(beforeConflict).filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 1);
  assert.deepEqual(transitions().map((event) => [event.type, event.payload.deck]), [
    ["DJ_TRACK_ACTIVE", 1],
    ["DJ_TRACK_ACTIVE", 2],
  ]);

  // A later master update cannot emit a duplicate deck-2 candidate.
  now += 1;
  detector.onMasterChange({ logicalDeck: 2, explicitMasterUpdatedAt: new Date(now).toISOString() });
  assert.deepEqual(transitions().map((event) => event.type), ["DJ_TRACK_ACTIVE", "DJ_TRACK_ACTIVE"]);
  const activeTwo = transitions()[1];
  assert.equal(activeTwo.payload.deck, 2);
  assert.equal(activeTwo.payload.contentId, "incoming");
  assert.equal(activeTwo.payload.positionRevision, 10);
  assert.notEqual(activeTwo.payload.playSessionId, outgoingSession);

  // Same revision stays silent; only a strictly newer fresh sample SYNCs once.
  const beforeSameRevision = events.length;
  detector.onSnapshot({
    explicitMasterDeck: 2,
    explicitMasterUpdatedAt: new Date(now).toISOString(),
    ...deck2SnapshotFields,
  });
  assert.equal(events.length, beforeSameRevision);

  now += 1;
  detector.onSnapshot({
    explicitMasterDeck: 2,
    explicitMasterUpdatedAt: new Date(now).toISOString(),
    deckNowPlaying: [{ deck: 2, contentId: "incoming", title: "Incoming", artist: "DSF", trackBpm: 128 }],
    deckPlaybacks: [deck2Playback(11, 33)],
  });
  assert.deepEqual(transitions().map((event) => event.type), [
    "DJ_TRACK_ACTIVE",
    "DJ_TRACK_ACTIVE",
    "DJ_TRACK_SYNC",
  ]);
  const sync = transitions()[2];
  assert.equal(sync.payload.deck, 2);
  assert.equal(sync.payload.playSessionId, activeTwo.payload.playSessionId);
  assert.equal(sync.payload.positionRevision, 11);

  const adapter = createSyndocalEnvelopeV3Adapter({ token: TEST_TOKEN });
  const activeTwoFrame = adapter.encodeEvent({
    type: activeTwo.type,
    eventId: activeTwo.eventId,
    sequence: 1,
    payload: activeTwo.payload,
  });
  assertV3Frame(activeTwoFrame, "DJ_TRACK_ACTIVE");
  assert.deepEqual(activeTwoFrame.payload, activeTwo.payload);
  const syncFrame = adapter.encodeEvent({
    type: sync.type,
    eventId: sync.eventId,
    sequence: 2,
    payload: sync.payload,
  });
  assertV3Frame(syncFrame, "DJ_TRACK_SYNC");
  assert.deepEqual(syncFrame.payload, sync.payload);
});

test("stale explicit snapshot cannot roll back an explicit master-change authority fence", () => {
  let nextId = 0;
  let now = NOW;
  const detector = createTrackActivityDetector({
    now: () => now,
    idFactory: () => `authority-fence-${++nextId}`,
  });
  const events = [];
  detector.on("event", (event) => events.push(event));
  const authorityEvents = () => events.filter((event) => [
    "DJ_TRACK_ACTIVE",
    "DJ_TRACK_SYNC",
    "DJ_LOOP_STATE",
  ].includes(event.type));
  const deckSnapshot = (deck, positionRevision, positionSec) => ({
    deckNowPlaying: [{
      deck,
      contentId: `content-${deck}`,
      title: `Deck ${deck}`,
      artist: "DSF",
      trackBpm: deck === 1 ? 120 : 128,
    }],
    deckPlaybacks: [{
      deck,
      isPlaying: true,
      bpm: deck === 1 ? 120 : 128,
      positionSec,
      positionRevision,
      positionObservedAt: new Date(now).toISOString(),
    }],
  });
  const authorityAtOne = new Date(NOW).toISOString();
  const authorityAtTwo = new Date(NOW + 1).toISOString();
  const authorityAtThree = new Date(NOW + 2).toISOString();

  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: authorityAtOne,
    ...deckSnapshot(1, 1, 8),
  });
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: authorityAtOne,
    ...deckSnapshot(2, 1, 32),
  });
  assert.deepEqual(
    authorityEvents().map((event) => [event.type, event.payload.deck]),
    [["DJ_TRACK_ACTIVE", 1], ["DJ_TRACK_ACTIVE", 2]],
  );

  now = NOW + 1;
  detector.onMasterChange({ deck: 2, explicitMasterUpdatedAt: authorityAtTwo });
  assert.deepEqual(
    authorityEvents().map((event) => [event.type, event.payload.deck]),
    [
      ["DJ_TRACK_ACTIVE", 1],
      ["DJ_TRACK_ACTIVE", 2],
    ],
  );
  assert.equal(detector.getState().currentMasterDeck, 2);
  assert.equal(detector.getState().masterDeckRevision, 2);

  // This delayed MASTER diagnostic cannot replace deck 2, but its valid
  // per-deck playback and measured loop must still flow as generic events.
  const beforeStaleSnapshot = events.length;
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: authorityAtOne,
    ...deckSnapshot(1, 2, 9),
    loopStates: [{
      deck: 1,
      activeKnown: true,
      active: true,
      startBeat: 16,
      endBeat: 24,
      lengthBeats: 8,
      revision: 1,
      source: "rekordbox-hook",
      updatedAt: new Date(now).toISOString(),
    }],
  });
  assert.deepEqual(events.slice(beforeStaleSnapshot).map((event) => event.type), [
    "DJ_TRACK_SYNC",
    "DJ_LOOP_STATE",
  ]);
  assert.equal(detector.getState().currentMasterDeck, 2);
  assert.equal(detector.getState().explicitMasterDeck, 2);
  assert.equal(detector.getState().masterDeckRevision, 2);
  assert.equal(detector.getState().explicitMasterAuthorityRevision, 2);

  // A strictly newer explicit snapshot is an authority transition and can
  // activate deck 1 once; replaying that same authority is silent.
  now = NOW + 2;
  const newerDeckOne = {
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: authorityAtThree,
    ...deckSnapshot(1, 3, 10),
  };
  detector.onSnapshot(newerDeckOne);
  detector.onSnapshot(newerDeckOne);
  assert.deepEqual(
    authorityEvents().map((event) => [event.type, event.payload.deck]),
    [
      ["DJ_TRACK_ACTIVE", 1],
      ["DJ_TRACK_ACTIVE", 2],
      ["DJ_TRACK_SYNC", 1],
      ["DJ_LOOP_STATE", 1],
      ["DJ_TRACK_SYNC", 1],
    ],
  );
  assert.equal(detector.getState().currentMasterDeck, 1);
  assert.equal(detector.getState().masterDeckRevision, 3);
  assert.equal(detector.getState().explicitMasterAuthorityRevision, 3);
});

test("master-change rejects stale, equal, invalid, and future authority timestamps, then reset clears the fence", () => {
  let now = NOW + 100;
  const detector = createTrackActivityDetector({ now: () => now });
  const authorityAtOne = new Date(NOW).toISOString();

  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: authorityAtOne,
  });
  for (const explicitMasterUpdatedAt of [
    new Date(NOW - 1).toISOString(),
    authorityAtOne,
    "not-a-timestamp",
    new Date(now + 1).toISOString(),
  ]) {
    assert.equal(detector.onMasterChange({ deck: 2, explicitMasterUpdatedAt }), null);
    assert.equal(detector.getState().currentMasterDeck, 1);
    assert.equal(detector.getState().masterDeckRevision, 1);
    assert.equal(detector.getState().explicitMasterAuthorityRevision, 1);
  }
  detector.onSnapshot({
    explicitMasterDeck: 2,
    explicitMasterUpdatedAt: new Date(now + 1).toISOString(),
  });
  assert.equal(detector.getState().currentMasterDeck, 1);
  assert.equal(detector.getState().masterDeckRevision, 1);
  assert.equal(detector.getState().explicitMasterAuthorityRevision, 1);

  now += 2;
  const recoveredAt = new Date(now).toISOString();
  assert.equal(detector.onMasterChange({ deck: 2, explicitMasterUpdatedAt: recoveredAt }), null);
  assert.equal(detector.getState().currentMasterDeck, 2);
  assert.equal(detector.getState().masterDeckRevision, 2);
  assert.equal(detector.getState().explicitMasterAuthorityRevision, 2);

  detector.reset();
  assert.deepEqual(detector.getState(), {
    currentMasterDeck: null,
    masterDeckSource: "unknown",
    explicitMasterDeck: null,
    explicitMasterUpdatedAt: null,
    explicitMasterAuthorityRevision: 0,
    masterDeckRevision: 0,
    decks: {},
  });
  // Reset deliberately clears the prior high-water mark; this old-but-valid
  // source timestamp is therefore a new initial authority record.
  assert.equal(detector.onMasterChange({ deck: 1, explicitMasterUpdatedAt: authorityAtOne }), null);
  assert.equal(detector.getState().currentMasterDeck, 1);
  assert.equal(detector.getState().masterDeckRevision, 1);
});

test("missing explicit authority timestamps do not roll back MASTER diagnostics or suppress candidates", () => {
  let now = NOW;
  const detector = createTrackActivityDetector({ now: () => now });
  const authorityAtOne = new Date(NOW).toISOString();
  const authorityAtTwo = new Date(NOW + 1).toISOString();
  const events = [];
  detector.on("event", (event) => events.push(event));

  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: authorityAtOne,
    deckNowPlaying: [{ deck: 1, contentId: "one", title: "One", artist: "DSF" }],
    deckPlaybacks: [{
      deck: 1,
      isPlaying: true,
      bpm: 120,
      positionSec: 1,
      positionRevision: 1,
      positionObservedAt: authorityAtOne,
    }],
  });
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: authorityAtOne,
    deckNowPlaying: [{ deck: 2, contentId: "two", title: "Two", artist: "DSF" }],
    deckPlaybacks: [{
      deck: 2,
      isPlaying: true,
      bpm: 128,
      positionSec: 2,
      positionRevision: 1,
      positionObservedAt: authorityAtOne,
    }],
  });

  now = NOW + 1;
  detector.onMasterChange({ deck: 2, explicitMasterUpdatedAt: authorityAtTwo });
  assert.equal(detector.getState().currentMasterDeck, 2);
  assert.equal(detector.getState().masterDeckRevision, 2);
  const beforeRejected = events.length;

  // `updatedAt` is deliberately ignored. An empty explicit timestamp is not
  // a valid authority event and must not select deck 1.
  assert.equal(detector.onMasterChange({
    deck: 1,
    explicitMasterUpdatedAt: "",
    updatedAt: new Date(NOW + 2).toISOString(),
  }), null);
  assert.equal(detector.onMasterChange({ deck: 1 }), null);
  for (const explicitMasterUpdatedAt of [undefined, null, "   "]) {
    detector.onSnapshot({
      explicitMasterDeck: 1,
      explicitMasterUpdatedAt,
    deckNowPlaying: [{ deck: 1, contentId: "poison", title: "Poison", artist: "DSF" }],
    deckPlaybacks: [{
      deck: 1,
      isPlaying: true,
      bpm: 120,
      positionSec: 99,
      positionRevision: 99,
      positionObservedAt: new Date(now).toISOString(),
    }],
      loopStates: [{
        deck: 1,
        activeKnown: true,
        active: true,
        startBeat: 16,
        endBeat: 24,
        lengthBeats: 8,
        revision: 99,
        source: "rekordbox-hook",
        updatedAt: new Date(now).toISOString(),
      }],
    });
  }
  assert.equal(events.slice(beforeRejected).some((event) => event.type === "DJ_TRACK_LOADED"), true);
  assert.equal(detector.getState().currentMasterDeck, 2);
  assert.equal(detector.getState().masterDeckRevision, 2);
  assert.equal(detector.getState().decks[1].track.contentId, "poison");
  assert.equal(detector.getState().decks[1].playback.positionRevision, 99);
  assert.equal(detector.getState().decks[1].loop.revision, 99);
});

test("same-deck stale explicit MASTER leaves diagnostics fenced but ingests a valid candidate snapshot", () => {
  let now = NOW;
  const detector = createTrackActivityDetector({ now: () => now });
  const authorityAtOne = new Date(NOW).toISOString();
  const authorityAtTwo = new Date(NOW + 10).toISOString();
  const events = [];
  detector.on("event", (event) => events.push(event));

  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: authorityAtOne,
    deckNowPlaying: [{ deck: 1, contentId: "safe", title: "Safe", artist: "DSF", trackBpm: 120 }],
    deckPlaybacks: [{
      deck: 1,
      isPlaying: true,
      bpm: 120,
      positionSec: 1,
      positionRevision: 1,
      positionObservedAt: authorityAtOne,
    }],
  });
  now = NOW + 10;
  detector.onMasterChange({ deck: 1, explicitMasterUpdatedAt: authorityAtTwo });
  const beforeStale = events.length;

  const rejectedSnapshot = {
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: authorityAtOne,
    deckNowPlaying: [{ deck: 1, contentId: "stale", title: "Stale", artist: "DSF", trackBpm: 150 }],
    deckPlaybacks: [{
      deck: 1,
      isPlaying: true,
      bpm: 150,
      positionSec: 99,
      positionRevision: 99,
      positionObservedAt: new Date(now).toISOString(),
    }],
    loopStates: [{
      deck: 1,
      activeKnown: true,
      active: true,
      startBeat: 16,
      endBeat: 24,
      lengthBeats: 8,
      revision: 99,
      source: "rekordbox-hook",
      updatedAt: new Date(now).toISOString(),
    }],
  };
  detector.onSnapshot(rejectedSnapshot);
  const state = detector.getState();
  assert.equal(events.slice(beforeStale).some((event) => event.type === "DJ_TRACK_LOADED"), true);
  assert.equal(state.currentMasterDeck, 1);
  assert.equal(state.decks[1].track.contentId, "stale");
  assert.equal(state.decks[1].playback.positionRevision, 99);
  assert.equal(state.decks[1].loop.revision, 99);

  const beforeInvalid = events.length;
  detector.onSnapshot({ ...rejectedSnapshot, explicitMasterUpdatedAt: "not-a-timestamp" });
  assert.deepEqual(events.slice(beforeInvalid), []);
  assert.equal(detector.getState().decks[1].track.contentId, "stale");
  assert.equal(detector.getState().decks[1].playback.positionRevision, 99);
  assert.equal(detector.getState().decks[1].loop.revision, 99);
});

test("provider master-change and its equal immediate explicit snapshot preserve one authority transition", () => {
  let now = NOW;
  let nextId = 0;
  const detector = createTrackActivityDetector({
    now: () => now,
    idFactory: () => `provider-authority-${++nextId}`,
  });
  const events = [];
  detector.on("event", (event) => events.push(event));
  const authorityAt = new Date(now).toISOString();
  const deckTwo = {
    deckNowPlaying: [{ deck: 2, contentId: "two", title: "Two", artist: "DSF", trackBpm: 128 }],
    deckPlaybacks: [{
      deck: 2,
      isPlaying: true,
      bpm: 128,
      positionSec: 32,
      positionRevision: 1,
      positionObservedAt: authorityAt,
    }],
  };

  detector.onSnapshot({ masterDeck: 1, ...deckTwo });
  detector.onMasterChange({ deck: 2, explicitMasterUpdatedAt: authorityAt });
  detector.onSnapshot({
    explicitMasterDeck: 2,
    explicitMasterUpdatedAt: authorityAt,
    deckNowPlaying: deckTwo.deckNowPlaying,
    deckPlaybacks: [{
      ...deckTwo.deckPlaybacks[0],
      positionSec: 33,
      positionRevision: 2,
    }],
  });
  assert.deepEqual(
    events
      .filter((event) => event.type === "DJ_TRACK_ACTIVE" || event.type === "DJ_TRACK_SYNC")
      .map((event) => [event.type, event.payload.deck, event.payload.positionRevision]),
    [
      ["DJ_TRACK_ACTIVE", 2, 1],
      ["DJ_TRACK_SYNC", 2, 2],
    ],
  );
  assert.equal(detector.getState().currentMasterDeck, 2);
  assert.equal(detector.getState().masterDeckRevision, 2);
  assert.equal(detector.getState().decks[2].playback.positionRevision, 2);
});

test("late contentId enrichment preserves a session's frozen title/artist wire identity", () => {
  let nextId = 0;
  const detector = createTrackActivityDetector({ now: () => NOW, idFactory: () => `id-${++nextId}` });
  const events = [];
  detector.on("event", (event) => events.push(event));
  const playback = (positionRevision) => ({
    deck: 1,
    isPlaying: true,
    bpm: 120,
    positionSec: positionRevision,
    positionRevision,
    positionObservedAt: new Date(NOW).toISOString(),
  });

  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date(NOW).toISOString(),
    deckNowPlaying: [{ deck: 1, title: "Life Over" }],
    deckPlaybacks: [playback(1)],
  });
  const playSessionId = detector.getState().decks[1].playSessionId;
  assert.ok(playSessionId);
  assert.equal(events.some((event) => event.type === "DJ_TRACK_ACTIVE"), false);

  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date(NOW).toISOString(),
    deckNowPlaying: [{ deck: 1, title: "Life Over", artist: "DSF" }],
    deckPlaybacks: [playback(2)],
  });
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 1);
  const active = events.find((event) => event.type === "DJ_TRACK_ACTIVE");
  assert.equal(active.payload.playSessionId, playSessionId);
  assert.deepEqual(
    { title: active.payload.title, artist: active.payload.artist, contentId: active.payload.contentId },
    { title: "Life Over", artist: "DSF", contentId: undefined },
  );

  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date(NOW).toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "42", title: "Life Over", artist: "DSF" }],
    deckPlaybacks: [playback(3)],
  });
  assert.equal(detector.getState().decks[1].playSessionId, playSessionId);
  assert.equal(detector.getState().decks[1].track.contentId, "42", "enrichment remains available for diagnostics");
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 1);
  const sync = events.filter((event) => event.type === "DJ_TRACK_SYNC").at(-1);
  assert.deepEqual(
    { title: sync.payload.title, artist: sync.payload.artist, contentId: sync.payload.contentId },
    { title: "Life Over", artist: "DSF", contentId: undefined },
  );
  assert.equal(sync.payload.playSessionId, playSessionId);
});

test("contentId is authoritative while playback-fallback emits a candidate", () => {
  let nextId = 0;
  const detector = createTrackActivityDetector({ now: () => NOW, idFactory: () => `id-${++nextId}` });
  const events = [];
  detector.on("event", (event) => events.push(event));
  const playback = (revision, playing = true) => ({
    deck: 1,
    isPlaying: playing,
    bpm: 120,
    positionSec: revision,
    positionRevision: revision,
    positionObservedAt: new Date(NOW).toISOString(),
  });
  detector.onSnapshot({
    masterDeck: 1,
    masterDeckSource: "playback-fallback",
    deckNowPlaying: [{ deck: 1, contentId: "old", title: "Same", artist: "Artist", trackBpm: 120 }],
    deckPlaybacks: [playback(1)],
  });
  assert.equal(events.some((event) => event.type === "DJ_TRACK_ACTIVE"), true);
  const authorityAt = new Date(NOW).toISOString();
  detector.onMasterChange({ deck: 1, explicitMasterUpdatedAt: authorityAt });
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 1);
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: authorityAt,
    deckNowPlaying: [{ deck: 1, contentId: "new", title: "Same", artist: "Artist", trackBpm: 120 }],
    deckPlaybacks: [playback(2)],
  });
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 1);
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: authorityAt,
    deckPlaybacks: [playback(3, false)],
  });
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: authorityAt,
    deckNowPlaying: [{ deck: 1, contentId: "new", title: "Same", artist: "Artist", trackBpm: 120 }],
    deckPlaybacks: [playback(4, true)],
  });
  const active = events.filter((event) => event.type === "DJ_TRACK_ACTIVE");
  assert.equal(active.length, 2);
  assert.equal(active[1].payload.contentId, "new");
  assert.notEqual(active[0].payload.playSessionId, active[1].payload.playSessionId);
});

test("measured hook loop revisions 8/4/2 route without pedal-intent synthesis", () => {
  let nextId = 0;
  const detector = createTrackActivityDetector({ now: () => NOW, idFactory: () => `id-${++nextId}` });
  const events = [];
  detector.on("event", (event) => events.push(event));
  const snapshot = (positionRevision, loop) => ({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date(NOW).toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "42", title: "Life Over", artist: "DSF", trackBpm: 120 }],
    deckPlaybacks: [{
      deck: 1,
      isPlaying: true,
      bpm: 120,
      positionSec: positionRevision,
      positionRevision,
      positionObservedAt: new Date(NOW).toISOString(),
    }],
    loopStates: loop ? [{
      deck: 1,
      source: "rekordbox-hook",
      active: true,
      activeKnown: true,
      startBeat: 32,
      endBeat: 32 + loop.beats,
      lengthBeats: loop.beats,
      revision: loop.revision,
      updatedAt: new Date(NOW).toISOString(),
    }] : [],
  });
  detector.onSnapshot(snapshot(1, null));
  detector.onSnapshot({
    ...snapshot(2, null),
    loopStates: [{
      deck: 1,
      source: "rekordbox-hook-playback-observed",
      active: true,
      activeKnown: true,
      startBeat: 32,
      endBeat: 40,
      lengthBeats: 8,
      revision: 1,
      updatedAt: new Date(NOW).toISOString(),
    }],
  });
  assert.equal(events.some((event) => event.type === "DJ_LOOP_STATE"), false);
  detector.onSnapshot(snapshot(2, { beats: 8, revision: 1 }));
  detector.onSnapshot(snapshot(3, { beats: 4, revision: 2 }));
  detector.onSnapshot(snapshot(4, { beats: 2, revision: 3 }));
  assert.deepEqual(
    events.filter((event) => event.type === "DJ_LOOP_STATE").map((event) => event.payload.lengthBeats),
    [8, 4, 2],
  );
  assert.ok(events.filter((event) => event.type === "DJ_LOOP_STATE").every(
    (event) => event.payload.source === "rekordbox-hook-measured",
  ));
});

test("real Hook UDP snapshots deliver measured 8/4/2 loops with one fenced play session", async (t) => {
  const port = 48_000 + Math.floor(Math.random() * 1_000);
  const provider = createHookUdpProvider({ enabled: true, port });
  const detector = createTrackActivityDetector();
  const events = [];
  detector.on("event", (event) => events.push(event));
  provider.on("snapshot", (snapshot) => detector.onSnapshot(snapshot));
  provider.on("track-loaded", (event) => detector.onTrackLoaded(event));
  provider.on("master-change", (event) => detector.onMasterChange(event));
  t.after(() => provider.stop());

  const waitFor = (emitter, name, predicate, label) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      emitter.off(name, listener);
      reject(new Error(`Timed out waiting for ${label}`));
    }, 1_000);
    const listener = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timeout);
      emitter.off(name, listener);
      resolve(value);
    };
    emitter.on(name, listener);
  });

  const started = waitFor(
    provider,
    "status",
    (status) => status.message?.includes("listener started"),
    "Hook UDP listener",
  );
  provider.start();
  await started;

  const sender = dgram.createSocket("udp4");
  t.after(() => sender.close());
  const send = (packet) => new Promise((resolve, reject) => {
    sender.send(
      Buffer.from(JSON.stringify(packet)),
      port,
      "127.0.0.1",
      (error) => (error ? reject(error) : resolve()),
    );
  });
  const sendAndObserveSnapshot = async (packet) => {
    const observed = waitFor(provider, "snapshot", () => true, `snapshot for ${packet.type}:${packet.name || ""}`);
    await send(packet);
    return observed;
  };

  await sendAndObserveSnapshot({ type: "track_load", deck: 1, contentId: 42 });
  await sendAndObserveSnapshot({ type: "track_meta", deck: 1, contentId: 42, title: "Life Over", artist: "DSF" });
  await sendAndObserveSnapshot({ type: "olvc", deck: 1, name: "@OriginalBPM", value: 12_000 });
  await sendAndObserveSnapshot({ type: "olvc", deck: 1, name: "@BPM", value: 12_025 });
  await sendAndObserveSnapshot({ type: "olvc", deck: 1, name: "@CurrentTime", value: 12_500 });
  await sendAndObserveSnapshot({ type: "olvc", deck: 1, name: "@IsPlaying", value: 1 });

  const beforeMaster = detector.getState().decks[1];
  assert.equal(beforeMaster.track.contentId, "42");
  assert.equal(beforeMaster.track.title, "Life Over");
  assert.equal(beforeMaster.track.artist, "DSF");
  assert.equal(beforeMaster.playback.positionSec, 12.5);
  assert.equal(beforeMaster.playback.bpm, 120.25);
  assert.equal(beforeMaster.playback.isPlaying, true);
  assert.equal(beforeMaster.playback.positionRevision, 1);

  const active = events.find((event) => event.type === "DJ_TRACK_ACTIVE");
  assert.ok(active, "playing deck must emit a candidate before MASTER changes");
  await send({ type: "master_change", deck: 1 });
  assert.equal(events.filter((event) => event.type === "DJ_TRACK_ACTIVE").length, 1);
  assert.equal(active.payload.contentId, "42");
  assert.equal(active.payload.positionAtSendSec, 12.5);
  assert.equal(active.payload.effectiveBpm, 120.25);

  for (const [revision, lengthBeats] of [[1, 8], [2, 4], [3, 2]]) {
    const loopPromise = waitFor(
      detector,
      "event",
      (event) => event.type === "DJ_LOOP_STATE" && event.payload.lengthBeats === lengthBeats,
      `${lengthBeats}-beat measured loop`,
    );
    await send({
      type: "loop_state",
      deck: 1,
      active: true,
      startBeat: 32,
      endBeat: 32 + lengthBeats,
      lengthBeats,
      revision,
    });
    const loop = await loopPromise;
    assert.equal(loop.payload.playSessionId, active.payload.playSessionId);
    assert.equal(loop.payload.source, "rekordbox-hook-measured");
  }

  const loopOffPromise = waitFor(
    detector,
    "event",
    (event) => event.type === "DJ_LOOP_STATE" && event.payload.active === false,
    "measured loop-off",
  );
  await send({
    type: "loop_state",
    deck: 1,
    active: false,
    revision: 4,
  });
  const loopOff = await loopOffPromise;
  assert.equal(loopOff.payload.startBeat, null);
  assert.equal(loopOff.payload.endBeat, null);
  assert.equal(loopOff.payload.lengthBeats, null);

  assert.deepEqual(
    events.filter((event) => event.type === "DJ_LOOP_STATE").map((event) => event.payload.lengthBeats),
    [8, 4, 2, null],
  );
});

class V3WebSocket extends EventEmitter {
  static instances = [];
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    V3WebSocket.instances.push(this);
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

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function waitForEvent(emitter, name, predicate, { timeoutMs = 500, label = name } = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      emitter.off(name, onEvent);
      reject(new Error(`Timed out waiting for ${label}`));
    }, timeoutMs);
    const onEvent = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timeout);
      emitter.off(name, onEvent);
      resolve(value);
    };
    emitter.on(name, onEvent);
  });
}

test("pending ACTIVE fails closed on socket close and is not replayed", async (t) => {
  V3WebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: V3WebSocket,
    reconnectMinMs: 50,
    reconnectMaxMs: 50,
    heartbeatMs: 60_000,
    ackTimeoutMs: 2_000,
    stateSyncProvider: () => ({ released: false, ownerDeck: 1, ownerDeckId: "rekordbox-deck-1", activePlaySessionId: "play-session-1" }),
  });
  t.after(() => client.stop());
  const ignoredAcks = [];
  client.on("ack-ignored", (ack) => ignoredAcks.push(ack));
  client.start();
  await flush();
  const first = V3WebSocket.instances[0];
  const sent = client.sendEvent({
    type: "DJ_TRACK_ACTIVE",
    eventId: "active-reconnect",
    payload: strictTrackPayload(),
  });
  assert.equal(sent.state, "pending");
  const firstFrame = first.sent.find((frame) => frame.eventId === "active-reconnect");
  assertV3Frame(firstFrame, "DJ_TRACK_ACTIVE");
  const reconnect = waitForEvent(
    client,
    "connected",
    (event) => event?.generation === 2,
    { label: "ACTIVE reconnect" },
  );
  first.readyState = 3;
  first.emit("close", 1006, "test-reconnect");
  assert.equal(client.getStatus().pendingAcks, 0);
  assert.equal(client.getStatus().lastDelivery.state, "send-failed");
  assert.equal(client.getStatus().lastDelivery.reason, "connection-closed");
  first.emit("message", JSON.stringify({
    v: 3,
    type: "ACK",
    eventId: "active-reconnect",
    sequence: firstFrame.sequence,
    outcome: "accepted",
    code: null,
    stateGeneration: 1,
  }));
  assert.equal(client.getStatus().pendingAcks, 0, "a late ACK from the closed socket cannot revive ACTIVE");
  await reconnect;
  const second = V3WebSocket.instances[1];
  second.emit("message", JSON.stringify({
    v: 3,
    type: "ACK",
    eventId: "active-reconnect",
    sequence: firstFrame.sequence,
    outcome: "accepted",
    code: null,
    stateGeneration: 1,
  }));
  assert.equal(ignoredAcks.at(-1).reason, "unknown-or-stale");
  assert.equal(client.getStatus().pendingAcks, 0);
  assert.equal(second.sent.some((frame) => frame.type === "DJ_TRACK_ACTIVE"), false);
  assert.equal(second.sent.some((frame) => frame.eventId === "active-reconnect"), false);
});

test("candidate ACTIVE is ACK-tracked while candidate SYNC is transient telemetry", async (t) => {
  V3WebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: V3WebSocket,
    heartbeatMs: 60_000,
    ackTimeoutMs: 2_000,
    stateSyncProvider: () => ({ released: false }),
  });
  t.after(() => client.stop());
  client.start();
  await flush();
  const socket = V3WebSocket.instances[0];
  const active = client.sendEvent({
    type: "DJ_TRACK_ACTIVE",
    eventId: "candidate-active-physical",
    payload: strictCandidateTrackPayload(),
  });
  assert.equal(active.state, "pending");
  assert.equal(active.ackRequired, true);
  assert.equal(client.getStatus().physicalEventIdRegistrySize, 1);
  const activeFrame = socket.sent.find((frame) => frame.eventId === active.eventId);
  assertV3Frame(activeFrame, "DJ_TRACK_ACTIVE");
  socket.emit("message", JSON.stringify({
    v: 3,
    type: "ACK",
    eventId: active.eventId,
    sequence: active.sequence,
    outcome: "accepted",
    code: null,
    stateGeneration: 1,
  }));
  assert.equal(client.getStatus().lastDelivery.state, "acknowledged");

  const sync = client.sendEvent({
    type: "DJ_TRACK_SYNC",
    eventId: "candidate-sync-diagnostic-id",
    payload: strictCandidateTrackPayload({ positionRevision: 9 }),
  });
  assert.equal(sync.state, "acknowledged");
  assert.equal(sync.ackRequired, false);
  assert.equal(client.getStatus().physicalEventIdRegistrySize, 1);
  const syncFrame = socket.sent.find((frame) => frame.type === "DJ_TRACK_SYNC");
  assertV3Frame(syncFrame, "DJ_TRACK_SYNC");
  assert.ok(syncFrame.eventId.startsWith("telemetry-"));
});

test("pending beat jump fails closed on socket close and is not replayed", async (t) => {
  V3WebSocket.instances = [];
  let currentSession = "play-session-a";
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: V3WebSocket,
    reconnectMinMs: 50,
    reconnectMaxMs: 50,
    heartbeatMs: 60_000,
    ackTimeoutMs: 60_000,
    stateSyncProvider: () => ({ released: false, ownerDeck: 1, ownerDeckId: "rekordbox-deck-1", activePlaySessionId: currentSession }),
  });
  t.after(() => client.stop());
  const ignoredAcks = [];
  client.on("ack-ignored", (ack) => ignoredAcks.push(ack));
  client.start();
  await flush();
  const first = V3WebSocket.instances[0];
  const boundPayload = { bars: 4, timelineId: "life-over", playSessionId: currentSession };
  const queued = client.sendEvent({ type: "DJ_TIMELINE_BEAT_JUMP", payload: boundPayload });
  assert.equal(queued.state, "pending");
  const firstFrame = first.sent.find((frame) => frame.eventId === queued.eventId);
  assertV3Frame(firstFrame, "DJ_TIMELINE_BEAT_JUMP");
  currentSession = "play-session-b";
  const reconnect = waitForEvent(
    client,
    "connected",
    (event) => event?.generation === 2,
    { label: "queued beat jump reconnect" },
  );
  first.readyState = 3;
  first.emit("close", 1006, "session-replacement");
  assert.equal(client.getStatus().pendingAcks, 0);
  assert.equal(client.getStatus().lastDelivery.state, "send-failed");
  assert.equal(client.getStatus().lastDelivery.reason, "connection-closed");
  first.emit("message", JSON.stringify({
    v: 3,
    type: "ACK",
    eventId: queued.eventId,
    sequence: firstFrame.sequence,
    outcome: "accepted",
    code: null,
    stateGeneration: 1,
  }));
  assert.equal(client.getStatus().pendingAcks, 0, "a late ACK from the closed socket cannot revive a beat jump");
  await reconnect;
  const second = V3WebSocket.instances.at(-1);
  second.emit("message", JSON.stringify({
    v: 3,
    type: "ACK",
    eventId: queued.eventId,
    sequence: firstFrame.sequence,
    outcome: "accepted",
    code: null,
    stateGeneration: 1,
  }));
  assert.equal(ignoredAcks.at(-1).reason, "unknown-or-stale");
  assert.equal(client.getStatus().pendingAcks, 0);
  assert.equal(second.sent.some((frame) => frame.type === "DJ_TIMELINE_BEAT_JUMP"), false);
  assert.equal(second.sent.some((frame) => frame.eventId === queued.eventId), false);
});

test("pending absolute LOOP_SET fails closed on socket close and only a new manual edge may send after reconnect", async (t) => {
  V3WebSocket.instances = [];
  let currentSession = "play-session-a";
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: V3WebSocket,
    reconnectMinMs: 50,
    reconnectMaxMs: 50,
    heartbeatMs: 60_000,
    ackTimeoutMs: 60_000,
    stateSyncProvider: () => ({ released: false, ownerDeck: 1, ownerDeckId: "rekordbox-deck-1", activePlaySessionId: currentSession }),
  });
  t.after(() => client.stop());
  client.start();
  await flush();
  const first = V3WebSocket.instances[0];
  const queued = client.sendEvent({
    type: "DJ_TIMELINE_LOOP_SET",
    payload: { active: false, timelineId: "life-over", playSessionId: currentSession },
  });
  assert.equal(queued.state, "pending");
  const firstFrame = first.sent.find((frame) => frame.eventId === queued.eventId);
  assertV3Frame(firstFrame, "DJ_TIMELINE_LOOP_SET");

  currentSession = "play-session-b";
  const reconnect = waitForEvent(
    client,
    "connected",
    (event) => event?.generation === 2,
    { label: "queued LOOP_SET reconnect" },
  );
  first.readyState = 3;
  first.emit("close", 1006, "loop-set-connection-closed");
  assert.equal(client.getStatus().pendingAcks, 0);
  assert.equal(client.getStatus().lastDelivery.state, "send-failed");
  assert.equal(client.getStatus().lastDelivery.reason, "connection-closed");
  await reconnect;

  const second = V3WebSocket.instances.at(-1);
  assert.equal(second.sent.some((frame) => frame.eventId === queued.eventId), false);
  assert.equal(second.sent.some((frame) => frame.type === "DJ_TIMELINE_LOOP_SET"), false);

  // A changed session requires a new physical/manual edge; the client never
  // turns a reconnect into an automatic LOOP_SET replay.
  const freshManual = client.sendEvent({
    type: "DJ_TIMELINE_LOOP_SET",
    payload: { active: false, timelineId: "life-over", playSessionId: currentSession },
  });
  assert.equal(freshManual.state, "pending");
  const freshFrame = second.sent.find((frame) => frame.eventId === freshManual.eventId);
  assertV3Frame(freshFrame, "DJ_TIMELINE_LOOP_SET");
  assert.equal(freshFrame.payload.playSessionId, "play-session-b");
});

test("DJ_RELEASE reconnect retry preserves eventId/payload and fresh v3 session until terminal ACK", async (t) => {
  V3WebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: V3WebSocket,
    reconnectMinMs: 50,
    reconnectMaxMs: 50,
    heartbeatMs: 60_000,
    ackTimeoutMs: 2_000,
    stateSyncProvider: () => ({ released: false, ownerDeck: 1, ownerDeckId: "rekordbox-deck-1", activePlaySessionId: "play-session-1" }),
  });
  t.after(() => client.stop());
  const ignoredAcks = [];
  client.on("ack-ignored", (ack) => ignoredAcks.push(ack));
  client.start();
  await flush();
  const first = V3WebSocket.instances[0];
  const payload = { state: "released", timelineId: "life-over", playSessionId: "play-session-1" };
  const sent = client.sendEvent({
    type: "DJ_RELEASE",
    eventId: "release-reconnect",
    payload,
  });
  assert.equal(sent.state, "pending");
  const firstFrame = first.sent.find((frame) => frame.eventId === sent.eventId);
  assertV3Frame(firstFrame, "DJ_RELEASE");
  assert.deepEqual(firstFrame.payload, payload);

  const reconnect = waitForEvent(
    client,
    "connected",
    (event) => event?.generation === 2,
    { label: "DJ_RELEASE reconnect" },
  );
  first.readyState = 3;
  first.emit("close", 1006, "release-reconnect");
  assert.equal(client.getStatus().pendingAcks, 1);
  assert.equal(client.getStatus().lastDelivery.state, "retrying");
  assert.equal(client.getStatus().lastDelivery.reason, "connection-closed");
  await reconnect;

  const second = V3WebSocket.instances[1];
  const replay = second.sent.find((frame) => frame.eventId === sent.eventId);
  assertV3Frame(replay, "DJ_RELEASE");
  assert.equal(replay.eventId, firstFrame.eventId);
  assert.deepEqual(replay.payload, firstFrame.payload);
  assert.notEqual(replay.sessionId, firstFrame.sessionId);
  assert.notEqual(replay.sequence, firstFrame.sequence);

  // An ACK carrying the old socket's sequence after the new connection is
  // live must not consume the release retry or alter its new correlation.
  second.emit("message", JSON.stringify({
    v: 3,
    type: "ACK",
    eventId: sent.eventId,
    sequence: firstFrame.sequence,
    outcome: "accepted",
    code: null,
    stateGeneration: 1,
  }));
  assert.equal(ignoredAcks.at(-1).reason, "unknown-or-stale");
  assert.equal(client.getStatus().pendingAcks, 1);
  assert.equal(client.getStatus().lastDelivery.state, "pending");

  second.emit("message", JSON.stringify({
    v: 3,
    type: "ACK",
    eventId: sent.eventId,
    sequence: replay.sequence,
    outcome: "duplicate",
    code: null,
    stateGeneration: 2,
  }));
  assert.equal(client.getStatus().pendingAcks, 0);
  assert.equal(client.getStatus().lastDelivery.state, "acknowledged");
  assert.equal(client.getStatus().lastDelivery.ack.outcome, "duplicate");
});

test("correlated timeline snapshot terminalizes DJ_RELEASE without ACK and prevents replay", async (t) => {
  V3WebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: V3WebSocket,
    reconnectMinMs: 50,
    reconnectMaxMs: 50,
    heartbeatMs: 60_000,
    ackTimeoutMs: 60_000,
    stateSyncProvider: () => ({ released: false, ownerDeck: 1, ownerDeckId: "rekordbox-deck-1", activePlaySessionId: "play-session-1" }),
  });
  t.after(() => client.stop());
  const timelineStates = [];
  client.on("timeline-state", (state) => timelineStates.push(state));
  client.start();
  await flush();
  const first = V3WebSocket.instances[0];
  const payload = { state: "released", timelineId: "life-over", playSessionId: "play-session-1" };
  const release = client.sendEvent({ type: "DJ_RELEASE", eventId: "release-snapshot", payload });
  assert.equal(release.state, "pending");

  first.emit("message", JSON.stringify(strictTimelineState({
    pedalOwner: "timeline",
    timelineId: payload.timelineId,
    playSessionId: payload.playSessionId,
    releaseEventId: release.eventId,
  })));
  assert.equal(timelineStates.length, 1, "the snapshot remains available to the router");
  assert.equal(client.getStatus().pendingAcks, 0);
  assert.equal(client.getStatus().lastDelivery.state, "acknowledged");
  assert.equal(client.getStatus().lastDelivery.reason, "timeline-state-correlated");
  assert.equal(Object.hasOwn(client.getStatus().lastDelivery, "ack"), false);
  assert.equal(client.getStatus().lastAckResult, null, "snapshot correlation does not fabricate an ACK result");

  const reconnect = waitForEvent(
    client,
    "connected",
    (event) => event?.generation === 2,
    { label: "snapshot-correlated reconnect" },
  );
  first.readyState = 3;
  first.emit("close", 1006, "snapshot-correlated");
  await reconnect;
  const second = V3WebSocket.instances[1];
  assert.equal(second.sent.some((frame) => frame.eventId === release.eventId), false);
  assert.equal(second.sent.some((frame) => frame.type === "DJ_RELEASE"), false);
});

test("retired timeline session cannot terminalize DJ_RELEASE within a generation", async (t) => {
  V3WebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: V3WebSocket,
    reconnectMinMs: 50,
    reconnectMaxMs: 50,
    heartbeatMs: 60_000,
    ackTimeoutMs: 60_000,
    stateSyncProvider: () => ({ released: false }),
  });
  t.after(() => client.stop());
  const timelineStates = [];
  client.on("timeline-state", (state) => timelineStates.push(state));
  client.start();
  await flush();
  const first = V3WebSocket.instances[0];
  const emitTimelineState = (sessionId, sequence, overrides) => {
    first.emit("message", JSON.stringify({
      ...strictTimelineState(overrides),
      sessionId,
      sequence,
      eventId: `timeline-${sessionId}-${sequence}`,
    }));
  };

  emitTimelineState("session-a", 10, {
    timelineId: "timeline-a",
    playSessionId: "play-session-a",
    pedalOwner: "dj",
  });
  emitTimelineState("session-b", 1, {
    timelineId: "timeline-b",
    playSessionId: "play-session-b",
    pedalOwner: "dj",
  });
  assert.equal(timelineStates.length, 2);

  const payload = {
    state: "released",
    timelineId: "timeline-a",
    playSessionId: "play-session-a",
  };
  const release = client.sendEvent({ type: "DJ_RELEASE", eventId: "release-aba", payload });
  assert.equal(release.state, "pending");

  // A:9 exactly correlates with the Release, but A was retired by B:1. It
  // must not reach the router or terminalize the pending handoff.
  emitTimelineState("session-a", 9, {
    timelineId: payload.timelineId,
    playSessionId: payload.playSessionId,
    pedalOwner: "timeline",
    releaseEventId: release.eventId,
  });
  assert.equal(timelineStates.length, 2, "retired-session state is not forwarded");
  assert.equal(client.getStatus().pendingAcks, 1);
  assert.equal(client.getStatus().lastDelivery.state, "pending");

  emitTimelineState("session-b", 2, {
    timelineId: "timeline-b",
    playSessionId: "play-session-b",
    pedalOwner: "dj",
  });
  assert.equal(timelineStates.length, 3, "newer current-session state is accepted");
  assert.equal(client.getStatus().pendingAcks, 1);

  const reconnect = waitForEvent(
    client,
    "connected",
    (event) => event?.generation === 2,
    { label: "retired-session fence reconnect" },
  );
  first.readyState = 3;
  first.emit("close", 1006, "retired-session-fence");
  assert.equal(client.getStatus().pendingAcks, 1);
  await reconnect;

  // A is eligible again only because the socket generation was replaced.
  const second = V3WebSocket.instances[1];
  second.emit("message", JSON.stringify({
    ...strictTimelineState({
      timelineId: payload.timelineId,
      playSessionId: payload.playSessionId,
      pedalOwner: "timeline",
      releaseEventId: release.eventId,
    }),
    sessionId: "session-a",
    sequence: 1,
    eventId: "timeline-session-a-1-reconnect",
  }));
  assert.equal(client.getStatus().pendingAcks, 0);
  assert.equal(client.getStatus().lastDelivery.reason, "timeline-state-correlated");
  assert.equal(timelineStates.length, 4);
});

test("mismatched and stale timeline snapshots keep DJ_RELEASE pending for replay", async (t) => {
  V3WebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: V3WebSocket,
    reconnectMinMs: 50,
    reconnectMaxMs: 50,
    heartbeatMs: 60_000,
    ackTimeoutMs: 60_000,
    stateSyncProvider: () => ({ released: false, ownerDeck: 1, ownerDeckId: "rekordbox-deck-1", activePlaySessionId: "play-session-1" }),
  });
  t.after(() => client.stop());
  client.start();
  await flush();
  const first = V3WebSocket.instances[0];
  const payload = { state: "released", timelineId: "life-over", playSessionId: "play-session-1" };
  const release = client.sendEvent({ type: "DJ_RELEASE", eventId: "release-snapshot-mismatch", payload });
  assert.equal(release.state, "pending");

  const mismatched = strictTimelineState({
    pedalOwner: "timeline",
    timelineId: "foreign-timeline",
    playSessionId: payload.playSessionId,
    releaseEventId: release.eventId,
  });
  first.emit("message", JSON.stringify(mismatched));
  assert.equal(client.getStatus().pendingAcks, 1);
  assert.equal(client.getStatus().lastDelivery.state, "pending");

  // Same Syndocal session/sequence is stale even though this payload now
  // matches the release, so it cannot clear the pending handoff.
  first.emit("message", JSON.stringify(strictTimelineState({
    pedalOwner: "timeline",
    timelineId: payload.timelineId,
    playSessionId: payload.playSessionId,
    releaseEventId: release.eventId,
  })));
  assert.equal(client.getStatus().pendingAcks, 1);

  const reconnect = waitForEvent(
    client,
    "connected",
    (event) => event?.generation === 2,
    { label: "mismatched snapshot reconnect" },
  );
  first.readyState = 3;
  first.emit("close", 1006, "mismatched-snapshot");
  await reconnect;
  const second = V3WebSocket.instances[1];
  const replay = second.sent.find((frame) => frame.eventId === release.eventId);
  assertV3Frame(replay, "DJ_RELEASE");
  assert.deepEqual(replay.payload, payload);
});

test("current timeline request rejection exposes a sanitized control failure", async (t) => {
  V3WebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: V3WebSocket,
    heartbeatMs: 60_000,
    ackTimeoutMs: 60_000,
    stateSyncProvider: () => ({ released: false }),
  });
  t.after(() => client.stop());
  const warnings = [];
  const failures = [];
  const acks = [];
  client.on("warning", (warning) => warnings.push(warning));
  client.on("control-failure", (failure) => failures.push(failure));
  client.on("ack", (ack) => acks.push(ack));

  client.start();
  await flush();
  const socket = V3WebSocket.instances[0];
  const physicalRegistryBefore = client.getStatus().physicalEventIdRegistrySize;
  const publicRequest = client.sendEvent({ type: "DJ_TIMELINE_STATE_REQUEST" });
  assert.equal(publicRequest.type, "DJ_TIMELINE_STATE_REQUEST");
  assert.equal(publicRequest.ackRequired, false);
  const request = socket.sent.at(-1);
  assertV3Frame(request, "DJ_TIMELINE_STATE_REQUEST");
  assert.equal(request.eventId, publicRequest.eventId);
  assert.equal(request.sequence, publicRequest.sequence);
  socket.emit("message", JSON.stringify({
    v: 3,
    type: "ACK",
    eventId: request.eventId,
    sequence: request.sequence,
    outcome: "no_mapping",
    code: "project_mapping_not_loaded",
    stateGeneration: 1,
  }));

  const status = client.getStatus();
  assert.match(status.lastError, /project_mapping_not_loaded/);
  assert.equal(status.message, status.lastError);
  assert.equal(status.lastAckResult.eventId, request.eventId);
  assert.equal(status.lastAckResult.ok, false);
  assert.equal(status.lastAckResult.code, "project_mapping_not_loaded");
  assert.equal(warnings.at(-1).type, "DJ_TIMELINE_STATE_REQUEST");
  assert.equal(warnings.at(-1).code, "project_mapping_not_loaded");
  assert.equal(failures.at(-1).reason, "control-ack-failed");
  assert.equal(failures.at(-1).code, "project_mapping_not_loaded");
  assert.equal(acks.at(-1).control, true);
  assert.equal(acks.at(-1).ok, false);
  assert.equal(client.getStatus().pendingAcks, 0, "control ACKs never enter physical pending delivery");
  assert.equal(client.getStatus().physicalEventIdRegistrySize, physicalRegistryBefore, "control IDs never enter physical identity storage");
});

test("accepted timeline request ACK waits for current state and fences stale ACKs", async (t) => {
  V3WebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: V3WebSocket,
    heartbeatMs: 60_000,
    ackTimeoutMs: 60_000,
    stateSyncProvider: () => ({ released: false }),
  });
  t.after(() => client.stop());
  const timelineStates = [];
  const ignoredAcks = [];
  client.on("timeline-state", (state) => timelineStates.push(state));
  client.on("ack-ignored", (ack) => ignoredAcks.push(ack));

  client.start();
  await flush();
  const socket = V3WebSocket.instances[0];
  const physicalRegistryBefore = client.getStatus().physicalEventIdRegistrySize;
  const publicRequest = client.sendEvent({ type: "DJ_TIMELINE_STATE_REQUEST" });
  assert.equal(publicRequest.type, "DJ_TIMELINE_STATE_REQUEST");
  assert.equal(publicRequest.ackRequired, false);
  const request = socket.sent.at(-1);
  assertV3Frame(request, "DJ_TIMELINE_STATE_REQUEST");
  assert.equal(request.eventId, publicRequest.eventId);
  assert.equal(request.sequence, publicRequest.sequence);
  socket.emit("message", JSON.stringify({
    v: 3,
    type: "ACK",
    eventId: request.eventId,
    sequence: request.sequence,
    outcome: "accepted",
    code: null,
    stateGeneration: 1,
  }));
  assert.equal(client.getStatus().lastAckResult.state, "accepted");
  assert.equal(client.getStatus().message, "Syndocal timeline state request accepted; awaiting authoritative timeline state");
  assert.equal(timelineStates.length, 0, "accepted ACK alone is not a timeline snapshot");

  socket.emit("message", JSON.stringify({
    v: 3,
    type: "ACK",
    eventId: request.eventId,
    sequence: request.sequence - 1,
    outcome: "accepted",
    code: null,
    stateGeneration: 1,
  }));
  assert.equal(ignoredAcks.at(-1).reason, "unknown-or-stale");
  assert.equal(client.getStatus().lastAckResult.state, "accepted");
  socket.emit("message", JSON.stringify(strictTimelineState({ pedalOwner: "dj" })));
  assert.equal(timelineStates.length, 1, "the authoritative response reaches the router");

  // The response clears the request correlation; a duplicate control ACK is
  // now stale instead of being treated as a second current request result.
  socket.emit("message", JSON.stringify({
    v: 3,
    type: "ACK",
    eventId: request.eventId,
    sequence: request.sequence,
    outcome: "duplicate",
    code: null,
    stateGeneration: 1,
  }));
  assert.equal(ignoredAcks.at(-1).reason, "unknown-or-stale");
  assert.equal(client.getStatus().lastAckResult.state, "accepted");
  assert.equal(client.getStatus().physicalEventIdRegistrySize, physicalRegistryBefore);
});

test("pending non-release physical events fail closed across close and error teardown", async (t) => {
  const cases = [
    {
      type: "DJ_LOOP_STATE",
      payload: {
        deck: 1,
        deckId: "rekordbox-deck-1",
        playSessionId: "play-session-1",
        active: true,
        startBeat: 32,
        endBeat: 40,
        lengthBeats: 8,
        revision: 4,
        sampleAgeMs: 3,
        source: "rekordbox-hook-measured",
      },
      teardown: "close",
      reason: "connection-closed",
    },
    {
      type: "DJ_LOOP_FALLBACK",
      payload: {
        deck: 1,
        deckId: "rekordbox-deck-1",
        playSessionId: "play-session-1",
        pedalIntentId: 1,
        baseMeasuredLoopRevision: 4,
        baseLoopDivision: 0,
        targetLengthBeats: 4,
        responseWindowMs: 500,
        source: "pedal-no-response-predicted",
      },
      teardown: "close",
      reason: "connection-closed",
    },
    {
      type: "DJ_TIMELINE_LOOP_SET",
      payload: { active: true, timelineId: "life-over", playSessionId: "play-session-1" },
      teardown: "close",
      reason: "connection-closed",
    },
    {
      type: "DJ_TRACK_ACTIVE",
      payload: strictTrackPayload(),
      teardown: "error",
      reason: "connection-error",
    },
  ];
  const clients = [];
  t.after(() => clients.forEach((client) => client.stop()));

  for (const [index, testCase] of cases.entries()) {
    V3WebSocket.instances = [];
    const client = createSyndocalClient({
      enabled: true,
      token: TEST_TOKEN,
      adapter: "syndocal-envelope-v3",
      WebSocketImpl: V3WebSocket,
      reconnectMinMs: 20,
      reconnectMaxMs: 20,
      heartbeatMs: 60_000,
      ackTimeoutMs: 60_000,
      stateSyncProvider: () => ({ released: false, ownerDeck: 1, ownerDeckId: "rekordbox-deck-1", activePlaySessionId: "play-session-1" }),
    });
    clients.push(client);
    client.start();
    await flush();
    const first = V3WebSocket.instances[0];
    const eventId = `teardown-${index}`;
    const sent = client.sendEvent({ type: testCase.type, eventId, payload: testCase.payload });
    assert.equal(sent.state, "pending");
    const reconnect = waitForEvent(
      client,
      "connected",
      (event) => event?.generation === 2,
      { label: `${testCase.type} ${testCase.teardown} reconnect` },
    );
    first.readyState = 3;
    if (testCase.teardown === "error") {
      first.emit("error", new Error("test-error"));
    } else {
      first.emit("close", 1006, "test-close");
    }
    assert.equal(client.getStatus().pendingAcks, 0);
    assert.equal(client.getStatus().lastDelivery.state, "send-failed");
    assert.equal(client.getStatus().lastDelivery.reason, testCase.reason);
    await reconnect;
    const second = V3WebSocket.instances[1];
    assert.equal(second.sent.some((frame) => frame.eventId === eventId), false);
    assert.equal(second.sent.some((frame) => frame.type === testCase.type), false);
  }
});

test("stopping a pending DJ_RELEASE terminates it without reconnect replay", async (t) => {
  V3WebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: V3WebSocket,
    reconnectMinMs: 20,
    reconnectMaxMs: 20,
    heartbeatMs: 60_000,
    ackTimeoutMs: 60_000,
    stateSyncProvider: () => ({ released: false, ownerDeck: 1, ownerDeckId: "rekordbox-deck-1", activePlaySessionId: "play-session-1" }),
  });
  t.after(() => client.stop());
  client.start();
  await flush();
  const first = V3WebSocket.instances[0];
  const release = client.sendEvent({
    type: "DJ_RELEASE",
    eventId: "release-stop",
    payload: { state: "released", timelineId: "life-over", playSessionId: "play-session-1" },
  });
  assert.equal(release.state, "pending");
  client.stop();
  assert.equal(client.getStatus().pendingAcks, 0);
  assert.equal(client.getStatus().lastDelivery.state, "send-failed");
  assert.equal(client.getStatus().lastDelivery.reason, "stopped");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(V3WebSocket.instances.length, 1);
  assert.equal(first.sent.filter((frame) => frame.type === "DJ_RELEASE").length, 1);
});

test("durable physical event IDs are single-use and caller sequence reorder fails closed", async (t) => {
  V3WebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: V3WebSocket,
    heartbeatMs: 60_000,
    stateSyncProvider: () => ({ released: false, ownerDeck: 1, ownerDeckId: "rekordbox-deck-1", activePlaySessionId: "play-session-1" }),
  });
  t.after(() => client.stop());
  client.start();
  await flush();
  const socket = V3WebSocket.instances[0];
  const first = client.sendEvent({
    type: "DJ_RELEASE",
    eventId: "release-single-use",
    payload: { state: "released", timelineId: "life-over", playSessionId: "play-session-1" },
  });
  assert.equal(first.state, "pending");
  const duplicate = client.sendEvent({
    type: "DJ_RELEASE",
    eventId: "release-single-use",
    payload: { state: "released", timelineId: "life-over", playSessionId: "play-session-1" },
  });
  assert.equal(duplicate.reason, "event-id-reused");
  const reordered = client.sendEvent({
    type: "DJ_RELEASE",
    eventId: "release-reordered",
    sequence: first.sequence,
    payload: { state: "released", timelineId: "life-over", playSessionId: "play-session-1" },
  });
  assert.equal(reordered.reason, "sequence-rollback");
  assert.equal(socket.sent.filter((frame) => frame.type === "DJ_RELEASE").length, 1);
});

test("continuous TRACK_SYNC exceeds the durable ID budget without storage, replay, or stale-session bleed", async (t) => {
  class EnduranceWebSocket extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.readyState = 0;
      this.controlFrames = [];
      this.syncCount = 0;
      this.firstSync = null;
      this.lastSync = null;
      EnduranceWebSocket.instances.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }

    send(value) {
      const frame = JSON.parse(value);
      if (frame.type === "DJ_TRACK_SYNC") {
        this.syncCount += 1;
        this.firstSync ||= frame;
        this.lastSync = frame;
      } else {
        this.controlFrames.push(frame);
      }
    }

    close() {
      this.readyState = 3;
    }
  }

  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: EnduranceWebSocket,
    reconnectMinMs: 50,
    reconnectMaxMs: 50,
    heartbeatMs: 60_000,
    ackTimeoutMs: 10_000,
    eventIdRegistryMax: 1,
    stateSyncProvider: () => ({
      released: false,
      ownerDeck: 1,
      ownerDeckId: "rekordbox-deck-1",
      activePlaySessionId: "play-session-1",
    }),
  });
  t.after(() => client.stop());
  client.start();
  await flush();
  const first = EnduranceWebSocket.instances[0];
  const payload = strictTrackPayload();
  let lastResult = null;
  const syncEmissionCount = 262_145;
  for (let revision = 1; revision <= syncEmissionCount; revision += 1) {
    payload.positionRevision = revision;
    lastResult = client.sendEvent({
      type: "DJ_TRACK_SYNC",
      // Detector IDs are diagnostic inputs for transient telemetry; the wire
      // uses its own generation+sequence identity and keeps no durable set.
      eventId: "reused-detector-sync-id",
      payload,
    });
  }
  assert.equal(lastResult.state, "acknowledged");
  assert.equal(lastResult.ackRequired, false);
  assert.equal(first.syncCount, syncEmissionCount);
  assert.equal(first.firstSync.eventId.startsWith("telemetry-"), true);
  assert.equal(first.lastSync.eventId.startsWith("telemetry-"), true);
  assert.notEqual(first.firstSync.eventId, first.lastSync.eventId);
  assert.ok(first.lastSync.sequence > first.firstSync.sequence);
  assert.equal(client.getStatus().physicalEventIdRegistrySize, 0);
  assert.equal(client.getStatus().physicalEventIdLatched, false);

  const durable = client.sendEvent({
    type: "DJ_RELEASE",
    eventId: "durable-release-after-sync-endurance",
    payload: { state: "released", timelineId: "life-over", playSessionId: "play-session-1" },
  });
  assert.equal(durable.state, "pending");
  assert.equal(client.getStatus().physicalEventIdRegistrySize, 1);
  assert.equal(client.getStatus().physicalEventIdLatched, true);
  payload.positionRevision += 1;
  assert.equal(client.sendEvent({
    type: "DJ_TRACK_SYNC",
    eventId: "reused-detector-sync-id",
    payload,
  }).state, "acknowledged");
  const firstCountBeforeReconnect = first.syncCount;
  const firstSessionId = first.lastSync.sessionId;

  const reconnect = waitForEvent(
    client,
    "connected",
    (event) => event?.generation === 2,
    { label: "TRACK_SYNC endurance reconnect" },
  );
  first.readyState = 3;
  first.emit("close", 1006, "endurance-reconnect");
  await reconnect;
  const second = EnduranceWebSocket.instances[1];
  assert.equal(second.syncCount, 0);
  assert.equal(first.syncCount, firstCountBeforeReconnect);
  const durableReplay = second.controlFrames.find((frame) => frame.eventId === durable.eventId);
  assertV3Frame(durableReplay, "DJ_RELEASE");
  assert.equal(durableReplay.payload.playSessionId, "play-session-1");

  payload.positionRevision += 1;
  const postReconnect = client.sendEvent({
    type: "DJ_TRACK_SYNC",
    eventId: "reused-detector-sync-id",
    payload,
  });
  assert.equal(postReconnect.state, "acknowledged");
  assert.equal(second.syncCount, 1);
  assert.notEqual(second.lastSync.sessionId, firstSessionId);
  assert.notEqual(second.lastSync.eventId, first.lastSync.eventId);
  assert.ok(second.lastSync.sequence > first.lastSync.sequence);
  assert.equal(first.syncCount, firstCountBeforeReconnect);
  assert.equal(client.getStatus().physicalEventIdRegistrySize, 1);
});

test("inbound flat/v1/v2 frames are visible protocol failures and v3 timeline state is exact", async (t) => {
  V3WebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: V3WebSocket,
    heartbeatMs: 60_000,
    stateSyncProvider: () => ({ released: false }),
  });
  t.after(() => client.stop());
  const failures = [];
  const states = [];
  const warnings = [];
  client.on("protocol-failure", (failure) => failures.push(failure));
  client.on("timeline-state", (state) => states.push(state));
  client.on("warning", (warning) => warnings.push(warning));
  client.start();
  await flush();
  const socket = V3WebSocket.instances[0];
  socket.emit("message", JSON.stringify({ type: "ACK", eventId: "flat" }));
  socket.emit("message", JSON.stringify({ v: 1, type: "ACK", eventId: "v1" }));
  socket.emit("message", JSON.stringify({ v: 2, type: "ACK", eventId: "retired-v2" }));
  socket.emit("message", JSON.stringify(strictTimelineState()));
  assert.deepEqual(failures.map((failure) => failure.reason), [
    "strict-envelope-v3-required",
    "retired-protocol-v1-or-v2",
    "retired-protocol-v1-or-v2",
  ]);
  assert.equal(states.length, 1);
  assert.equal(states[0].playSessionId, "play-session-1");
  assert.equal(states[0].transitionHoldActive, false);
  // The decoded state exposes authoritative session identity and the
  // monotonic per-session sequence so the router can fence same-session
  // stale/equal replays without inventing any defaults.
  assert.equal(states[0].sessionId, "syndocal-session");
  assert.equal(states[0].sequence, 1);
  assert.equal(states[0].eventId, "timeline-state-1");
  const decoded = decodeV3TimelineState({
    ...strictTimelineState(),
    sequence: 9,
    eventId: "timeline-state-9",
  });
  assert.equal(decoded.sessionId, "syndocal-session");
  assert.equal(decoded.sequence, 9);
  assert.equal(decoded.eventId, "timeline-state-9");
  assert.equal(decodeV3TimelineState({ ...strictTimelineState(), bonus: true }), null);
  const missingTransitionHold = strictTimelineState();
  delete missingTransitionHold.payload.transitionHoldActive;
  assert.equal(decodeV3TimelineState(missingTransitionHold), null);
  assert.equal(decodeV3TimelineState(strictTimelineState({ transitionHoldActive: "true" })), null);
  assert.equal(decodeV3TimelineState(strictTimelineState({ transitionHoldActive: false, extra: true })), null);

  // The public transport warning names the new strict field, rather than
  // leaving an operator to infer why an otherwise valid-looking v3 state was
  // rejected. Neither missing nor non-boolean values may reach the router.
  socket.emit("message", JSON.stringify(missingTransitionHold));
  socket.emit("message", JSON.stringify(strictTimelineState({ transitionHoldActive: "true" })));
  assert.equal(states.length, 1);
  assert.deepEqual(warnings.map((warning) => warning.message), [
    "Invalid DJ_TIMELINE_STATE ignored; expected state, boolean loopActive, and required boolean transitionHoldActive",
    "Invalid DJ_TIMELINE_STATE ignored; expected state, boolean loopActive, and required boolean transitionHoldActive",
  ]);
  assert.equal(
    client.getStatus().lastError,
    "Invalid DJ_TIMELINE_STATE ignored; expected state, boolean loopActive, and required boolean transitionHoldActive",
  );
});

test("v3 timeline state accepts idle pedalOwner null and rejects unknown ownership", () => {
  const idle = decodeV3TimelineState(strictTimelineState({
    state: "idle",
    timelineId: null,
    positionBars: 0,
    playSessionId: null,
    pedalOwner: null,
    releaseEventId: null,
  }));
  assert.ok(idle);
  assert.equal(idle.state, "idle");
  assert.equal(idle.pedalOwner, null);

  const timeline = decodeV3TimelineState(strictTimelineState({
    pedalOwner: "timeline",
    releaseEventId: "release-1",
  }));
  assert.ok(timeline);
  assert.equal(timeline.pedalOwner, "timeline");

  assert.equal(decodeV3TimelineState(strictTimelineState({
    state: "idle",
    timelineId: null,
    positionBars: 0,
    playSessionId: null,
    pedalOwner: "timeline",
    releaseEventId: "release-1",
  })), null);
  assert.equal(decodeV3TimelineState(strictTimelineState({
    state: "idle",
    timelineId: null,
    positionBars: 0,
    playSessionId: "play-session-1",
    pedalOwner: "timeline",
    releaseEventId: null,
  })), null);
  assert.equal(decodeV3TimelineState(strictTimelineState({ pedalOwner: "rekordbox" })), null);
});

test("ACK v3 schema rejects missing, extra, stale, and nonfinite fields", () => {
  const valid = {
    v: 3,
    type: "ACK",
    eventId: "event-1",
    sequence: 3,
    outcome: "accepted",
    code: null,
    stateGeneration: 1,
  };
  assert.equal(validateEnvelopeV3Ack(valid).valid, true);
  for (const invalid of [
    { ...valid, v: 1 },
    { ...valid, sequence: Number.NaN },
    { ...valid, stateGeneration: -1 },
    { ...valid, outcome: "ok" },
    { ...valid, extra: true },
    { ...valid, eventId: " event-1" },
  ]) assert.equal(validateEnvelopeV3Ack(invalid).valid, false);
});

function createFakeRouter() {
  const timerTasks = [];
  const timerApi = {
    setTimeout(callback, delayMs) {
      const task = { callback, delayMs, cleared: false };
      timerTasks.push(task);
      return task;
    },
    clearTimeout(task) {
      task.cleared = true;
    },
    runNext() {
      const task = timerTasks
        .filter((entry) => !entry.cleared)
        .sort((left, right) => left.delayMs - right.delayMs)[0];
      assert.ok(task, "expected a scheduled router timer");
      task.cleared = true;
      task.callback();
    },
  };
  const detector = new EventEmitter();
  detector.state = {
    currentMasterDeck: 1,
    masterDeckSource: "explicit",
    decks: { 1: { track: null, playSessionId: "play-session-1" } },
  };
  detector.getState = () => detector.state;
  detector.onSnapshot = () => detector.state;
  detector.onTrackLoaded = () => null;
  detector.onMasterChange = () => null;
  const client = new EventEmitter();
  client.status = { enabled: true, state: "connected" };
  client.getStatus = () => ({ ...client.status });
  client.sent = [];
  client.sendEvent = (event) => {
    client.sent.push(event);
    return {
      eventId: event.eventId || `sent-${client.sent.length}`,
      type: event.type,
      state: "pending",
      ackState: "pending",
      ok: false,
      sent: true,
    };
  };
  client.start = () => {};
  client.stop = () => {};
  const midi = {
    sent: [],
    resolveTarget: (_mapping, deck) => ({ targetDeck: deck, targetChannel: 1 }),
    sendMapping(mapping) { this.sent.push(mapping); return true; },
    startFilterRamp(options) {
      this.sent.push("filterRamp");
      return { started: true, ok: true, targetDeck: options.targetDeck, targetChannel: 1 };
    },
    startReleaseFade(options) {
      this.sent.push("releaseFade");
      return { started: true, ok: true, targetDeck: options.targetDeck, targetChannel: 1 };
    },
    resetReleaseFade() { return { ok: true, value: 127 }; },
    cancelFilterRamp() {},
    cancelReleaseFade() {},
    getStatus: () => ({}),
    start() {},
    stop() {},
  };
  const pedal = { start() {}, stop() {}, getStatus: () => ({}) };
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal,
    releaseMacro: EXACT_RELEASE_MACRO,
    releaseFade: EXACT_RELEASE_FADE,
    timerApi,
    now: () => NOW,
  });
  return { detector, client, midi, router, timerApi };
}

test("router admits one per-deck candidate only after terminal ACTIVE ACK", () => {
  const { detector, client, router } = createFakeRouter();
  detector.emit("event", {
    type: "DJ_TRACK_ACTIVE",
    eventId: "candidate-active-route",
    payload: strictCandidateTrackPayload(),
  });
  assert.deepEqual(client.sent.map((event) => event.type), ["DJ_TRACK_ACTIVE"]);
  assert.equal(router.getStateSync().ownerDeck, null);
  client.emit("delivery", {
    eventId: "candidate-active-route",
    type: "DJ_TRACK_ACTIVE",
    state: "acknowledged",
    ack: { outcome: "accepted" },
  });
  detector.emit("event", {
    type: "DJ_TRACK_SYNC",
    eventId: "candidate-sync-route",
    payload: strictCandidateTrackPayload({ positionRevision: 9 }),
  });
  assert.deepEqual(client.sent.map((event) => event.type), ["DJ_TRACK_ACTIVE", "DJ_TRACK_SYNC"]);
  assert.equal(router.getStateSync().ownerDeck, 2);
  assert.equal(router.getStateSync().ownerDeckId, "rekordbox-deck-2");
  assert.equal(router.getStateSync().activePlaySessionId, "candidate-session-2");
  assert.equal(router.getStatus().mode, "dj-control");
});

test("router fences foreign same-session identity on SYNC and reannouncement", () => {
  const { detector, client, router } = createFakeRouter();
  const owner = strictCandidateTrackPayload({
    contentId: undefined,
    title: "Life Over",
    artist: "DSF",
  });
  delete owner.contentId;
  detector.emit("event", {
    type: "DJ_TRACK_ACTIVE",
    eventId: "owner-text-active",
    payload: owner,
  });
  client.emit("delivery", {
    eventId: "owner-text-active",
    type: "DJ_TRACK_ACTIVE",
    state: "acknowledged",
    ack: { outcome: "accepted" },
  });
  const admittedBefore = router.getStateSync().admittedTrack;
  const sentBeforeForeign = client.sent.length;
  const lateContent = strictCandidateTrackPayload({
    contentId: "42",
    playSessionId: owner.playSessionId,
    positionRevision: owner.positionRevision + 1,
  });

  detector.emit("event", {
    type: "DJ_TRACK_SYNC",
    eventId: "foreign-identity-sync",
    payload: lateContent,
  });
  detector.emit("event", {
    type: "DJ_TRACK_ACTIVE",
    eventId: "foreign-identity-reannounce",
    payload: lateContent,
  });

  assert.equal(client.sent.length, sentBeforeForeign, "foreign identity must not route");
  assert.deepEqual(router.getStateSync().admittedTrack, admittedBefore, "foreign identity must not mutate owner");
  assert.equal(router.getStateSync().activePlaySessionId, owner.playSessionId);
});

test("router flushes an initial measured loop after delayed candidate ACTIVE ACK", () => {
  const { detector, client } = createFakeRouter();
  const candidate = strictCandidateTrackPayload({
    loop: { active: true, startBeat: 32, endBeat: 40, lengthBeats: 8, revision: 1, sampleAgeMs: 0, source: "rekordbox-hook-measured" },
  });
  const measuredLoop = {
    deck: candidate.deck,
    deckId: candidate.deckId,
    playSessionId: candidate.playSessionId,
    active: true,
    startBeat: 32,
    endBeat: 40,
    lengthBeats: 8,
    revision: 1,
    sampleAgeMs: 0,
    source: "rekordbox-hook-measured",
  };
  let flushes = 0;
  detector.requestMeasuredLoopForSession = (owner) => {
    flushes += 1;
    assert.deepEqual(owner, {
      deck: candidate.deck,
      deckId: candidate.deckId,
      playSessionId: candidate.playSessionId,
    });
    detector.emit("event", { type: "DJ_LOOP_STATE", eventId: "initial-loop", payload: measuredLoop });
  };
  detector.emit("event", { type: "DJ_TRACK_ACTIVE", eventId: "candidate-active", payload: candidate });
  assert.deepEqual(client.sent.map((event) => event.type), ["DJ_TRACK_ACTIVE"]);

  client.emit("delivery", {
    eventId: "candidate-active",
    type: "DJ_TRACK_ACTIVE",
    state: "acknowledged",
    ack: { outcome: "duplicate" },
  });

  assert.equal(flushes, 1);
  assert.deepEqual(client.sent.map((event) => event.type), ["DJ_TRACK_ACTIVE", "DJ_LOOP_STATE"]);
  assert.deepEqual(client.sent[1].payload, measuredLoop);
  assert.equal(Object.hasOwn(client.sent[1].payload, "masterDeckRevision"), false);
});

test("router fails closed for unaccepted, malformed, competing, and released candidates", () => {
  const { detector, client, router, timerApi } = createFakeRouter();
  const candidate = (suffix, deck = 2) => strictCandidateTrackPayload({
    deck,
    deckId: `rekordbox-deck-${deck}`,
    playSessionId: `candidate-session-${suffix}`,
  });
  for (const [eventId, delivery] of [
    ["no-mapping", { state: "acknowledged", ack: { outcome: "no_mapping" } }],
    ["rejected", { state: "acknowledged", ack: { outcome: "rejected" } }],
    ["busy", { state: "acknowledged", ack: { outcome: "busy" } }],
    ["timeout", { state: "timed_out" }],
  ]) {
    detector.emit("event", { type: "DJ_TRACK_ACTIVE", eventId, payload: candidate(eventId) });
    client.emit("delivery", { eventId, type: "DJ_TRACK_ACTIVE", ...delivery });
    assert.equal(router.getStateSync().ownerDeck, null, `${eventId} must not admit ownership`);
  }

  const owner = candidate("owner", 2);
  detector.emit("event", { type: "DJ_TRACK_ACTIVE", eventId: "accepted-owner", payload: owner });
  client.emit("delivery", {
    eventId: "accepted-owner",
    type: "DJ_TRACK_ACTIVE",
    state: "acknowledged",
    ack: { outcome: "accepted" },
  });
  assert.equal(router.getStateSync().ownerDeck, 2);

  const competitor = candidate("competitor", 3);
  detector.emit("event", { type: "DJ_TRACK_ACTIVE", eventId: "accepted-competitor", payload: competitor });
  client.emit("delivery", {
    eventId: "accepted-competitor",
    type: "DJ_TRACK_ACTIVE",
    state: "acknowledged",
    ack: { outcome: "duplicate" },
  });
  assert.equal(router.getStateSync().ownerDeck, 2, "a concurrent candidate cannot steal ownership");

  const sentBeforeMalformed = client.sent.length;
  assert.doesNotThrow(() => detector.emit("event", { type: "DJ_TRACK_SYNC", eventId: "bad-sync", payload: {} }));
  assert.doesNotThrow(() => detector.emit("event", { type: "DJ_LOOP_STATE", eventId: "bad-loop", payload: {} }));
  assert.equal(client.sent.length, sentBeforeMalformed);

  router.triggerAction("release");
  timerApi.runNext();
  assert.equal(router.getStateSync().released, true);
  client.emit("delivery", {
    eventId: "accepted-owner",
    type: "DJ_TRACK_ACTIVE",
    state: "acknowledged",
    ack: { outcome: "accepted" },
  });
  assert.equal(router.getStateSync().released, true, "a late ACTIVE ACK cannot reacquire a released session");
});

test("router reannounces fresh candidates only after each connection's timeline-state gate", () => {
  const { detector, client } = createFakeRouter();
  const candidate = strictCandidateTrackPayload();
  let reannounceCalls = 0;
  detector.requestCurrentTrackCandidates = () => {
    reannounceCalls += 1;
    detector.emit("event", { type: "DJ_TRACK_ACTIVE", eventId: "reannounce-active", payload: candidate });
  };

  // The initial connection can follow an already-playing Rekordbox session.
  // It must be treated exactly like a reconnect, rather than assuming the
  // first pre-open send was retained by the receiver.
  assert.equal(reannounceCalls, 0);
  client.emit("timeline-state", { state: "idle", loopActive: false, transitionHoldActive: false });
  assert.equal(reannounceCalls, 1);
  assert.deepEqual(client.sent.map((event) => event.type), ["DJ_TRACK_ACTIVE"]);
  assert.equal(Object.hasOwn(client.sent[0].payload, "master"), false);

  client.emit("timeline-state", { state: "idle", loopActive: false, transitionHoldActive: false });
  assert.equal(reannounceCalls, 1, "one connection may request candidates only once");

  client.sent.length = 0;
  client.emit("status", { enabled: true, state: "disconnected", connectionGeneration: 1 });
  client.emit("status", { enabled: true, state: "connected", connectionGeneration: 2 });
  assert.equal(reannounceCalls, 1);
  client.emit("timeline-state", { state: "idle", loopActive: false, transitionHoldActive: false });
  assert.equal(reannounceCalls, 2);
  assert.deepEqual(client.sent.map((event) => event.type), ["DJ_TRACK_ACTIVE"]);
});

test("router retires prior timeline sessions within one connection generation", () => {
  const { client, router } = createFakeRouter();
  const emitTimelineState = (sessionId, sequence, overrides = {}) => {
    client.emit("timeline-state", {
      state: "running",
      loopActive: false,
      transitionHoldActive: false,
      timelineId: `timeline-${sessionId}`,
      positionBars: sequence,
      playSessionId: `play-${sessionId}`,
      pedalOwner: "dj",
      releaseEventId: null,
      sessionId,
      sequence,
      ...overrides,
    });
  };

  client.emit("status", { enabled: true, state: "connected", connectionGeneration: 1 });
  emitTimelineState("session-a", 10);
  assert.equal(router.getStatus().timelineId, "timeline-session-a");

  emitTimelineState("session-b", 1);
  assert.equal(router.getStatus().timelineId, "timeline-session-b");
  assert.equal(router.getStatus().timelinePlaySessionId, "play-session-b");

  const beforeRetired = router.getStatus();
  emitTimelineState("session-a", 9, {
    timelineId: "timeline-a-retired-replay",
    playSessionId: "play-a-retired-replay",
    pedalOwner: "timeline",
    releaseEventId: "release-aba",
  });
  const afterRetired = router.getStatus();
  assert.equal(afterRetired.timelineId, beforeRetired.timelineId);
  assert.equal(afterRetired.timelinePlaySessionId, beforeRetired.timelinePlaySessionId);
  assert.equal(afterRetired.timelinePedalOwner, beforeRetired.timelinePedalOwner);
  assert.equal(afterRetired.timelineReleaseEventId, beforeRetired.timelineReleaseEventId);

  emitTimelineState("session-b", 2, { timelineId: "timeline-session-b-current" });
  assert.equal(router.getStatus().timelineId, "timeline-session-b-current");
  assert.equal(router.getStatus().timelinePositionBars, 2);

  client.emit("status", { enabled: true, state: "disconnected", connectionGeneration: 1 });
  client.emit("status", { enabled: true, state: "connected", connectionGeneration: 2 });
  emitTimelineState("session-a", 1, {
    timelineId: "timeline-session-a-new-generation",
    playSessionId: "play-session-a-new-generation",
  });
  assert.equal(router.getStatus().timelineId, "timeline-session-a-new-generation");
  assert.equal(router.getStatus().timelinePositionBars, 1);
});

test("router never revives a released session during a reconnect reannouncement", () => {
  const { detector, client, router, timerApi } = createFakeRouter();
  const candidate = strictCandidateTrackPayload({ playSessionId: "released-reannounce-session" });
  let reannounceCalls = 0;
  detector.requestCurrentTrackCandidates = () => {
    reannounceCalls += 1;
    detector.emit("event", {
      type: "DJ_TRACK_ACTIVE",
      eventId: `released-reannounce-${reannounceCalls}`,
      payload: candidate,
    });
  };

  client.emit("timeline-state", { state: "idle", loopActive: false, transitionHoldActive: false });
  client.emit("delivery", {
    eventId: "released-reannounce-1",
    type: "DJ_TRACK_ACTIVE",
    state: "acknowledged",
    ack: { outcome: "accepted" },
  });
  assert.equal(router.getStateSync().activePlaySessionId, candidate.playSessionId);
  router.triggerAction("release");
  timerApi.runNext();
  assert.equal(router.getStateSync().released, true);

  client.emit("status", { enabled: true, state: "disconnected", connectionGeneration: 1 });
  client.emit("status", { enabled: true, state: "connected", connectionGeneration: 2 });
  client.emit("timeline-state", { state: "idle", loopActive: false, transitionHoldActive: false });
  assert.equal(reannounceCalls, 2);
  assert.equal(
    client.sent.filter((event) => event.type === "DJ_TRACK_ACTIVE").length,
    1,
    "the released session's reannounced ACTIVE must not be routed",
  );
});

test("pedal ownership changes only after correlated release and late sync cannot reacquire", () => {
  const { detector, client, midi, router, timerApi } = createFakeRouter();
  const candidate = strictCandidateTrackPayload();
  detector.emit("event", {
    type: "DJ_TRACK_ACTIVE",
    eventId: "active-1",
    payload: candidate,
  });
  assert.equal(Object.hasOwn(client.sent[0].payload, "master"), false);
  assert.equal(Object.hasOwn(client.sent[0].payload, "masterDeckRevision"), false);
  client.emit("delivery", {
    eventId: "active-1",
    type: "DJ_TRACK_ACTIVE",
    state: "acknowledged",
    ack: { outcome: "accepted" },
  });
  client.emit("timeline-state", {
    ...strictTimelineState({ playSessionId: candidate.playSessionId }).payload,
    type: "DJ_TIMELINE_STATE",
  });
  assert.equal(router.getStatus().mode, "dj-control");

  const loopAction = router.triggerAction("loop-half");
  assert.equal(loopAction.ok, true);
  assert.equal(client.sent.some((event) => event.type === "DJ_LOOP_STATE"), false);
  assert.deepEqual(midi.sent, ["loopHalf"]);

  const release = router.triggerAction("release");
  assert.equal(release.phase, "handoff-pending", "DJ_RELEASE is routed at the F13 edge before local MIDI completion");
  timerApi.runNext();
  assert.equal(router.getStatus().mode, "handoff-pending");
  const releaseDelivery = router.getStatus().lastAction.delivery;
  const releaseEvent = client.sent.find((event) => event.type === "DJ_RELEASE");
  assert.deepEqual(releaseEvent.payload, {
    state: "released",
    timelineId: "life-over",
    playSessionId: candidate.playSessionId,
  });
  const sentBeforeLateSync = client.sent.length;
  detector.emit("event", {
    type: "DJ_TRACK_SYNC",
    eventId: "late-sync",
    payload: strictCandidateTrackPayload({ positionRevision: 9 }),
  });
  assert.equal(client.sent.length, sentBeforeLateSync);

  client.emit("timeline-state", {
    ...strictTimelineState({
      playSessionId: candidate.playSessionId,
      pedalOwner: "timeline",
      releaseEventId: "wrong-release",
    }).payload,
    type: "DJ_TIMELINE_STATE",
  });
  assert.equal(router.getStatus().mode, "handoff-pending");
  client.emit("timeline-state", {
    ...strictTimelineState({
      playSessionId: candidate.playSessionId,
      pedalOwner: "timeline",
      releaseEventId: releaseDelivery.eventId,
    }).payload,
    releaseEventId: releaseDelivery.eventId,
    type: "DJ_TIMELINE_STATE",
  });
  assert.equal(router.getStatus().mode, "timeline-control");
});

test("DJ_RELEASE stays pending across reconnect retry until the correlated timeline snapshot", () => {
  const { detector, client, router, timerApi } = createFakeRouter();
  const candidate = strictCandidateTrackPayload();
  detector.emit("event", {
    type: "DJ_TRACK_ACTIVE",
    eventId: "release-reconnect-active",
    payload: candidate,
  });
  client.emit("delivery", {
    eventId: "release-reconnect-active",
    type: "DJ_TRACK_ACTIVE",
    state: "acknowledged",
    ack: { outcome: "accepted" },
  });
  client.emit("timeline-state", {
    ...strictTimelineState({ playSessionId: candidate.playSessionId }).payload,
    type: "DJ_TIMELINE_STATE",
  });

  router.triggerAction("release");
  const releaseEvent = client.sent.find((event) => event.type === "DJ_RELEASE");
  const releaseEventId = router.getStatus().lastAction.releaseEventId;
  assert.ok(releaseEvent && releaseEventId);
  client.emit("status", { enabled: true, state: "disconnected", connectionGeneration: 1 });
  client.emit("delivery", {
    eventId: releaseEventId,
    type: "DJ_RELEASE",
    state: "retrying",
    ackState: "retrying",
    ok: false,
    reason: "connection-closed",
  });
  assert.equal(router.getStatus().mode, "handoff-pending");
  assert.equal(router.getStatus().releaseMacroPhase, "handoff-pending");
  assert.equal(router.getStatus().lastAction.delivery.state, "retrying");

  // The physical tail continues while the same durable event is queued for
  // replay; retrying must not clear the handoff correlation key.
  timerApi.runNext();
  client.emit("status", { enabled: true, state: "connected", connectionGeneration: 2 });
  client.emit("delivery", {
    eventId: releaseEventId,
    type: "DJ_RELEASE",
    state: "acknowledged",
    ackState: "acknowledged",
    ok: true,
    ack: { outcome: "accepted" },
  });
  assert.equal(router.getStatus().mode, "handoff-pending");
  assert.equal(router.getStatus().lastAction.delivery.state, "acknowledged");
  client.emit("timeline-state", {
    ...strictTimelineState({
      playSessionId: candidate.playSessionId,
      pedalOwner: "timeline",
      releaseEventId,
    }).payload,
    type: "DJ_TIMELINE_STATE",
  });
  assert.equal(router.getStatus().mode, "timeline-control");
  assert.equal(router.getStatus().releaseMacroPhase, "complete");
  assert.equal(router.getStatus().lastAction.delivery.state, "acknowledged");
  router.stop();
});

test("strict v3 capabilities and typed encoders exclude DJ_MASTER_CHANGED entirely", () => {
  const adapter = createSyndocalEnvelopeV3Adapter({ token: TEST_TOKEN });
  const hello = adapter.encodeHello({ eventId: "hello-capabilities", sequence: 1 });
  assert.equal(hello.payload.capabilities.includes("DJ_MASTER_CHANGED"), false);
  assert.equal(hello.payload.capabilities.includes("DJ_LOOP_FALLBACK"), true);
  for (const payload of [
    { deck: 1, deckId: "rekordbox-deck-1" },
    { deck: 2 },
    {},
    null,
    "deck-1",
  ]) {
    assert.equal(adapter.encodeEvent({
      type: "DJ_MASTER_CHANGED",
      eventId: "retired-encoded",
      sequence: 2,
      payload,
    }), null);
  }
});

test("DJ_MASTER_CHANGED cannot be queued, encoded, delivered, retried, or replayed", async (t) => {
  V3WebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: V3WebSocket,
    heartbeatMs: 60_000,
    reconnectMinMs: 50,
    reconnectMaxMs: 50,
    stateSyncProvider: () => ({ released: false, ownerDeck: 1, ownerDeckId: "rekordbox-deck-1", activePlaySessionId: "play-session-1" }),
  });
  t.after(() => client.stop());
  const failures = [];
  const deliveries = [];
  client.on("protocol-failure", (failure) => failures.push(failure));
  client.on("delivery", (delivery) => deliveries.push(delivery.type));
  client.start();
  await flush();
  const first = V3WebSocket.instances[0];

  const attempted = client.sendEvent({
    type: "DJ_MASTER_CHANGED",
    eventId: "retired-master-changed",
    sequence: 50,
    payload: { deck: 2, deckId: "rekordbox-deck-2" },
  });
  assert.equal(attempted.skipped, true);
  assert.equal(attempted.reason, "unsupported-type");
  assert.equal(attempted.sent, false);
  assert.equal(attempted.ok, false);
  assert.equal(first.sent.some((frame) => frame.type === "DJ_MASTER_CHANGED"), false);
  assert.equal(client.getStatus().pendingAcks, 0);
  assert.equal(client.getStatus().physicalEventIdRegistrySize, 0);
  assert.deepEqual(deliveries, []);
  assert.deepEqual(failures, []);

  first.emit("message", JSON.stringify({
    v: 3,
    type: "ACK",
    eventId: "retired-master-changed",
    sequence: 50,
    outcome: "busy",
    code: "BUSY",
    stateGeneration: 1,
  }));
  assert.equal(client.getStatus().pendingAcks, 0);
  assert.equal(client.getStatus().lastDelivery, null);
  assert.equal(first.sent.some((frame) => frame.type === "DJ_MASTER_CHANGED"), false);

  const reconnect = waitForEvent(
    client,
    "connected",
    (event) => event?.generation === 2,
    { label: "retired-event reconnect" },
  );
  first.readyState = 3;
  first.emit("close", 1006, "retired-reconnect");
  await reconnect;
  const second = V3WebSocket.instances.at(-1);
  assert.equal(second.sent.some((frame) => frame.type === "DJ_MASTER_CHANGED"), false);
});

test("router drops a foreign DJ_MASTER_CHANGED detector event without reaching the client", () => {
  const { detector, client } = createFakeRouter();
  detector.emit("event", {
    type: "DJ_MASTER_CHANGED",
    eventId: "injected-retired-master",
    payload: { deck: 2 },
  });
  assert.equal(client.sent.some((event) => event.type === "DJ_MASTER_CHANGED"), false);
});
