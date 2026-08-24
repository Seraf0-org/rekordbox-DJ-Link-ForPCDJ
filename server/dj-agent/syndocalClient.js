const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");

function makeId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const TIMELINE_STATES = new Set(["idle", "running", "stopped", "ended", "reset"]);
const SUPPORTED_EVENT_TYPES = new Set([
  "DJ_MASTER_CHANGED",
  "DJ_MASTER_TRACK_ACTIVE",
  "DJ_LOOP_STATE",
  "DJ_RELEASE",
  "DJ_TIMELINE_STATE_REQUEST",
  "DJ_TIMELINE_BEAT_JUMP",
  "DJ_TIMELINE_LOOP_SET",
]);
const PHYSICAL_EVENT_TYPES = new Set([
  "DJ_MASTER_CHANGED",
  "DJ_MASTER_TRACK_ACTIVE",
  "DJ_LOOP_STATE",
  "DJ_RELEASE",
  "DJ_TIMELINE_BEAT_JUMP",
  "DJ_TIMELINE_LOOP_SET",
]);
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

function normalizeMasterTrackState(track) {
  if (track == null) {
    return null;
  }
  if (!isPlainRecord(track)) {
    return null;
  }
  const normalized = { contentId: null, title: null, artist: null, isPlaying: false };
  for (const field of ["contentId", "title", "artist"]) {
    const result = optionalField(track, field, normalizeOptionalString);
    if (!result.valid) return null;
    normalized[field] = result.value;
  }
  const playing = Object.hasOwn(track, "isPlaying")
    ? optionalBooleanField(track, "isPlaying")
    : optionalBooleanField(track, "playing");
  if (!playing.valid || playing.value == null) return null;
  normalized.isPlaying = playing.value;
  return normalized;
}

function encodeFlatStateSync(state = {}) {
  if (!isPlainRecord(state)) {
    return null;
  }
  const loopDivision = optionalNumberField(state, "loopDivision");
  if (
    !loopDivision.valid ||
    (loopDivision.value != null &&
      (!Number.isInteger(loopDivision.value) || loopDivision.value < 0 || loopDivision.value > 63))
  ) {
    return null;
  }
  const released = Object.hasOwn(state, "released") ? state.released : false;
  if (typeof released !== "boolean") return null;
  const masterDeck = optionalField(state, "masterDeck", normalizeDeck);
  if (!masterDeck.valid) return null;
  if (Object.hasOwn(state, "masterTrack") && state.masterTrack === undefined) return null;
  const masterTrack = normalizeMasterTrackState(state.masterTrack);
  if (state.masterTrack != null && masterTrack == null) return null;
  return {
    loopDivision: loopDivision.value,
    released,
    masterDeck: masterDeck.value,
    masterTrack,
  };
}

function encodeFlatEvent(event = {}) {
  if (!isPlainRecord(event) || typeof event.type !== "string") {
    return null;
  }
  const type = event.type;
  const eventId = normalizeIdentity(event.eventId);
  if (!eventId || !Number.isSafeInteger(event.sequence) || event.sequence < 1) return null;
  if (
    Object.hasOwn(event, "payload") &&
    !isPlainRecord(event.payload)
  ) {
    return null;
  }
  const payload = event.payload || {};
  const envelope = { type, eventId, sequence: event.sequence };
  if (!SUPPORTED_EVENT_TYPES.has(type)) return null;

  switch (type) {
    case "DJ_MASTER_CHANGED": {
      const masterDeck = optionalField(payload, "masterDeck", normalizeDeck);
      const deck = optionalField(payload, "deck", normalizeDeck);
      const playing = Object.hasOwn(payload, "isPlaying")
        ? optionalBooleanField(payload, "isPlaying")
        : optionalBooleanField(payload, "playing");
      const master = optionalBooleanField(payload, "master");
      if (!masterDeck.valid || !deck.valid || (!masterDeck.value && !deck.value) || !playing.valid || !master.valid) {
        return null;
      }
      const message = { ...envelope };
      if (masterDeck.value) message.masterDeck = masterDeck.value;
      if (deck.value) message.deck = deck.value;
      if (playing.value != null) message.isPlaying = playing.value;
      if (master.value != null) message.master = master.value;
      return message;
    }
    case "DJ_MASTER_TRACK_ACTIVE": {
      const deck = normalizeDeck(Object.hasOwn(payload, "deck") ? payload.deck : payload.masterDeck);
      const playSessionId = normalizeOptionalString(payload.playSessionId);
      const playing = Object.hasOwn(payload, "isPlaying")
        ? optionalBooleanField(payload, "isPlaying")
        : optionalBooleanField(payload, "playing");
      const master = optionalBooleanField(payload, "master");
      if (deck == null || playSessionId == null || !playing.valid || playing.value !== true || !master.valid) {
        return null;
      }
      const message = {
        ...envelope,
        deck,
        playSessionId,
        isPlaying: true,
        master: master.value == null ? true : master.value,
      };
      for (const field of ["contentId", "title", "artist", "deckId", "startedAt"]) {
        const result = optionalField(payload, field, normalizeOptionalString);
        if (!result.valid) return null;
        if (result.value != null) message[field] = result.value;
      }
      const trackBpm = optionalNumberField(payload, "trackBpm");
      if (!trackBpm.valid || (trackBpm.value != null && (trackBpm.value < 0 || trackBpm.value > 1_000))) return null;
      if (trackBpm.value != null) message.trackBpm = trackBpm.value;
      const positionSec = optionalNumberField(payload, "positionSec");
      if (!positionSec.valid || (positionSec.value != null && positionSec.value < 0)) return null;
      if (positionSec.value != null) message.positionSec = positionSec.value;
      return message;
    }
    case "DJ_LOOP_STATE": {
      const division = optionalNumberField(payload, "division");
      const enabled = optionalBooleanField(payload, "enabled");
      if (!division.valid || division.value == null || !Number.isInteger(division.value) || division.value < 0 || division.value > 63 || !enabled.valid) {
        return null;
      }
      const message = { ...envelope, division: division.value };
      if (enabled.value != null) message.enabled = enabled.value;
      return message;
    }
    case "DJ_RELEASE": {
      const state = optionalField(payload, "state", normalizeOptionalString);
      if (!state.valid) return null;
      const message = { ...envelope };
      if (state.value != null) message.state = state.value;
      return message;
    }
    case "DJ_TIMELINE_STATE_REQUEST":
      return envelope;
    case "DJ_TIMELINE_BEAT_JUMP": {
      const bars = optionalNumberField(payload, "bars");
      const timelineId = optionalField(payload, "timelineId", normalizeOptionalString);
      if (!bars.valid || bars.value == null || !Number.isInteger(bars.value) || ![-4, 4].includes(bars.value) || !timelineId.valid || timelineId.value == null) {
        return null;
      }
      return { ...envelope, bars: bars.value, timelineId: timelineId.value };
    }
    case "DJ_TIMELINE_LOOP_SET": {
      const timelineId = optionalField(payload, "timelineId", normalizeOptionalString);
      const active = optionalBooleanField(payload, "active");
      if (!timelineId.valid || timelineId.value == null || !active.valid || active.value == null) {
        return null;
      }
      return { ...envelope, active: active.value, timelineId: timelineId.value };
    }
    default:
      return null;
  }
}

function normalizeTimelineState(message = {}) {
  const fields = [
    "type",
    "eventId",
    "sequence",
    "state",
    "loopActive",
    "timelineId",
    "positionBars",
  ];
  if (!hasExactFields(message, fields)) {
    return null;
  }
  if (message.type !== "DJ_TIMELINE_STATE") {
    return null;
  }
  if (typeof message.state !== "string" || !TIMELINE_STATES.has(message.state)) {
    return null;
  }
  if (typeof message.loopActive !== "boolean") {
    return null;
  }
  const eventId = normalizeIdentity(message.eventId);
  const timelineId = normalizeIdentity(message.timelineId);
  if (!eventId || eventId !== message.eventId || !timelineId || timelineId !== message.timelineId) {
    return null;
  }
  if (!Number.isSafeInteger(message.sequence) || message.sequence < 1) {
    return null;
  }
  if (!Number.isSafeInteger(message.positionBars) || message.positionBars < 0) {
    return null;
  }
  return {
    type: "DJ_TIMELINE_STATE",
    state: message.state,
    loopActive: message.loopActive,
    timelineId,
    positionBars: message.positionBars,
    eventId,
    sequence: message.sequence,
  };
}

function createGenericJsonAdapter({ token = "" } = {}) {
  return {
    name: "generic-json",
    encodeHello({ eventId, sequence }) {
      return {
        type: "DJ_AGENT_HELLO",
        eventId,
        sequence,
        protocol: "generic-json",
        token: token || undefined,
        capabilities: [
          "DJ_MASTER_CHANGED",
          "DJ_MASTER_TRACK_ACTIVE",
          "DJ_LOOP_STATE",
          "DJ_RELEASE",
          "DJ_TIMELINE_BEAT_JUMP",
          "DJ_TIMELINE_LOOP_SET",
          "DJ_TIMELINE_STATE",
          "DJ_TIMELINE_STATE_REQUEST",
          "DJ_STATE_SYNC",
        ],
      };
    },
    encodeEvent(event) {
      return encodeFlatEvent(event);
    },
    encodeStateSync({ eventId, sequence, state }) {
      const encoded = encodeFlatStateSync(state);
      return encoded ? {
        type: "DJ_STATE_SYNC",
        eventId,
        sequence,
        ...encoded,
      } : null;
    },
    encodeHeartbeat({ eventId, sequence }) {
      return {
        type: "DJ_HEARTBEAT",
        eventId,
        sequence,
        at: new Date().toISOString(),
      };
    },
    decode(data) {
      if (data && typeof data === "object" && "data" in data) {
        return this.decode(data.data);
      }
      if (data && typeof data === "object") {
        return data;
      }
      try {
        return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
      } catch {
        return null;
      }
    },
    isAck(message) {
      return Boolean(message && message.type === "ACK");
    },
    isStateSyncRequest(message) {
      return Boolean(
        message &&
          (message.type === "DJ_STATE_SYNC_REQUEST" || message.type === "STATE_SYNC_REQUEST")
      );
    },
    isTimelineState(message) {
      return Boolean(message && String(message.type || "").trim().toUpperCase() === "DJ_TIMELINE_STATE");
    },
    decodeTimelineState(message) {
      return normalizeTimelineState(message);
    },
    encodeTimelineStateRequest({ eventId, sequence }) {
      return {
        type: "DJ_TIMELINE_STATE_REQUEST",
        eventId,
        sequence,
      };
    },
  };
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
  if (name === "generic-json") {
    return { adapterObject: createGenericJsonAdapter({ token }), error: null };
  }
  if (name === "syndocal-envelope-v1") {
    try {
      return { adapterObject: createSyndocalEnvelopeV1Adapter({ token }), error: null };
    } catch (error) {
      return { adapterObject: null, error: error?.message || String(error) };
    }
  }
  if (!name) {
    return {
      adapterObject: null,
      error: "Syndocal adapter is not configured; select generic-json explicitly or provide an adapterFactory",
    };
  }
  return {
    adapterObject: null,
    error: `Syndocal adapter '${String(adapter)}' is unavailable; no silent generic fallback is allowed`,
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

function validateTypedAck(message) {
  const fields = [
    "type",
    "eventId",
    "ok",
    "message",
    "outcome",
    "sequence",
    "code",
    "stateGeneration",
  ];
  if (!hasExactFields(message, fields)) {
    return { valid: false, reason: "ack-fields-invalid" };
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { valid: false, reason: "ack-not-object" };
  }
  if (message.type !== "ACK") {
    return { valid: false, reason: "ack-type-mismatch" };
  }
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
  if (typeof message.ok !== "boolean") {
    return { valid: false, reason: "ack-ok-invalid" };
  }
  const ackMessage = normalizeOptionalString(message.message);
  if (!ackMessage || ackMessage !== message.message) {
    return { valid: false, reason: "ack-message-invalid" };
  }
  if (typeof message.outcome !== "string" || !ACK_OUTCOMES.has(message.outcome)) {
    return { valid: false, reason: "ack-outcome-invalid" };
  }
  if (
    message.code !== null &&
    (typeof message.code !== "string" ||
      hasUnicodeControl(message.code) ||
      Buffer.byteLength(message.code, "utf8") > MAX_STRING_UTF8_BYTES)
  ) {
    return { valid: false, reason: "ack-code-invalid" };
  }
  const successOutcome = message.outcome === "accepted" || message.outcome === "duplicate";
  if (message.outcome === "busy" && message.ok !== false) {
    return { valid: false, reason: "ack-busy-ok-inconsistent" };
  }
  if (message.outcome !== "busy" && message.ok !== successOutcome) {
    return { valid: false, reason: "ack-outcome-ok-inconsistent" };
  }
  return { valid: true, eventId, outcome: message.outcome };
}

// Dedicated KDMX/Syndocal legacy v1 envelope wire contract, traced from
// KDMX crates/protocol/src/lib.rs (DjLinkEnvelope/DjLinkAck and bounds) and
// crates/io/src/remote_ws.rs (handle_dj_link_client envelope branch). The
// envelope path is a distinct wire format from generic-json flat frames:
// every frame carries {v,type,agentId,sessionId,sequence,eventId,payload},
// typed payloads are deny-unknown-fields, and the server serializes
// DjLinkAck without ok/message on this wire.
const ENVELOPE_V1_PROTOCOL_VERSION = 1;
const ENVELOPE_V1_MAX_SEQUENCE = 9_007_199_254_740_991;
const ENVELOPE_V1_MAX_FRAME_BYTES = 64 * 1024;
const ENVELOPE_V1_AGENT_ID = "rb-output-dj-agent";
const ENVELOPE_ACK_FIELDS = ["v", "type", "eventId", "sequence", "outcome", "code", "stateGeneration"];

function envelopeStringOk(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_STRING_UTF8_BYTES &&
    !hasUnicodeControl(value)
  );
}

function validateEnvelopeAck(message) {
  if (!isPlainRecord(message)) {
    return { valid: false, reason: "ack-not-object" };
  }
  if (!hasExactFields(message, ENVELOPE_ACK_FIELDS)) {
    return { valid: false, reason: "ack-fields-invalid" };
  }
  if (message.v !== ENVELOPE_V1_PROTOCOL_VERSION) {
    return { valid: false, reason: "ack-version-invalid" };
  }
  if (message.type !== "ACK") {
    return { valid: false, reason: "ack-type-mismatch" };
  }
  const eventId = normalizeIdentity(message.eventId);
  if (!eventId || eventId !== message.eventId) {
    return { valid: false, reason: "ack-event-id-invalid" };
  }
  if (
    !Number.isSafeInteger(message.sequence) ||
    message.sequence < 1 ||
    message.sequence > ENVELOPE_V1_MAX_SEQUENCE
  ) {
    return { valid: false, reason: "ack-sequence-invalid" };
  }
  if (!Number.isSafeInteger(message.stateGeneration) || message.stateGeneration < 0) {
    return { valid: false, reason: "ack-state-generation-invalid" };
  }
  if (typeof message.outcome !== "string" || !ACK_OUTCOMES.has(message.outcome)) {
    return { valid: false, reason: "ack-outcome-invalid" };
  }
  if (
    message.code !== null &&
    !envelopeStringOk(message.code)
  ) {
    return { valid: false, reason: "ack-code-invalid" };
  }
  return { valid: true, eventId, outcome: message.outcome };
}

// Typed payload encoders mirror the KDMX DjLink*Payload serde structs
// exactly (required fields present, optional fields omitted when null,
// numeric/string bounds enforced before any send).
function encodeEnvelopeMasterChanged(payload = {}) {
  const masterDeck = optionalField(payload, "masterDeck", normalizeDeck);
  const deck = optionalField(payload, "deck", normalizeDeck);
  const playing = Object.hasOwn(payload, "isPlaying")
    ? optionalBooleanField(payload, "isPlaying")
    : optionalBooleanField(payload, "playing");
  const master = optionalBooleanField(payload, "master");
  if (!masterDeck.valid || !deck.valid || (!masterDeck.value && !deck.value) || !playing.valid || !master.valid) {
    return null;
  }
  const encoded = {};
  if (masterDeck.value) encoded.masterDeck = masterDeck.value;
  if (deck.value) encoded.deck = deck.value;
  encoded.isPlaying = playing.value != null ? playing.value : false;
  encoded.master = master.value != null ? master.value : true;
  return encoded;
}

function encodeEnvelopeMasterTrackActive(payload = {}) {
  const deck = normalizeDeck(Object.hasOwn(payload, "deck") ? payload.deck : payload.masterDeck);
  const playSessionId = normalizeOptionalString(payload.playSessionId);
  const playing = Object.hasOwn(payload, "isPlaying")
    ? optionalBooleanField(payload, "isPlaying")
    : optionalBooleanField(payload, "playing");
  const master = optionalBooleanField(payload, "master");
  if (deck == null || playSessionId == null || !playing.valid || playing.value !== true || !master.valid) {
    return null;
  }
  const encoded = { deck, playSessionId, isPlaying: true };
  for (const field of ["contentId", "title", "artist", "deckId", "startedAt"]) {
    const result = optionalField(payload, field, normalizeOptionalString);
    if (!result.valid) return null;
    if (result.value != null) encoded[field] = result.value;
  }
  const trackBpm = optionalNumberField(payload, "trackBpm");
  if (!trackBpm.valid || (trackBpm.value != null && (trackBpm.value < 0 || trackBpm.value > 1_000))) return null;
  if (trackBpm.value != null) encoded.trackBpm = trackBpm.value;
  const positionSec = optionalNumberField(payload, "positionSec");
  if (!positionSec.valid || (positionSec.value != null && positionSec.value < 0)) return null;
  if (positionSec.value != null) encoded.positionSec = positionSec.value;
  encoded.master = master.value == null ? true : master.value;
  return encoded;
}

function encodeEnvelopeLoopState(payload = {}) {
  const division = optionalNumberField(payload, "division");
  const enabled = optionalBooleanField(payload, "enabled");
  if (
    !division.valid ||
    division.value == null ||
    !Number.isInteger(division.value) ||
    division.value < 0 ||
    division.value > 63 ||
    !enabled.valid
  ) {
    return null;
  }
  return { division: division.value, enabled: enabled.value == null ? true : enabled.value };
}

function encodeEnvelopeRelease(payload = {}) {
  const state = optionalField(payload, "state", normalizeOptionalString);
  if (!state.valid) return null;
  const encoded = {};
  if (state.value != null) encoded.state = state.value;
  return encoded;
}

function encodeEnvelopeBeatJump(payload = {}) {
  const bars = optionalNumberField(payload, "bars");
  const timelineId = optionalField(payload, "timelineId", normalizeOptionalString);
  if (
    !bars.valid ||
    bars.value == null ||
    !Number.isInteger(bars.value) ||
    ![-4, 4].includes(bars.value) ||
    !timelineId.valid ||
    timelineId.value == null
  ) {
    return null;
  }
  return { bars: bars.value, timelineId: timelineId.value };
}

function encodeEnvelopeLoopSet(payload = {}) {
  const timelineId = optionalField(payload, "timelineId", normalizeOptionalString);
  const active = optionalBooleanField(payload, "active");
  if (!timelineId.valid || timelineId.value == null || !active.valid || active.value == null) {
    return null;
  }
  return { active: active.value, timelineId: timelineId.value };
}

function encodeEnvelopeTypedEvent(type, payload) {
  switch (type) {
    case "DJ_MASTER_CHANGED":
      return encodeEnvelopeMasterChanged(payload);
    case "DJ_MASTER_TRACK_ACTIVE":
      return encodeEnvelopeMasterTrackActive(payload);
    case "DJ_LOOP_STATE":
      return encodeEnvelopeLoopState(payload);
    case "DJ_RELEASE":
      return encodeEnvelopeRelease(payload);
    case "DJ_TIMELINE_BEAT_JUMP":
      return encodeEnvelopeBeatJump(payload);
    case "DJ_TIMELINE_LOOP_SET":
      return encodeEnvelopeLoopSet(payload);
    default:
      return null;
  }
}

function createSyndocalEnvelopeV1Adapter({ token = "" } = {}) {
  // The HELLO authToken must satisfy the KDMX DjLinkHelloPayload bounds
  // before any connection is attempted; fail at factory time instead of
  // sending an unauthenticated HELLO.
  if (!validToken(token)) {
    throw new Error("Syndocal syndocal-envelope-v1 token is required and must be 32..256 UTF-8 bytes");
  }
  const sessionIdFor = () => {
    // KDMX requires every envelope frame to repeat the HELLO agentId/sessionId
    // (a mismatch is rejected as session_mismatch), while a repeated HELLO
    // shape is admitted as Duplicate and the socket is closed. A fresh
    // session identity is minted per HELLO so reconnects never replay.
    if (!sessionId) {
      sessionId = `rb-output-${Date.now().toString(36)}-${makeId()}`;
    }
    return sessionId;
  };
  let sessionId = null;
  function envelopeFrame({ type, eventId, sequence }, payload) {
    const sessionIdValue = sessionIdFor();
    if (!sessionIdValue) {
      return null;
    }
    return {
      v: ENVELOPE_V1_PROTOCOL_VERSION,
      type,
      agentId: ENVELOPE_V1_AGENT_ID,
      sessionId: sessionIdValue,
      sequence,
      eventId,
      payload,
    };
  }
  return {
    name: "syndocal-envelope-v1",
    validateAck: validateEnvelopeAck,
    encodeHello({ eventId, sequence }) {
      // A new connection must not inherit a previous session identity.
      sessionId = null;
      return envelopeFrame({ type: "DJ_AGENT_HELLO", eventId, sequence }, {
        authToken: token,
        version: ENVELOPE_V1_PROTOCOL_VERSION,
        capabilities: [
          "DJ_MASTER_CHANGED",
          "DJ_MASTER_TRACK_ACTIVE",
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
      if (!isPlainRecord(event) || typeof event.type !== "string") {
        return null;
      }
      if (!SUPPORTED_EVENT_TYPES.has(event.type)) {
        return null;
      }
      // KDMX DjLinkTimelineStateRequestPayload is an empty deny-unknown-fields
      // struct; the request never carries payload fields on this wire.
      const encoded = event.type === "DJ_TIMELINE_STATE_REQUEST"
        ? {}
        : encodeEnvelopeTypedEvent(event.type, isPlainRecord(event.payload) ? event.payload : {});
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) {
        return null;
      }
      const eventId = normalizeIdentity(event.eventId);
      if (!eventId) return null;
      return encoded
        ? envelopeFrame({ type: event.type, eventId, sequence: event.sequence }, encoded)
        : null;
    },
    encodeStateSync({ eventId, sequence, state }) {
      if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
      const eventIdValue = normalizeIdentity(eventId);
      if (!eventIdValue) return null;
      const flat = encodeFlatStateSync(state);
      if (!flat) return null;
      const payload = { released: flat.released };
      if (flat.loopDivision != null) payload.loopDivision = flat.loopDivision;
      if (flat.masterDeck != null) payload.masterDeck = flat.masterDeck;
      if (flat.masterTrack != null) payload.masterTrack = flat.masterTrack;
      return envelopeFrame(
        { type: "DJ_STATE_SYNC", eventId: eventIdValue, sequence },
        payload,
      );
    },
    encodeHeartbeat({ eventId, sequence }) {
      return envelopeFrame({ type: "DJ_HEARTBEAT", eventId, sequence }, {});
    },
    encodeTimelineStateRequest({ eventId, sequence }) {
      return envelopeFrame({ type: "DJ_TIMELINE_STATE_REQUEST", eventId, sequence }, {});
    },
    decode(data) {
      let text;
      if (typeof data === "string") {
        text = data;
      } else if (Buffer.isBuffer(data)) {
        text = data.toString("utf8");
      } else if (data && typeof data === "object" && typeof data.data !== "undefined") {
        return this.decode(data.data);
      } else {
        return null;
      }
      if (Buffer.byteLength(text, "utf8") > ENVELOPE_V1_MAX_FRAME_BYTES) {
        return null;
      }
      try {
        const parsed = JSON.parse(text);
        return isPlainRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    isAck(message) {
      return Boolean(isPlainRecord(message) && message.v === ENVELOPE_V1_PROTOCOL_VERSION && message.type === "ACK");
    },
    isStateSyncRequest() {
      // The KDMX DJ Link server never solicits state sync on the v1
      // envelope wire; it only broadcasts DJ_TIMELINE_STATE frames.
      return false;
    },
    isTimelineState(message) {
      return Boolean(
        isPlainRecord(message) &&
          message.v === ENVELOPE_V1_PROTOCOL_VERSION &&
          message.type === "DJ_TIMELINE_STATE"
      );
    },
    decodeTimelineState(message) {
      if (
        !isPlainRecord(message) ||
        message.v !== ENVELOPE_V1_PROTOCOL_VERSION ||
        message.type !== "DJ_TIMELINE_STATE"
      ) {
        return null;
      }
      if (!envelopeStringOk(message.agentId) || !envelopeStringOk(message.sessionId)) {
        return null;
      }
      if (
        !Number.isSafeInteger(message.sequence) ||
        message.sequence < 1 ||
        message.sequence > ENVELOPE_V1_MAX_SEQUENCE
      ) {
        return null;
      }
      const payload = message.payload;
      if (!isPlainRecord(payload)) return null;
      const fields = ["state", "loopActive", "timelineId", "positionBars"];
      if (!hasExactFields(payload, fields)) {
        return null;
      }
      if (typeof payload.state !== "string" || !TIMELINE_STATES.has(payload.state)) {
        return null;
      }
      if (typeof payload.loopActive !== "boolean") {
        return null;
      }
      const eventId = normalizeIdentity(message.eventId);
      const timelineId = normalizeIdentity(payload.timelineId);
      if (!eventId || eventId !== message.eventId || !timelineId || timelineId !== payload.timelineId) {
        return null;
      }
      if (!Number.isSafeInteger(payload.positionBars) || payload.positionBars < 0) {
        return null;
      }
      return {
        type: "DJ_TIMELINE_STATE",
        state: payload.state,
        loopActive: payload.loopActive,
        timelineId,
        positionBars: payload.positionBars,
        eventId,
        sequence: message.sequence,
      };
    },
  };
}

function createSyndocalClient({
  enabled = false,
  host = "127.0.0.1",
  port = 9100,
  path = "/dj-link",
  nic = "",
  token = "",
  adapter = "generic-json",
  adapterFactory = null,
  WebSocketImpl = null,
  wsModule = "ws",
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
  // Both proven wire contracts require a bounded HELLO credential; the
  // envelope adapter additionally enforces this at factory time.
  if (
    enabled &&
    adapterObject &&
    (adapterObject.name === "generic-json" || adapterObject.name === "syndocal-envelope-v1") &&
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
  let socket = null;
  let socketGeneration = 0;
  let generationCounter = 0;
  let running = false;
  let reconnectTimer = null;
  let heartbeatTimer = null;
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
    adapter: adapterObject?.name || (String(adapter || "").trim() || null),
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
      adapter: adapterObject?.name || (String(adapter || "").trim() || null),
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
    if (!eventId || eventId.startsWith("control-") || physicalEventIdRegistry.has(eventId)) {
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
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
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
        : validateTypedAck(message);
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
    const message = adapterObject?.encodeHeartbeat
      ? adapterObject.encodeHeartbeat(envelope)
      : { type: "DJ_HEARTBEAT", ...envelope };
    return sendRaw(message, { kind: "heartbeat" });
  }

  function startHeartbeat() {
    clearHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, heartbeatInterval);
  }

  function sendHello() {
    const envelope = nextControlEnvelope();
    if (!envelope) {
      return reportControlEnvelopeFailure("hello");
    }
    const message = adapterObject?.encodeHello
      ? adapterObject.encodeHello(envelope)
      : { type: "DJ_AGENT_HELLO", ...envelope };
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
    let flatState = null;
    try {
      flatState = adapterObject?.name === "generic-json" ? encodeFlatStateSync(state) : true;
    } catch (error) {
      const failure = {
        kind: "state-sync",
        reason: "state-sync-validation-error",
        error,
      };
      updateStatus({
        stateSync: "error",
        lastError: "Syndocal state sync snapshot validation failed",
        message: "Syndocal state sync failed",
      });
      emitter.emit("state-sync-error", failure);
      emitter.emit("send-failed", failure);
      return false;
    }
    if (adapterObject?.name === "generic-json" && !flatState) {
      const failure = {
        kind: "state-sync",
        reason: "invalid-state-sync",
      };
      updateStatus({
        stateSync: "error",
        lastError: "Syndocal state sync snapshot failed KDMX validation",
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
      message = adapterObject?.name === "generic-json"
        ? { type: "DJ_STATE_SYNC", ...envelope, ...flatState }
        : adapterObject?.encodeStateSync
          ? adapterObject.encodeStateSync({ ...envelope, state })
          : { type: "DJ_STATE_SYNC", ...envelope, ...encodeFlatStateSync(state) };
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
    if (requestedId && physicalEventIdRegistry.has(requestedId)) {
      return {
        eventId: requestedId,
        type,
        sequence: controlEventSequence,
        sent: false,
        ok: false,
        skipped: true,
        state: "skipped",
        ackState: "skipped",
        reason: "control-id-conflicts-with-physical",
      };
    }
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
      message = adapterObject.name === "generic-json"
        ? encodeFlatEvent({
            type,
            eventId,
            sequence: controlEventSequence,
            payload: Object.hasOwn(source, "payload") ? source.payload : {},
          })
        : adapterObject.encodeEvent
          ? adapterObject.encodeEvent({
              type,
              eventId,
              sequence: controlEventSequence,
              payload: Object.hasOwn(source, "payload") ? source.payload : {},
            })
          : encodeFlatEvent({
            type,
            eventId,
            sequence: controlEventSequence,
            payload: Object.hasOwn(source, "payload") ? source.payload : {},
          });
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

  function sendPhysicalEncodedEvent({ eventId, type, sequence: eventSequence, message, requiresAck }) {
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
    const pending = {
      type,
      message,
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
    if (requestedId && physicalEventIdRegistry.has(requestedId)) {
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
    const eventIdCandidate = requestedId || normalizeIdentity(makeId());
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
      const message = adapterObject.name === "generic-json"
        ? encodeFlatEvent(event)
        : adapterObject.encodeEvent
          ? adapterObject.encodeEvent(event)
          : encodeFlatEvent(event);
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
      eventId = reservePhysicalEventId(eventIdCandidate);
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
    finalizeAllPending("send-failed", { reason });
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
  createGenericJsonAdapter,
  createSyndocalClient,
  createSyndocalEnvelopeV1Adapter,
  encodeFlatEvent,
  encodeFlatStateSync,
  normalizeTimelineState,
  resolveAdapter,
  resolveWebSocketImplementation,
  validateEnvelopeAck,
  validateTypedAck,
};
