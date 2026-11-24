"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  REKORDBOX_LOCAL_TEST_CONFIG_PATH,
  REKORDBOX_LOCAL_TEST_MODE,
  REKORDBOX_LOCAL_TEST_SAFETY_LABEL,
  REKORDBOX_LOCAL_TEST_SCHEMA,
  loadDjAgentConfig,
  loadRekordboxLocalTestConfig,
  validateFilterThenFadeThenStopShowConfig,
  validateRekordboxLocalTestConfig,
} = require("../server/dj-agent/config");
const {
  MIDI_DEVICE_NAME,
  TEMPLATE_PATH,
  discoverCustomMidiPort,
  initializeRekordboxLocalTestConfig,
  parseAndValidateTemplate,
  selectCustomMidiPort,
} = require("../scripts/init-rekordbox-local-test-config");
const { verifyCurrentMidiSelection } = require("../scripts/validate-rekordbox-local-test-config");
const { createShowEventRouter } = require("../server/dj-agent/showEventRouter");

const PROFILE = [8, 4, 2, 1, 1 / 2, 1 / 4, 1 / 8, 1 / 16, 1 / 32, 1 / 64];

function templateSource() {
  return JSON.parse(fs.readFileSync(TEMPLATE_PATH, "utf8"));
}

function validLocalSource(port = 7) {
  const source = templateSource();
  source.midi.port = port;
  return source;
}

function withExternalSource(source, callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rb-output-rekordbox-local-test-"));
  const configPath = path.join(root, "config.json");
  fs.writeFileSync(configPath, JSON.stringify(source), "utf8");
  try {
    return callback(configPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function loadLocalSource(source = validLocalSource(), env = {}) {
  return withExternalSource(source, (configPath) => loadRekordboxLocalTestConfig({ configPath, env }));
}

function fixedPathFixture({ resolvedPath, source = validLocalSource() } = {}) {
  const calls = { realpath: [], read: [] };
  return {
    calls,
    fsApi: {
      realpathSync: {
        native(target) {
          calls.realpath.push(target);
          return resolvedPath;
        },
      },
      readFileSync(target) {
        calls.read.push(target);
        return JSON.stringify(source);
      },
    },
  };
}

function fixedPathSecurity({ topology = true, acl = true } = {}) {
  const calls = { topology: [], acl: [] };
  return {
    calls,
    securityApi: {
      fixedPathHasNoReparsePoints(target) {
        calls.topology.push(target);
        return topology;
      },
      verifyRekordboxLocalTestAcl(target) {
        calls.acl.push(target);
        return acl;
      },
    },
  };
}

test("local schema is separate, exact, token-free, and preserves physical controls", () => {
  const source = validLocalSource(7);
  assert.equal(validateRekordboxLocalTestConfig(source), true);
  assert.equal(validateFilterThenFadeThenStopShowConfig(source), false);
  assert.equal(source.schema, REKORDBOX_LOCAL_TEST_SCHEMA);
  assert.equal(Object.hasOwn(source, "syndocal"), false);
  assert.equal(Object.hasOwn(source, "token"), false);
  const config = loadLocalSource(source);
  assert.equal(config.enabled, true);
  assert.equal(config.mode, REKORDBOX_LOCAL_TEST_MODE);
  assert.equal(config.testOnly, true);
  assert.equal(config.safetyLabel, REKORDBOX_LOCAL_TEST_SAFETY_LABEL);
  assert.equal(config.syndocal.enabled, false);
  assert.equal(config.syndocal.host, "");
  assert.equal(config.syndocal.nic, "");
  assert.equal(config.syndocal.token, "");
  assert.equal(config.midi.port, 7);
  assert.equal(config.pedal.bindings.loopHalf, "F14");
  assert.equal(config.midi.releaseMacro.sequence, "filter-then-fade-then-stop");
});

test("production loader rejects the local discriminator and local input has no network escape", () => {
  withExternalSource(validLocalSource(), (configPath) => {
    const config = loadDjAgentConfig({ env: { DJ_AGENT_CONFIG_PATH: configPath } });
    assert.equal(config.enabled, false);
    assert.equal(config.syndocal.enabled, false);
    assert.equal(config.warning.includes("CustomMIDI1"), false);
  });
  for (const invalid of [
    { ...validLocalSource(), syndocal: {} },
    { ...validLocalSource(), version: "1.1.11" },
    { ...validLocalSource(), schema: "retired-local-schema" },
    { ...validLocalSource(), midi: { ...validLocalSource().midi, port: null } },
  ]) {
    assert.equal(validateRekordboxLocalTestConfig(invalid), false);
  }
});

test("Windows live fixed path rejects a leaf symlink before reading or invoking ACL", () => {
  const fixed = fixedPathFixture({ resolvedPath: "C:\\Foreign\\rb-output-rekordbox-local-test-v1.json" });
  const security = fixedPathSecurity({ topology: false });
  const config = loadRekordboxLocalTestConfig({
    platform: "win32",
    configPath: REKORDBOX_LOCAL_TEST_CONFIG_PATH,
    fsApi: fixed.fsApi,
    securityApi: security.securityApi,
  });

  assert.equal(config.enabled, false);
  assert.match(config.warning, /fixed config path topology/i);
  assert.deepEqual(security.calls.topology, [REKORDBOX_LOCAL_TEST_CONFIG_PATH]);
  assert.deepEqual(security.calls.acl, []);
  assert.deepEqual(fixed.calls.realpath, []);
  assert.deepEqual(fixed.calls.read, []);
});

test("Windows live fixed path rejects a parent-junction foreign realpath before readConfigFile", () => {
  const foreignPath = "C:\\Foreign\\rb-output-rekordbox-local-test-v1.json";
  const fixed = fixedPathFixture({ resolvedPath: foreignPath });
  const security = fixedPathSecurity();
  const config = loadRekordboxLocalTestConfig({
    platform: "win32",
    configPath: REKORDBOX_LOCAL_TEST_CONFIG_PATH,
    fsApi: fixed.fsApi,
    securityApi: security.securityApi,
  });

  assert.equal(config.enabled, false);
  assert.match(config.warning, /fixed config path topology changed/i);
  assert.deepEqual(security.calls.topology, [REKORDBOX_LOCAL_TEST_CONFIG_PATH]);
  assert.deepEqual(security.calls.acl, [REKORDBOX_LOCAL_TEST_CONFIG_PATH]);
  assert.deepEqual(fixed.calls.realpath, [REKORDBOX_LOCAL_TEST_CONFIG_PATH]);
  assert.deepEqual(fixed.calls.read, []);
});

test("Windows live fixed path accepts only the exact path after one original-path security check", () => {
  const fixed = fixedPathFixture({ resolvedPath: REKORDBOX_LOCAL_TEST_CONFIG_PATH });
  const security = fixedPathSecurity();
  const config = loadRekordboxLocalTestConfig({
    platform: "win32",
    configPath: REKORDBOX_LOCAL_TEST_CONFIG_PATH,
    fsApi: fixed.fsApi,
    securityApi: security.securityApi,
  });

  assert.equal(config.enabled, true);
  assert.deepEqual(security.calls.topology, [REKORDBOX_LOCAL_TEST_CONFIG_PATH]);
  assert.deepEqual(security.calls.acl, [REKORDBOX_LOCAL_TEST_CONFIG_PATH]);
  assert.deepEqual(fixed.calls.realpath, [REKORDBOX_LOCAL_TEST_CONFIG_PATH]);
  assert.deepEqual(fixed.calls.read, [REKORDBOX_LOCAL_TEST_CONFIG_PATH]);
});

test("fixed-path spelling aliases are rejected while the injected temp parser seam remains independent", () => {
  const alias = REKORDBOX_LOCAL_TEST_CONFIG_PATH.replace("rb-output", "RB-OUTPUT");
  const fixed = fixedPathFixture({ resolvedPath: REKORDBOX_LOCAL_TEST_CONFIG_PATH });
  const security = fixedPathSecurity();
  const aliased = loadRekordboxLocalTestConfig({
    platform: "win32",
    configPath: alias,
    fsApi: fixed.fsApi,
    securityApi: security.securityApi,
  });
  assert.equal(aliased.enabled, false);
  assert.match(aliased.warning, /exact fixed config path spelling/i);
  assert.deepEqual(security.calls.topology, []);
  assert.deepEqual(security.calls.acl, []);
  assert.deepEqual(fixed.calls.realpath, []);
  assert.deepEqual(fixed.calls.read, []);

  withExternalSource(validLocalSource(9), (configPath) => {
    const tempSecurityCalls = [];
    const temp = loadRekordboxLocalTestConfig({
      platform: "win32",
      configPath,
      securityApi: {
        fixedPathHasNoReparsePoints() {
          tempSecurityCalls.push("topology");
          return false;
        },
        verifyRekordboxLocalTestAcl() {
          tempSecurityCalls.push("acl");
          return false;
        },
      },
    });
    assert.equal(temp.enabled, true);
    assert.equal(temp.midi.port, 9);
    assert.deepEqual(tempSecurityCalls, []);
  });
});

test("CustomMIDI1 discovery fails closed for unavailable, zero, duplicate, and wrong-port results", () => {
  assert.equal(selectCustomMidiPort({ ok: true, available: true, ports: [{ port: 4, name: MIDI_DEVICE_NAME }] }), 4);
  assert.throws(() => discoverCustomMidiPort(() => ({ ok: false, available: false, ports: [], reason: "midi-unavailable" })), /enumeration failed/i);
  assert.throws(() => discoverCustomMidiPort(() => ({ ok: true, available: true, ports: [] })), /exact CustomMIDI1 output must enumerate exactly once/i);
  assert.throws(() => discoverCustomMidiPort(() => ({ ok: true, available: true, ports: [
    { port: 1, name: MIDI_DEVICE_NAME },
    { port: 3, name: MIDI_DEVICE_NAME },
  ] })), /exact CustomMIDI1 output must enumerate exactly once/i);
  assert.equal(verifyCurrentMidiSelection(validLocalSource(4), () => ({
    ok: true,
    available: true,
    ports: [{ port: 4, name: MIDI_DEVICE_NAME }],
  })).ok, true);
  assert.equal(verifyCurrentMidiSelection(validLocalSource(4), () => ({
    ok: true,
    available: true,
    ports: [{ port: 6, name: MIDI_DEVICE_NAME }],
  })).ok, false);
  assert.equal(verifyCurrentMidiSelection(validLocalSource(4), () => ({
    ok: true,
    available: true,
    ports: [{ port: 4, name: MIDI_DEVICE_NAME }, { port: 6, name: MIDI_DEVICE_NAME }],
  })).ok, false);
});

test("init discovers actual MIDI port before creating an external target and never overwrites it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rb-output-rekordbox-init-"));
  const targetPath = path.join(root, "generated.json");
  try {
    const result = initializeRekordboxLocalTestConfig({
      targetPath,
      env: {},
      enumerateOutputs: () => ({
        ok: true,
        available: true,
        ports: [{ port: 12, name: MIDI_DEVICE_NAME }],
      }),
      installAcl: () => ({ ok: true }),
    });
    assert.equal(result.midiPort, 12);
    const generated = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    assert.equal(generated.schema, REKORDBOX_LOCAL_TEST_SCHEMA);
    assert.equal(generated.midi.port, 12);
    assert.equal(Object.hasOwn(generated, "syndocal"), false);

    assert.throws(() => initializeRekordboxLocalTestConfig({
      targetPath,
      env: {},
      enumerateOutputs: () => ({ ok: true, available: true, ports: [{ port: 12, name: MIDI_DEVICE_NAME }] }),
      installAcl: () => ({ ok: true }),
    }), /refusing to overwrite existing/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ACL failure removes only the file created by this init attempt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rb-output-rekordbox-acl-"));
  const targetPath = path.join(root, "generated.json");
  try {
    assert.throws(() => initializeRekordboxLocalTestConfig({
      targetPath,
      env: {},
      enumerateOutputs: () => ({ ok: true, available: true, ports: [{ port: 8, name: MIDI_DEVICE_NAME }] }),
      installAcl: () => { throw new Error("ACL unavailable"); },
    }), /restrictive Windows ACL/i);
    assert.equal(fs.existsSync(targetPath), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows launcher exposes only the explicit local-test mode and exact local UI URL", { skip: process.platform !== "win32" }, () => {
  const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
  const env = { ...process.env };
  for (const key of [
    "DJ_AGENT_CONFIG_PATH", "DJ_AGENT_CONFIG", "DJ_AGENT_ENABLED", "DJ_AGENT_ALLOW_REMOTE_ACTIONS",
    "SYNDOCAL_ENABLED", "SYNDOCAL_HOST", "SYNDOCAL_PORT", "SYNDOCAL_PATH", "SYNDOCAL_NIC", "SYNDOCAL_TOKEN",
    "SYNDOCAL_WS_ADAPTER", "SYNDOCAL_HEARTBEAT_MS", "PEDAL_ENABLED", "PEDAL_MODULE", "MIDI_ENABLED", "MIDI_MODULE",
    "MIDI_DEVICE", "MIDI_PORT", "MIDI_RELEASE_FADE", "MIDI_RELEASE_MACRO", "MIDI_DECK_CHANNELS", "PORT",
    "RB_OUTPUT_HOST", "RB_OUTPUT_SETUP_MAPPING_PATH", "REKORDBOX_EXE_PATH", "HOOK_UDP_ENABLED", "HOOK_UDP_PORT",
    "REKORDBOX_POLL_MS", "PYTHON_BIN", "REKORDBOX_BRIDGE_SCRIPT", "REKORDBOX_CONTENT_LOOKUP_SCRIPT",
    "REKORDBOX_DB_PATH", "REKORDBOX_DB_DIR", "REKORDBOX_DB_KEY", "PYTHONPATH", "PYTHONHOME", "PYTHONIOENCODING",
    "PYTHONUTF8", "ABLETON_LINK_ENABLED", "ABLETON_LINK_MODULE", "ABLETON_LINK_INITIAL_TEMPO", "HISTORY_OFFSET_SECONDS",
    "NODE_OPTIONS", "RB_OUTPUT_REKORDBOX_LOCAL_TEST_LIVE",
  ]) delete env[key];
  const run = (args) => childProcess.spawnSync(comspec, ["/d", "/c", "call start-all.bat", ...args], {
    cwd: path.resolve(__dirname, ".."),
    env,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  const unknown = run(["--not-a-supported-mode"]);
  assert.equal(unknown.status, 64);
  const combined = run(["--rekordbox-local-test", "unexpected"]);
  assert.equal(combined.status, 64);
  const preflight = run(["--preflight-rekordbox-local-test"]);
  if (!fs.existsSync(REKORDBOX_LOCAL_TEST_CONFIG_PATH)) {
    assert.notEqual(preflight.status, 0, "preflight without an initialized fixed config must fail closed");
  }
  const launcher = fs.readFileSync(path.resolve(__dirname, "..", "start-all.bat"), "utf8");
  assert.match(launcher, /--rekordbox-local-test/i);
  assert.match(launcher, /http:\/\/127\.0\.0\.1:8787/i);
  assert.doesNotMatch(launcher, /same.?pc/i);
});

function createLocalRouter({ localTestMode = true, deferMacroCallbacks = false, recordOperations = false } = {}) {
  const detector = new EventEmitter();
  const candidate = {
    deck: 1,
    deckId: "rekordbox-deck-1",
    playSessionId: "local-session-1",
    wireIdentity: { contentId: "content-local-1" },
    identity: "content:content-local-1",
    fresh: true,
    isPlaying: true,
  };
  detector.current = candidate;
  detector.getCurrentProductionCandidate = () => detector.current;
  detector.getProductionCandidateStatus = () => ({ stage: "candidate-ready", deck: 1, playSessionId: candidate.playSessionId });
  detector.getState = () => ({
    decks: {
      1: {
        track: { contentId: detector.current?.wireIdentity?.contentId || null },
        playback: { isPlaying: detector.current?.isPlaying === true },
        playSessionId: detector.current?.playSessionId || null,
        wireIdentity: detector.current?.wireIdentity || null,
      },
    },
  });
  detector.onSnapshot = () => null;
  detector.onTrackLoaded = () => null;
  detector.onMasterChange = () => null;
  detector.start = () => {};
  detector.stop = () => {};
  detector.requestMeasuredLoopForSession = () => {};
  detector.requestCurrentTrackCandidates = () => {};

  const client = new EventEmitter();
  client.sent = [];
  client.getStatus = () => localTestMode
    ? ({ enabled: false, state: "disabled" })
    : ({ enabled: true, state: "connected" });
  client.sendEvent = (event) => {
    client.sent.push(event);
    if (localTestMode) throw new Error("local mode must not call sendEvent");
    return {
      eventId: event.eventId || `production-${client.sent.length}`,
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
    startFilterRamp(options) {
      this.sent.push("filter-start");
      this.filterOptions = options;
      if (!deferMacroCallbacks) options.onComplete?.({ ok: true, targetChannel: 1 });
      return { started: true, ok: true, targetChannel: 1 };
    },
    startReleaseFade(options) {
      this.sent.push("fade-start");
      this.fadeOptions = options;
      if (!deferMacroCallbacks) options.onComplete?.({ ok: true, targetChannel: 1 });
      return { started: true, ok: true, targetChannel: 1 };
    },
    resetReleaseFade() { this.sent.push("fade-reset"); return { ok: true }; },
    cancelFilterRamp() { if (recordOperations) this.sent.push("filter-cancel"); return true; },
    cancelReleaseFade() { if (recordOperations) this.sent.push("fade-cancel"); return true; },
    getStatus: () => ({ ok: true, available: true }),
    start() {},
    stop() {},
  };
  const pedal = { start() {}, stop() {}, getStatus: () => ({}) };
  const timerTasks = [];
  const timerApi = {
    setTimeout(callback, delayMs) {
      const task = { callback, delayMs, cleared: false };
      timerTasks.push(task);
      return task;
    },
    clearTimeout(task) { if (task) task.cleared = true; },
    runNext() {
      const task = timerTasks.find((entry) => !entry.cleared);
      assert.ok(task, "expected local timer");
      task.cleared = true;
      task.callback();
    },
    pending() { return timerTasks.filter((entry) => !entry.cleared); },
  };
  const router = createShowEventRouter({
    detector,
    syndocalClient: client,
    midi,
    pedal,
    releaseMacro: {
      enabled: true,
      sequence: "filter-then-fade-then-stop",
      filter: { startValue: 64, endValue: 127, durationMs: 1000, updateIntervalMs: 50, resetValue: 64 },
      resetAfterStop: true,
      resetDelayMs: 0,
    },
    releaseFade: {
      enabled: true,
      mappingName: "releaseFade",
      target: "deck",
      startValue: 127,
      endValue: 0,
      durationMs: 1000,
      updateIntervalMs: 50,
      resetAfterStop: true,
      resetValue: 127,
      resetDelayMs: 0,
    },
    loopFallback: { timerApi, responseWindowMs: 500 },
    timerApi,
    localTestMode,
  });
  return {
    candidate,
    client,
    detector,
    fadeOptions: () => midi.fadeOptions,
    filterOptions: () => midi.filterOptions,
    midi,
    router,
    timerApi,
  };
}

function measuredLoop(candidate, lengthBeats = 4, revision = 1) {
  return {
    deck: candidate.deck,
    deckId: candidate.deckId,
    playSessionId: candidate.playSessionId,
    active: true,
    startBeat: 32,
    endBeat: 32 + lengthBeats,
    lengthBeats,
    revision,
    sampleAgeMs: 0,
    source: "rekordbox-hook-measured",
  };
}

function replaceLocalCandidate(fixture, suffix = "replacement") {
  const replacement = {
    ...fixture.candidate,
    playSessionId: `local-${suffix}-session`,
    wireIdentity: { contentId: `content-${suffix}` },
  };
  fixture.detector.current = replacement;
  fixture.detector.emit("event", {
    type: "DJ_TRACK_ACTIVE",
    eventId: `local-${suffix}-active`,
    payload: { ...replacement, ...replacement.wireIdentity },
  });
  return replacement;
}

test("local router admits only exact fresh-playing detector identity and never calls Syndocal", () => {
  const { candidate, client, detector, router } = createLocalRouter();
  detector.emit("event", {
    type: "DJ_TRACK_ACTIVE",
    eventId: "local-active",
    payload: { ...candidate, ...candidate.wireIdentity },
  });
  assert.equal(client.sent.length, 0);
  assert.equal(router.getStateSync().ownerSource, "local-fresh-playing-candidate");
  const activeDelivery = router.getStateSync().lastAction?.delivery;
  assert.equal(activeDelivery, undefined);

  detector.emit("event", {
    type: "DJ_TRACK_SYNC",
    eventId: "local-sync",
    payload: { ...candidate, ...candidate.wireIdentity, positionRevision: 2 },
  });
  detector.emit("event", {
    type: "DJ_LOOP_STATE",
    eventId: "local-loop",
    payload: measuredLoop(candidate, 4),
  });
  const state = router.getStateSync();
  assert.equal(client.sent.length, 0);
  assert.equal(state.loopDivision, 4, "measured 4 beats must remain the display value, not profile index 1");
  assert.equal(state.stage1LoopFallback.nextTargetLengthBeats, 2, "next F14 target follows measured 4-beat authority");
  assert.equal(state.lastAction, null);

  detector.current = { ...candidate, playSessionId: "different-session", wireIdentity: { contentId: "different" } };
  detector.emit("event", {
    type: "DJ_TRACK_ACTIVE",
    eventId: "foreign-active",
    payload: { ...candidate, playSessionId: "different-session", wireIdentity: { contentId: "different" }, contentId: "different" },
  });
  assert.equal(router.getStateSync().ownerWireIdentity, "content:content-local-1");
});

test("local admission fails closed for stale, stopped, or mismatched current candidates", () => {
  const stale = createLocalRouter();
  stale.detector.current = { ...stale.candidate, fresh: false, isPlaying: false };
  stale.detector.emit("event", {
    type: "DJ_TRACK_ACTIVE",
    eventId: "stale-active",
    payload: { ...stale.candidate, ...stale.candidate.wireIdentity },
  });
  assert.equal(stale.router.getStateSync().ownerDeck, null);
  assert.equal(stale.client.sent.length, 0);
  const mismatch = createLocalRouter();
  mismatch.detector.emit("event", {
    type: "DJ_TRACK_ACTIVE",
    eventId: "mismatch-active",
    payload: {
      ...mismatch.candidate,
      ...mismatch.candidate.wireIdentity,
      playSessionId: "other-session",
      contentId: "other-content",
    },
  });
  assert.equal(mismatch.router.getStateSync().ownerDeck, null);
  assert.equal(mismatch.client.sent.length, 0);
});

test("local F13/F14 revalidate the current fresh-playing owner before any MIDI or event", () => {
  const cases = [
    {
      name: "stopped",
      mutate(current) { return { ...current, isPlaying: false }; },
    },
    {
      name: "stale",
      mutate(current) { return { ...current, fresh: false }; },
    },
    {
      name: "replacement session",
      mutate(current) {
        return {
          ...current,
          playSessionId: "replacement-session",
          wireIdentity: { contentId: "replacement-content" },
        };
      },
    },
    {
      name: "replacement identity",
      mutate(current) {
        return { ...current, wireIdentity: { contentId: "replacement-content" } };
      },
    },
  ];

  for (const { name, mutate } of cases) {
    const f14 = createLocalRouter();
    f14.detector.emit("event", {
      type: "DJ_TRACK_ACTIVE",
      eventId: `${name}-f14-active`,
      payload: { ...f14.candidate, ...f14.candidate.wireIdentity },
    });
    f14.detector.current = mutate(f14.detector.current);
    const loopHalf = f14.router.triggerAction("loop-half");
    assert.equal(loopHalf.reason, "local-track-candidate-not-current", `${name} F14 must block`);
    assert.equal(loopHalf.midiSent, false);
    assert.deepEqual(f14.midi.sent, [], `${name} F14 must not send MIDI`);
    assert.equal(f14.client.sent.length, 0, `${name} F14 must not send an event`);

    const f13 = createLocalRouter();
    f13.detector.emit("event", {
      type: "DJ_TRACK_ACTIVE",
      eventId: `${name}-f13-active`,
      payload: { ...f13.candidate, ...f13.candidate.wireIdentity },
    });
    f13.detector.current = mutate(f13.detector.current);
    const release = f13.router.triggerAction("release");
    assert.equal(release.reason, "local-track-candidate-not-current", `${name} F13 must block`);
    assert.equal(release.midiSent, false);
    assert.deepEqual(f13.midi.sent, [], `${name} F13 must not send MIDI`);
    assert.equal(f13.client.sent.length, 0, `${name} F13 must not send an event`);
  }
});

test("local F13 cancels the filter generation when the same deck is replaced", () => {
  const fixture = createLocalRouter({ deferMacroCallbacks: true, recordOperations: true });
  fixture.detector.emit("event", {
    type: "DJ_TRACK_ACTIVE",
    eventId: "local-filter-owner",
    payload: { ...fixture.candidate, ...fixture.candidate.wireIdentity },
  });
  fixture.router.triggerAction("release");
  assert.deepEqual(fixture.midi.sent, ["filter-start"]);
  const oldFilter = fixture.filterOptions();

  replaceLocalCandidate(fixture, "filter");
  assert.equal(fixture.router.getStatus().releaseMacroPhase, "failed");
  assert.equal(fixture.router.getStatus().releaseMacroReason, "local-track-candidate-replaced");
  assert.equal(fixture.router.getStatus().lastAction.reason, "local-track-candidate-replaced");
  assert.equal(fixture.router.getStatus().lastAction.ok, false);
  assert.equal(fixture.router.getStatus().lastAction.cancelled, true);
  assert.equal(fixture.client.sent.length, 0);
  assert.deepEqual(fixture.midi.sent.slice(1), ["filter-cancel", "fade-cancel"]);

  oldFilter.onComplete({ ok: true, targetChannel: 1 });
  assert.equal(fixture.timerApi.pending().length, 0);
  assert.deepEqual(fixture.midi.sent.slice(1), ["filter-cancel", "fade-cancel"]);
});

test("local F13 cancels the fade generation when the same deck is replaced", () => {
  const fixture = createLocalRouter({ deferMacroCallbacks: true, recordOperations: true });
  fixture.detector.emit("event", {
    type: "DJ_TRACK_ACTIVE",
    eventId: "local-fade-owner",
    payload: { ...fixture.candidate, ...fixture.candidate.wireIdentity },
  });
  fixture.router.triggerAction("release");
  const oldFilter = fixture.filterOptions();
  oldFilter.onComplete({ ok: true, targetChannel: 1 });
  const oldFade = fixture.fadeOptions();
  assert.deepEqual(fixture.midi.sent, ["filter-start", "fade-start"]);

  replaceLocalCandidate(fixture, "fade");
  assert.equal(fixture.router.getStatus().releaseMacroReason, "local-track-candidate-replaced");
  assert.equal(fixture.router.getStatus().lastAction.localFailure, "local-track-candidate-replaced");
  assert.equal(fixture.client.sent.length, 0);
  assert.deepEqual(fixture.midi.sent.slice(2), ["filter-cancel", "fade-cancel"]);

  oldFade.onComplete({ ok: true, targetChannel: 1, resetValue: 127 });
  assert.equal(fixture.timerApi.pending().length, 0);
  assert.equal(fixture.midi.sent.includes("stop"), false);
  assert.equal(fixture.midi.sent.includes("filter"), false);
  assert.equal(fixture.midi.sent.includes("fade-reset"), false);
});

test("local F13 rechecks the owner immediately before Stop", () => {
  const fixture = createLocalRouter({ deferMacroCallbacks: true, recordOperations: true });
  fixture.detector.emit("event", {
    type: "DJ_TRACK_ACTIVE",
    eventId: "local-stop-owner",
    payload: { ...fixture.candidate, ...fixture.candidate.wireIdentity },
  });
  fixture.router.triggerAction("release");
  fixture.filterOptions().onComplete({ ok: true, targetChannel: 1 });
  const oldFade = fixture.fadeOptions();
  fixture.detector.current = {
    ...fixture.candidate,
    playSessionId: "local-stop-replacement-session",
    wireIdentity: { contentId: "content-stop-replacement" },
  };
  oldFade.onComplete({ ok: true, targetChannel: 1, resetValue: 127 });

  const status = fixture.router.getStatus();
  assert.equal(status.releaseMacroReason, "local-track-candidate-replaced");
  assert.equal(status.lastAction.reason, "local-track-candidate-replaced");
  assert.equal(fixture.client.sent.length, 0);
  assert.equal(fixture.midi.sent.includes("stop"), false);
  assert.equal(fixture.midi.sent.includes("filter"), false);
  assert.equal(fixture.midi.sent.includes("fade-reset"), false);
  assert.equal(fixture.timerApi.pending().length, 0);
});

test("local F13 rechecks the owner immediately before reset", () => {
  const fixture = createLocalRouter({ deferMacroCallbacks: true, recordOperations: true });
  fixture.detector.emit("event", {
    type: "DJ_TRACK_ACTIVE",
    eventId: "local-reset-owner",
    payload: { ...fixture.candidate, ...fixture.candidate.wireIdentity },
  });
  fixture.router.triggerAction("release");
  fixture.filterOptions().onComplete({ ok: true, targetChannel: 1 });
  fixture.fadeOptions().onComplete({ ok: true, targetChannel: 1, resetValue: 127 });
  assert.equal(fixture.midi.sent.includes("stop"), true);
  assert.equal(fixture.timerApi.pending().length, 1);

  const midiCountBeforeReplacement = fixture.midi.sent.length;
  fixture.detector.current = {
    ...fixture.candidate,
    playSessionId: "local-reset-replacement-session",
    wireIdentity: { contentId: "content-reset-replacement" },
    isPlaying: false,
  };
  fixture.timerApi.runNext();

  const status = fixture.router.getStatus();
  assert.equal(status.releaseMacroReason, "local-track-candidate-replaced");
  assert.equal(status.lastAction.reason, "local-track-candidate-replaced");
  assert.equal(fixture.client.sent.length, 0);
  assert.equal(fixture.midi.sent.includes("filter"), false);
  assert.equal(fixture.midi.sent.includes("fade-reset"), false);
  assert.deepEqual(fixture.midi.sent.slice(midiCountBeforeReplacement), ["filter-cancel", "fade-cancel"]);
  assert.equal(fixture.timerApi.pending().length, 0);
});

test("local F13 allows the exact paused owner to reset after a successful Stop", () => {
  const fixture = createLocalRouter({ deferMacroCallbacks: true, recordOperations: true });
  fixture.detector.emit("event", {
    type: "DJ_TRACK_ACTIVE",
    eventId: "local-paused-owner",
    payload: { ...fixture.candidate, ...fixture.candidate.wireIdentity },
  });
  fixture.router.triggerAction("release");
  fixture.filterOptions().onComplete({ ok: true, targetChannel: 1 });
  fixture.fadeOptions().onComplete({ ok: true, targetChannel: 1, resetValue: 127 });
  assert.equal(fixture.midi.sent.includes("stop"), true);
  assert.equal(fixture.timerApi.pending().length, 1);

  // Rekordbox's current playing candidate intentionally disappears on PAUSE,
  // but the detector's deck state still proves the same session and frozen
  // wire identity for the post-Stop neutral reset.
  fixture.detector.current = { ...fixture.candidate, isPlaying: false };
  assert.equal(fixture.router.getStatus().releaseMacroActive, true);
  fixture.timerApi.runNext();

  const status = fixture.router.getStatus();
  assert.equal(status.lastReleaseReset.state, "completed");
  assert.equal(status.releaseMacroPhase, "complete");
  assert.equal(status.releaseMacroReason, null);
  assert.equal(fixture.client.sent.length, 0);
  assert.deepEqual(fixture.midi.sent.slice(-2), ["filter", "fade-reset"]);
});

test("production router still requires terminal ACTIVE ACK and exposes no owner before it", () => {
  const production = createLocalRouter({ localTestMode: false });
  production.detector.emit("event", {
    type: "DJ_TRACK_ACTIVE",
    eventId: "production-active",
    payload: { ...production.candidate, ...production.candidate.wireIdentity },
  });
  assert.equal(production.client.sent.length, 1);
  assert.equal(production.router.getStateSync().ownerDeck, null);
  assert.equal(production.router.triggerAction("loop-half").reason, "no-admitted-track-candidate");
});

test("local router marks remote delivery not-applicable, blocks Timeline, and keeps F14 local", () => {
  const { candidate, client, detector, midi, router, timerApi } = createLocalRouter();
  detector.emit("event", {
    type: "DJ_TRACK_ACTIVE",
    eventId: "local-active",
    payload: { ...candidate, ...candidate.wireIdentity },
  });
  const action = router.triggerAction("loop-half");
  assert.equal(action.midiSent, true);
  assert.equal(action.delivery, null);
  assert.equal(client.sent.length, 0);
  timerApi.runNext();
  const fallbackAction = router.getStateSync().lastAction;
  assert.equal(fallbackAction.fallback.delivery.state, "not-applicable");
  assert.equal(fallbackAction.fallback.delivery.localOnly, true);
  assert.equal(fallbackAction.syndocalSent, false);
  assert.equal(fallbackAction.ok, true);
  assert.equal(router.getStateSync().stage1LoopFallback.nextTargetLengthBeats, 4);
  detector.emit("event", {
    type: "DJ_LOOP_STATE",
    eventId: "local-loop",
    payload: measuredLoop(candidate, 2),
  });
  assert.equal(router.getStateSync().loopDivision, 2);
  const timeline = router.triggerAction("beat-jump-plus-4");
  assert.equal(timeline.ok, false);
  assert.equal(timeline.reason, "timeline-disabled-in-rekordbox-local-test");
  const release = router.triggerAction("release");
  assert.equal(client.sent.length, 0);
  assert.equal(release.pending, true);
  assert.deepEqual(midi.sent.slice(-1), ["stop"]);
  timerApi.runNext();
  const releaseResult = router.getStateSync().lastAction;
  assert.equal(releaseResult.delivery.state, "not-applicable");
  assert.equal(releaseResult.delivery.localOnly, true);
  assert.equal(releaseResult.delivery.reason, "local-only");
  assert.equal(releaseResult.ok, true);
  assert.equal(releaseResult.reason, null);
  assert.deepEqual(midi.sent.slice(-5), ["filter-start", "fade-start", "stop", "filter", "fade-reset"]);
  assert.equal(client.sent.length, 0);
  assert.equal(router.getStatus().syndocal.state, "disabled");
  assert.ok(PROFILE.includes(router.getStateSync().loopDivision));
});
