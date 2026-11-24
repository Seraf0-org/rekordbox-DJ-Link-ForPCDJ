#!/usr/bin/env node
"use strict";

// Read-only, token-free CLI for the already-running DJ Agent. The capture
// implementation is split into safety, projection, and HTTP modules.

const {
  ACK_OUTCOMES,
  DEFAULT_DEADLINE_MS,
  DEFAULT_INTERVAL_MS,
  DEFAULT_SETUP_URL,
  DEFAULT_STATUS_URL,
  DEFAULT_TIMEOUT_MS,
  EvidenceCaptureError,
  EvidenceUsageError,
  MAX_WATCH_SAMPLES,
  MIN_DEADLINE_MS,
  MIN_INTERVAL_MS,
  MIN_TIMEOUT_MS,
  MAX_DEADLINE_MS,
  MAX_INTERVAL_MS,
  MAX_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  assertTokenFree,
  parseHttpEndpoint,
} = require("./dj-agent-hw4-evidence-safety");
const { buildEvidenceSample, projectAck, projectDelivery } = require("./dj-agent-hw4-evidence-projection");
const { captureEvidence, captureSample } = require("./dj-agent-hw4-evidence-http");

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
    parseHttpEndpoint(options.statusUrl, "/api/dj-agent/status");
    parseHttpEndpoint(options.setupUrl, "/api/dj-agent/setup");
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
