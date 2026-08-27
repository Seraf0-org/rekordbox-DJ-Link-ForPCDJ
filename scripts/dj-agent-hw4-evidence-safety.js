"use strict";

// Shared safety boundary for HW-4 evidence capture. This module owns endpoint
// validation, scalar normalizers, and recursive secret/config rejection.

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
  "connected", "connecting", "disconnected", "disabled", "not-started", "unavailable",
]);
const STATE_SYNC_STATES = new Set(["not-sent", "sent", "error", "send-failed"]);
const TIMELINE_STATES = new Set(["unknown", "idle", "running", "stopped", "ended", "reset"]);
const TIMELINE_MODES = new Set(["dj-control", "handoff-pending", "timeline-control"]);
const PEDAL_OWNERS = new Set(["dj", "timeline"]);
const DELIVERY_STATES = new Set([
  "pending", "acknowledged", "rejected", "timed-out", "send-failed", "retrying", "skipped",
]);
const ACK_OUTCOMES = new Set(["accepted", "duplicate", "no_mapping", "rejected", "busy"]);
const EVENT_TYPES = new Set([
  "ACK", "DJ_STATE_SYNC", "DJ_TIMELINE_STATE", "DJ_TIMELINE_STATE_REQUEST",
  "DJ_TIMELINE_BEAT_JUMP", "DJ_TIMELINE_LOOP_SET", "DJ_TRACK_ACTIVE", "DJ_TRACK_SYNC",
  "DJ_LOOP_STATE", "DJ_LOOP_FALLBACK", "DJ_RELEASE",
]);
const LOOP_DIVISIONS = new Set(["8", "4", "2", "1", "1/2", "1/4", "1/8", "1/16", "1/32", "1/64"]);

// tokenConfigured is the only token-named output key and must remain a
// boolean readiness fact. Credential/config material is otherwise forbidden.
const SAFE_METADATA_KEYS = new Set(["tokenConfigured"]);
const SECRET_KEY_PARTS = [
  "token", "authtoken", "refreshtoken", "authorization", "password", "secret",
  "credential", "privatekey", "apikey", "accesskey", "signingkey", "clientsecret", "cookie",
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
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new EvidenceUsageError("endpoint-invalid");
  }
  if (!parsed.hostname || !isLiteralLoopbackHost(parsed.hostname)) {
    throw new EvidenceUsageError("endpoint-loopback-required");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new EvidenceUsageError("endpoint-credentials-or-query-forbidden");
  }
  if (
    parsed.pathname !== expectedPath ||
    parsed.port && (!/^\d+$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65_535)
  ) {
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
  if (text.length === 0 || text.length > MAX_SAFE_ID_LENGTH || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) {
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
  return typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(value) ? value : null;
}

function safeCode(value) {
  return typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(value) ? value : null;
}

function looksLikeHighEntropySecret(value) {
  if (typeof value !== "string" || value.length < 24 || value.length > 256 || !/^[A-Za-z0-9+/=]+$/.test(value)) {
    return false;
  }
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) || 0) + 1);
  if (counts.size < 8) return false;
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy >= 3.5;
}

function normalizedKey(key) {
  return String(key).replace(/[-_]/g, "").toLowerCase();
}

function keyContainsAny(key, parts) {
  const normalized = normalizedKey(key);
  return parts.some((part) => normalized.includes(part));
}

function assertTokenFree(value, { allowSourceConfigContainer = false, checkHighEntropy = true } = {}) {
  const stack = [{ value, depth: 0 }];
  const seen = new Set();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > 20_000 || current.depth > 40) throw new EvidenceCaptureError("redaction-bound exceeded");
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
    if (seen.has(current.value)) throw new EvidenceCaptureError("cyclic-response");
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      if (current.value.length > 1_000) throw new EvidenceCaptureError("array-bound-exceeded");
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (!isPlainRecord(current.value)) throw new EvidenceCaptureError("non-plain-response-value");
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
      stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  return value;
}

module.exports = {
  ACK_OUTCOMES,
  CONNECTION_STATES,
  DEFAULT_DEADLINE_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_SETUP_URL,
  DEFAULT_STATUS_URL,
  DEFAULT_TIMEOUT_MS,
  DELIVERY_STATES,
  EvidenceCaptureError,
  EvidenceUsageError,
  EVENT_TYPES,
  LOOP_DIVISIONS,
  MAX_DEADLINE_MS,
  MAX_INTERVAL_MS,
  MAX_RESPONSE_BYTES,
  MAX_SAFE_ID_LENGTH,
  MAX_TIMEOUT_MS,
  MAX_WATCH_SAMPLES,
  MIN_DEADLINE_MS,
  MIN_INTERVAL_MS,
  MIN_TIMEOUT_MS,
  PEDAL_OWNERS,
  SETUP_PATH,
  STATE_SYNC_STATES,
  STATUS_PATH,
  TIMELINE_MODES,
  TIMELINE_STATES,
  assertTokenFree,
  isPlainRecord,
  looksLikeHighEntropySecret,
  normalizedEndpoint,
  parseHttpEndpoint,
  safeBoolean,
  safeCode,
  safeEnum,
  safeId,
  safeInteger,
  safeNumber,
  safeReason,
  safeTimestamp,
};
