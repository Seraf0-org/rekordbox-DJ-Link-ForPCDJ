"use strict";

// Read-only HTTP capture for the already-running DJ Agent. Only diagnostic
// GETs are issued; no process or action route is started, stopped, or changed.

const http = require("node:http");
const https = require("node:https");
const {
  DEFAULT_DEADLINE_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_SETUP_URL,
  DEFAULT_STATUS_URL,
  DEFAULT_TIMEOUT_MS,
  EvidenceCaptureError,
  EvidenceUsageError,
  MAX_RESPONSE_BYTES,
  MAX_WATCH_SAMPLES,
  MAX_DEADLINE_MS,
  MAX_INTERVAL_MS,
  MAX_TIMEOUT_MS,
  MIN_DEADLINE_MS,
  MIN_INTERVAL_MS,
  MIN_TIMEOUT_MS,
  SETUP_PATH,
  STATUS_PATH,
  assertTokenFree,
  parseHttpEndpoint,
} = require("./dj-agent-hw4-evidence-safety");
const { buildEvidenceSample } = require("./dj-agent-hw4-evidence-projection");

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
  if (
    typeof maxBytes !== "number" ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_RESPONSE_BYTES
  ) {
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
            // token-free configTemplate container, but any secret field inside
            // it is an immediate fail-closed violation.
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

module.exports = {
  captureEvidence,
  captureSample,
};
