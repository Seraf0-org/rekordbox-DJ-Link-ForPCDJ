const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const dgram = require("node:dgram");

const {
  createSyndocalClient,
  createSyndocalEnvelopeV2Adapter,
  decodeV2TimelineState,
  resolveAdapter,
  validateEnvelopeV2Ack,
} = require("../server/dj-agent/syndocalClient");
const { createTrackActivityDetector } = require("../server/dj-agent/trackActivityDetector");
const { createShowEventRouter } = require("../server/dj-agent/showEventRouter");
const { createHookUdpProvider } = require("../server/providers/hookUdpProvider");

const TEST_TOKEN = "0123456789abcdef0123456789abcdef";
const NOW = Date.parse("2026-08-25T00:00:00.000Z");
const ENVELOPE_FIELDS = ["v", "type", "agentId", "sessionId", "sequence", "eventId", "payload"];

function assertV2Frame(frame, type) {
  assert.deepEqual(Object.keys(frame).sort(), [...ENVELOPE_FIELDS].sort());
  assert.equal(frame.v, 2);
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
    v: 2,
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

test("production adapter is a strict v2 clean break and rejects flat/v1 names", () => {
  const v2 = resolveAdapter({ adapter: "syndocal-envelope-v2", token: TEST_TOKEN });
  assert.equal(v2.error, null);
  assert.equal(v2.adapterObject.name, "syndocal-envelope-v2");
  for (const retired of ["generic-json", "syndocal-envelope-v1", "", "envelope-v2"]) {
    const result = resolveAdapter({ adapter: retired, token: TEST_TOKEN });
    assert.equal(result.adapterObject, null);
    assert.match(result.error, /v2|required|retired/i);
  }
});

test("v2 active/sync payloads require exact identity, master deck, position, BPM, revision, and freshness", () => {
  const adapter = createSyndocalEnvelopeV2Adapter({ token: TEST_TOKEN });
  const hello = adapter.encodeHello({ eventId: "hello-1", sequence: 1 });
  assertV2Frame(hello, "DJ_AGENT_HELLO");
  assert.deepEqual(hello.payload.version, 2);
  assert.ok(hello.payload.capabilities.includes("DJ_MASTER_TRACK_SYNC"));

  const encoded = adapter.encodeEvent({
    type: "DJ_MASTER_TRACK_ACTIVE",
    eventId: "active-1",
    sequence: 2,
    payload: strictTrackPayload(),
  });
  assertV2Frame(encoded, "DJ_MASTER_TRACK_ACTIVE");
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
  assertV2Frame(titleArtistIdentity, "DJ_MASTER_TRACK_SYNC");
});

test("v2 loop and release encoders accept only measured/correlated state", () => {
  const adapter = createSyndocalEnvelopeV2Adapter({ token: TEST_TOKEN });
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
  assertV2Frame(adapter.encodeEvent({ type: "DJ_LOOP_STATE", eventId: "loop-1", sequence: 2, payload: loop }), "DJ_LOOP_STATE");
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
  assertV2Frame(adapter.encodeEvent({
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

test("detector delays active until complete, emits one active per session, and fences revisions/reorder/staleness", () => {
  let nextId = 0;
  let now = NOW;
  const detector = createTrackActivityDetector({ now: () => now, idFactory: () => `id-${++nextId}` });
  const events = [];
  detector.on("event", (event) => events.push(event));

  detector.onSnapshot({
    explicitMasterDeck: 1,
    deckNowPlaying: [{ deck: 1, contentId: "42", title: "Life Over", artist: "DSF", trackBpm: 120 }],
    deckPlaybacks: [{ deck: 1, isPlaying: true, bpm: 120 }],
  });
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 0);
  const playSessionId = detector.getState().decks[1].playSessionId;
  assert.ok(playSessionId);

  detector.onSnapshot({
    explicitMasterDeck: 1,
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
    deckNowPlaying: [{ deck: 1, title: "Life Over" }],
    deckPlaybacks: [playback(1)],
  });
  const playSessionId = detector.getState().decks[1].playSessionId;
  assert.ok(playSessionId);
  assert.equal(events.some((event) => event.type === "DJ_MASTER_TRACK_ACTIVE"), false);

  detector.onSnapshot({
    explicitMasterDeck: 1,
    deckNowPlaying: [{ deck: 1, title: "Life Over", artist: "DSF" }],
    deckPlaybacks: [playback(2)],
  });
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 1);
  assert.equal(events.find((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").payload.playSessionId, playSessionId);

  detector.onSnapshot({
    explicitMasterDeck: 1,
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
  detector.onMasterChange({ deck: 1 });
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 1);
  detector.onSnapshot({
    explicitMasterDeck: 1,
    deckNowPlaying: [{ deck: 1, contentId: "new", title: "Same", artist: "Artist", trackBpm: 120 }],
    deckPlaybacks: [playback(2)],
  });
  assert.equal(events.filter((event) => event.type === "DJ_MASTER_TRACK_ACTIVE").length, 1);
  detector.onSnapshot({ explicitMasterDeck: 1, deckPlaybacks: [playback(3, false)] });
  detector.onSnapshot({
    explicitMasterDeck: 1,
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

  assert.deepEqual(
    events.filter((event) => event.type === "DJ_LOOP_STATE").map((event) => event.payload.lengthBeats),
    [8, 4, 2],
  );
});

class V2WebSocket extends EventEmitter {
  static instances = [];
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    V2WebSocket.instances.push(this);
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

test("ACK reconnect retry preserves eventId/playSession exactly once and uses a fresh v2 session", async (t) => {
  V2WebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v2",
    WebSocketImpl: V2WebSocket,
    reconnectMinMs: 50,
    reconnectMaxMs: 50,
    heartbeatMs: 60_000,
    ackTimeoutMs: 2_000,
    stateSyncProvider: () => ({ released: false, masterDeck: 1, activePlaySessionId: "play-session-1" }),
  });
  t.after(() => client.stop());
  client.start();
  await flush();
  const first = V2WebSocket.instances[0];
  const sent = client.sendEvent({
    type: "DJ_MASTER_TRACK_ACTIVE",
    eventId: "active-reconnect",
    payload: strictTrackPayload(),
  });
  assert.equal(sent.state, "pending");
  const firstFrame = first.sent.find((frame) => frame.eventId === "active-reconnect");
  assertV2Frame(firstFrame, "DJ_MASTER_TRACK_ACTIVE");
  first.readyState = 3;
  first.emit("close", 1006, "test-reconnect");
  assert.equal(client.getStatus().lastDelivery.state, "retrying");
  await new Promise((resolve) => setTimeout(resolve, 70));
  await flush();
  const second = V2WebSocket.instances[1];
  const replay = second.sent.find((frame) => frame.eventId === "active-reconnect");
  assertV2Frame(replay, "DJ_MASTER_TRACK_ACTIVE");
  assert.notEqual(replay.sessionId, firstFrame.sessionId);
  assert.notEqual(replay.sequence, firstFrame.sequence);
  assert.equal(replay.payload.playSessionId, firstFrame.payload.playSessionId);
  assert.deepEqual(replay.payload, firstFrame.payload);

  first.emit("message", JSON.stringify({
    v: 2,
    type: "ACK",
    eventId: "active-reconnect",
    sequence: firstFrame.sequence,
    outcome: "accepted",
    code: null,
    stateGeneration: 1,
  }));
  assert.equal(client.getStatus().pendingAcks, 1);
  second.emit("message", JSON.stringify({
    v: 2,
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

test("durable physical event IDs are single-use and caller sequence reorder fails closed", async (t) => {
  V2WebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v2",
    WebSocketImpl: V2WebSocket,
    heartbeatMs: 60_000,
    stateSyncProvider: () => ({ released: false, masterDeck: 1, activePlaySessionId: "play-session-1" }),
  });
  t.after(() => client.stop());
  client.start();
  await flush();
  const socket = V2WebSocket.instances[0];
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
    adapter: "syndocal-envelope-v2",
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

  first.readyState = 3;
  first.emit("close", 1006, "endurance-reconnect");
  await new Promise((resolve) => setTimeout(resolve, 70));
  await flush();
  const second = EnduranceWebSocket.instances[1];
  assert.equal(second.syncCount, 0);
  assert.equal(first.syncCount, firstCountBeforeReconnect);
  const durableReplay = second.controlFrames.find((frame) => frame.eventId === durable.eventId);
  assertV2Frame(durableReplay, "DJ_RELEASE");
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

test("inbound flat/v1 frames are visible protocol failures and v2 timeline state is exact", async (t) => {
  V2WebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v2",
    WebSocketImpl: V2WebSocket,
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
  const socket = V2WebSocket.instances[0];
  socket.emit("message", JSON.stringify({ type: "ACK", eventId: "flat" }));
  socket.emit("message", JSON.stringify({ v: 1, type: "ACK", eventId: "v1" }));
  socket.emit("message", JSON.stringify(strictTimelineState()));
  assert.deepEqual(failures.map((failure) => failure.reason), ["strict-envelope-v2-required", "retired-protocol-v1"]);
  assert.equal(states.length, 1);
  assert.equal(states[0].playSessionId, "play-session-1");
  assert.equal(decodeV2TimelineState({ ...strictTimelineState(), bonus: true }), null);
});

test("ACK v2 schema rejects missing, extra, stale, and nonfinite fields", () => {
  const valid = {
    v: 2,
    type: "ACK",
    eventId: "event-1",
    sequence: 3,
    outcome: "accepted",
    code: null,
    stateGeneration: 1,
  };
  assert.equal(validateEnvelopeV2Ack(valid).valid, true);
  for (const invalid of [
    { ...valid, v: 1 },
    { ...valid, sequence: Number.NaN },
    { ...valid, stateGeneration: -1 },
    { ...valid, outcome: "ok" },
    { ...valid, extra: true },
    { ...valid, eventId: " event-1" },
  ]) assert.equal(validateEnvelopeV2Ack(invalid).valid, false);
});

function createFakeRouter() {
  const detector = new EventEmitter();
  detector.state = { currentMasterDeck: 1, masterDeckSource: "explicit", decks: { 1: { track: null } } };
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
