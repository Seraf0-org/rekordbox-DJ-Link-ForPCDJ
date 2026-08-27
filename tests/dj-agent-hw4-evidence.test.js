"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");

const {
  EvidenceCaptureError,
  EvidenceUsageError,
  assertTokenFree,
  buildEvidenceSample,
  captureEvidence,
  captureSample,
  parseArgs,
} = require("../scripts/dj-agent-hw4-evidence");

const TEST_TOKEN = "0123456789abcdef0123456789abcdef";
const PROVIDER_SECRETS = [
  `sk-proj-${"a".repeat(24)}`,
  `sk-live-${"b".repeat(24)}`,
  `sk-test-${"c".repeat(24)}`,
  `ghp_${"d".repeat(32)}`,
  `github_pat_${"e".repeat(32)}`,
  `xoxb-${"f".repeat(24)}`,
  `xoxa-${"1".repeat(24)}`,
  `xoxp-${"2".repeat(24)}`,
  `xoxr-${"3".repeat(24)}`,
  `xoxs-${"4".repeat(24)}`,
];
const TIMESTAMP = "2026-08-28T00:00:00.000Z";
const RECORDER_PRODUCTION_MODULES = [
  "dj-agent-hw4-evidence.js",
  "dj-agent-hw4-evidence-safety.js",
  "dj-agent-hw4-evidence-projection.js",
  "dj-agent-hw4-evidence-http.js",
];
const READ_ONLY_FORBIDDEN_PATTERNS = [
  ["process-control import", /require\(["']node:(?:child_process|net|dgram|cluster|worker_threads)["']\)/],
  ["process-control call", /\b(?:spawn|exec|fork|execFile|execSync|spawnSync)\s*\(/],
  ["process termination", /\.\s*(?:kill|disconnect)\s*\(/],
  ["mutating HTTP method", /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/i],
  ["action route", /\/api\/dj-agent\/actions\//],
];

function assertReadOnlyRecorderSource(source, label) {
  for (const [description, pattern] of READ_ONLY_FORBIDDEN_PATTERNS) {
    assert.doesNotMatch(source, pattern, `${label} contains ${description}`);
  }
}

function statusFixture() {
  return {
    enabled: true,
    allowRemoteActions: false,
    status: {
      ok: true,
      state: "connected",
      updatedAt: TIMESTAMP,
      mode: "timeline-control",
      timelineState: "running",
      timelineLoopActive: true,
      timelineTransitionHoldActive: false,
      timelineId: "timeline-1",
      timelinePositionBars: 12.5,
      timelineSnapshotReady: true,
      timelinePlaySessionId: "timeline-play-1",
      timelinePedalOwner: "timeline",
      timelineReleaseEventId: "release-1",
      lastTimelineAction: {
        delivery: {
          eventId: "timeline-action-1",
          type: "DJ_TIMELINE_LOOP_SET",
          state: "acknowledged",
          ackState: "acknowledged",
          ok: true,
          sent: true,
          ackRequired: true,
          attempts: 1,
          busyRetries: 0,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
      },
      syndocal: {
        state: "connected",
        connected: true,
        adapter: "syndocal-envelope-v3",
        connectionGeneration: 4,
        wireSequence: 12,
        stateSync: "sent",
        pendingAcks: 0,
        lastAckAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        lastAckResult: {
          eventId: "release-1",
          type: "DJ_RELEASE",
          sequence: 12,
          outcome: "accepted",
          code: null,
          stateGeneration: 3,
          receivedAt: TIMESTAMP,
          message: "this field must not be copied",
        },
        lastDelivery: {
          eventId: "release-1",
          type: "DJ_RELEASE",
          state: "acknowledged",
          ackState: "acknowledged",
          ok: true,
          sent: true,
          ackRequired: true,
          awaitingAck: false,
          attempts: 1,
          busyRetries: 0,
          reason: null,
          createdAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
          ack: {
            eventId: "release-1",
            type: "DJ_RELEASE",
            sequence: 12,
            outcome: "accepted",
            code: null,
            stateGeneration: 3,
            message: "this field must not be copied",
          },
          message: "this field must not be copied",
        },
      },
      ownerDeck: 2,
      ownerDeckId: "deck-2",
      activePlaySessionId: "play-1",
      ownerWireIdentity: "track-1",
      ownerTrack: {
        contentId: "1234",
        title: "private title must not be copied",
        artist: "private artist must not be copied",
        isPlaying: true,
      },
    },
    state: {
      released: false,
      loopDivision: "1/2",
      activePlaySessionId: "play-1",
      ownerDeck: 2,
      ownerDeckId: "deck-2",
      ownerWireIdentity: "track-1",
      ownerTrack: {
        contentId: "1234",
        title: "private title must not be copied",
        artist: "private artist must not be copied",
        isPlaying: true,
      },
    },
  };
}

function setupFixture() {
  return {
    ok: true,
    localOnly: true,
    enabled: true,
    tokenConfigured: true,
    configTemplate: {
      version: "1.1.9",
      enabled: true,
      syndocal: { adapter: "syndocal-envelope-v3" },
    },
    mappingArtifact: {
      valid: true,
      operatorVerified: true,
      semanticFingerprint: "a".repeat(64),
    },
    readiness: {
      state: "ready",
      ready: true,
      actions: { mapping: true, releaseMacro: true },
    },
    networkInterfaces: [{ name: "Ethernet", address: "192.168.50.2" }],
    midiPorts: { ports: [{ name: "CustomMIDI1", port: 1 }] },
  };
}

function startMockServer(t, { status = statusFixture(), setup = setupFixture(), delayMs = 0 } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const payload = request.url === "/api/dj-agent/status" ? status :
        request.url === "/api/dj-agent/setup" ? setup : null;
      const respond = () => {
        if (!payload) {
          response.writeHead(404, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: false }));
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (delayMs > 0) setTimeout(respond, delayMs);
      else respond();
    });
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        statusUrl: `http://127.0.0.1:${address.port}/api/dj-agent/status`,
        setupUrl: `http://127.0.0.1:${address.port}/api/dj-agent/setup`,
        requests,
      });
    });
  });
}

test("projection is bounded and excludes config, track text, messages, and token material", () => {
  const sample = buildEvidenceSample({
    status: statusFixture(),
    setup: setupFixture(),
    observedAt: TIMESTAMP,
  });
  assert.equal(sample.connection.connectionGeneration, 4);
  assert.equal(sample.session.playSessionId, "play-1");
  assert.equal(sample.ack.outcome, "accepted");
  assert.equal(sample.delivery.state, "acknowledged");
  assert.equal(sample.timeline.state, "running");
  assert.equal(sample.owner.present, true);
  assert.equal(sample.owner.deck, 2);
  assert.equal(Object.hasOwn(sample.owner, "contentId"), false);
  assert.equal(Object.hasOwn(sample.owner, "wireIdentity"), false);
  assert.equal(sample.setup.tokenConfigured, true);
  assert.equal(sample.provenance.statusEndpoint, "http://127.0.0.1:8787/api/dj-agent/status");
  assert.equal(sample.provenance.setupEndpoint, "http://127.0.0.1:8787/api/dj-agent/setup");
  const connectingStatus = statusFixture();
  connectingStatus.status.syndocal.state = "connecting";
  assert.equal(
    buildEvidenceSample({ status: connectingStatus, setup: setupFixture(), observedAt: TIMESTAMP }).connection.state,
    "connecting",
  );

  const serialized = JSON.stringify(sample);
  assert.equal(serialized.includes(TEST_TOKEN), false);
  assert.equal(serialized.includes("configTemplate"), false);
  assert.equal(serialized.includes("private title"), false);
  assert.equal(serialized.includes("this field must not be copied"), false);
  assert.doesNotThrow(() => assertTokenFree(sample));
});

test("provider-shaped secrets fail closed in projected session, timeline, and event identifiers", () => {
  const cases = [
    ["sessionId", (status, value) => { status.status.syndocal.sessionId = value; }],
    ["playSessionId", (status, value) => { status.status.activePlaySessionId = value; }],
    ["timelinePlaySessionId", (status, value) => { status.status.timelinePlaySessionId = value; }],
    ["timelineId", (status, value) => { status.status.timelineId = value; }],
    ["deliveryEventId", (status, value) => { status.status.syndocal.lastDelivery.eventId = value; }],
    ["ackEventId", (status, value) => { status.status.syndocal.lastAckResult.eventId = value; }],
    ["releaseEventId", (status, value) => { status.status.timelineReleaseEventId = value; }],
  ];
  for (const providerSecret of PROVIDER_SECRETS) {
    for (const [label, mutate] of cases) {
      const status = statusFixture();
      mutate(status, providerSecret);
      assert.throws(
        () => buildEvidenceSample({ status, setup: setupFixture(), observedAt: TIMESTAMP }),
        (error) => error instanceof EvidenceCaptureError && error.code === "provider-secret-shaped-value",
        `${label} must reject a provider-shaped secret`,
      );
    }
  }
});

test("recursive redaction assertion rejects secret keys, secret-shaped values, and invalid token metadata", () => {
  assert.throws(
    () => assertTokenFree({ nested: { token: TEST_TOKEN } }),
    (error) => error instanceof EvidenceCaptureError && error.code === "secret-shaped-key",
  );
  assert.throws(
    () => assertTokenFree({ nested: { authorization: "Bearer private-value" } }),
    (error) => error instanceof EvidenceCaptureError && error.code === "secret-shaped-key",
  );
  assert.throws(
    () => assertTokenFree({ nested: { note: `Bearer ${TEST_TOKEN}` } }),
    (error) => error instanceof EvidenceCaptureError && error.code === "secret-shaped-value",
  );
  assert.throws(
    () => assertTokenFree({ nested: { note: `token:${TEST_TOKEN}` } }),
    (error) => error instanceof EvidenceCaptureError && error.code === "secret-shaped-value",
  );
  assert.throws(
    () => assertTokenFree({ nested: { accessKey: "private" } }),
    (error) => error instanceof EvidenceCaptureError && error.code === "secret-shaped-key",
  );
  assert.throws(
    () => assertTokenFree({ nested: { signingKey: "private" } }),
    (error) => error instanceof EvidenceCaptureError && error.code === "secret-shaped-key",
  );
  assert.throws(
    () => assertTokenFree({ nested: { jwt: "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.signature" } }),
    (error) => error instanceof EvidenceCaptureError && error.code === "secret-shaped-value",
  );
  assert.throws(
    () => assertTokenFree({ nested: { url: "http://127.0.0.1/api?access_token=private" } }),
    (error) => error instanceof EvidenceCaptureError && error.code === "secret-shaped-value",
  );
  assert.throws(
    () => assertTokenFree({ nested: { url: "http://127.0.0.1/api%3Ftoken%3Dprivate" } }),
    (error) => error instanceof EvidenceCaptureError && error.code === "secret-shaped-value",
  );
  assert.throws(
    () => assertTokenFree({ nested: { opaque: "b3V0cHV0LXNlY3JldC10b2tlbi1leGFtcGxlLWRhdGE=" } }),
    (error) => error instanceof EvidenceCaptureError && error.code === "secret-shaped-value",
  );
  for (const providerSecret of PROVIDER_SECRETS) {
    assert.throws(
      () => assertTokenFree({ nested: { value: providerSecret } }),
      (error) => error instanceof EvidenceCaptureError && error.code === "secret-shaped-value",
    );
  }
  assert.throws(
    () => assertTokenFree({ tokenConfigured: "yes" }),
    (error) => error instanceof EvidenceCaptureError && error.code === "token-metadata-invalid",
  );
  assert.throws(
    () => assertTokenFree({ configTemplate: { enabled: true } }),
    (error) => error instanceof EvidenceCaptureError && error.code === "secret-shaped-key",
  );
  assert.doesNotThrow(() => assertTokenFree({ tokenConfigured: true }));
  assert.doesNotThrow(() => assertTokenFree({ configTemplate: { enabled: true } }, { allowSourceConfigContainer: true }));
});

test("HTTP capture uses only GET and returns one-shot token-free JSON", async (t) => {
  const mock = await startMockServer(t);
  const document = await captureEvidence({
    statusUrl: mock.statusUrl,
    setupUrl: mock.setupUrl,
    intervalMs: 50,
  });
  assert.equal(document.mode, "once");
  assert.equal(document.sampleCount, 1);
  assert.equal(document.samples[0].responses.statusHttpStatus, 200);
  assert.equal(document.samples[0].responses.setupHttpStatus, 200);
  assert.equal(document.samples[0].provenance.statusEndpoint, mock.statusUrl);
  assert.equal(document.samples[0].provenance.setupEndpoint, mock.setupUrl);
  assert.equal(mock.requests.length, 2);
  assert.deepEqual(mock.requests.map((request) => request.method).sort(), ["GET", "GET"]);
  assert.deepEqual(mock.requests.map((request) => request.body), ["", ""]);
  assert.equal(JSON.stringify(document).includes(TEST_TOKEN), false);
  assert.equal(JSON.stringify(document).includes("configTemplate"), false);
});

test("watch mode is bounded and samples the same read-only endpoints", async (t) => {
  const mock = await startMockServer(t);
  const document = await captureEvidence({
    statusUrl: mock.statusUrl,
    setupUrl: mock.setupUrl,
    watchCount: 2,
    intervalMs: 50,
  });
  assert.equal(document.mode, "watch");
  assert.equal(document.sampleCount, 2);
  assert.equal(document.samples.length, 2);
  assert.equal(mock.requests.length, 4);
  assert.throws(() => parseArgs(["--watch"]), EvidenceUsageError);
  assert.throws(() => parseArgs(["--watch", "1"]), EvidenceUsageError);
  assert.throws(() => parseArgs(["--watch", "121"]), EvidenceUsageError);
  assert.throws(() => parseArgs(["--interval-ms", "49"]), EvidenceUsageError);
  assert.throws(() => parseArgs(["--deadline-ms", "99"]), EvidenceUsageError);
});

test("independent sample deadline aborts both pending GET requests", async (t) => {
  const mock = await startMockServer(t, { delayMs: 250 });
  await assert.rejects(
    () => captureSample({
      statusUrl: mock.statusUrl,
      setupUrl: mock.setupUrl,
      timeoutMs: 5_000,
      deadlineMs: 100,
    }),
    (error) => error instanceof EvidenceCaptureError && error.code === "capture-deadline-exceeded",
  );
  assert.equal(mock.requests.length, 2);
  assert.deepEqual(mock.requests.map((request) => request.method).sort(), ["GET", "GET"]);
});

test("source responses containing a secret-shaped key fail closed before projection", async (t) => {
  const status = statusFixture();
  status.status.syndocal.token = TEST_TOKEN;
  const mock = await startMockServer(t, { status });
  await assert.rejects(
    () => captureSample({ statusUrl: mock.statusUrl, setupUrl: mock.setupUrl }),
    (error) => error instanceof EvidenceCaptureError && error.code === "secret-shaped-key",
  );
});

test("endpoint validation rejects credentials, query strings, and non-diagnostic paths", () => {
  assert.throws(
    () => parseArgs(["--status-url", "http://192.168.50.1:8787/api/dj-agent/status"]),
    (error) => error instanceof EvidenceUsageError && error.code === "endpoint-loopback-required",
  );
  assert.throws(
    () => parseArgs(["--setup-url", "http://localhost:8787/api/dj-agent/setup"]),
    (error) => error instanceof EvidenceUsageError && error.code === "endpoint-loopback-required",
  );
  assert.throws(
    () => parseArgs(["--status-url", `http://user:${TEST_TOKEN}@127.0.0.1:8787/api/dj-agent/status`]),
    (error) => error instanceof EvidenceUsageError && error.code === "endpoint-credentials-or-query-forbidden",
  );
  assert.throws(
    () => parseArgs(["--setup-url", "http://127.0.0.1:8787/api/dj-agent/setup?token=private"]),
    (error) => error instanceof EvidenceUsageError && error.code === "endpoint-credentials-or-query-forbidden",
  );
  assert.throws(
    () => parseArgs(["--status-url", "http://127.0.0.1:8787/api/dj-agent/actions/release"]),
    (error) => error instanceof EvidenceUsageError && error.code === "endpoint-path-or-port-invalid",
  );
});

test("all recorder production modules have no process-control or action-request implementation", () => {
  for (const moduleName of RECORDER_PRODUCTION_MODULES) {
    const source = fs.readFileSync(path.join(__dirname, "..", "scripts", moduleName), "utf8");
    assertReadOnlyRecorderSource(source, moduleName);
  }
});

test("read-only source guard rejects forbidden child-module operations", () => {
  for (const [description, source] of [
    ["process-control import", 'require("node:child_process")'],
    ["process-control call", "spawn(command)"],
    ["process termination", "child.kill()"],
    ["mutating HTTP method", 'method: "POST"'],
    ["action route", '"/api/dj-agent/actions/release"'],
  ]) {
    assert.throws(
      () => assertReadOnlyRecorderSource(source, `synthetic ${description}`),
      assert.AssertionError,
      description,
    );
  }
});
