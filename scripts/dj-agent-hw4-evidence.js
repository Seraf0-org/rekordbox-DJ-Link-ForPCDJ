#!/usr/bin/env node
"use strict";

// Read-only, token-free evidence capture for the already-running DJ Agent.
// This module only performs HTTP GET requests to the two diagnostic endpoints;
// it never starts, stops, restarts, or sends an action to any process.

const http = require("node:http");
const https = require("node:https");

const DEFAULT_STATUS_URL = "http://127.0.0.1:8787/api/dj-agent/status";
const DEFAULT_SETUP_URL = "http://127.0.0.1:8787/api/dj-agent/setup";
const STATUS_PATH = "/api/dj-agent/status";
const SETUP_PATH = "/api/dj-agent/setup";
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_WATCH_SAMPLES = 120;
const DEFAULT_INTERVAL_MS = 1_000;
const MIN_INTERVAL_MS = 50;
const MAX_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_DEADLINE_MS = 10_000;
const MIN_DEADLINE_MS = 100;
const MAX_DEADLINE_MS = 60_000;
const MAX_SAFE_ID_LENGTH = 256;

const CONNECTION_STATES = new Set([
  "connected",
  "connecting",
  "disconnected",
  "disabled",
  "not-started",
  "unavailable",
]);
const STATE_SYNC_STATES = new Set(["not-sent", "sent", "error", "send-failed"]);
const TIMELINE_STATES = new Set(["unknown", "idle", "running", "stopped", "ended", "reset"]);
const TIMELINE_MODES = new Set(["dj-control", "handoff-pending", "timeline-control"]);
const PEDAL_OWNERS = new Set(["dj", "timeline"]);
const DELIVERY_STATES = new Set([
  "pending",
  "acknowledged",
  "rejected",
  "timed-out",
  "send-failed",
  "retrying",
  "skipped",
]);
const ACK_OUTCOMES = new Set(["accepted", "duplicate", "no_mapping", "rejected", "busy"]);
const EVENT_TYPES = new Set([
  "ACK",
  "DJ_STATE_SYNC",
  "DJ_TIMELINE_STATE",
  "DJ_TIMELINE_STATE_REQUEST",
  "DJ_TIMELINE_BEAT_JUMP",
  "DJ_TIMELINE_LOOP_SET",
  "DJ_TRACK_ACTIVE",
  "DJ_TRACK_SYNC",
  "DJ_LOOP_STATE",
  "DJ_LOOP_FALLBACK",
  "DJ_RELEASE",
]);
const LOOP_DIVISIONS = new Set(["8", "4", "2", "1", "1/2", "1/4", "1/8", "1/16", "1/32", "1/64"]);

// `tokenConfigured` is deliberately the only token-named output key. It is a
// boolean readiness fact, never credential material. Everything else that
// looks like a credential or config key fails closed.
const SAFE_METADATA_KEYS = new Set(["tokenConfigured"]);
const SECRET_KEY_PARTS = [
  "token",
  "authtoken",
  "refreshtoken",
  "authorization",
  "password",
  "secret",
  "credential",
  "privatekey",
  "apikey",
  "accesskey",
  "signingkey",
  "clientsecret",
  "cookie",
];
const CONFIG_KEY_PARTS = ["config", "configuration", "environment", "env"];
const SECRET_VALUE_PATTERNS = [
  /(?:bearer|authorization|auth[_-]?token|access[_-]?(?:token|key)|signing[_-]?key|password|secret|credential)\s*[:=]\s*\S+/i,
  /(?:^|\s)bearer\s+\S+/i,
  /(?:^|[\s"'])token\s*[:=]\s*\S+/i,
  /(?:^|[?&#\s])(?:access[_-]?(?:token|key)|api[_-]?key|auth[_-]?token|credential|password|secret|signature|signing[_-]?key|token)\s*=\s*[^&#\s]+/i,
  /(?:%3f|%26)(?:access(?:%5f|[_-])?(?:token|key)|api(?:%5f|[_-])?key|auth(?:%5f|[_-])?token|credential|password|secret|signature|signing(?:%5f|[_-])?key|token)(?:%3d|=)[^%&#\s]+/i,
  /(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:$|[^A-Za-z0-9_-])/,
];
const PROVIDER_SECRET_VALUE_PATTERN = /(?:^|[^A-Za-z0-9])(?:sk-(?:proj|live|test)-|ghp_|github_pat_|xox[abpsr]-)[A-Za-z0-9][A-Za-z0-9_-]{5,}/i;

class EvidenceCaptureError extends Error {
  constructor(code) {
    super(`HW-4 evidence capture failed: ${code}`);
    this.name = "EvidenceCaptureError";
    this.code = code;
  }
}

class EvidenceUsageError extends Error {
  constructor(code) {
    super(`HW-4 evidence usage error: ${code}`);
    this.name = "EvidenceUsageError";
    this.code = code;
  }
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isLiteralLoopbackHost(hostname) {
  if (typeof hostname !== "string") return false;
  if (/^127(?:\.\d{1,3}){3}$/.test(hostname)) {
    return hostname.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  return hostname === "[::1]" || hostname === "::1";
}

function parseHttpEndpoint(value, expectedPath) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new EvidenceUsageError("endpoint-invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new EvidenceUsageError("endpoint-invalid");
  }
  if (!(["http:", "https:"].includes(parsed.protocol))) {
    throw new EvidenceUsageError("endpoint-invalid");
  }
  if (!parsed.hostname || !isLiteralLoopbackHost(parsed.hostname)) {
    throw new EvidenceUsageError("endpoint-loopback-required");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new EvidenceUsageError("endpoint-credentials-or-query-forbidden");
  }
  if (parsed.pathname !== expectedPath || parsed.port && (!/^\d+$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65_535)) {
    throw new EvidenceUsageError("endpoint-path-or-port-invalid");
  }
  return parsed;
}

function normalizedEndpoint(endpoint, expectedPath) {
  const parsed = endpoint instanceof URL ? endpoint : parseHttpEndpoint(endpoint, expectedPath);
  const port = parsed.port ? `:${parsed.port}` : "";
  return `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname}`;
}

function safeBoolean(value) {
  return typeof value === "boolean" ? value : null;
}

function safeInteger(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function safeNumber(value, { min = -Number.MAX_SAFE_VALUE, max = Number.MAX_SAFE_VALUE } = {}) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function safeTimestamp(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 80) return null;
  if (/\p{Cc}/u.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function safeId(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value);
  if (
    text.length === 0 ||
    text.length > MAX_SAFE_ID_LENGTH ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)
  ) {
    return null;
  }
  if (PROVIDER_SECRET_VALUE_PATTERN.test(text)) {
    throw new EvidenceCaptureError("provider-secret-shaped-value");
  }
  return text;
}

function safeEnum(value, allowed) {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function safeReason(value) {
  if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(value)) return null;
  return value;
}

function safeCode(value) {
  if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(value)) return null;
  return value;
}

function looksLikeHighEntropySecret(value) {
  if (
    typeof value !== "string" ||
    value.length < 24 ||
    value.length > 256 ||
    !/^[A-Za-z0-9+/=]+$/.test(value)
  ) {
    return false;
  }
  const counts = new Map();
  for (const character of value) {
    counts.set(character, (counts.get(character) || 0) + 1);
  }
  if (counts.size < 8) return false;
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 3.5;
}

function firstRecord(...values) {
  return values.find((value) => isPlainRecord(value)) || null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}

function projectAck(source) {
  const ack = isPlainRecord(source) ? source : {};
  return {
    eventId: safeId(ack.eventId),
    type: safeEnum(ack.type, EVENT_TYPES),
    sequence: safeInteger(ack.sequence, { min: 1 }),
    outcome: safeEnum(ack.outcome, ACK_OUTCOMES),
    code: safeCode(ack.code),
    stateGeneration: safeInteger(ack.stateGeneration),
    state: safeEnum(ack.state, DELIVERY_STATES),
    ok: safeBoolean(ack.ok),
    receivedAt: safeTimestamp(ack.receivedAt),
  };
}

function projectDelivery(source) {
  const delivery = isPlainRecord(source) ? source : {};
  return {
    eventId: safeId(delivery.eventId),
    type: safeEnum(delivery.type, EVENT_TYPES),
    state: safeEnum(delivery.state, DELIVERY_STATES),
    ackState: safeEnum(delivery.ackState, DELIVERY_STATES),
    ok: safeBoolean(delivery.ok),
    sent: safeBoolean(delivery.sent),
    ackRequired: safeBoolean(delivery.ackRequired),
    awaitingAck: safeBoolean(delivery.awaitingAck),
    attempts: safeInteger(delivery.attempts, { min: 0 }),
    busyRetries: safeInteger(delivery.busyRetries, { min: 0 }),
    reason: safeReason(delivery.reason),
    createdAt: safeTimestamp(delivery.createdAt),
    updatedAt: safeTimestamp(delivery.updatedAt),
    ack: projectAck(delivery.ack),
  };
}

function projectConnection(status) {
  const syndocal = isPlainRecord(status) ? status : {};
  return {
    state: safeEnum(syndocal.state, CONNECTION_STATES),
    connected: safeBoolean(syndocal.connected),
    adapter: syndocal.adapter === "syndocal-envelope-v3" ? syndocal.adapter : null,
    connectionGeneration: safeInteger(syndocal.connectionGeneration),
    wireSequence: safeInteger(syndocal.wireSequence),
    stateSync: safeEnum(syndocal.stateSync, STATE_SYNC_STATES),
    pendingAcks: safeInteger(syndocal.pendingAcks, { min: 0 }),
    lastAckAt: safeTimestamp(syndocal.lastAckAt),
    updatedAt: safeTimestamp(syndocal.updatedAt),
  };
}

function projectTimeline(status, state) {
  const router = isPlainRecord(status) ? status : {};
  const stateSync = isPlainRecord(state) ? state : {};
  const playSessionId = firstValue(router.timelinePlaySessionId, stateSync.timelinePlaySessionId);
  return {
    mode: safeEnum(router.mode, TIMELINE_MODES),
    state: safeEnum(router.timelineState, TIMELINE_STATES),
    loopActive: safeBoolean(router.timelineLoopActive),
    transitionHoldActive: safeBoolean(router.timelineTransitionHoldActive),
    id: safeId(router.timelineId),
    positionBars: safeNumber(router.timelinePositionBars, { min: 0, max: 1_000_000_000 }),
    snapshotReady: safeBoolean(router.timelineSnapshotReady),
    pedalOwner: safeEnum(router.timelinePedalOwner, PEDAL_OWNERS),
    playSessionId: safeId(playSessionId),
    releaseEventId: safeId(router.timelineReleaseEventId),
    lastAction: projectDelivery(router.lastTimelineAction?.delivery),
  };
}

function projectOwner(status, state) {
  const router = isPlainRecord(status) ? status : {};
  const stateSync = isPlainRecord(state) ? state : {};
  const ownerPresent = [
    router.ownerDeck,
    router.ownerDeckId,
    router.activePlaySessionId,
    router.ownerWireIdentity,
    router.ownerTrack,
    stateSync.ownerDeck,
    stateSync.ownerDeckId,
    stateSync.activePlaySessionId,
    stateSync.ownerWireIdentity,
    stateSync.ownerTrack,
  ].some((value) => value !== null && value !== undefined);
  const rawDeck = firstValue(router.ownerDeck, stateSync.ownerDeck);
  const deckText = typeof rawDeck === "number" || typeof rawDeck === "string" ? String(rawDeck) : "";
  return {
    present: ownerPresent,
    deck: deckText === "1" || deckText === "2" ? Number(deckText) : null,
  };
}

function projectSetup(setup) {
  const source = isPlainRecord(setup) ? setup : {};
  const readiness = isPlainRecord(source.readiness) ? source.readiness : {};
  const actions = isPlainRecord(readiness.actions) ? readiness.actions : {};
  const mapping = isPlainRecord(source.mappingArtifact) ? source.mappingArtifact : {};
  return {
    ok: safeBoolean(source.ok),
    localOnly: safeBoolean(source.localOnly),
    enabled: safeBoolean(source.enabled),
    // This is a boolean readiness fact only; the credential itself is never
    // accepted by the projection or written to evidence.
    tokenConfigured: safeBoolean(source.tokenConfigured),
    mapping: {
      valid: safeBoolean(mapping.valid),
      operatorVerified: safeBoolean(mapping.operatorVerified),
    },
    readiness: {
      state: safeEnum(readiness.state, new Set(["disabled", "ready", "blocked", "not-ready"])),
      ready: safeBoolean(readiness.ready),
      mappingAction: safeBoolean(actions.mapping),
      releaseMacroAction: safeBoolean(actions.releaseMacro),
    },
  };
}

function buildEvidenceSample({
  status,
  setup,
  observedAt,
  statusHttpStatus = 200,
  setupHttpStatus = 200,
  statusEndpoint = DEFAULT_STATUS_URL,
  setupEndpoint = DEFAULT_SETUP_URL,
} = {}) {
  if (!isPlainRecord(status) || !isPlainRecord(setup)) {
    throw new EvidenceCaptureError("response-shape-invalid");
  }
  const normalizedStatusEndpoint = normalizedEndpoint(statusEndpoint, STATUS_PATH);
  const normalizedSetupEndpoint = normalizedEndpoint(setupEndpoint, SETUP_PATH);
  const publicStatus = isPlainRecord(status.status) ? status.status : {};
  const publicState = isPlainRecord(status.state) ? status.state : {};
  const syndocal = isPlainRecord(publicStatus.syndocal) ? publicStatus.syndocal : {};
  const statusLastDelivery = firstRecord(
    syndocal.lastDelivery,
    publicStatus.lastDelivery,
    publicState.lastDelivery,
    publicState.lastAction?.delivery,
  );
  const statusLastAck = firstRecord(
    syndocal.lastAckResult,
    publicStatus.lastAckResult,
    statusLastDelivery?.ack,
    publicState.lastAction?.delivery?.ack,
  );
  const sessionId = firstValue(
    syndocal.sessionId,
    publicStatus.sessionId,
    publicState.sessionId,
    publicState.timelineSessionId,
    statusLastDelivery?.sessionId,
  );

  const sample = {
    observedAt: safeTimestamp(observedAt) || new Date().toISOString(),
    provenance: {
      transport: "http-get",
      statusEndpoint: normalizedStatusEndpoint,
      setupEndpoint: normalizedSetupEndpoint,
    },
    responses: {
      statusHttpStatus: safeInteger(statusHttpStatus, { min: 100, max: 599 }),
      setupHttpStatus: safeInteger(setupHttpStatus, { min: 100, max: 599 }),
    },
    agent: {
      enabled: safeBoolean(status.enabled),
      allowRemoteActions: safeBoolean(status.allowRemoteActions),
      ok: safeBoolean(publicStatus.ok),
      state: safeEnum(publicStatus.state, CONNECTION_STATES),
      updatedAt: safeTimestamp(publicStatus.updatedAt),
    },
    session: {
      sessionId: safeId(sessionId),
      playSessionId: safeId(firstValue(publicStatus.activePlaySessionId, publicState.activePlaySessionId)),
      connectionGeneration: safeInteger(syndocal.connectionGeneration),
    },
    connection: projectConnection(syndocal),
    state: {
      mode: safeEnum(publicStatus.mode, TIMELINE_MODES),
      timelineState: safeEnum(publicStatus.timelineState, TIMELINE_STATES),
      timelineLoopActive: safeBoolean(publicStatus.timelineLoopActive),
      timelineTransitionHoldActive: safeBoolean(publicStatus.timelineTransitionHoldActive),
      timelineSnapshotReady: safeBoolean(publicStatus.timelineSnapshotReady),
      released: safeBoolean(publicState.released),
      loopDivision: safeEnum(String(publicState.loopDivision ?? ""), LOOP_DIVISIONS),
    },
    ack: projectAck(statusLastAck),
    delivery: projectDelivery(statusLastDelivery),
    timeline: projectTimeline(publicStatus, publicState),
    owner: projectOwner(publicStatus, publicState),
    setup: projectSetup(setup),
  };
  assertTokenFree(sample);
  return sample;
}

function normalizedKey(key) {
  return String(key).replace(/[-_]/g, "").toLowerCase();
}

function keyContainsAny(key, parts) {
  const normalized = normalizedKey(key);
  return parts.some((part) => normalized.includes(part));
}

function assertTokenFree(value, { allowSourceConfigContainer = false, checkHighEntropy = true } = {}) {
  const stack = [{ value, path: "$", depth: 0 }];
  const seen = new Set();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > 20_000 || current.depth > 40) {
      throw new EvidenceCaptureError("redaction-bound exceeded");
    }
    if (typeof current.value === "string") {
      if (
        SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(current.value)) ||
        PROVIDER_SECRET_VALUE_PATTERN.test(current.value) ||
        (checkHighEntropy && looksLikeHighEntropySecret(current.value))
      ) {
        throw new EvidenceCaptureError("secret-shaped-value");
      }
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    if (seen.has(current.value)) {
      throw new EvidenceCaptureError("cyclic-response");
    }
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      if (current.value.length > 1_000) throw new EvidenceCaptureError("array-bound-exceeded");
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], path: `${current.path}[${index}]`, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isPlainRecord(current.value)) {
      throw new EvidenceCaptureError("non-plain-response-value");
    }
    const keys = Object.keys(current.value);
    if (keys.length > 256) throw new EvidenceCaptureError("object-bound-exceeded");
    for (const key of keys) {
      const child = current.value[key];
      const normalized = normalizedKey(key);
      if (SAFE_METADATA_KEYS.has(key)) {
        if (typeof child !== "boolean") throw new EvidenceCaptureError("token-metadata-invalid");
      } else if (
        keyContainsAny(key, SECRET_KEY_PARTS) ||
        (keyContainsAny(key, CONFIG_KEY_PARTS) && !(allowSourceConfigContainer && normalized === "configtemplate"))
      ) {
        throw new EvidenceCaptureError("secret-shaped-key");
      }
      stack.push({ value: child, path: `${current.path}.${key}`, depth: current.depth + 1 });
    }
  }
  return value;
}

function parseJsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new EvidenceCaptureError("response-json-invalid");
  }
}

function requestJson(endpoint, {
  label,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES,
  signal = null,
} = {}) {
  const expectedPath = label === "setup" ? SETUP_PATH : STATUS_PATH;
  const parsed = endpoint instanceof URL ? endpoint : parseHttpEndpoint(endpoint, expectedPath);
  if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE_BYTES) {
    throw new EvidenceCaptureError("response-bound-invalid");
  }
  const transport = parsed.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request = null;
    let removeAbortListener = null;
    let bytes = 0;
    const chunks = [];
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      removeAbortListener?.();
      if (error) reject(error);
      else resolve(result);
    };
    const abortRequest = () => {
      request?.destroy();
      finish(new EvidenceCaptureError(`${label}-aborted`));
    };
    if (signal) {
      if (signal.aborted) {
        finish(new EvidenceCaptureError(`${label}-aborted`));
        return;
      }
      signal.addEventListener("abort", abortRequest, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", abortRequest);
    }
    request = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname,
        method: "GET",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-store",
        },
        timeout: timeoutMs,
      },
      (response) => {
        response.setEncoding("utf8");
        response.once("aborted", () => finish(new EvidenceCaptureError(`${label}-response-aborted`)));
        response.once("error", () => finish(new EvidenceCaptureError(`${label}-response-failed`)));
        response.once("close", () => {
          if (!response.complete) finish(new EvidenceCaptureError(`${label}-response-aborted`));
        });
        response.on("data", (chunk) => {
          bytes += Buffer.byteLength(chunk, "utf8");
          if (bytes > maxBytes) {
            response.destroy();
            finish(new EvidenceCaptureError(`${label}-response-too-large`));
            return;
          }
          chunks.push(chunk);
        });
        response.once("end", () => {
          const statusCode = Number(response.statusCode);
          if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) {
            finish(new EvidenceCaptureError(`${label}-http-${Number.isInteger(statusCode) ? statusCode : "invalid"}`));
            return;
          }
          let body;
          try {
            body = parseJsonBody(chunks.join(""));
          } catch (error) {
            finish(error);
            return;
          }
          try {
            // Scan the source before projection. The real setup endpoint has a
            // token-free configTemplate container, but any token/credential
            // field inside it is an immediate fail-closed violation.
            assertTokenFree(body, { allowSourceConfigContainer: true, checkHighEntropy: false });
          } catch (error) {
            finish(error);
            return;
          }
          finish(null, { body, statusCode });
        });
      },
    );
    request.once("timeout", () => {
      request.destroy();
      finish(new EvidenceCaptureError(`${label}-timeout`));
    });
    request.once("error", () => finish(new EvidenceCaptureError(`${label}-request-failed`)));
    request.end();
  });
}

async function captureSample({
  statusUrl = DEFAULT_STATUS_URL,
  setupUrl = DEFAULT_SETUP_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  deadlineMs = DEFAULT_DEADLINE_MS,
} = {}) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < MIN_DEADLINE_MS || deadlineMs > MAX_DEADLINE_MS) {
    throw new EvidenceUsageError("deadline-out-of-range");
  }
  const statusEndpoint = parseHttpEndpoint(statusUrl, STATUS_PATH);
  const setupEndpoint = parseHttpEndpoint(setupUrl, SETUP_PATH);
  const observedAt = new Date().toISOString();
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const [status, setup] = await Promise.all([
      requestJson(statusEndpoint, { label: "status", timeoutMs, signal: controller.signal }),
      requestJson(setupEndpoint, { label: "setup", timeoutMs, signal: controller.signal }),
    ]);
    return buildEvidenceSample({
      status: status.body,
      setup: setup.body,
      observedAt,
      statusHttpStatus: status.statusCode,
      setupHttpStatus: setup.statusCode,
      statusEndpoint,
      setupEndpoint,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new EvidenceCaptureError("capture-deadline-exceeded");
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function captureEvidence({
  statusUrl = DEFAULT_STATUS_URL,
  setupUrl = DEFAULT_SETUP_URL,
  watchCount = 1,
  intervalMs = DEFAULT_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  deadlineMs = DEFAULT_DEADLINE_MS,
} = {}) {
  if (!Number.isSafeInteger(watchCount) || watchCount < 1 || watchCount > MAX_WATCH_SAMPLES) {
    throw new EvidenceUsageError("watch-count-out-of-range");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw new EvidenceUsageError("interval-out-of-range");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new EvidenceUsageError("timeout-out-of-range");
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < MIN_DEADLINE_MS || deadlineMs > MAX_DEADLINE_MS) {
    throw new EvidenceUsageError("deadline-out-of-range");
  }
  const samples = [];
  for (let index = 0; index < watchCount; index += 1) {
    samples.push(await captureSample({ statusUrl, setupUrl, timeoutMs, deadlineMs }));
    if (index + 1 < watchCount) await sleep(intervalMs);
  }
  const document = {
    schemaVersion: 1,
    kind: "dj-agent-hw4-evidence",
    mode: watchCount === 1 ? "once" : "watch",
    sampleCount: samples.length,
    samples,
  };
  assertTokenFree(document);
  return document;
}

const USAGE = `Usage: node scripts/dj-agent-hw4-evidence.js [options]

Read-only GET capture from the local DJ Agent status/setup APIs.
The output is token-free JSON; redirect stdout to an evidence file.

Options:
  --watch COUNT       Capture 2..120 bounded samples (default: one sample, no --watch)
  --interval-ms MS    Delay between samples, 50..60000 (default: 1000)
  --timeout-ms MS     Per-request timeout, 100..30000 (default: 5000)
  --deadline-ms MS    Total wall-clock deadline per sample, 100..60000 (default: 10000)
  --status-url URL    Exact literal-loopback status URL (no query/credentials)
  --setup-url URL     Exact literal-loopback setup URL (no query/credentials)
  --help              Show this usage text

The recorder sends only HTTP GET requests and never controls a process or an
action route. Run it on the DJ PC so setup remains localhost-only.
`;

function parsePositiveInteger(value, code) {
  if (!/^\d+$/.test(value || "")) throw new EvidenceUsageError(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new EvidenceUsageError(code);
  return parsed;
}

function parseArgs(argv = []) {
  const options = {
    statusUrl: DEFAULT_STATUS_URL,
    setupUrl: DEFAULT_SETUP_URL,
    watchCount: 1,
    watchProvided: false,
    intervalMs: DEFAULT_INTERVAL_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    deadlineMs: DEFAULT_DEADLINE_MS,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    if (!["--watch", "--interval-ms", "--timeout-ms", "--deadline-ms", "--status-url", "--setup-url"].includes(arg)) {
      throw new EvidenceUsageError("argument-invalid");
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new EvidenceUsageError("argument-value-missing");
    index += 1;
    if (arg === "--watch") {
      options.watchProvided = true;
      options.watchCount = parsePositiveInteger(value, "watch-count-invalid");
    }
    else if (arg === "--interval-ms") options.intervalMs = parsePositiveInteger(value, "interval-invalid");
    else if (arg === "--timeout-ms") options.timeoutMs = parsePositiveInteger(value, "timeout-invalid");
    else if (arg === "--deadline-ms") options.deadlineMs = parsePositiveInteger(value, "deadline-invalid");
    else if (arg === "--status-url") options.statusUrl = value;
    else if (arg === "--setup-url") options.setupUrl = value;
  }
  if (!options.help) {
    parseHttpEndpoint(options.statusUrl, STATUS_PATH);
    parseHttpEndpoint(options.setupUrl, SETUP_PATH);
    if ((options.watchProvided && options.watchCount < 2) || options.watchCount > MAX_WATCH_SAMPLES) {
      throw new EvidenceUsageError("watch-count-out-of-range");
    }
    if (options.intervalMs < MIN_INTERVAL_MS || options.intervalMs > MAX_INTERVAL_MS) {
      throw new EvidenceUsageError("interval-out-of-range");
    }
    if (options.timeoutMs < MIN_TIMEOUT_MS || options.timeoutMs > MAX_TIMEOUT_MS) {
      throw new EvidenceUsageError("timeout-out-of-range");
    }
    if (options.deadlineMs < MIN_DEADLINE_MS || options.deadlineMs > MAX_DEADLINE_MS) {
      throw new EvidenceUsageError("deadline-out-of-range");
    }
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[ERROR] ${error instanceof EvidenceUsageError ? error.message : "HW-4 evidence usage error"}`);
    return 64;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    const document = await captureEvidence(options);
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof EvidenceCaptureError || error instanceof EvidenceUsageError
      ? error.code
      : "capture-failed";
    console.error(`[ERROR] HW-4 evidence capture failed: ${code}`);
    return 1;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  ACK_OUTCOMES,
  DEFAULT_DEADLINE_MS,
  DEFAULT_SETUP_URL,
  DEFAULT_STATUS_URL,
  EvidenceCaptureError,
  EvidenceUsageError,
  MAX_RESPONSE_BYTES,
  MAX_WATCH_SAMPLES,
  assertTokenFree,
  buildEvidenceSample,
  captureEvidence,
  captureSample,
  parseArgs,
  parseHttpEndpoint,
  projectAck,
  projectDelivery,
};
