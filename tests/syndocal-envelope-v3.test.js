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
    masterDeckRevision: 1,
    contentId: "42",
    title: "Life Over",
    artist: "DSF",
    trackBpm: 120,
    positionAtSendSec: 12.5,
    effectiveBpm: 120.25,
    positionRevision: 8,
    sampleAgeMs: 10,
    isPlaying: true,
    master: true,
    startedAt: "2026-08-25T00:00:00.000Z",
    playSessionId: "play-session-1",
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

test("v3 active/sync payloads require exact identity, master deck, position, BPM, revision, and freshness", () => {
  const adapter = createSyndocalEnvelopeV3Adapter({ token: TEST_TOKEN });
  const hello = adapter.encodeHello({ eventId: "hello-1", sequence: 1 });
  assertV3Frame(hello, "DJ_AGENT_HELLO");
  assert.deepEqual(hello.payload.version, 3);
  assert.ok(hello.payload.capabilities.includes("DJ_MASTER_TRACK_SYNC"));
  assert.ok(hello.payload.capabilities.includes("DJ_LOOP_FALLBACK"));

  const encoded = adapter.encodeEvent({
    type: "DJ_MASTER_TRACK_ACTIVE",
    eventId: "active-1",
    sequence: 2,
    payload: strictTrackPayload(),
  });
  assertV3Frame(encoded, "DJ_MASTER_TRACK_ACTIVE");
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
      type: "DJ_MASTER_TRACK_ACTIVE",
      eventId: `invalid-${index}`,
      sequence: index + 3,
      payload: strictTrackPayload(patch),
    }), null);
  });

  const titleArtistIdentity = adapter.encodeEvent({
    type: "DJ_MASTER_TRACK_SYNC",
    eventId: "sync-text-identity",
    sequence: 30,
    payload: strictTrackPayload({ contentId: null }),
  });
  assertV3Frame(titleArtistIdentity, "DJ_MASTER_TRACK_SYNC");
});

test("v3 loop and release encoders accept only measured/correlated state", () => {
  const adapter = createSyndocalEnvelopeV3Adapter({ token: TEST_TOKEN });
  adapter.encodeHello({ eventId: "hello", sequence: 1 });
  const loop = {
    deck: 1,
    deckId: "rekordbox-deck-1",
    masterDeckRevision: 3,
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
    masterDeckRevision: 3,
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

test("v3 beat jump and loop set encoders require a canonical playSessionId", () => {
  const adapter = createSyndocalEnvelopeV3Adapter({ token: TEST_TOKEN });
  adapter.encodeHello({ eventId: "hello-actions", sequence: 1 });
  const beatJump = { bars: -4, timelineId: "life-over", playSessionId: "play-session-1" };
  const loopSet = { active: true, timelineId: "life-over", playSessionId: "play-session-1" };
  const jumpFrame = adapter.encodeEvent({
    type: "DJ_TIMELINE_BEAT_JUMP",
    eventId: "jump-canonical",
    sequence: 2,
    payload: beatJump,
  });
  assertV3Frame(jumpFrame, "DJ_TIMELINE_BEAT_JUMP");
  assert.deepEqual(jumpFrame.payload, beatJump);
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
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 0);
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
  const active = events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE");
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
    events.filter((event) => event.type === "DJ_MASTER_TRACK_SYNC").map((event) => event.payload.positionRevision),
    [2],
  );
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 1);
});

test("master switch emits one fresh strict ACTIVE then one strictly newer SYNC without duplicate activation", () => {
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

  // A complete, fresh non-master candidate must not activate merely because it
  // is playing. The explicit master event is the activation authority.
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
    events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE" || event.type === "DJ_MASTER_TRACK_SYNC"),
    [],
  );

  const authorityAt = new Date(now).toISOString();
  detector.onMasterChange({ deck: 2, explicitMasterUpdatedAt: authorityAt });
  detector.onMasterChange({ deck: 2, explicitMasterUpdatedAt: authorityAt });
  const activationEvents = () => events.filter(
    (event) => event.type === "DJ_MASTER_TRACK_ACTIVE" || event.type === "DJ_MASTER_TRACK_SYNC",
  );
  assert.deepEqual(activationEvents().map((event) => event.type), ["DJ_MASTER_TRACK_ACTIVE"]);
  const active = activationEvents()[0];
  assert.equal(active.payload.deck, 2);
  assert.equal(active.payload.deckId, "rekordbox-deck-2");
  assert.equal(active.payload.masterDeckRevision, 2);
  assert.equal(active.payload.contentId, "deck-2-content");
  assert.equal(active.payload.positionAtSendSec, 32.5);
  assert.equal(active.payload.effectiveBpm, 128);
  assert.equal(active.payload.positionRevision, 10);
  assert.equal(active.payload.sampleAgeMs, 0);
  assert.equal(active.payload.isPlaying, true);
  assert.equal(active.payload.master, true);
  assert.ok(active.payload.playSessionId);
  const adapter = createSyndocalEnvelopeV3Adapter({ token: TEST_TOKEN });
  const activeFrame = adapter.encodeEvent({
    type: active.type,
    eventId: active.eventId,
    sequence: 1,
    payload: active.payload,
  });
  assertV3Frame(activeFrame, "DJ_MASTER_TRACK_ACTIVE");
  assert.deepEqual(activeFrame.payload, active.payload);

  // Equal revision cannot duplicate either transition; only a strictly newer,
  // fresh sample may advance the active play session to SYNC.
  snapshot(candidatePlayback(10, 32.5));
  assert.deepEqual(activationEvents().map((event) => event.type), ["DJ_MASTER_TRACK_ACTIVE"]);
  now += 1;
  snapshot(candidatePlayback(11, 33));
  assert.deepEqual(
    activationEvents().map((event) => event.type),
    ["DJ_MASTER_TRACK_ACTIVE", "DJ_MASTER_TRACK_SYNC"],
  );
  const sync = activationEvents()[1];
  assert.equal(sync.payload.playSessionId, active.payload.playSessionId);
  assert.equal(sync.payload.masterDeckRevision, active.payload.masterDeckRevision);
  assert.equal(sync.payload.positionRevision, 11);
  assert.equal(sync.payload.positionAtSendSec, 33);
  assert.equal(sync.payload.sampleAgeMs, 0);
  const syncFrame = adapter.encodeEvent({
    type: sync.type,
    eventId: sync.eventId,
    sequence: 2,
    payload: sync.payload,
  });
  assertV3Frame(syncFrame, "DJ_MASTER_TRACK_SYNC");
  assert.deepEqual(syncFrame.payload, sync.payload);
});

test("conflicting non-explicit snapshot cannot duplicate ACTIVE or steal the explicit master generation", () => {
  let nextId = 0;
  let now = NOW;
  const detector = createTrackActivityDetector({
    now: () => now,
    idFactory: () => `authority-${++nextId}`,
  });
  const events = [];
  detector.on("event", (event) => events.push(event));
  const transitions = () => events.filter(
    (event) => event.type === "DJ_MASTER_TRACK_ACTIVE" || event.type === "DJ_MASTER_TRACK_SYNC",
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
    [["DJ_MASTER_TRACK_ACTIVE", 1]],
  );
  const activeOne = transitions()[0];
  assert.equal(activeOne.payload.masterDeckRevision, 1);
  const outgoingSession = activeOne.payload.playSessionId;

  // Reproduced P0 seam: a snapshot reporting a conflicting non-explicit
  // masterDeck while deck 1 is the established explicit master must not
  // advance the activation generation or rearm ACTIVE for deck 1.
  const beforeConflict = events.length;
  detector.onSnapshot({ masterDeck: 2, masterDeckSource: "snapshot", ...deck2SnapshotFields });
  assert.equal(detector.getState().explicitMasterDeck, 1);
  assert.equal(detector.getState().currentMasterDeck, 1);
  assert.equal(detector.getState().masterDeckSource, "explicit");
  assert.equal(detector.getState().decks[1].lastActiveMasterGeneration, 1);
  assert.equal(events.slice(beforeConflict).filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 0);
  assert.deepEqual(transitions(), [activeOne]);

  // The later actual explicit handover activates deck 2 exactly once.
  now += 1;
  detector.onMasterChange({ logicalDeck: 2, explicitMasterUpdatedAt: new Date(now).toISOString() });
  assert.deepEqual(transitions().map((event) => event.type), [
    "DJ_MASTER_TRACK_ACTIVE",
    "DJ_MASTER_TRACK_ACTIVE",
  ]);
  const activeTwo = transitions()[1];
  assert.equal(activeTwo.payload.deck, 2);
  assert.equal(activeTwo.payload.masterDeckRevision, 2);
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
    "DJ_MASTER_TRACK_ACTIVE",
    "DJ_MASTER_TRACK_ACTIVE",
    "DJ_MASTER_TRACK_SYNC",
  ]);
  const sync = transitions()[2];
  assert.equal(sync.payload.deck, 2);
  assert.equal(sync.payload.masterDeckRevision, 2);
  assert.equal(sync.payload.playSessionId, activeTwo.payload.playSessionId);
  assert.equal(sync.payload.positionRevision, 11);

  const adapter = createSyndocalEnvelopeV3Adapter({ token: TEST_TOKEN });
  const activeTwoFrame = adapter.encodeEvent({
    type: activeTwo.type,
    eventId: activeTwo.eventId,
    sequence: 1,
    payload: activeTwo.payload,
  });
  assertV3Frame(activeTwoFrame, "DJ_MASTER_TRACK_ACTIVE");
  assert.deepEqual(activeTwoFrame.payload, activeTwo.payload);
  const syncFrame = adapter.encodeEvent({
    type: sync.type,
    eventId: sync.eventId,
    sequence: 2,
    payload: sync.payload,
  });
  assertV3Frame(syncFrame, "DJ_MASTER_TRACK_SYNC");
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
    "DJ_MASTER_TRACK_ACTIVE",
    "DJ_MASTER_TRACK_SYNC",
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
    authorityEvents().map((event) => [event.type, event.payload.deck, event.payload.masterDeckRevision]),
    [["DJ_MASTER_TRACK_ACTIVE", 1, 1]],
  );

  now = NOW + 1;
  detector.onMasterChange({ deck: 2, explicitMasterUpdatedAt: authorityAtTwo });
  assert.deepEqual(
    authorityEvents().map((event) => [event.type, event.payload.deck, event.payload.masterDeckRevision]),
    [
      ["DJ_MASTER_TRACK_ACTIVE", 1, 1],
      ["DJ_MASTER_TRACK_ACTIVE", 2, 2],
    ],
  );
  assert.equal(detector.getState().currentMasterDeck, 2);
  assert.equal(detector.getState().masterDeckRevision, 2);

  // This delayed snapshot is a complete old authority state. It must neither
  // replace deck 2 nor contribute any track/loop event after the fence.
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
  assert.deepEqual(events.slice(beforeStaleSnapshot), []);
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
    authorityEvents().map((event) => [event.type, event.payload.deck, event.payload.masterDeckRevision]),
    [
      ["DJ_MASTER_TRACK_ACTIVE", 1, 1],
      ["DJ_MASTER_TRACK_ACTIVE", 2, 2],
      ["DJ_MASTER_TRACK_ACTIVE", 1, 3],
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
    masterDeckRevision: 0,
    masterDeckSource: "unknown",
    explicitMasterDeck: null,
    explicitMasterUpdatedAt: null,
    explicitMasterAuthorityRevision: 0,
    decks: {},
  });
  // Reset deliberately clears the prior high-water mark; this old-but-valid
  // source timestamp is therefore a new initial authority record.
  assert.equal(detector.onMasterChange({ deck: 1, explicitMasterUpdatedAt: authorityAtOne }), null);
  assert.equal(detector.getState().currentMasterDeck, 1);
  assert.equal(detector.getState().masterDeckRevision, 1);
});

test("missing explicit authority timestamps reject atomically and cannot roll back a newer master", () => {
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
  assert.deepEqual(events.slice(beforeRejected), []);
  assert.equal(detector.getState().currentMasterDeck, 2);
  assert.equal(detector.getState().masterDeckRevision, 2);
  assert.equal(detector.getState().decks[1].track.contentId, "one");
  assert.equal(detector.getState().decks[1].playback.positionRevision, 1);
  assert.equal(detector.getState().decks[1].loop, null);
});

test("same-deck stale explicit snapshot atomically drops track, position, and loop mutation", () => {
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
  assert.deepEqual(events.slice(beforeStale), []);
  assert.equal(state.currentMasterDeck, 1);
  assert.equal(state.decks[1].track.contentId, "safe");
  assert.equal(state.decks[1].playback.positionRevision, 1);
  assert.equal(state.decks[1].loop, null);

  const beforeInvalid = events.length;
  detector.onSnapshot({ ...rejectedSnapshot, explicitMasterUpdatedAt: "not-a-timestamp" });
  assert.deepEqual(events.slice(beforeInvalid), []);
  assert.equal(detector.getState().decks[1].track.contentId, "safe");
  assert.equal(detector.getState().decks[1].playback.positionRevision, 1);
  assert.equal(detector.getState().decks[1].loop, null);
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
      .filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE" || event.type === "DJ_MASTER_TRACK_SYNC")
      .map((event) => [event.type, event.payload.deck, event.payload.positionRevision]),
    [
      ["DJ_MASTER_TRACK_ACTIVE", 2, 1],
      ["DJ_MASTER_TRACK_SYNC", 2, 2],
    ],
  );
  assert.equal(detector.getState().currentMasterDeck, 2);
  assert.equal(detector.getState().masterDeckRevision, 2);
  assert.equal(detector.getState().decks[2].playback.positionRevision, 2);
});

test("delayed exact track identity and later authoritative contentId keep one play session and one ACTIVE", () => {
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
  assert.equal(events.some((event) => event.type === "DJ_MASTER_TRACK_ACTIVE"), false);

  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date(NOW).toISOString(),
    deckNowPlaying: [{ deck: 1, title: "Life Over", artist: "DSF" }],
    deckPlaybacks: [playback(2)],
  });
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 1);
  assert.equal(events.find((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").payload.playSessionId, playSessionId);

  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: new Date(NOW).toISOString(),
    deckNowPlaying: [{ deck: 1, contentId: "42", title: "Life Over", artist: "DSF" }],
    deckPlaybacks: [playback(3)],
  });
  assert.equal(detector.getState().decks[1].playSessionId, playSessionId);
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 1);
  const sync = events.filter((event) => event.type === "DJ_MASTER_TRACK_SYNC").at(-1);
  assert.equal(sync.payload.contentId, "42");
  assert.equal(sync.payload.playSessionId, playSessionId);
});

test("contentId is authoritative and fallback master never creates a show activation", () => {
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
  assert.equal(events.some((event) => event.type === "DJ_MASTER_TRACK_ACTIVE"), false);
  const authorityAt = new Date(NOW).toISOString();
  detector.onMasterChange({ deck: 1, explicitMasterUpdatedAt: authorityAt });
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 1);
  detector.onSnapshot({
    explicitMasterDeck: 1,
    explicitMasterUpdatedAt: authorityAt,
    deckNowPlaying: [{ deck: 1, contentId: "new", title: "Same", artist: "Artist", trackBpm: 120 }],
    deckPlaybacks: [playback(2)],
  });
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 1);
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
  const active = events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE");
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

  const activePromise = waitFor(
    detector,
    "event",
    (event) => event.type === "DJ_MASTER_TRACK_ACTIVE",
    "strict active event",
  );
  await send({ type: "master_change", deck: 1 });
  const active = await activePromise;
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

test("ACK reconnect retry preserves eventId/playSession exactly once and uses a fresh v3 session", async (t) => {
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
    stateSyncProvider: () => ({ released: false, masterDeck: 1, activePlaySessionId: "play-session-1" }),
  });
  t.after(() => client.stop());
  client.start();
  await flush();
  const first = V3WebSocket.instances[0];
  const sent = client.sendEvent({
    type: "DJ_MASTER_TRACK_ACTIVE",
    eventId: "active-reconnect",
    payload: strictTrackPayload(),
  });
  assert.equal(sent.state, "pending");
  const firstFrame = first.sent.find((frame) => frame.eventId === "active-reconnect");
  assertV3Frame(firstFrame, "DJ_MASTER_TRACK_ACTIVE");
  const reconnect = waitForEvent(
    client,
    "connected",
    (event) => event?.generation === 2,
    { label: "ACK retry reconnect" },
  );
  first.readyState = 3;
  first.emit("close", 1006, "test-reconnect");
  assert.equal(client.getStatus().lastDelivery.state, "retrying");
  await reconnect;
  const second = V3WebSocket.instances[1];
  const replay = second.sent.find((frame) => frame.eventId === "active-reconnect");
  assertV3Frame(replay, "DJ_MASTER_TRACK_ACTIVE");
  assert.notEqual(replay.sessionId, firstFrame.sessionId);
  assert.notEqual(replay.sequence, firstFrame.sequence);
  assert.equal(replay.payload.playSessionId, firstFrame.payload.playSessionId);
  assert.deepEqual(replay.payload, firstFrame.payload);

  first.emit("message", JSON.stringify({
    v: 3,
    type: "ACK",
    eventId: "active-reconnect",
    sequence: firstFrame.sequence,
    outcome: "accepted",
    code: null,
    stateGeneration: 1,
  }));
  assert.equal(client.getStatus().pendingAcks, 1);
  second.emit("message", JSON.stringify({
    v: 3,
    type: "ACK",
    eventId: "active-reconnect",
    sequence: replay.sequence,
    outcome: "duplicate",
    code: null,
    stateGeneration: 2,
  }));
  assert.equal(client.getStatus().pendingAcks, 0);
  assert.equal(client.getStatus().lastDelivery.state, "acknowledged");
});

test("reconnect replay of a queued timeline command keeps its originally bound playSessionId", async (t) => {
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
    stateSyncProvider: () => ({ released: false, masterDeck: 1, activePlaySessionId: currentSession }),
  });
  t.after(() => client.stop());
  client.start();
  await flush();
  const first = V3WebSocket.instances[0];
  const boundPayload = { bars: -4, timelineId: "life-over", playSessionId: currentSession };
  const queued = client.sendEvent({ type: "DJ_TIMELINE_BEAT_JUMP", payload: boundPayload });
  assert.equal(queued.state, "pending");
  currentSession = "play-session-b";
  const reconnect = waitForEvent(
    client,
    "connected",
    (event) => event?.generation === 2,
    { label: "queued beat jump reconnect" },
  );
  first.readyState = 3;
  first.emit("close", 1006, "session-replacement");
  await reconnect;
  const second = V3WebSocket.instances.at(-1);
  const replay = second.sent.find((frame) => frame.eventId === queued.eventId);
  assertV3Frame(replay, "DJ_TIMELINE_BEAT_JUMP");
  assert.deepEqual(replay.payload, boundPayload);
  assert.equal(replay.payload.playSessionId, "play-session-a");
  assert.notEqual(replay.payload.playSessionId, currentSession);
});

test("durable physical event IDs are single-use and caller sequence reorder fails closed", async (t) => {
  V3WebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v3",
    WebSocketImpl: V3WebSocket,
    heartbeatMs: 60_000,
    stateSyncProvider: () => ({ released: false, masterDeck: 1, activePlaySessionId: "play-session-1" }),
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
      if (frame.type === "DJ_MASTER_TRACK_SYNC") {
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
      masterDeck: 1,
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
      type: "DJ_MASTER_TRACK_SYNC",
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
    type: "DJ_MASTER_TRACK_SYNC",
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
    type: "DJ_MASTER_TRACK_SYNC",
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
    stateSyncProvider: () => ({ released: false, masterDeck: null, activePlaySessionId: null }),
  });
  t.after(() => client.stop());
  const failures = [];
  const states = [];
  client.on("protocol-failure", (failure) => failures.push(failure));
  client.on("timeline-state", (state) => states.push(state));
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
  const detector = new EventEmitter();
  detector.state = {
    currentMasterDeck: 1,
    masterDeckRevision: 1,
    masterDeckSource: "explicit",
    decks: { 1: { track: null, playSessionId: "play-session-1" } },
  };
  detector.getState = () => detector.state;
  detector.onSnapshot = () => detector.state;
  detector.onTrackLoaded = () => null;
  detector.onMasterChange = () => null;
  detector.requestCurrentMasterActive = () => null;
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
    getStatus: () => ({}),
    start() {},
    stop() {},
  };
  const pedal = { start() {}, stop() {}, getStatus: () => ({}) };
  const router = createShowEventRouter({ detector, syndocalClient: client, midi, pedal, now: () => NOW });
  return { detector, client, midi, router };
}

test("pedal ownership changes only after correlated release and late sync cannot reacquire", () => {
  const { detector, client, midi, router } = createFakeRouter();
  detector.emit("event", {
    type: "DJ_MASTER_TRACK_ACTIVE",
    eventId: "active-1",
    payload: strictTrackPayload(),
  });
  client.emit("timeline-state", {
    ...strictTimelineState().payload,
    type: "DJ_TIMELINE_STATE",
  });
  assert.equal(router.getStatus().mode, "dj-control");

  const loopAction = router.triggerAction("loop-half");
  assert.equal(loopAction.ok, true);
  assert.equal(client.sent.some((event) => event.type === "DJ_LOOP_STATE"), false);
  assert.deepEqual(midi.sent, ["loopHalf"]);

  const release = router.triggerAction("release");
  assert.equal(release.mode, "handoff-pending");
  const releaseEvent = client.sent.find((event) => event.type === "DJ_RELEASE");
  assert.deepEqual(releaseEvent.payload, {
    state: "released",
    timelineId: "life-over",
    playSessionId: "play-session-1",
  });
  const sentBeforeLateSync = client.sent.length;
  detector.emit("event", {
    type: "DJ_MASTER_TRACK_SYNC",
    eventId: "late-sync",
    payload: strictTrackPayload({ positionRevision: 9 }),
  });
  assert.equal(client.sent.length, sentBeforeLateSync);

  client.emit("timeline-state", {
    ...strictTimelineState({ pedalOwner: "timeline", releaseEventId: "wrong-release" }).payload,
    type: "DJ_TIMELINE_STATE",
  });
  assert.equal(router.getStatus().mode, "handoff-pending");
  client.emit("timeline-state", {
    ...strictTimelineState({ pedalOwner: "timeline", releaseEventId: releaseEvent.eventId || release.delivery.eventId }).payload,
    releaseEventId: release.delivery.eventId,
    type: "DJ_TIMELINE_STATE",
  });
  assert.equal(router.getStatus().mode, "timeline-control");
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
    stateSyncProvider: () => ({ released: false, masterDeck: 1, activePlaySessionId: "play-session-1" }),
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
