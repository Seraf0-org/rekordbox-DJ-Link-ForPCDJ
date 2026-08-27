"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const {
  RUNTIME_SHOW_OVERRIDE_KEYS,
  REPOSITORY_ROOT,
  STRICT_SHOW_CONFIG_DISABLED_REASON,
  loadDjAgentConfig,
  readConfigFile,
  resolveStrictExternalShowPath,
  validateFilterThenFadeThenStopShowConfig,
} = require("../server/dj-agent/config");
const { validToken } = require("../server/dj-agent/tokenValidation");
const { createTrackActivityDetector } = require("../server/dj-agent/trackActivityDetector");
const { createRekordboxMidi } = require("../server/dj-agent/rekordboxMidi");
const { createSyndocalClient } = require("../server/dj-agent/syndocalClient");
const { createShowEventRouter } = require("../server/dj-agent/showEventRouter");

const TEST_TOKEN = "0123456789abcdef0123456789abcdef";
const PRIVATE_PATH = "C:\\Users\\alice\\Documents\\dj-agent-secret.json";

function strictShowConfig(token = TEST_TOKEN) {
  return {
    version: "1.1.8",
    enabled: true,
    syndocal: {
      enabled: true,
      host: "192.168.50.1",
      port: 9100,
      path: "/dj-link",
      nic: "192.168.50.2",
      token,
      adapter: "syndocal-envelope-v3",
      heartbeatMs: 5000,
    },
    pedal: { enabled: true, bindings: { release: "F13", loopHalf: "F14", filterClose: "F15" } },
    midi: {
      enabled: true,
      device: "CustomMIDI1",
      port: 1,
      mappings: {
        loopHalf: { channel: 1, messageType: "noteOn", note: 36, value: 127 },
        stop: { channel: 1, messageType: "noteOn", note: 37, value: 127 },
        filter: { channel: 1, messageType: "controlChange", cc: 16 },
        releaseFade: { channel: 1, messageType: "controlChange", cc: 17 },
      },
      deckChannels: { 1: 1, 2: 2 },
      filter: { startValue: 64, endValue: 127, durationMs: 1000, updateIntervalMs: 50 },
      releaseFade: {
        enabled: true,
        mapping: "releaseFade",
        target: "deck",
        startValue: 127,
        endValue: 0,
        durationMs: 1000,
        updateIntervalMs: 50,
        resetAfterStop: true,
        resetValue: 127,
        resetDelayMs: 0,
      },
      releaseMacro: {
        enabled: true,
        sequence: "filter-then-fade-then-stop",
        filter: { startValue: 64, endValue: 127, durationMs: 1000, updateIntervalMs: 50, resetValue: 64 },
        resetAfterStop: true,
        resetDelayMs: 0,
      },
    },
  };
}

function loadExternalShow(source = strictShowConfig(), env = {}) {
  return loadDjAgentConfig({
    env: { DJ_AGENT_CONFIG_PATH: PRIVATE_PATH, ...env },
    fsApi: { readFileSync: () => JSON.stringify(source) },
  });
}

function assertDisabled(config) {
  assert.equal(config.enabled, false);
  assert.equal(config.syndocal.enabled, false);
  assert.equal(config.midi.enabled, false);
  assert.equal(config.pedal.enabled, false);
  assert.equal(config.warning, STRICT_SHOW_CONFIG_DISABLED_REASON);
  assert.equal(config.warning.includes(TEST_TOKEN), false);
  assert.equal(config.warning.includes("alice"), false);
}

test("config read failure exposes only a generic public warning", () => {
  const privateError = new Error(`ENOENT: no such file or directory, open '${PRIVATE_PATH}' for ${TEST_TOKEN}`);
  const result = readConfigFile(PRIVATE_PATH, { readFileSync() { throw privateError; } });
  assert.deepEqual(result.config, {});
  assert.equal(result.warning, "DJ Agent config warning: config-read-failed");
  assert.equal(result.warning.includes(TEST_TOKEN), false);
  assert.equal(result.warning.includes("alice"), false);
});

test("runtime enables only the exact external v1.1.8 show source", () => {
  const config = loadExternalShow();
  assert.equal(config.enabled, true);
  assert.equal(config.warning, null);
  assert.equal(config.syndocal.token, TEST_TOKEN);
  assert.deepEqual(config.midi.mappings, strictShowConfig().midi.mappings);
  assert.equal(config.midi.releaseMacro.sequence, "filter-then-fade-then-stop");
  assert.equal(config.midi.releaseFade.mappingName, "releaseFade");
});

test("source-direct and packaged-equivalent roots share the exact activation gate", (t) => {
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-output-gate-external-"));
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-output-package-root-"));
  const externalPath = path.join(externalRoot, "show.json");
  t.after(() => {
    fs.rmSync(externalRoot, { recursive: true, force: true });
    fs.rmSync(packageRoot, { recursive: true, force: true });
  });
  const load = (source, repositoryRoot, env = {}) => {
    fs.writeFileSync(externalPath, JSON.stringify(source), "utf8");
    return loadDjAgentConfig({
      env: { DJ_AGENT_CONFIG_PATH: externalPath, ...env },
      repositoryRoot,
    });
  };

  const legacy = strictShowConfig();
  legacy.version = "1.1.6";
  for (const repositoryRoot of [REPOSITORY_ROOT, packageRoot]) {
    assert.equal(load(strictShowConfig(), repositoryRoot).enabled, true);
    assertDisabled(load(legacy, repositoryRoot));
    assertDisabled(load(strictShowConfig(), repositoryRoot, { DJ_AGENT_ENABLED: "true" }));
    assertDisabled(load(strictShowConfig(), repositoryRoot, { DJ_AGENT_CONFIG: JSON.stringify(strictShowConfig()) }));
  }
  assertDisabled(loadDjAgentConfig({ env: {} }));
});

test("module checkout root, not process cwd, defines the direct-entry external boundary", (t) => {
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-output-external-show-"));
  const externalPath = path.join(externalRoot, "show.json");
  const originalCwd = process.cwd();
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(externalRoot, { recursive: true, force: true });
  });
  fs.writeFileSync(externalPath, JSON.stringify(strictShowConfig()), "utf8");

  // This is the loader invoked by `node <checkout>/server/index.js`. The
  // caller's CWD is deliberately outside the checkout, so only the module
  // root may define whether the external-file boundary is crossed.
  process.chdir(externalRoot);
  const loadedFromDifferentCwd = loadDjAgentConfig({
    env: { DJ_AGENT_CONFIG_PATH: externalPath },
  });
  assert.equal(loadedFromDifferentCwd.enabled, true);
  assert.equal(
    resolveStrictExternalShowPath(
      path.join(REPOSITORY_ROOT, "config", "dj-agent-v1.1.8.example.json"),
      fs,
      REPOSITORY_ROOT,
    ),
    null,
  );
});

test("every enabled-show environment override fails closed before transport activation", () => {
  for (const key of RUNTIME_SHOW_OVERRIDE_KEYS) {
    const config = loadExternalShow(strictShowConfig(), { [key]: key === "MIDI_PORT" ? "1" : "true" });
    assertDisabled(config);
  }
});

test("strict validator and runtime share exact whitespace/control/token bounds", () => {
  for (const token of [
    ` ${TEST_TOKEN}`,
    `${TEST_TOKEN} `,
    `${TEST_TOKEN.slice(0, -1)}\t`,
    `${TEST_TOKEN.slice(0, -1)}\u0000`,
    `${TEST_TOKEN.slice(0, -1)}\u0085`,
    `${TEST_TOKEN.slice(0, -1)}\uD800`,
    "short",
    "a".repeat(257),
  ]) {
    const source = strictShowConfig(token);
    assert.equal(validToken(token), false);
    assert.equal(validateFilterThenFadeThenStopShowConfig(source), false);
    assertDisabled(loadExternalShow(source));
  }
});

test("strict external config composes production MIDI/client/router through F13 and Stage 2", async (t) => {
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-output-composition-"));
  const externalPath = path.join(externalRoot, "show.json");
  t.after(() => fs.rmSync(externalRoot, { recursive: true, force: true }));
  fs.writeFileSync(externalPath, JSON.stringify(strictShowConfig()), "utf8");
  const config = loadDjAgentConfig({ env: { DJ_AGENT_CONFIG_PATH: externalPath } });
  assert.equal(config.enabled, true);

  const messages = [];
  const midi = createRekordboxMidi({
    ...config.midi,
    outputFactory: () => ({
      getPortCount: () => 2,
      getPortName: (index) => index === 1 ? "CustomMIDI1" : "Other MIDI",
      openPort: () => {},
      closePort: () => {},
      sendMessage: (message) => messages.push(message),
    }),
  });
  midi.start();
  assert.equal(midi.getStatus().ok, true);

  class CompositionWebSocket extends EventEmitter {
    static instances = [];

    constructor() {
      super();
      this.readyState = 0;
      this.sent = [];
      CompositionWebSocket.instances.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open");
      });
    }

    send(raw) { this.sent.push(JSON.parse(raw)); }

    close() {
      this.readyState = 3;
      this.emit("close", 1000, "test");
    }
  }

  const client = createSyndocalClient({
    ...config.syndocal,
    enabled: true,
    WebSocketImpl: CompositionWebSocket,
    heartbeatMs: 60_000,
    ackTimeoutMs: 5_000,
    reconnectMinMs: 60_000,
    intervalApi: { setInterval() { return {}; }, clearInterval() {} },
  });
  const timers = [];
  const timerApi = {
    setTimeout(callback, delayMs) { const timer = { callback, delayMs, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { timer.cleared = true; },
  };
  const detector = createTrackActivityDetector({ idFactory: () => "composition-track" });
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal: { start() {}, stop() {}, getStatus: () => ({}) },
    releaseFade: config.midi.releaseFade,
    releaseMacro: config.midi.releaseMacro,
    timerApi,
  });
  t.after(() => router.stop());
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const socket = CompositionWebSocket.instances.at(-1);
  assert.ok(socket);
  assert.equal(client.getStatus().state, "connected");
  let candidate = null;
  detector.on("event", (event) => { if (event.type === "DJ_TRACK_ACTIVE") candidate = event; });
  const snapshot = (isPlaying, positionRevision) => ({
    deckNowPlaying: [{ deck: 1, contentId: "composition", title: "Composition", artist: "Test" }],
    deckPlaybacks: [{ deck: 1, isPlaying, bpm: 120, positionSec: positionRevision, positionRevision, positionObservedAt: new Date().toISOString() }],
  });
  detector.onSnapshot(snapshot(false, 1));
  detector.onSnapshot(snapshot(true, 2));
  assert.ok(candidate);
  const activeFrame = socket.sent.find((frame) => frame.type === "DJ_TRACK_ACTIVE");
  assert.ok(activeFrame);
  socket.emit("message", JSON.stringify({
    v: 3,
    type: "ACK",
    eventId: activeFrame.eventId,
    sequence: activeFrame.sequence,
    outcome: "accepted",
    code: null,
    stateGeneration: 1,
  }));

  // A peer may provide the current timeline identity while explicitly leaving
  // Stage 1 with the DJ. That identity is required for the later correlated
  // release, but it is not Stage 2 authority.
  socket.emit("message", JSON.stringify({
    v: 3,
    type: "DJ_TIMELINE_STATE",
    agentId: "syndocal-test",
    sessionId: "syndocal-composition",
    sequence: 1,
    eventId: "composition-stage1",
    payload: {
      state: "running",
      loopActive: false,
      timelineId: "composition-timeline",
      positionBars: 0,
      playSessionId: candidate.payload.playSessionId,
      pedalOwner: "dj",
      releaseEventId: null,
    },
  }));
  assert.equal(router.getStatus().mode, "dj-control");

  router.triggerAction("release");
  const planned = timers.find((timer) => timer.delayMs === 1_000);
  assert.ok(planned);
  planned.cleared = true;
  planned.callback();
  const releaseFrame = socket.sent.find((frame) => frame.type === "DJ_RELEASE");
  assert.ok(releaseFrame);
  assert.deepEqual(messages.slice(0, 2), [[0xb0, 16, 64], [0xb0, 17, 127]]);

  socket.emit("message", JSON.stringify({
    v: 3,
    type: "ACK",
    eventId: releaseFrame.eventId,
    sequence: releaseFrame.sequence,
    outcome: "accepted",
    code: null,
    stateGeneration: 2,
  }));

  socket.emit("message", JSON.stringify({
    v: 3,
    type: "DJ_TIMELINE_STATE",
    agentId: "syndocal-test",
    sessionId: "syndocal-composition",
    sequence: 2,
    eventId: "composition-running",
    payload: {
      state: "running",
      loopActive: false,
      timelineId: "composition-timeline",
      positionBars: 16,
      playSessionId: candidate.payload.playSessionId,
      pedalOwner: "timeline",
      releaseEventId: releaseFrame.eventId,
    },
  }));
  assert.equal(router.getStatus().mode, "timeline-control");
  const midiBeforeStage2 = messages.length;
  router.triggerAction("release");
  router.triggerAction("loop-half");
  router.triggerAction("filter-close");
  assert.equal(messages.length, midiBeforeStage2);
});
