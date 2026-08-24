const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  createSyndocalClient,
  createSyndocalEnvelopeV1Adapter,
  encodeFlatEvent,
  resolveAdapter,
  validateEnvelopeAck,
  validateTypedAck,
} = require("../server/dj-agent/syndocalClient");
const { createTrackActivityDetector } = require("../server/dj-agent/trackActivityDetector");
const { createShowEventRouter } = require("../server/dj-agent/showEventRouter");
const { createBuildIdentity, hexIdentity, readPackageVersion } = require("../server/buildIdentity");

const TEST_TOKEN = "0123456789abcdef0123456789abcdef";

class EnvelopeWebSocket extends EventEmitter {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    EnvelopeWebSocket.instances.push(this);
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

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Exact KDMX DjLinkEnvelope wire shape: every frame carries exactly these
// seven keys and typed payloads deny unknown fields.
const ENVELOPE_FIELDS = ["v", "type", "agentId", "sessionId", "sequence", "eventId", "payload"];

function assertEnvelopeFrame(frame, expectedType) {
  assert.deepEqual(Object.keys(frame).sort(), [...ENVELOPE_FIELDS].sort());
  assert.equal(frame.v, 1);
  assert.equal(frame.type, expectedType);
  assert.equal(frame.agentId, "rb-output-dj-agent");
  assert.ok(frame.sessionId.length > 0 && frame.sessionId.length <= 256);
  assert.ok(Number.isSafeInteger(frame.sequence) && frame.sequence >= 1);
  assert.ok(typeof frame.eventId === "string" && frame.eventId.length > 0);
}

test("syndocal-envelope-v1 HELLO/state-sync/state-request handshake order and exact frame schema", async (t) => {
  EnvelopeWebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v1",
    WebSocketImpl: EnvelopeWebSocket,
    heartbeatMs: 60_000,
    stateSyncProvider: () => ({ loopDivision: 1, released: false, masterDeck: "2" }),
  });
  t.after(() => client.stop());
  client.start();
  await flush();
  const socket = EnvelopeWebSocket.instances.at(-1);
  assert.equal(socket.url, "ws://127.0.0.1:9100/dj-link");

  const [hello, stateSync, stateRequest] = socket.sent;
  assert.equal(hello.type, "DJ_AGENT_HELLO");
  assertEnvelopeFrame(hello, "DJ_AGENT_HELLO");
  assert.deepEqual(
    Object.keys(hello.payload).sort(),
    ["authToken", "capabilities", "version"].sort(),
  );
  assert.equal(hello.payload.authToken, TEST_TOKEN);
  assert.equal(hello.payload.version, 1);
  assert.ok(Array.isArray(hello.payload.capabilities) && hello.payload.capabilities.length <= 32);

  // Every frame on the connection repeats the HELLO agent/session identity.
  assert.equal(stateSync.type, "DJ_STATE_SYNC");
  assertEnvelopeFrame(stateSync, "DJ_STATE_SYNC");
  assert.equal(stateSync.sessionId, hello.sessionId);
  assert.equal(stateRequest.type, "DJ_TIMELINE_STATE_REQUEST");
  assertEnvelopeFrame(stateRequest, "DJ_TIMELINE_STATE_REQUEST");
  assert.equal(stateRequest.sessionId, hello.sessionId);
  assert.deepEqual(stateRequest.payload, {});

  // State sync payload mirrors the KDMX DjLinkStateSyncPayload struct.
  assert.deepEqual(Object.keys(stateSync.payload).sort(), ["loopDivision", "masterDeck", "released"]);
});

test("syndocal-envelope-v1 reconnect mints a fresh session identity (no HELLO Duplicate replay)", async (t) => {
  EnvelopeWebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v1",
    WebSocketImpl: EnvelopeWebSocket,
    heartbeatMs: 60_000,
    reconnectMinMs: 5,
    reconnectMaxMs: 8,
    stateSyncProvider: () => ({}),
  });
  t.after(() => client.stop());
  client.start();
  await flush();
  const first = EnvelopeWebSocket.instances.at(-1);
  const firstSession = first.sent[0].sessionId;
  first.close();
  // scheduleReconnect floors the first retry at 50ms.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const second = EnvelopeWebSocket.instances.at(-1);
  assert.notEqual(second, first);
  assert.notEqual(second.sent[0].sessionId, firstSession);
});

test("syndocal-envelope-v1 physical events use exact typed payloads and strict ACK semantics", async (t) => {
  EnvelopeWebSocket.instances = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v1",
    WebSocketImpl: EnvelopeWebSocket,
    heartbeatMs: 60_000,
    ackTimeoutMs: 80,
    busyRetryMaxAttempts: 2,
    busyRetryBaseMs: 2,
    busyRetryMaxMs: 4,
    requiresAckTypes: [],
  });
  t.after(() => client.stop());
  client.start();
  await flush();
  const socket = EnvelopeWebSocket.instances.at(-1);

  const sent = client.sendEvent({
    type: "DJ_LOOP_STATE",
    eventId: "env-loop-1",
    sequence: 51,
    payload: { division: 3, source: "must-not-cross-wire" },
  });
  assert.equal(sent.sent, true);
  const eventFrame = socket.sent.find((frame) => frame.type === "DJ_LOOP_STATE");
  assertEnvelopeFrame(eventFrame, "DJ_LOOP_STATE");
  assert.deepEqual(eventFrame.payload, { division: 3, enabled: true });

  // Malformed ACK shapes are rejected, never applied.
  for (const bad of [
    { v: 1, type: "ACK", eventId: "env-loop-1", sequence: 51, outcome: "accepted", code: null, stateGeneration: 1, ok: true },
    { v: 2, type: "ACK", eventId: "env-loop-1", sequence: 51, outcome: "accepted", code: null, stateGeneration: 1 },
    { v: 1, type: "ACK", eventId: "env-loop-1", sequence: 51, outcome: "exploded", code: null, stateGeneration: 1 },
  ]) {
    let sawProtocolFailure = false;
    const onFail = () => { sawProtocolFailure = true; };
    client.on("protocol-failure", onFail);
    socket.emit("message", JSON.stringify(bad));
    client.off("protocol-failure", onFail);
    assert.equal(sawProtocolFailure, true, `expected rejection for ${JSON.stringify(bad)}`);
    assert.equal(client.getStatus().lastDelivery.state, "pending");
  }

  // Duplicate counts as success; unknown eventId ACK is ignored.
  socket.emit("message", JSON.stringify({
    v: 1, type: "ACK", eventId: "env-loop-1", sequence: 51,
    outcome: "duplicate", code: null, stateGeneration: 9,
  }));
  assert.equal(client.getStatus().lastDelivery.state, "acknowledged");
  assert.equal(client.getStatus().lastDelivery.ack.outcome, "duplicate");

  // Busy retries the identical frame a finite number of times, then
  // terminalizes without ever reporting success.
  const busySent = client.sendEvent({
    type: "DJ_RELEASE",
    eventId: "env-release-1",
    sequence: 52,
    payload: { state: "released" },
  });
  assert.equal(busySent.sent, true);
  const releaseFrame = socket.sent.filter((f) => f.type === "DJ_RELEASE").at(-1);
  for (let i = 0; i < 2; i += 1) {
    socket.emit("message", JSON.stringify({
      v: 1, type: "ACK", eventId: "env-release-1", sequence: 52,
      outcome: "busy", code: "in_flight", stateGeneration: 3,
    }));
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
  const releaseFrames = socket.sent.filter((f) => f.type === "DJ_RELEASE" && f.sequence === 52);
  assert.ok(releaseFrames.length <= 2, "busy retry must be finite");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(["timed-out", "rejected"].includes(client.getStatus().lastDelivery.state));
  assert.equal(client.getStatus().lastDelivery.ok, false);
});

test("syndocal-envelope-v1 rejects malformed outbound payloads fail-closed and decodes only valid timeline states", async (t) => {
  EnvelopeWebSocket.instances = [];
  const warnings = [];
  const timelineStates = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v1",
    WebSocketImpl: EnvelopeWebSocket,
    heartbeatMs: 60_000,
    stateSyncProvider: () => ({ released: "not-a-boolean" }),
  });
  t.after(() => client.stop());
  client.on("warning", (warning) => warnings.push(warning));
  client.on("timeline-state", (state) => timelineStates.push(state));
  client.start();
  await flush();
  const socket = EnvelopeWebSocket.instances.at(-1);

  // Invalid snapshot blocks the state sync send entirely.
  const stateSyncFrames = socket.sent.filter((f) => f.type === "DJ_STATE_SYNC");
  assert.equal(stateSyncFrames.length, 0);
  assert.equal(socket.sent.some((f) => f.type === "DJ_TIMELINE_STATE_REQUEST"), false);
  assert.equal(client.getStatus().stateSync, "error");

  // Invalid beat jump payload is skipped, never placed on the wire.
  const badJump = client.sendEvent({
    type: "DJ_TIMELINE_BEAT_JUMP",
    eventId: "bad-jump",
    sequence: 61,
    payload: { bars: -3, timelineId: "show" },
  });
  assert.equal(badJump.skipped, true);
  assert.equal(badJump.reason, "invalid-payload");
  assert.equal(socket.sent.some((f) => f.type === "DJ_TIMELINE_BEAT_JUMP"), false);

  // Nested DJ_TIMELINE_STATE with exact payload fields is accepted...
  socket.emit("message", JSON.stringify({
    v: 1,
    type: "DJ_TIMELINE_STATE",
    agentId: "kdmx",
    sessionId: "session-1",
    sequence: 90,
    eventId: "ts-1",
    payload: { state: "running", loopActive: true, timelineId: "show-2026", positionBars: 128 },
  }));
  assert.equal(timelineStates.length, 1);
  assert.deepEqual(timelineStates[0], {
    type: "DJ_TIMELINE_STATE",
    state: "running",
    loopActive: true,
    timelineId: "show-2026",
    positionBars: 128,
    eventId: "ts-1",
    sequence: 90,
  });

  // ...while flat frames, wrong versions, extra payload fields, and invalid
  // enum values are rejected with a warning and never reach the router.
  for (const invalid of [
    // Flat generic-json shape must not be decoded on this wire.
    { type: "DJ_TIMELINE_STATE", eventId: "flat-1", sequence: 91, state: "running", loopActive: false, timelineId: "t", positionBars: 1 },
    { v: 2, type: "DJ_TIMELINE_STATE", agentId: "a", sessionId: "s", sequence: 92, eventId: "v2-1", payload: { state: "running", loopActive: false, timelineId: "t", positionBars: 1 } },
    { v: 1, type: "DJ_TIMELINE_STATE", agentId: "a", sessionId: "s", sequence: 93, eventId: "extra-1", payload: { state: "running", loopActive: false, timelineId: "t", positionBars: 1, bonus: true } },
    { v: 1, type: "DJ_TIMELINE_STATE", agentId: "a", sessionId: "s", sequence: 94, eventId: "enum-1", payload: { state: "warping", loopActive: false, timelineId: "t", positionBars: 1 } },
  ]) {
    socket.emit("message", JSON.stringify(invalid));
  }
  assert.equal(timelineStates.length, 1);
  assert.equal(warnings.length >= 3, true);
  assert.equal(warnings.every((w) => /Invalid DJ_TIMELINE_STATE/.test(w.message)), true);
});

test("Stage 1 local MIDI independence and Stage 2 network fail-closed gates hold on syndocal-envelope-v1", async (t) => {
  EnvelopeWebSocket.instances = [];
  const detector = createTrackActivityDetector({ idFactory: (() => {
    let id = 0;
    return () => `env-detector-${++id}`;
  })() });
  let router = null;
  const midiSends = [];
  const midi = {
    sendMapping: (name) => { midiSends.push(name); return true; },
    resolveTarget: (_name, targetDeck) => ({ targetDeck, targetChannel: 1 }),
    getStatus: () => ({ ok: true }),
    start() {},
    stop() {},
  };
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v1",
    WebSocketImpl: EnvelopeWebSocket,
    heartbeatMs: 60_000,
    stateSyncProvider: () => (router?.getStateSync() || {}),
  });
  t.after(() => client.stop());
  router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
  });
  router.onSnapshot({
    masterDeck: 1,
    deckNowPlaying: [{ deck: 1, contentId: "c1", title: "T", artist: "A", trackBpm: 120 }],
    deckPlaybacks: [{ deck: 1, isPlaying: true }],
  });
  client.start();
  await flush();

  // Stage 2 gates before an authoritative snapshot arrives.
  assert.equal(router.getStatus().timelineSnapshotReady, false);
  const blockedLoop = router.triggerAction("loop-half");
  // Stage 1 loop-half still drives local MIDI even while the snapshot gate is
  // closed; only Stage 2 aliases are gated.
  assert.deepEqual(midiSends.includes("loopHalf"), true);
  assert.equal(blockedLoop.delivery.state !== undefined, true);

  // Stage 2 actions stay blocked until running is authoritative.
  const blockedBeatJump = router.triggerAction("filter-close");
  assert.equal(blockedBeatJump.ok, false);
  assert.equal(blockedBeatJump.reason, "stage1-filter-disabled");
  const socket = EnvelopeWebSocket.instances.at(-1);
  assert.equal(socket.sent.some((f) => f.type === "DJ_TIMELINE_BEAT_JUMP"), false);

  socket.emit("message", JSON.stringify({
    v: 1,
    type: "DJ_TIMELINE_STATE",
    agentId: "kdmx",
    sessionId: "session-stage",
    sequence: 100,
    eventId: "ts-stage",
    payload: { state: "running", loopActive: false, timelineId: "show-stage", positionBars: 8 },
  }));
  assert.equal(router.getStatus().mode, "timeline-control");
  assert.equal(router.getStatus().timelineSnapshotReady, true);

  // Stage 2 maps release to beat-jump-minus-4 over the envelope wire and never
  // sends Rekordbox MIDI in timeline-control.
  midiSends.length = 0;
  const stage2 = router.triggerAction("release");
  const jumpFrame = socket.sent.filter((f) => f.type === "DJ_TIMELINE_BEAT_JUMP").at(-1);
  assertEnvelopeFrame(jumpFrame, "DJ_TIMELINE_BEAT_JUMP");
  assert.deepEqual(jumpFrame.payload, { bars: -4, timelineId: "show-stage" });
  assert.equal(midiSends.length, 0);
  assert.equal(stage2.delivery.sent, true);

  // Disconnecting suspends timeline control without falling back to MIDI.
  const modeBefore = router.getStatus().mode;
  socket.close();
  await flush();
  assert.equal(modeBefore, "timeline-control");
  assert.match(router.getStatus().lastTimelineWarning || "", /disconnected|suspended/i);
});

test("adapter selection is explicit: no silent fallback to generic-json", () => {
  const resolved = resolveAdapter({ adapter: "syndocal-envelope-v1", token: TEST_TOKEN });
  assert.equal(resolved.adapterObject.name, "syndocal-envelope-v1");
  assert.equal(resolved.error, null);

  const unknown = resolveAdapter({ adapter: "kdmx-turbo", token: TEST_TOKEN });
  assert.equal(unknown.adapterObject, null);
  assert.match(unknown.error, /no silent generic fallback/);

  const missing = resolveAdapter({ adapter: "", token: TEST_TOKEN });
  assert.equal(missing.adapterObject, null);
  assert.match(missing.error, /select generic-json explicitly/);

  // Short tokens fail at factory time for the envelope wire.
  const weakToken = resolveAdapter({ adapter: "syndocal-envelope-v1", token: "too-short" });
  assert.equal(weakToken.adapterObject, null);
  assert.match(weakToken.error, /32\.\.256/);

  // An explicitly requested generic-json adapter still resolves and keeps its
  // legacy flat encoding behavior byte-for-byte.
  const legacy = resolveAdapter({ adapter: "generic-json", token: TEST_TOKEN }).adapterObject;
  assert.equal(legacy.name, "generic-json");
  const flat = encodeFlatEvent({
    type: "DJ_LOOP_STATE",
    eventId: "legacy-1",
    sequence: 7,
    payload: { division: 1 },
  });
  assert.deepEqual(Object.keys(flat).sort(), ["division", "eventId", "sequence", "type"].sort());
  assert.equal(validateTypedAck({
    type: "ACK", eventId: "e", ok: true, message: "accepted", outcome: "accepted",
    sequence: 1, code: null, stateGeneration: 0,
  }).valid, true);
});

test("envelope ACK validator enforces the exact seven-field KDMX contract", () => {
  assert.equal(
    validateEnvelopeAck({ v: 1, type: "ACK", eventId: "e", sequence: 2, outcome: "accepted", code: null, stateGeneration: 0 }).valid,
    true,
  );
  assert.equal(
    validateEnvelopeAck({ v: 1, type: "ACK", eventId: "e", sequence: 2, outcome: "busy", code: "in_flight", stateGeneration: 0 }).valid,
    true,
  );
  assert.equal(validateEnvelopeAck(null).valid, false);
  assert.equal(validateEnvelopeAck({}).reason, "ack-fields-invalid");
  assert.equal(
    validateEnvelopeAck({ v: 1, type: "ACK", eventId: "", sequence: 2, outcome: "accepted", code: null, stateGeneration: 0 }).reason,
    "ack-event-id-invalid",
  );
  assert.equal(
    validateEnvelopeAck({ v: 1, type: "ACK", eventId: "e", sequence: 0, outcome: "accepted", code: null, stateGeneration: 0 }).valid,
    false,
  );
  assert.equal(
    validateEnvelopeAck({ v: 1, type: "ACK", eventId: "e", sequence: 2, outcome: "accepted", code: "ok", stateGeneration: -1 }).valid,
    false,
  );
  const adapter = createSyndocalEnvelopeV1Adapter({ token: TEST_TOKEN });
  assert.equal(adapter.isAck({ v: 1, type: "ACK" }), true);
  assert.equal(adapter.isAck({ type: "ACK" }), false);
  assert.equal(adapter.isStateSyncRequest({ type: "STATE_SYNC_REQUEST" }), false);
});

test("outbound envelope frames never leak the credential through public send events", async (t) => {
  EnvelopeWebSocket.instances = [];
  const publicMessages = [];
  const client = createSyndocalClient({
    enabled: true,
    token: TEST_TOKEN,
    adapter: "syndocal-envelope-v1",
    WebSocketImpl: EnvelopeWebSocket,
    heartbeatMs: 60_000,
    stateSyncProvider: () => ({}),
  });
  t.after(() => client.stop());
  client.on("sent", ({ message }) => publicMessages.push(message));
  client.start();
  await flush();
  assert.equal(publicMessages.length >= 3, true);
  for (const message of publicMessages) {
    assert.equal(JSON.stringify(message).includes(TEST_TOKEN), false);
  }
  // The wire itself still carries the credential exactly once in HELLO.
  const socket = EnvelopeWebSocket.instances.at(-1);
  const helloOnWire = socket.sent.find((frame) => frame.type === "DJ_AGENT_HELLO");
  assert.equal(helloOnWire.payload.authToken, TEST_TOKEN);
  assert.equal(socket.sent.filter((f) => f.type === "DJ_AGENT_HELLO").length, 1);
});

test("build identity is read-only, redacted for non-hex input, and version-matches package metadata", () => {
  const fixedNow = () => "2026-08-24T00:00:00.000Z";
  const identity = createBuildIdentity({
    env: {
      RB_OUTPUT_GIT_COMMIT: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
      RB_OUTPUT_SOURCE_FINGERPRINT: "deadbeef",
      SYNDOCAL_TOKEN: TEST_TOKEN,
      DJ_AGENT_CONFIG_PATH: "C:\\secrets\\config.json",
    },
    now: fixedNow,
  });
  assert.deepEqual(identity, {
    name: "rb-output",
    version: readPackageVersion(),
    gitCommit: "abcdef1234567890abcdef1234567890abcdef12",
    sourceFingerprint: "deadbeef",
    generatedAt: "2026-08-24T00:00:00.000Z",
    provenance: { status: "dev-unverified", identitySource: null, identityHash: null },
  });
  const serialized = JSON.stringify(identity);
  assert.equal(serialized.includes(TEST_TOKEN), false);
  assert.equal(serialized.includes("config.json"), false);
  assert.equal(Object.hasOwn(identity, "token"), false);
  assert.equal(Object.hasOwn(identity, "configPath"), false);

  assert.equal(hexIdentity("nothex"), null);
  assert.equal(hexIdentity("abc"), null);
  assert.equal(hexIdentity("g".repeat(40)), null);
  assert.equal(hexIdentity("a".repeat(65)), null);
  assert.equal(hexIdentity("a".repeat(64)), "a".repeat(64));
  assert.equal(hexIdentity(undefined), null);

  const minimal = createBuildIdentity({ env: {}, now: fixedNow });
  assert.equal(minimal.gitCommit, null);
  assert.equal(minimal.sourceFingerprint, null);
});
