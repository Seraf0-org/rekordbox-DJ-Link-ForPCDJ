const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");

function makeId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const TIMELINE_STATES = new Set(["idle", "running", "stopped", "ended", "reset"]);
const SUPPORTED_EVENT_TYPES = new Set([
  "DJ_MASTER_TRACK_ACTIVE",
  "DJ_MASTER_TRACK_SYNC",
  "DJ_LOOP_STATE",
  "DJ_RELEASE",
  "DJ_TIMELINE_STATE_REQUEST",
  "DJ_TIMELINE_BEAT_JUMP",
  "DJ_TIMELINE_LOOP_SET",
]);
const PHYSICAL_EVENT_TYPES = new Set([
  "DJ_MASTER_TRACK_ACTIVE",
  "DJ_LOOP_STATE",
  "DJ_RELEASE",
  "DJ_TIMELINE_BEAT_JUMP",
  "DJ_TIMELINE_LOOP_SET",
]);
const TRANSIENT_TELEMETRY_TYPES = new Set(["DJ_MASTER_TRACK_SYNC"]);
const ACK_OUTCOMES = new Set(["accepted", "duplicate", "no_mapping", "rejected", "busy"]);
const DEFAULT_DELIVERY_HISTORY_MAX = 256;
const DEFAULT_MAX_PENDING_ACKS = 256;
const DEFAULT_PHYSICAL_EVENT_ID_REGISTRY_MAX = 262_144;
const MAX_STRING_UTF8_BYTES = 256;
const MIN_TOKEN_UTF8_BYTES = 32;
let processControlIdCounter = 0;

function makeControlId() {
  if (processControlIdCounter >= Number.MAX_SAFE_INTEGER) {
    return null;
  }
  processControlIdCounter += 1;
  return `control-${processControlIdCounter}-${makeId()}`;
}

function hasUnicodeControl(value) {
  if (/\p{Cc}/u.test(value)) {
    return true;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, fields) {
  if (!isPlainRecord(value)) {
    return false;
  }
  const allowed = new Set(fields);
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === fields.length &&
    keys.every((key) => typeof key === "string" && allowed.has(key)) &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function normalizeOptionalString(value, { allowNumber = false, rejectEdgeWhitespace = false } = {}) {
  if (allowNumber && typeof value === "number" && Number.isFinite(value)) {
    value = String(value);
  }
  if (typeof value !== "string") {
    return null;
  }
  if (hasUnicodeControl(value)) {
    return null;
  }
  if (
    !value ||
    value.trim() === "" ||
    (rejectEdgeWhitespace && value.trim() !== value) ||
    Buffer.byteLength(value, "utf8") > MAX_STRING_UTF8_BYTES
  ) {
    return null;
  }
  return value;
}

function normalizeIdentity(value) {
  return normalizeOptionalString(value, { rejectEdgeWhitespace: true });
}

function normalizeDeck(value) {
  return normalizeOptionalString(value, { allowNumber: true, rejectEdgeWhitespace: true });
}

function normalizeFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalField(source, name, normalizer) {
  if (!Object.hasOwn(source, name)) {
    return { present: false, valid: true, value: null };
  }
  if (source[name] === null) {
    return { present: true, valid: true, value: null };
  }
  const value = normalizer(source[name]);
  return { present: true, valid: value != null, value };
}

function optionalBooleanField(source, name) {
  if (!Object.hasOwn(source, name)) {
    return { present: false, valid: true, value: null };
  }
  if (source[name] === null) {
    return { present: true, valid: false, value: null };
  }
  return {
    present: true,
    valid: typeof source[name] === "boolean",
    value: typeof source[name] === "boolean" ? source[name] : null,
  };
}

function optionalNumberField(source, name) {
  if (!Object.hasOwn(source, name)) {
    return { present: false, valid: true, value: null };
  }
  if (source[name] === null) {
    return { present: true, valid: true, value: null };
  }
  const value = normalizeFiniteNumber(source[name]);
  return { present: true, valid: value != null, value };
}

let bundledWs = null;
try {
  // Literal require keeps the installed ws implementation visible to pkg.
  bundledWs = require("ws");
} catch {
  bundledWs = null;
}

function resolveWebSocketImplementation(moduleName = "ws") {
  if (moduleName === "ws" && bundledWs) {
    const implementation = bundledWs?.WebSocket || bundledWs?.default || bundledWs;
    return typeof implementation === "function" ? implementation : null;
  }
  if (moduleName) {
    try {
      const loaded = require(moduleName);
      const implementation = loaded?.WebSocket || loaded?.default || loaded;
      if (typeof implementation === "function") {
        return implementation;
      }
    } catch {
      return null;
    }
  }
  // Never silently use Node's global WebSocket: it does not accept the
  // headers/localAddress options used by this client.
  return null;
}

function addSocketListener(socket, name, handler) {
  if (!socket) {
    return () => {};
  }
  if (typeof socket.on === "function") {
    socket.on(name, handler);
    return () => {
      if (typeof socket.off === "function") {
        socket.off(name, handler);
      } else if (typeof socket.removeListener === "function") {
        socket.removeListener(name, handler);
      }
    };
  }
  const property = `on${name}`;
  socket[property] = handler;
  return () => {
    if (socket[property] === handler) {
      socket[property] = null;
    }
  };
}

function socketIsOpen(socket) {
  if (!socket) {
    return false;
  }
  if (typeof socket.readyState !== "number") {
    return true;
  }
  return socket.readyState === 1;
}

// Adapter names that may be reflected on externally readable status
// surfaces (/api/state, /api/status). Any other value - including a
// configured-but-unrecognized SYNDOCAL_WS_ADAPTER string - stays internal
// and is reported as null so hostile configuration is never echoed back.
const RECOGNIZED_ADAPTER_NAMES = new Set(["syndocal-envelope-v2"]);

function publicAdapterName(adapterObject) {
  const name = adapterObject && typeof adapterObject === "object" ? adapterObject.name : null;
  return RECOGNIZED_ADAPTER_NAMES.has(name) ? name : null;
}

// Stable, non-reflective reason for an unrecognized adapter selection: it
// must never embed the configured value, its length, or any derived
// fingerprint, because status.message/lastError are LAN-readable.
const UNRECOGNIZED_ADAPTER_ERROR =
  "Syndocal adapter must be syndocal-envelope-v2; flat and v1 protocols are retired and rejected";

function resolveAdapter({ adapter, adapterFactory, token }) {
  if (adapter && typeof adapter === "object") {
    return { adapterObject: adapter, error: null };
  }
  if (typeof adapterFactory === "function") {
    try {
      const adapterObject = adapterFactory({ token, name: adapter });
      if (!adapterObject || typeof adapterObject !== "object") {
        return { adapterObject: null, error: "Syndocal adapter factory returned no adapter" };
      }
      return { adapterObject, error: null };
    } catch (error) {
      return { adapterObject: null, error: error?.message || String(error) };
    }
  }
  const name = String(adapter || "").trim().toLocaleLowerCase();
  if (name === "syndocal-envelope-v2") {
    try {
      return { adapterObject: createSyndocalEnvelopeV2Adapter({ token }), error: null };
    } catch (error) {
      return { adapterObject: null, error: error?.message || String(error) };
    }
  }
  if (!name) {
    return {
      adapterObject: null,
      error: "Syndocal adapter is not configured; syndocal-envelope-v2 is required",
    };
  }
  return {
    adapterObject: null,
    error: UNRECOGNIZED_ADAPTER_ERROR,
  };
}

function validToken(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    /\s/u.test(value) ||
    hasUnicodeControl(value)
  ) {
    return false;
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  return byteLength >= MIN_TOKEN_UTF8_BYTES && byteLength <= MAX_STRING_UTF8_BYTES;
}

const ENVELOPE_V2_PROTOCOL_VERSION = 2;
const ENVELOPE_V2_MAX_SAMPLE_AGE_MS = 1_500;
const ENVELOPE_V2_MAX_FRAME_BYTES = 64 * 1024;
const ENVELOPE_V2_AGENT_ID = "rb-output-dj-agent";
const ENVELOPE_V2_PEDAL_OWNERS = new Set(["dj", "timeline"]);
const ENVELOPE_V2_ACK_FIELDS = ["v", "type", "eventId", "sequence", "outcome", "code", "stateGeneration"];

function v2EnvelopeStringOk(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_STRING_UTF8_BYTES &&
    !hasUnicodeControl(value)
  );
}

function validateEnvelopeV2Ack(message) {
  if (!isPlainRecord(message)) return { valid: false, reason: "ack-not-object" };
  if (!hasExactFields(message, ENVELOPE_V2_ACK_FIELDS)) {
    return { valid: false, reason: "ack-fields-invalid" };
  }
  if (message.v !== ENVELOPE_V2_PROTOCOL_VERSION) {
    return { valid: false, reason: "ack-version-invalid" };
  }
  if (message.type !== "ACK") return { valid: false, reason: "ack-type-mismatch" };
  const eventId = normalizeIdentity(message.eventId);
  if (!eventId || eventId !== message.eventId) {
    return { valid: false, reason: "ack-event-id-invalid" };
  }
  if (!Number.isSafeInteger(message.sequence) || message.sequence < 1) {
    return { valid: false, reason: "ack-sequence-invalid" };
  }
  if (!Number.isSafeInteger(message.stateGeneration) || message.stateGeneration < 0) {
    return { valid: false, reason: "ack-state-generation-invalid" };
  }
  if (typeof message.outcome !== "string" || !ACK_OUTCOMES.has(message.outcome)) {
    return { valid: false, reason: "ack-outcome-invalid" };
  }
  if (message.code !== null && !v2EnvelopeStringOk(message.code)) {
    return { valid: false, reason: "ack-code-invalid" };
  }
  return { valid: true, eventId, outcome: message.outcome };
}

function requiredString(payload, name) {
  const value = normalizeIdentity(payload?.[name]);
  return value && value === payload[name] ? value : null;
}

function strictFinite(payload, name, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const value = payload?.[name];
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return null;
  if (integer && !Number.isSafeInteger(value)) return null;
  return value;
}

function encodeV2Loop(loop) {
  if (loop === null) return null;
  if (!isPlainRecord(loop)) return undefined;
  const required = ["active", "startBeat", "endBeat", "lengthBeats", "revision", "sampleAgeMs", "source"];
  if (!hasExactFields(loop, required) || typeof loop.active !== "boolean") return undefined;
  const revision = strictFinite(loop, "revision", { min: 1, integer: true });
  const sampleAgeMs = strictFinite(loop, "sampleAgeMs", {
    min: 0,
    max: ENVELOPE_V2_MAX_SAMPLE_AGE_MS,
  });
  const source = requiredString(loop, "source");
  if (revision == null || sampleAgeMs == null || source !== "rekordbox-hook-measured") return undefined;
  const values = {};
  for (const name of ["startBeat", "endBeat", "lengthBeats"]) {
    if (loop[name] === null) values[name] = null;
    else {
      const value = strictFinite(loop, name, { min: 0 });
      if (value == null) return undefined;
      values[name] = value;
    }
  }
  if (
    loop.active &&
    (values.startBeat == null ||
      values.endBeat == null ||
      values.lengthBeats == null ||
      values.endBeat <= values.startBeat ||
      values.lengthBeats <= 0 ||
      Math.abs(values.endBeat - values.startBeat - values.lengthBeats) > 0.001)
  ) {
    return undefined;
  }
  return {
    active: loop.active,
    startBeat: values.startBeat,
    endBeat: values.endBeat,
    lengthBeats: values.lengthBeats,
    revision,
    sampleAgeMs,
    source,
  };
}

function encodeV2TrackSample(payload) {
  if (!isPlainRecord(payload)) return null;
  const deck = strictFinite(payload, "deck", { min: 1, max: 4, integer: true });
  const deckId = requiredString(payload, "deckId");
  const masterDeckRevision = strictFinite(payload, "masterDeckRevision", { min: 1, integer: true });
  const playSessionId = requiredString(payload, "playSessionId");
  const positionAtSendSec = strictFinite(payload, "positionAtSendSec", { min: 0, max: 7_200 });
  const effectiveBpm = strictFinite(payload, "effectiveBpm", { min: Number.MIN_VALUE, max: 1_000 });
  const positionRevision = strictFinite(payload, "positionRevision", { min: 1, integer: true });
  const sampleAgeMs = strictFinite(payload, "sampleAgeMs", {
    min: 0,
    max: ENVELOPE_V2_MAX_SAMPLE_AGE_MS,
  });
  if (
    deck == null ||
    deckId !== `rekordbox-deck-${deck}` ||
    masterDeckRevision == null ||
    !playSessionId ||
    positionAtSendSec == null ||
    effectiveBpm == null ||
    positionRevision == null ||
    sampleAgeMs == null ||
    payload.isPlaying !== true ||
    payload.master !== true
  ) {
    return null;
  }
  const contentId = payload.contentId === null ? null : normalizeIdentity(payload.contentId);
  const title = payload.title === null ? null : normalizeOptionalString(payload.title);
  const artist = payload.artist === null ? null : normalizeOptionalString(payload.artist);
  if ((payload.contentId !== null && !contentId) || (payload.title !== null && !title) || (payload.artist !== null && !artist)) {
    return null;
  }
  if (!contentId && (!title || !artist)) return null;
  const trackBpm = payload.trackBpm === null
    ? null
    : strictFinite(payload, "trackBpm", { min: Number.MIN_VALUE, max: 1_000 });
  if (payload.trackBpm !== null && trackBpm == null) return null;
  const startedAt = requiredString(payload, "startedAt");
  if (!startedAt || !Number.isFinite(Date.parse(startedAt))) return null;
  const loop = encodeV2Loop(payload.loop);
  if (loop === undefined) return null;
  return {
    deck,
    deckId,
    masterDeckRevision,
    contentId,
    title,
    artist,
    trackBpm,
    positionAtSendSec,
    effectiveBpm,
    positionRevision,
    sampleAgeMs,
    isPlaying: true,
    master: true,
    startedAt,
    playSessionId,
    loop,
  };
}

function encodeV2MeasuredLoop(payload) {
  if (!isPlainRecord(payload)) return null;
  const deck = strictFinite(payload, "deck", { min: 1, max: 4, integer: true });
  const deckId = requiredString(payload, "deckId");
  const masterDeckRevision = strictFinite(payload, "masterDeckRevision", { min: 1, integer: true });
  const playSessionId = requiredString(payload, "playSessionId");
  const loop = encodeV2Loop({
    active: payload.active,
    startBeat: payload.startBeat,
    endBeat: payload.endBeat,
    lengthBeats: payload.lengthBeats,
    revision: payload.revision,
    sampleAgeMs: payload.sampleAgeMs,
    source: payload.source,
  });
  if (
    deck == null ||
    deckId !== `rekordbox-deck-${deck}` ||
    masterDeckRevision == null ||
    !playSessionId ||
    !loop
  ) return null;
  return { deck, deckId, masterDeckRevision, playSessionId, ...loop };
}

function encodeV2Release(payload) {
  if (!isPlainRecord(payload) || payload.state !== "released") return null;
  const timelineId = requiredString(payload, "timelineId");
  const playSessionId = requiredString(payload, "playSessionId");
  if (!timelineId || !playSessionId) return null;
  return { state: "released", timelineId, playSessionId };
}

// Timeline command payloads accept exactly the canonical wire fields plus,
// optionally, the single intentional local-only metadata field the router
// supplies: source must be the exact string "pedal". Any other own key
// (including symbols), a missing wire field, or wrong metadata rejects the
// payload; only canonical wire fields are ever emitted onto the wire.
const V2_TIMELINE_COMMAND_LOCAL_SOURCE = "pedal";

function v2TimelineCommandShapeOk(payload, wireFields) {
  if (!isPlainRecord(payload)) return false;
  const keys = Reflect.ownKeys(payload);
  if (
    keys.length < wireFields.length ||
    keys.length > wireFields.length + 1 ||
    !keys.every((key) =>
      typeof key === "string" &&
      (wireFields.includes(key) || key === "source"))
  ) {
    return false;
  }
  if (!wireFields.every((field) => Object.hasOwn(payload, field))) return false;
  if (Object.hasOwn(payload, "source") && requiredString(payload, "source") !== V2_TIMELINE_COMMAND_LOCAL_SOURCE) {
    return false;
  }
  return true;
}

function encodeV2BeatJump(payload) {
  if (!v2TimelineCommandShapeOk(payload, ["bars", "timelineId", "playSessionId"])) return null;
  const bars = strictFinite(payload, "bars", { integer: true });
  const timelineId = requiredString(payload, "timelineId");
  const playSessionId = requiredString(payload, "playSessionId");
  return [-4, 4].includes(bars) && timelineId && playSessionId
    ? { bars, timelineId, playSessionId }
    : null;
}

function encodeV2LoopSet(payload) {
  if (!v2TimelineCommandShapeOk(payload, ["active", "timelineId", "playSessionId"])) return null;
  if (typeof payload.active !== "boolean") return null;
  const timelineId = requiredString(payload, "timelineId");
  const playSessionId = requiredString(payload, "playSessionId");
  return timelineId && playSessionId
    ? { active: payload.active, timelineId, playSessionId }
    : null;
}

function encodeV2TypedEvent(type, payload) {
  switch (type) {
    case "DJ_MASTER_TRACK_ACTIVE":
    case "DJ_MASTER_TRACK_SYNC":
      return encodeV2TrackSample(payload);
    case "DJ_LOOP_STATE":
      return encodeV2MeasuredLoop(payload);
    case "DJ_RELEASE":
      return encodeV2Release(payload);
    case "DJ_TIMELINE_BEAT_JUMP":
      return encodeV2BeatJump(payload);
    case "DJ_TIMELINE_LOOP_SET":
      return encodeV2LoopSet(payload);
    default:
      return null;
  }
}

function decodeV2TimelineState(message) {
  if (
    !isPlainRecord(message) ||
    message.v !== ENVELOPE_V2_PROTOCOL_VERSION ||
    message.type !== "DJ_TIMELINE_STATE" ||
    !hasExactFields(message, ["v", "type", "agentId", "sessionId", "sequence", "eventId", "payload"])
  ) return null;
  if (!v2EnvelopeStringOk(message.agentId) || !v2EnvelopeStringOk(message.sessionId)) return null;
  if (!Number.isSafeInteger(message.sequence) || message.sequence < 1) return null;
  if (!requiredString(message, "eventId")) return null;
  const payload = message.payload;
  const fields = [
    "state",
    "loopActive",
    "timelineId",
    "positionBars",
    "playSessionId",
    "pedalOwner",
    "releaseEventId",
  ];
  if (!isPlainRecord(payload) || !hasExactFields(payload, fields)) return null;
  if (typeof payload.state !== "string" || !TIMELINE_STATES.has(payload.state)) return null;
  if (typeof payload.loopActive !== "boolean") return null;
  const timelineId = payload.timelineId === null ? null : requiredString(payload, "timelineId");
  const playSessionId = payload.playSessionId === null ? null : requiredString(payload, "playSessionId");
  const releaseEventId = payload.releaseEventId === null ? null : requiredString(payload, "releaseEventId");
  const positionBars = strictFinite(payload, "positionBars", { min: 0, integer: true });
  if (
    (payload.timelineId !== null && !timelineId) ||
    (payload.playSessionId !== null && !playSessionId) ||
    (payload.releaseEventId !== null && !releaseEventId) ||
    positionBars == null ||
    !ENVELOPE_V2_PEDAL_OWNERS.has(payload.pedalOwner)
  ) return null;
  if (payload.state === "running" && (!timelineId || !playSessionId)) return null;
  if (payload.pedalOwner === "timeline" && (!playSessionId || !releaseEventId)) return null;
  return {
    type: "DJ_TIMELINE_STATE",
    state: payload.state,
    loopActive: payload.loopActive,
    timelineId,
    positionBars,
    playSessionId,
    pedalOwner: payload.pedalOwner,
    releaseEventId,
    // Session identity plus the monotonic per-session sequence let the
    // router fence same-session stale/equal replays without mutation.
    sessionId: message.sessionId,
    eventId: message.eventId,
    sequence: message.sequence,
  };
}

function createSyndocalEnvelopeV2Adapter({ token = "" } = {}) {
  if (!validToken(token)) {
    throw new Error("Syndocal syndocal-envelope-v2 token is required and must be 32..256 UTF-8 bytes");
  }
  let sessionId = null;
  const sessionIdFor = () => {
    if (!sessionId) sessionId = `rb-output-v2-${Date.now().toString(36)}-${makeId()}`;
    return sessionId;
  };
  const frame = ({ type, eventId, sequence }, payload) => ({
    v: ENVELOPE_V2_PROTOCOL_VERSION,
    type,
    agentId: ENVELOPE_V2_AGENT_ID,
    sessionId: sessionIdFor(),
    sequence,
    eventId,
    payload,
  });
  return {
    name: "syndocal-envelope-v2",
    validateAck: validateEnvelopeV2Ack,
    encodeHello({ eventId, sequence }) {
      sessionId = null;
      return frame({ type: "DJ_AGENT_HELLO", eventId, sequence }, {
        authToken: token,
        version: ENVELOPE_V2_PROTOCOL_VERSION,
        capabilities: [
          "DJ_MASTER_TRACK_ACTIVE",
          "DJ_MASTER_TRACK_SYNC",
          "DJ_LOOP_STATE",
          "DJ_RELEASE",
          "DJ_TIMELINE_BEAT_JUMP",
          "DJ_TIMELINE_LOOP_SET",
          "DJ_TIMELINE_STATE_REQUEST",
          "DJ_STATE_SYNC",
        ],
      });
    },
    encodeEvent(event) {
      if (!isPlainRecord(event) || !SUPPORTED_EVENT_TYPES.has(event.type)) return null;
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) return null;
      const eventId = normalizeIdentity(event.eventId);
      if (!eventId || eventId !== event.eventId) return null;
      const payload = event.type === "DJ_TIMELINE_STATE_REQUEST"
        ? {}
        : encodeV2TypedEvent(event.type, event.payload);
      return payload ? frame({ type: event.type, eventId, sequence: event.sequence }, payload) : null;
    },
    encodeStateSync({ eventId, sequence, state }) {
      if (!Number.isSafeInteger(sequence) || sequence < 1 || !normalizeIdentity(eventId)) return null;
      if (!isPlainRecord(state) || typeof state.released !== "boolean") return null;
      const masterDeck = state.masterDeck == null ? null : normalizeDeck(state.masterDeck);
      const activePlaySessionId = state.activePlaySessionId == null
        ? null
        : normalizeIdentity(state.activePlaySessionId);
      if ((state.masterDeck != null && !masterDeck) || (state.activePlaySessionId != null && !activePlaySessionId)) {
        return null;
      }
      return frame({ type: "DJ_STATE_SYNC", eventId, sequence }, {
        released: state.released,
        masterDeck,
        activePlaySessionId,
      });
    },
    encodeHeartbeat({ eventId, sequence }) {
      return frame({ type: "DJ_HEARTBEAT", eventId, sequence }, {});
    },
    encodeTimelineStateRequest({ eventId, sequence }) {
      return frame({ type: "DJ_TIMELINE_STATE_REQUEST", eventId, sequence }, {});
    },
    decode(data) {
      let text = data;
      if (data && typeof data === "object" && Object.hasOwn(data, "data")) text = data.data;
      if (Buffer.isBuffer(text)) text = text.toString("utf8");
      if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > ENVELOPE_V2_MAX_FRAME_BYTES) return null;
      try {
        const parsed = JSON.parse(text);
        return isPlainRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    isAck(message) {
      return Boolean(isPlainRecord(message) && message.v === ENVELOPE_V2_PROTOCOL_VERSION && message.type === "ACK");
    },
    isStateSyncRequest() {
      return false;
    },
    isTimelineState(message) {
      return Boolean(isPlainRecord(message) && message.v === ENVELOPE_V2_PROTOCOL_VERSION && message.type === "DJ_TIMELINE_STATE");
    },
    decodeTimelineState: decodeV2TimelineState,
  };
}

const DEFAULT_INTERVAL_API = Object.freeze({
  setInterval(callback, ms) {
    return setInterval(callback, ms);
  },
  clearInterval(handle) {
    clearInterval(handle);
  },
});

function resolveIntervalApi(intervalApi) {
  if (intervalApi == null) {
    return DEFAULT_INTERVAL_API;
  }
  if (
    (typeof intervalApi !== "object" && typeof intervalApi !== "function") ||
    typeof intervalApi.setInterval !== "function" ||
    typeof intervalApi.clearInterval !== "function"
  ) {
    throw new TypeError(
      "Syndocal intervalApi must be an object providing setInterval and clearInterval functions",
    );
  }
  return intervalApi;
}

function createSyndocalClient({
  enabled = false,
  host = "127.0.0.1",
  port = 9100,
  path = "/dj-link",
  nic = "",
  token = "",
  adapter = "syndocal-envelope-v2",
  adapterFactory = null,
  WebSocketImpl = null,
  wsModule = "ws",
  intervalApi = null,
  reconnectMinMs = 500,
  reconnectMaxMs = 10_000,
  heartbeatMs = 5_000,
  ackTimeoutMs = 5_000,
  busyRetryMaxAttempts = 3,
  busyRetryBaseMs = 100,
  busyRetryMaxMs = 1_000,
  deliveryHistoryMax = DEFAULT_DELIVERY_HISTORY_MAX,
  maxPendingAcks = DEFAULT_MAX_PENDING_ACKS,
  eventIdRegistryMax = DEFAULT_PHYSICAL_EVENT_ID_REGISTRY_MAX,
  requiresAckTypes = [],
  stateSyncProvider = () => ({}),
  now = () => Date.now(),
} = {}) {
  const emitter = new EventEmitter();
  const resolvedAdapter = resolveAdapter({ adapter, adapterFactory, token });
  let adapterError = resolvedAdapter.error;
  const adapterObject = resolvedAdapter.adapterObject;
  // The sole production wire contract requires a bounded HELLO credential.
  if (
    enabled &&
    adapterObject &&
    adapterObject.name === "syndocal-envelope-v2" &&
    !validToken(token)
  ) {
    adapterError = "Syndocal token is required and must be 32..256 UTF-8 bytes";
  }
  const url = `ws://${host}:${port}${String(path || "/dj-link").startsWith("/") ? path : `/${path}`}`;
  const ackTypes = new Set([
    ...PHYSICAL_EVENT_TYPES,
    ...(Array.isArray(requiresAckTypes) ? requiresAckTypes : []),
  ]);
  const maxBusyAttempts = Math.max(1, Math.trunc(Number(busyRetryMaxAttempts) || 1));
  const busyRetryBase = Math.max(0, Number(busyRetryBaseMs) || 0);
  const busyRetryCeiling = Math.max(busyRetryBase, Number(busyRetryMaxMs) || busyRetryBase);
  const maxDeliveryHistory = Math.max(1, Math.trunc(Number(deliveryHistoryMax) || DEFAULT_DELIVERY_HISTORY_MAX));
  const maxPending = Math.max(1, Math.trunc(Number(maxPendingAcks) || DEFAULT_MAX_PENDING_ACKS));
  const maxEventIds = Math.max(
    1,
    Math.trunc(Number(eventIdRegistryMax) || DEFAULT_PHYSICAL_EVENT_ID_REGISTRY_MAX),
  );
  const heartbeatInterval = Math.max(1, Number(heartbeatMs) || 1);
  const ackTimeout = Math.max(1, Number(ackTimeoutMs) || 1);
  const intervals = resolveIntervalApi(intervalApi);
  let socket = null;
  let socketGeneration = 0;
  let generationCounter = 0;
  let running = false;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let heartbeatArmed = false;
  let reconnectDelay = Math.max(50, reconnectMinMs);
  let wireSequence = 0;
  let physicalEventIdLatched = false;
  let lastDelivery = null;
  let lastAckResult = null;
  let status = {
    enabled: Boolean(enabled),
    state: enabled ? (adapterError ? "unavailable" : "disconnected") : "disabled",
    message: enabled
      ? adapterError || "Not connected"
      : "Syndocal integration disabled by config",
    url,
    nic: nic || null,
    adapter: publicAdapterName(adapterObject),
    updatedAt: new Date(now()).toISOString(),
    lastError: adapterError || null,
    lastAckAt: null,
    lastAckResult: null,
    lastDelivery: null,
    stateSync: "not-sent",
    wireSequence: 0,
    connectionGeneration: 0,
    pendingAcksMax: maxPending,
    eventIdRegistrySize: 0,
    eventIdRegistryMax: maxEventIds,
    physicalEventIdRegistrySize: 0,
    physicalEventIdRegistryMax: maxEventIds,
    physicalEventIdLatched: false,
    deliveryHistorySize: 0,
    deliveryHistoryMax: maxDeliveryHistory,
  };
  const pendingAcks = new Map();
  const deliveryHistory = new Map();
  const physicalEventIdRegistry = new Set();
  const socketCleanups = [];

  function updateStatus(patch) {
    status = {
      ...status,
      ...patch,
      enabled: Boolean(enabled),
      url,
      nic: nic || null,
      adapter: publicAdapterName(adapterObject),
      connectionGeneration: socketGeneration,
      wireSequence,
      lastAckResult: lastAckResult ? { ...lastAckResult } : null,
      lastDelivery: lastDelivery ? { ...lastDelivery } : null,
      pendingAcksMax: maxPending,
      eventIdRegistrySize: physicalEventIdRegistry.size,
      eventIdRegistryMax: maxEventIds,
      physicalEventIdRegistrySize: physicalEventIdRegistry.size,
      physicalEventIdRegistryMax: maxEventIds,
      physicalEventIdLatched,
      deliveryHistorySize: deliveryHistory.size,
      deliveryHistoryMax: maxDeliveryHistory,
      updatedAt: new Date(now()).toISOString(),
    };
    emitter.emit("status", { ...status });
  }

  function nextControlEnvelope() {
    if (wireSequence >= Number.MAX_SAFE_INTEGER) {
      return null;
    }
    const generated = makeControlId();
    if (!generated || physicalEventIdRegistry.has(generated)) {
      return null;
    }
    wireSequence += 1;
    return { eventId: generated, sequence: wireSequence };
  }

  function makeTransientTelemetryId(type, sequence) {
    if (
      !TRANSIENT_TELEMETRY_TYPES.has(type) ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1
    ) {
      return null;
    }
    // O(1), session-local identity: continuous telemetry is fenced by the
    // connection generation plus the globally monotonic wire sequence. It is
    // intentionally absent from the durable physical-event registry and is
    // never replayed after reconnect.
    return `telemetry-${socketGeneration}-${sequence}`;
  }

  function reportControlEnvelopeFailure(kind) {
    const reason = wireSequence >= Number.MAX_SAFE_INTEGER
      ? "control-sequence-overflow"
      : "control-id-admission-failed";
    updateStatus({ lastError: `Syndocal ${reason}` });
    emitter.emit("send-failed", { kind, reason });
    return false;
  }

  function reservePhysicalEventId(candidate) {
    const eventId = normalizeIdentity(candidate);
    if (
      !eventId ||
      eventId.startsWith("control-") ||
      eventId.startsWith("telemetry-") ||
      physicalEventIdRegistry.has(eventId)
    ) {
      return null;
    }
    if (physicalEventIdLatched || physicalEventIdRegistry.size >= maxEventIds) {
      physicalEventIdLatched = true;
      updateStatus({ lastError: "Syndocal physical event identity admission limit reached" });
      return null;
    }
    physicalEventIdRegistry.add(eventId);
    if (physicalEventIdRegistry.size >= maxEventIds) {
      physicalEventIdLatched = true;
    }
    return eventId;
  }

  function clearSocketListeners() {
    while (socketCleanups.length > 0) {
      socketCleanups.pop()();
    }
  }

  function clearHeartbeat() {
    if (!heartbeatArmed) {
      return;
    }
    heartbeatArmed = false;
    const handle = heartbeatTimer;
    heartbeatTimer = null;
    intervals.clearInterval(handle);
  }

  function trimDeliveryHistory() {
    while (deliveryHistory.size > maxDeliveryHistory) {
      const evictId = deliveryHistory.keys().next().value;
      if (evictId == null) {
        break;
      }
      deliveryHistory.delete(evictId);
    }
  }

  function publishDelivery(delivery, { ackResult = null } = {}) {
    const snapshot = { ...delivery };
    deliveryHistory.set(snapshot.eventId, snapshot);
    trimDeliveryHistory();
    lastDelivery = snapshot;
    if (ackResult) {
      lastAckResult = { ...ackResult };
    }
    updateStatus({ lastDelivery, lastAckResult });
    emitter.emit("delivery", snapshot);
    return snapshot;
  }

  function clearPendingTimers(pending) {
    if (!pending) {
      return;
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    if (pending.retryTimer) {
      clearTimeout(pending.retryTimer);
    }
    pending.timer = null;
    pending.retryTimer = null;
  }

  function finalizeDelivery(eventId, state, extra = {}, expected = null) {
    const pending = pendingAcks.get(eventId);
    if (!pending) {
      return null;
    }
    if (
      expected &&
      (expected.pending !== pending ||
        (expected.sequence !== undefined && expected.sequence !== pending.sequence) ||
        (expected.generation !== undefined && expected.generation !== pending.generation) ||
        (expected.socket && expected.socket !== pending.socket))
    ) {
      return null;
    }
    clearPendingTimers(pending);
    pendingAcks.delete(eventId);
    const delivery = pending.delivery;
    Object.assign(delivery, {
      state,
      ackState: state,
      ok: state === "acknowledged",
      updatedAt: new Date(now()).toISOString(),
      ...extra,
    });
    const ackResult =
      (delivery.ackRequired || ["rejected", "timed-out", "send-failed"].includes(state)) &&
      state !== "pending"
        ? {
            eventId: delivery.eventId,
            type: delivery.type,
            sequence: pending.sequence,
            ok: state === "acknowledged",
            state,
            message: delivery.message || null,
            outcome: delivery.ack?.outcome || null,
            code: delivery.ack?.code || null,
            stateGeneration: Number.isSafeInteger(delivery.ack?.stateGeneration)
              ? delivery.ack.stateGeneration
              : null,
            receivedAt: delivery.updatedAt,
          }
        : null;
    const snapshot = publishDelivery(delivery, { ackResult });
    if (state === "timed-out") {
      emitter.emit("ack-timeout", { eventId: delivery.eventId, type: delivery.type, delivery: snapshot });
    }
    return snapshot;
  }

  function finalizeAllPending(state, extra = {}) {
    for (const [eventId, pending] of [...pendingAcks.entries()]) {
      finalizeDelivery(eventId, state, extra, { pending });
    }
  }

  function scheduleReconnect() {
    if (!running || reconnectTimer || !enabled || adapterError) {
      return;
    }
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectMaxMs, Math.max(delay * 2, reconnectMinMs));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    updateStatus({ state: "disconnected", message: `Syndocal reconnect scheduled in ${delay}ms` });
  }

  function armAckTimeout(eventId, pending) {
    if (!pendingAcks.has(eventId)) {
      return;
    }
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (
        pendingAcks.get(eventId) === pending &&
        running &&
        socket === pending.socket &&
        socketGeneration === pending.generation
      ) {
        finalizeDelivery(eventId, "timed-out", { reason: "ack-timeout" }, { pending });
      } else {
        return;
      }
    }, ackTimeout);
  }

  function handleBusyAck(eventId, message, candidate, generation) {
    const pending = pendingAcks.get(eventId);
    if (
      !pending ||
      pending.socket !== candidate ||
      pending.generation !== generation ||
      socket !== candidate ||
      socketGeneration !== generation ||
      !running ||
      pending.sequence !== message.sequence
    ) {
      return null;
    }
    if (pending.retryTimer) {
      return { ...pending.delivery };
    }
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    const attempts = pending.attempts || 1;
    const busyRetries = pending.busyRetries || 0;
    if (attempts >= maxBusyAttempts) {
      return finalizeDelivery(
        eventId,
        "timed-out",
        {
          reason: "busy-retry-exhausted",
          message: message.message || message.error || "Syndocal remained busy",
          ack: message,
          busyRetries,
          attempts,
        },
        { pending, sequence: pending.sequence, generation, socket: candidate },
      );
    }
    pending.busyRetries = busyRetries + 1;
    pending.delivery.busyRetries = pending.busyRetries;
    pending.delivery.attempts = attempts;
    pending.delivery.reason = "busy";
    pending.delivery.message = message.message || message.error || "Syndocal busy";
    pending.delivery.updatedAt = new Date(now()).toISOString();
    const backoff = Math.min(
      busyRetryCeiling,
      busyRetryBase * (2 ** Math.max(0, pending.busyRetries - 1)),
    );
    pending.retryTimer = setTimeout(() => {
      pending.retryTimer = null;
      if (
        pendingAcks.get(eventId) !== pending ||
        !running ||
        socket !== pending.socket ||
        socketGeneration !== pending.generation
      ) {
        return;
      }
      pending.attempts = (pending.attempts || 1) + 1;
      const sent = sendRaw(pending.message, {
        kind: "event-retry",
        type: pending.type,
        eventId,
        attempt: pending.attempts,
        targetSocket: pending.socket,
        generation: pending.generation,
      });
      if (
        pendingAcks.get(eventId) !== pending ||
        !running ||
        socket !== pending.socket ||
        socketGeneration !== pending.generation
      ) {
        return;
      }
      pending.delivery.sent = sent;
      pending.delivery.attempts = pending.attempts;
      pending.delivery.reason = sent ? "busy-retry" : "not-sent";
      pending.delivery.updatedAt = new Date(now()).toISOString();
      if (!sent) {
        finalizeDelivery(
          eventId,
          "send-failed",
          { reason: "busy-retry-send-failed" },
          { pending, sequence: pending.sequence, generation: pending.generation, socket: pending.socket },
        );
        return;
      }
      publishDelivery(pending.delivery);
      armAckTimeout(eventId, pending);
    }, Math.max(0, backoff));
    publishDelivery(pending.delivery);
    return { ...pending.delivery };
  }

  function handleMessage(candidate, generation, raw) {
    if (
      !adapterObject ||
      !running ||
      socket !== candidate ||
      socketGeneration !== generation
    ) {
      return;
    }
    const message = adapterObject.decode?.(raw);
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      emitter.emit("message", raw);
      return;
    }
    emitter.emit("message", message);
    if (adapterObject.name === "syndocal-envelope-v2" && message.v !== ENVELOPE_V2_PROTOCOL_VERSION) {
      const failure = {
        reason: message.v === 1 ? "retired-protocol-v1" : "strict-envelope-v2-required",
        message,
      };
      updateStatus({ lastError: failure.reason });
      emitter.emit("protocol-failure", failure);
      return;
    }
    const looksLikeAck =
      message.type === "ACK" ||
      (typeof message.type === "string" && message.type.trim().toUpperCase() === "ACK") ||
      (Object.hasOwn(message, "eventId") && (
        Object.hasOwn(message, "outcome") ||
        Object.hasOwn(message, "stateGeneration") ||
        Object.hasOwn(message, "ok") ||
        Object.hasOwn(message, "message") ||
        Object.hasOwn(message, "code")
      ));
    if (looksLikeAck || adapterObject.isAck?.(message)) {
      const validation = typeof adapterObject.validateAck === "function"
        ? adapterObject.validateAck(message)
        : { valid: false, reason: "adapter-ack-validator-missing" };
      if (!validation.valid) {
        const failure = { reason: validation.reason, message };
        emitter.emit("protocol-failure", failure);
        emitter.emit("ack-ignored", failure);
        return;
      }
      const { eventId, outcome } = validation;
      const pending = eventId ? pendingAcks.get(eventId) : null;
      if (
        !eventId ||
        !pending ||
        pending.socket !== candidate ||
        pending.generation !== generation ||
        !Number.isSafeInteger(message.sequence) ||
        message.sequence !== pending.sequence
      ) {
        emitter.emit("ack-ignored", { reason: "unknown-or-stale", message });
        return;
      }
      if (outcome === "busy") {
        const delivery = handleBusyAck(eventId, message, candidate, generation);
        if (!delivery) {
          emitter.emit("ack-ignored", { reason: "pending-correlation-failed", message });
          return;
        }
        status.lastAckAt = new Date(now()).toISOString();
        updateStatus({ lastAckAt: status.lastAckAt });
        emitter.emit("ack", {
          eventId,
          ok: false,
          busy: true,
          message: { ...message },
          delivery,
        });
        return;
      }
      const ok = outcome === "accepted" || outcome === "duplicate";
      const delivery = finalizeDelivery(eventId, ok ? "acknowledged" : "rejected", {
        message: message.message || null,
        ack: message,
      }, { pending, sequence: message.sequence, generation, socket: candidate });
      if (!delivery) {
        emitter.emit("ack-ignored", { reason: "pending-correlation-failed", message });
        return;
      }
      status.lastAckAt = new Date(now()).toISOString();
      updateStatus({ lastAckAt: status.lastAckAt });
      emitter.emit("ack", {
        eventId,
        ok,
        message: { ...message },
        delivery,
      });
      return;
    }
    if (adapterObject.isStateSyncRequest?.(message)) {
      sendStateSync();
      return;
    }
    if (
      adapterObject.isTimelineState?.(message) ||
      (typeof message.type === "string" && message.type.trim() === "DJ_TIMELINE_STATE")
    ) {
      const timelineState = adapterObject.decodeTimelineState?.(message);
      if (!timelineState) {
        const warning = "Invalid DJ_TIMELINE_STATE ignored; expected state and boolean loopActive";
        updateStatus({ lastError: warning });
        emitter.emit("warning", { message: warning, type: "DJ_TIMELINE_STATE", raw: message });
        return;
      }
      emitter.emit("timeline-state", timelineState);
      return;
    }
    if (String(message.type || "").trim().startsWith("DJ_TIMELINE_")) {
      const warning = `Unknown Syndocal timeline message ignored: ${String(message.type)}`;
      updateStatus({ lastError: warning });
      emitter.emit("warning", { message: warning, type: String(message.type), raw: message });
    }
  }

  function publicMessage(message) {
    if (!message || typeof message !== "object") {
      return message;
    }
    let result = message;
    if (Object.hasOwn(result, "token")) {
      result = { ...result, token: "[redacted]" };
    }
    if (
      isPlainRecord(result.payload) &&
      Object.hasOwn(result.payload, "authToken")
    ) {
      result = { ...result, payload: { ...result.payload, authToken: "[redacted]" } };
    }
    return result;
  }

  function sendRaw(message, {
    kind = "message",
    targetSocket = socket,
    generation = socketGeneration,
    ...meta
  } = {}) {
    if (
      !targetSocket ||
      (generation && (socket !== targetSocket || socketGeneration !== generation || !running)) ||
      !socketIsOpen(targetSocket)
    ) {
      if (!generation || (socket === targetSocket && socketGeneration === generation && running)) {
        emitter.emit("send-failed", { kind, reason: "disconnected", message: publicMessage(message), ...meta });
      }
      return false;
    }
    try {
      targetSocket.send(JSON.stringify(message));
      emitter.emit("sent", { kind, message: publicMessage(message), ...meta });
      return true;
    } catch (error) {
      updateStatus({ lastError: error?.message || String(error), message: "Syndocal send failed" });
      emitter.emit("send-failed", { kind, reason: "send-error", error, message: publicMessage(message), ...meta });
      return false;
    }
  }

  function sendHeartbeat() {
    const envelope = nextControlEnvelope();
    if (!envelope) {
      return reportControlEnvelopeFailure("heartbeat");
    }
    const message = adapterObject?.encodeHeartbeat?.(envelope);
    if (!message) return reportControlEnvelopeFailure("heartbeat-encode");
    return sendRaw(message, { kind: "heartbeat" });
  }

  function startHeartbeat() {
    clearHeartbeat();
    heartbeatTimer = intervals.setInterval(sendHeartbeat, heartbeatInterval);
    heartbeatArmed = true;
  }

  function sendHello() {
    const envelope = nextControlEnvelope();
    if (!envelope) {
      return reportControlEnvelopeFailure("hello");
    }
    const message = adapterObject?.encodeHello?.(envelope);
    if (!message) return reportControlEnvelopeFailure("hello-encode");
    return sendRaw(message, { kind: "hello" });
  }

  function sendStateSync() {
    let state;
    try {
      if (typeof stateSyncProvider !== "function") {
        throw new TypeError("state-sync-provider-not-callable");
      }
      state = stateSyncProvider();
    } catch (error) {
      const failure = {
        kind: "state-sync",
        reason: "state-sync-provider-error",
        error,
      };
      updateStatus({
        stateSync: "error",
        lastError: "Syndocal state sync provider failed",
        message: "Syndocal state sync failed",
      });
      emitter.emit("state-sync-error", failure);
      emitter.emit("send-failed", failure);
      return false;
    }
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      const failure = {
        kind: "state-sync",
        reason: "invalid-state-sync",
      };
      updateStatus({
        stateSync: "error",
        lastError: "Syndocal state sync provider returned an invalid snapshot",
        message: "Syndocal state sync failed",
      });
      emitter.emit("state-sync-error", failure);
      emitter.emit("send-failed", failure);
      return false;
    }
    const envelope = nextControlEnvelope();
    if (!envelope) {
      const failure = { kind: "state-sync", reason: "control-sequence-overflow" };
      updateStatus({ stateSync: "error", lastError: failure.reason });
      emitter.emit("state-sync-error", failure);
      emitter.emit("send-failed", failure);
      return false;
    }
    let message;
    try {
      message = adapterObject?.encodeStateSync
        ? adapterObject.encodeStateSync({ ...envelope, state })
        : null;
    } catch (error) {
      const failure = { kind: "state-sync", reason: "state-sync-encode-error", error };
      updateStatus({
        stateSync: "error",
        lastError: "Syndocal state sync encoding failed",
        message: "Syndocal state sync failed",
      });
      emitter.emit("state-sync-error", failure);
      emitter.emit("send-failed", failure);
      return false;
    }
    if (!message) {
      const failure = { kind: "state-sync", reason: "invalid-state-sync" };
      updateStatus({
        stateSync: "error",
        lastError: "Syndocal state sync encoding rejected the snapshot",
        message: "Syndocal state sync failed",
      });
      emitter.emit("state-sync-error", failure);
      emitter.emit("send-failed", failure);
      return false;
    }
    const sent = sendRaw(message, { kind: "state-sync" });
    updateStatus({ stateSync: sent ? "sent" : "send-failed" });
    return sent;
  }

  function sendTimelineStateRequest() {
    if (typeof adapterObject?.encodeTimelineStateRequest !== "function") {
      return false;
    }
    const envelope = nextControlEnvelope();
    if (!envelope) {
      return reportControlEnvelopeFailure("timeline-state-request");
    }
    const message = adapterObject.encodeTimelineStateRequest(envelope);
    return sendRaw(message, { kind: "timeline-state-request" });
  }

  function sendControlEvent(type, source, requestedId) {
    if (requestedId) {
      return {
        eventId: requestedId,
        type,
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "control-event-id-not-accepted",
      };
    }
    const hasSequence = Object.hasOwn(source, "sequence");
    const controlEventSequence = hasSequence ? source.sequence : wireSequence + 1;
    if (!hasSequence && wireSequence >= Number.MAX_SAFE_INTEGER) {
      return {
        eventId: requestedId,
        type,
        sequence: controlEventSequence,
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "control-sequence-overflow",
      };
    }
    if (!Number.isSafeInteger(controlEventSequence) || controlEventSequence < 1) {
      return {
        eventId: requestedId,
        type,
        sequence: controlEventSequence,
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "invalid-sequence",
      };
    }
    if (hasSequence && controlEventSequence <= wireSequence) {
      return {
        eventId: requestedId,
        type,
        sequence: controlEventSequence,
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "sequence-rollback",
      };
    }
    const eventId = requestedId || makeControlId();
    if (!eventId) {
      return {
        eventId: null,
        type,
        sequence: controlEventSequence,
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "control-id-generation-failed",
      };
    }
    let message;
    try {
      message = adapterObject.encodeEvent
        ? adapterObject.encodeEvent({
            type,
            eventId,
            sequence: controlEventSequence,
            payload: Object.hasOwn(source, "payload") ? source.payload : {},
          })
        : null;
    } catch {
      message = null;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return {
        eventId,
        type,
        sequence: controlEventSequence,
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "invalid-payload",
      };
    }
    wireSequence = controlEventSequence;
    const delivery = {
      eventId,
      type,
      state: "pending",
      ackState: "pending",
      ok: false,
      sent: false,
      ackRequired: false,
      attempts: 1,
      busyRetries: 0,
      createdAt: new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
    };
    const sent = sendRaw(message, { kind: "control-event", type, eventId });
    delivery.sent = sent;
    delivery.state = sent ? "acknowledged" : "send-failed";
    delivery.ackState = delivery.state;
    delivery.ok = sent;
    delivery.reason = sent ? undefined : "not-sent";
    publishDelivery(delivery);
    return {
      eventId,
      sequence: controlEventSequence,
      type,
      sent,
      ackRequired: false,
      ok: delivery.ok,
      state: delivery.state,
      ackState: delivery.ackState,
      awaitingAck: false,
      delivery: { ...delivery },
    };
  }

  function sendPhysicalEncodedEvent({ eventId, type, sequence: eventSequence, message, requiresAck, event }) {
    const delivery = {
      eventId,
      type,
      state: "pending",
      ackState: "pending",
      ok: false,
      sent: false,
      ackRequired: requiresAck,
      attempts: 1,
      busyRetries: 0,
      createdAt: new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
    };
    if (!requiresAck) {
      const sent = sendRaw(message, { kind: "event", type, eventId, generation: socketGeneration });
      delivery.sent = sent;
      delivery.state = sent ? "acknowledged" : "send-failed";
      delivery.ackState = delivery.state;
      delivery.ok = sent;
      delivery.reason = sent ? null : "not-sent";
      publishDelivery(delivery);
      return {
        eventId,
        sequence: eventSequence,
        type,
        sent,
        ackRequired: false,
        ok: sent,
        state: delivery.state,
        ackState: delivery.state,
        awaitingAck: false,
        delivery: { ...delivery },
      };
    }
    const pending = {
      type,
      message,
      event: { ...event, payload: { ...(event?.payload || {}) } },
      sequence: eventSequence,
      generation: socketGeneration,
      socket,
      timer: null,
      retryTimer: null,
      attempts: 1,
      busyRetries: 0,
      delivery,
    };
    pendingAcks.set(eventId, pending);
    armAckTimeout(eventId, pending);
    publishDelivery(delivery);
    const sent = sendRaw(message, {
      kind: "event",
      type,
      eventId,
      generation: pending.generation,
    });
    delivery.sent = sent;
    if (!sent) {
      finalizeDelivery(
        eventId,
        "send-failed",
        { reason: "not-sent" },
        { pending, sequence: eventSequence, generation: pending.generation, socket: pending.socket },
      );
    } else if (pendingAcks.has(eventId)) {
      delivery.ackState = delivery.state;
      publishDelivery(delivery);
    } else {
      // A test or adapter may ACK synchronously from socket.send(). Refresh
      // the terminal snapshot with the truthful sent=true result.
      publishDelivery(delivery);
    }
    const finalDelivery = pendingAcks.get(eventId)?.delivery || delivery;
    return {
      eventId,
      sequence: eventSequence,
      type,
      sent,
      ackRequired: requiresAck,
      ok: finalDelivery.ok,
      state: finalDelivery.state,
      ackState: finalDelivery.state,
      awaitingAck: finalDelivery.state === "pending",
      delivery: { ...finalDelivery },
    };
  }

  function sendEvent(input) {
    const source = typeof input === "string" ? { type: input } : input;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      return {
        eventId: null,
        type: "",
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "invalid-event",
      };
    }
    if (typeof source.type !== "string") {
      return {
        eventId: null,
        type: "",
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "missing-type",
      };
    }
    const type = source.type;
    const transientTelemetry = TRANSIENT_TELEMETRY_TYPES.has(type);
    const requestedId = Object.hasOwn(source, "eventId") ? normalizeIdentity(source.eventId) : null;
    if (!type) {
      return { sent: false, ok: false, state: "send-failed", ackState: "send-failed", reason: "missing-type" };
    }
    if (Object.hasOwn(source, "eventId") && !requestedId) {
      return { eventId: null, type, sent: false, ok: false, skipped: true, state: "skipped", ackState: "skipped", reason: "invalid-event-id" };
    }
    if (!SUPPORTED_EVENT_TYPES.has(type)) {
      const skipped = {
        eventId: requestedId,
        type,
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "unsupported-type",
      };
      emitter.emit("skipped", skipped);
      return skipped;
    }
    if (type === "DJ_TIMELINE_STATE_REQUEST" && Object.hasOwn(source, "eventId")) {
      const skipped = {
        eventId: requestedId,
        type,
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "control-event-id-not-accepted",
      };
      emitter.emit("skipped", skipped);
      return skipped;
    }
    if (!adapterObject) {
      return {
        eventId: requestedId,
        type,
        sent: false,
        ok: false,
        state: "send-failed",
        ackState: "send-failed",
        reason: "adapter-unavailable",
      };
    }
    const requiresAck = ackTypes.has(type);
    if (requiresAck && pendingAcks.size >= maxPending) {
      updateStatus({ lastError: "Syndocal pending ACK admission limit reached" });
      return {
        eventId: requestedId,
        type,
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "pending-ack-limit",
      };
    }
    if (type === "DJ_TIMELINE_STATE_REQUEST") {
      if (
        Object.hasOwn(source, "payload") &&
        (!source.payload || typeof source.payload !== "object" || Array.isArray(source.payload))
      ) {
        return {
          eventId: requestedId,
          type,
          sent: false,
          ok: false,
          skipped: true,
          state: "skipped",
          ackState: "skipped",
          reason: "invalid-payload",
        };
      }
      return sendControlEvent(type, source, requestedId);
    }
    if (!transientTelemetry && requestedId && physicalEventIdRegistry.has(requestedId)) {
      return {
        eventId: requestedId,
        type,
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "event-id-reused",
      };
    }
    const hasSequence = Object.hasOwn(source, "sequence");
    const eventSequence = hasSequence ? source.sequence : wireSequence + 1;
    if (!hasSequence && wireSequence >= Number.MAX_SAFE_INTEGER) {
      return {
        eventId: requestedId,
        type,
        sequence: eventSequence,
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "sequence-overflow",
      };
    }
    if (!Number.isSafeInteger(eventSequence) || eventSequence < 1) {
      return {
        eventId: requestedId,
        type,
        sequence: eventSequence,
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "invalid-sequence",
      };
    }
    if (hasSequence && eventSequence <= wireSequence) {
      return {
        eventId: requestedId,
        type,
        sequence: eventSequence,
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "sequence-rollback",
      };
    }
    if (
      Object.hasOwn(source, "payload") &&
      (!source.payload || typeof source.payload !== "object" || Array.isArray(source.payload))
    ) {
      return {
        eventId: requestedId,
        type,
        sequence: eventSequence,
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "invalid-payload",
      };
    }
    const eventIdCandidate = transientTelemetry
      ? makeTransientTelemetryId(type, eventSequence)
      : requestedId || normalizeIdentity(makeId());
    if (!eventIdCandidate) {
      return {
        eventId: requestedId,
        type,
        sequence: eventSequence,
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "event-id-generation-failed",
      };
    }
    let eventId;
    try {
      const event = {
        type,
        eventId: eventIdCandidate,
        sequence: eventSequence,
        payload: Object.hasOwn(source, "payload") ? source.payload : {},
      };
      const message = adapterObject.encodeEvent ? adapterObject.encodeEvent(event) : null;
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        return {
          eventId: eventIdCandidate,
          type,
          sequence: eventSequence,
          sent: false,
          ok: false,
          skipped: true,
          state: "skipped",
          ackState: "skipped",
          reason: "invalid-payload",
        };
      }
      eventId = transientTelemetry ? eventIdCandidate : reservePhysicalEventId(eventIdCandidate);
      if (!eventId) {
        updateStatus({ lastError: "Syndocal event identity admission rejected" });
        return {
          eventId: requestedId,
          type,
          sequence: eventSequence,
          sent: false,
          ok: false,
          skipped: true,
          state: "skipped",
          ackState: "skipped",
          reason: eventIdCandidate.startsWith("control-")
            ? "event-id-conflicts-with-control"
            : eventIdCandidate.startsWith("telemetry-")
              ? "event-id-conflicts-with-telemetry"
            : requestedId && physicalEventIdRegistry.has(requestedId)
              ? "event-id-reused"
              : physicalEventIdLatched
                ? "event-id-admission-limit"
                : "event-id-admission-failed",
        };
      }
      wireSequence = eventSequence;
      return sendPhysicalEncodedEvent({
        eventId,
        type,
        sequence: eventSequence,
        message,
        requiresAck,
        event,
      });
    } catch {
      return {
        eventId: eventIdCandidate,
        type,
        sequence: eventSequence,
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "invalid-payload",
      };
    }
  }

  function isCurrentSocket(candidate, generation) {
    return Boolean(
      running &&
      candidate &&
      socket === candidate &&
      socketGeneration === generation,
    );
  }

  function teardownCurrent(candidate, generation, reason, error = null) {
    if (candidate && !isCurrentSocket(candidate, generation)) {
      return false;
    }
    if (candidate && socket !== candidate) {
      return false;
    }
    const closingSocket = candidate || socket;
    clearHeartbeat();
    clearSocketListeners();
    socket = null;
    socketGeneration = 0;
    for (const pending of pendingAcks.values()) {
      clearPendingTimers(pending);
      pending.socket = null;
      pending.generation = 0;
      pending.delivery.state = "retrying";
      pending.delivery.ackState = "retrying";
      pending.delivery.ok = false;
      pending.delivery.reason = reason;
      pending.delivery.updatedAt = new Date(now()).toISOString();
      publishDelivery(pending.delivery);
    }
    if (error) {
      updateStatus({
        state: "disconnected",
        message: "Syndocal connection error: " + (error?.message || String(error)),
        lastError: error?.message || String(error),
      });
    }
    if (closingSocket && typeof closingSocket.close === "function") {
      try {
        closingSocket.close();
      } catch {
        // Ignore close errors after a failed connection.
      }
    }
    return true;
  }

  function handleOpen(candidate, generation) {
    if (!isCurrentSocket(candidate, generation)) {
      return;
    }
    reconnectDelay = Math.max(50, reconnectMinMs);
    updateStatus({ state: "connected", message: "Syndocal connected", lastError: null });
    startHeartbeat();
    sendHello();
    const stateSyncSent = sendStateSync();
    if (stateSyncSent) {
      sendTimelineStateRequest();
    }
    for (const [eventId, pending] of pendingAcks) {
      if (!pending.event || wireSequence >= Number.MAX_SAFE_INTEGER) {
        finalizeDelivery(eventId, "send-failed", { reason: "reconnect-sequence-overflow" }, { pending });
        continue;
      }
      wireSequence += 1;
      const replayEvent = {
        ...pending.event,
        eventId,
        sequence: wireSequence,
        payload: { ...(pending.event.payload || {}) },
      };
      const replayMessage = adapterObject.encodeEvent?.(replayEvent);
      if (!replayMessage) {
        finalizeDelivery(eventId, "rejected", { reason: "reconnect-payload-invalid" }, { pending });
        continue;
      }
      clearPendingTimers(pending);
      pending.event = replayEvent;
      pending.message = replayMessage;
      pending.sequence = wireSequence;
      pending.socket = candidate;
      pending.generation = generation;
      pending.attempts += 1;
      pending.delivery.state = "pending";
      pending.delivery.ackState = "pending";
      pending.delivery.reason = "reconnect-retry";
      pending.delivery.attempts = pending.attempts;
      pending.delivery.sequence = wireSequence;
      const sent = sendRaw(replayMessage, {
        kind: "event-reconnect-retry",
        type: pending.type,
        eventId,
        generation,
        attempt: pending.attempts,
      });
      pending.delivery.sent = sent;
      pending.delivery.updatedAt = new Date(now()).toISOString();
      if (!sent && pendingAcks.has(eventId)) {
        finalizeDelivery(eventId, "send-failed", { reason: "reconnect-retry-send-failed" }, { pending });
      } else if (pendingAcks.has(eventId)) {
        publishDelivery(pending.delivery);
        armAckTimeout(eventId, pending);
      }
    }
    emitter.emit("connected", { url, generation });
  }

  function handleClose(candidate, generation, code, reason) {
    if (!isCurrentSocket(candidate, generation)) {
      return;
    }
    if (!teardownCurrent(candidate, generation, "connection-closed")) {
      return;
    }
    updateStatus({
      state: "disconnected",
      message: "Syndocal disconnected" + (code != null ? " (" + code + ")" : ""),
      closeCode: code ?? null,
      closeReason: reason ? String(reason) : null,
    });
    emitter.emit("disconnected", { code, reason, generation });
    scheduleReconnect();
  }

  function handleError(candidate, generation, error) {
    if (candidate && !isCurrentSocket(candidate, generation)) {
      return;
    }
    if (!teardownCurrent(candidate, generation, "connection-error", error)) {
      return;
    }
    emitter.emit("adapter-error", error);
    scheduleReconnect();
  }

  function connect() {
    if (!running || !enabled || socket) {
      return;
    }
    if (adapterError || !adapterObject) {
      running = false;
      updateStatus({ state: "unavailable", message: adapterError || "Syndocal adapter unavailable" });
      emitter.emit("unavailable", { reason: "adapter-unavailable", message: adapterError });
      return;
    }
    const Implementation = WebSocketImpl || resolveWebSocketImplementation(wsModule);
    if (typeof Implementation !== "function") {
      running = false;
      updateStatus({
        state: "unavailable",
        message: "Syndocal WebSocket unavailable; install optional ws dependency",
        lastError: "WebSocket implementation not found",
      });
      emitter.emit("unavailable", { reason: "missing-websocket-dependency" });
      return;
    }
    const generation = ++generationCounter;
    updateStatus({ state: "connecting", message: "Connecting to Syndocal " + url });
    const options = {};
    if (token) {
      options.headers = { Authorization: "Bearer " + token };
    }
    if (nic) {
      options.localAddress = nic;
    }
    let candidate;
    try {
      candidate = new Implementation(
        url,
        Object.keys(options).length > 0 ? options : undefined,
      );
    } catch (error) {
      handleError(null, generation, error);
      return;
    }
    socket = candidate;
    socketGeneration = generation;
    socketCleanups.push(addSocketListener(candidate, "open", () => handleOpen(candidate, generation)));
    socketCleanups.push(addSocketListener(candidate, "message", (raw) => handleMessage(candidate, generation, raw)));
    socketCleanups.push(addSocketListener(candidate, "error", (error) => handleError(candidate, generation, error)));
    socketCleanups.push(addSocketListener(candidate, "close", (code, reason) => handleClose(candidate, generation, code, reason)));
  }

  function start() {
    if (!enabled) {
      updateStatus({ state: "disabled", message: "Syndocal integration disabled by config" });
      return;
    }
    if (adapterError) {
      updateStatus({ state: "unavailable", message: adapterError, lastError: adapterError });
      emitter.emit("unavailable", { reason: "adapter-unavailable", message: adapterError });
      return;
    }
    if (running) {
      return;
    }
    running = true;
    connect();
  }

  function stop() {
    running = false;
    ++generationCounter;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    clearHeartbeat();
    const closingSocket = socket;
    clearSocketListeners();
    socket = null;
    socketGeneration = 0;
    finalizeAllPending("send-failed", { reason: "stopped" });
    if (closingSocket && typeof closingSocket.close === "function") {
      try {
        closingSocket.close();
      } catch {
        // Ignore close errors during process shutdown.
      }
    }
    if (enabled) {
      updateStatus({ state: adapterError ? "unavailable" : "disconnected", message: "Syndocal client stopped" });
    }
  }

  function getStatus() {
    return {
      ...status,
      pendingAcks: pendingAcks.size,
      pendingAcksMax: maxPending,
      eventIdRegistrySize: physicalEventIdRegistry.size,
      eventIdRegistryMax: maxEventIds,
      physicalEventIdRegistrySize: physicalEventIdRegistry.size,
      physicalEventIdRegistryMax: maxEventIds,
      wireSequence,
      physicalEventIdLatched,
      deliveryHistorySize: deliveryHistory.size,
      deliveryHistoryMax: maxDeliveryHistory,
      lastDelivery: lastDelivery ? { ...lastDelivery } : null,
      lastAckResult: lastAckResult ? { ...lastAckResult } : null,
    };
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    getStatus,
    sendEvent,
    sendStateSync,
    sendTimelineStateRequest,
    start,
    stop,
  };
}

module.exports = {
  createSyndocalClient,
  createSyndocalEnvelopeV2Adapter,
  decodeV2TimelineState,
  encodeV2MeasuredLoop,
  encodeV2Release,
  encodeV2TrackSample,
  resolveAdapter,
  resolveWebSocketImplementation,
  validateEnvelopeV2Ack,
};
