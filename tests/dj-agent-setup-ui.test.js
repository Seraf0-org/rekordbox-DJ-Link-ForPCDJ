"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { validateFilterThenFadeThenStopShowConfig } = require("../server/dj-agent/config");

const PUBLIC_DIR = path.join(__dirname, "..", "server", "public");
const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
const app = fs.readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
const styles = fs.readFileSync(path.join(PUBLIC_DIR, "styles.css"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "..", "server", "index.js"), "utf8");

test("first-run setup card is always present and exposes read-only setup surfaces", () => {
  const cardStart = html.indexOf('<section id="djAgentSetupCard"');
  const cardEnd = html.indexOf('<section class="card mixer-panel"', cardStart);
  assert.ok(cardStart >= 0);
  assert.ok(cardEnd > cardStart);
  const card = html.slice(cardStart, cardEnd);

  assert.equal(/\bhidden\b/.test(card), false);
  for (const id of [
    "djAgentSetupRefresh",
    "djAgentSetupReadiness",
    "djAgentMidiPorts",
    "djAgentMappingArtifact",
    "djAgentConfigPreview",
    "djAgentSyndocalHost",
    "djAgentSyndocalNic",
    "djAgentMidiOutput",
    "djAgentAdapter",
  ]) {
    assert.match(card, new RegExp('id="' + id + '"'));
  }
  assert.match(card, /F13/);
  assert.match(card, /F14/);
  assert.match(card, /F15/);
  assert.match(card, /releaseMacro[^]*enabled[^]*true[^]*filter-then-fade-then-stop/);
  assert.match(card, /does not install drivers/);
  assert.match(card, /not persisted, sent to the server, or stored in localStorage/);
});

test("static setup preview is complete nested v1.1.11 and validates after restoring only the token placeholder", () => {
  const match = html.match(/<pre id="djAgentConfigPreview"[^>]*>([\s\S]*?)<\/pre>/);
  assert.ok(match);
  const preview = JSON.parse(match[1]);
  assert.deepEqual(Object.keys(preview).sort(), ["enabled", "midi", "pedal", "syndocal", "trackActivity", "version"]);
  assert.deepEqual(Object.keys(preview.midi).sort(), [
    "deckChannels", "device", "enabled", "filter", "mappings", "port", "releaseFade", "releaseMacro",
  ]);
  assert.equal(Object.hasOwn(preview, "releaseMacro"), false);
  assert.equal(Object.hasOwn(preview, "releaseFade"), false);
  assert.equal(preview.version, "1.1.11");
  assert.equal(preview.syndocal.adapter, "syndocal-envelope-v3");
  assert.equal(preview.midi.releaseFade.enabled, true);
  assert.equal(preview.midi.releaseMacro.sequence, "filter-then-fade-then-stop");
  assert.deepEqual(preview.trackActivity.ownerSelection, {
    mode: "titleContains",
    titleNeedle: "人生オーバー",
    deck1MetadataWaitMs: 1400,
  });
  const withTokenPlaceholder = {
    ...preview,
    syndocal: { ...preview.syndocal, token: "<SYNDOCAL_ONE_TIME_TOKEN>" },
  };
  assert.equal(
    validateFilterThenFadeThenStopShowConfig(withTokenPlaceholder, { allowTokenPlaceholder: true }),
    true,
  );
});

test("setup client uses only local GET, handles remote/403 gracefully, and has no setup persistence", () => {
  assert.match(app, /fetch\(\"\/api\/dj-agent\/setup\", \{\s*method: \"GET\"/);
  assert.match(app, /response\.status === 403/);
  assert.match(app, /DJ PC上のlocalhostで開く/);
  assert.match(app, /networkInterfaces/);
  assert.match(app, /option\.value = address/);
  assert.match(app, /option\.dataset\.interfaceName = name/);
  assert.doesNotMatch(app, /const value = name \|\| address/);
  assert.match(app, /configTemplate/);
  assert.match(app, /releaseMacro[\s\S]{0,160}enabled: true/);
  const setupBlock = app.slice(app.indexOf("function isLocalDjAgentHost"), app.indexOf("function renderWarnings"));
  assert.equal(setupBlock.includes("localStorage"), false);
  assert.equal(setupBlock.includes('method: "POST"'), false);
  assert.equal(setupBlock.includes("/api/dj-agent/actions/"), false);
});

test("setup does not seed implicit MIDI or adapter choices", () => {
  const defaultTemplate = app.slice(
    app.indexOf("const DEFAULT_DJ_AGENT_CONFIG_TEMPLATE"),
    app.indexOf("const SETUP_ADAPTERS"),
  );
  assert.match(defaultTemplate, /midi:\s*\{\s*device: "",\s*port: null/);

  const seedBlock = app.slice(app.indexOf("function seedDjAgentSetupDraft"), app.indexOf("function renderDjAgentSetupControls"));
  assert.match(seedBlock, /djAgentSetupDraft\.adapter\s*=\s*""/);
  assert.match(seedBlock, /typeof midi\.device === "string"/);
  assert.match(seedBlock, /normalizeSetupMidiPort\(midi\.port\)/);
  assert.doesNotMatch(seedBlock, /Number\(midi\.port\)/);
  assert.match(app, /function normalizeSetupMidiPort\(value\)\s*\{[\s\S]*typeof value === "number"[\s\S]*Number\.isSafeInteger\(value\)/);
  assert.match(app, /function parseSetupMidiPortText\(value\)\s*\{[\s\S]*typeof value !== "string"/);
});

test("DJ Link setup offers only the v3 adapter", () => {
  assert.match(html, /<option value="syndocal-envelope-v3">syndocal-envelope-v3<\/option>/);
  assert.doesNotMatch(html, /syndocal-envelope-v2/);
  assert.match(app, /const SETUP_ADAPTERS = \["syndocal-envelope-v3"\];/);
});

test("Web Agent is diagnostic-only; operator return is owned by Syndocal", () => {
  assert.doesNotMatch(html, /djAgentReturnToDjControl|Return to DJ control/);
  assert.match(html, /id="djAgentCandidateStage"/);
  assert.match(html, /id="djAgentAuthorityConsistency"/);
  assert.match(app, /SYNC REQUIRED/);
  assert.match(app, /authorityConsistency/);
  assert.doesNotMatch(app, /return-to-dj-control|operator-deck1-fallback|lastOperatorOverride/);
  assert.doesNotMatch(server, /return-to-dj-control|operatorDjControlReturn|lastOperatorOverride/);
  const actionHandler = server.slice(
    server.indexOf("function handleDjAgentAction"),
    server.indexOf("// These diagnostics use the same action path"),
  );
  assert.match(actionHandler, /isActionRequestAllowed\(_req\)/);
  assert.match(server, /stateSyncProvider: \(\) => \(djAgentRouter \? djAgentRouter\.getSyndocalStateSync\(\) : \{\}\)/);
});

test("local Agent status renders authority as not-applicable without connected/error state", () => {
  const elementNames = [
    "djAgentPanelEl", "djAgentSafetyBannerEl", "djAgentSyndocalStatusEl", "djAgentMidiStatusEl",
    "djAgentModeEl", "djAgentOwnerRowEl", "djAgentOwnerEl", "djAgentCandidateStageEl",
    "djAgentAuthorityConsistencyEl", "djAgentTimelineStateEl", "djAgentTimelineLoopEl",
    "djAgentReleaseMacroEl", "djAgentLastEventEl", "djAgentLastTimelineActionEl",
    "djAgentLastAckEl", "djAgentActionResultEl",
  ];
  const makeElement = () => {
    const classes = new Map();
    return {
      textContent: "",
      hidden: false,
      classList: {
        values: classes,
        toggle(name, value) { classes.set(name, value === true); },
      },
    };
  };
  const context = Object.fromEntries(elementNames.map((name) => [name, makeElement()]));
  const sourceStart = app.indexOf("function renderDjAgentStatus");
  const sourceEnd = app.indexOf("function isLocalDjAgentHost");
  const api = vm.runInNewContext(
    `${app.slice(sourceStart, sourceEnd)}; ({ renderDjAgentStatus })`,
    context,
  );
  api.renderDjAgentStatus({
    djAgent: {
      enabled: true,
      testOnly: true,
      localTestMode: true,
      safetyLabel: "REKORDBOX LOCAL TEST / NO SYNDOCAL",
      syndocal: { state: "connected", lastAckAt: "must-not-render" },
      midi: { ok: false, message: "midi-selection-invalid" },
      mode: "dj-control",
      timelineState: "running",
      timelineLoopActive: true,
      authorityConsistency: {
        state: "not-applicable",
        label: "NOT APPLICABLE / LOCAL-ONLY",
      },
    },
  });
  assert.equal(context.djAgentSyndocalStatusEl.textContent, "NOT APPLICABLE / LOCAL-ONLY");
  assert.equal(context.djAgentSyndocalStatusEl.classList.values.get("connected"), false);
  assert.equal(context.djAgentAuthorityConsistencyEl.textContent, "NOT APPLICABLE / LOCAL-ONLY");
  assert.equal(context.djAgentAuthorityConsistencyEl.classList.values.get("connected"), false);
  assert.equal(context.djAgentAuthorityConsistencyEl.classList.values.get("error"), false);
  assert.equal(context.djAgentTimelineStateEl.textContent, "NOT APPLICABLE / LOCAL-ONLY");
});

test("local setup message prioritizes a failed MIDI gate and keeps the safety banner neutral", () => {
  const sourceStart = app.indexOf("function getDjAgentSetupMessage");
  const sourceEnd = app.indexOf("function renderDjAgentSetup(");
  const api = vm.runInNewContext(
    `${app.slice(sourceStart, sourceEnd)}; ({ getDjAgentSetupMessage })`,
    {},
  );
  const failed = api.getDjAgentSetupMessage({
    localOnly: true,
    ok: true,
    enabled: true,
    testOnly: true,
    readiness: {
      ready: false,
      gates: { midi: { state: "blocked", allowed: false, reason: "midi-selection-invalid" } },
    },
  });
  assert.equal(failed.state, "error");
  assert.match(failed.text, /REKORDBOX LOCAL TEST \/ NO SYNDOCAL/);
  assert.match(failed.text, /MIDI readiness blocked/);
  assert.match(failed.text, /midi-selection-invalid/);

  const ready = api.getDjAgentSetupMessage({
    localOnly: true,
    ok: true,
    enabled: true,
    testOnly: true,
    readiness: { ready: true, gates: { midi: { state: "ready", allowed: true } } },
  });
  assert.equal(ready.state, "");
  assert.match(ready.text, /remote delivery is not applicable/);
});

test("setup reflects only an exact enumerated MIDI name+port pair and fails closed after refresh", () => {
  const controlsBlock = app.slice(app.indexOf("function renderDjAgentSetupControls"), app.indexOf("function updateDjAgentConfigPreviewFromDraft"));
  assert.match(controlsBlock, /placeholder\.value\s*=\s*""/);
  assert.match(controlsBlock, /placeholder\.selected\s*=\s*true/);
  assert.match(controlsBlock, /option\.dataset\.port\s*=\s*String\(index\)/);
  assert.match(controlsBlock, /option\.dataset\.deviceName\s*===\s*selectedDevice/);
  assert.match(controlsBlock, /parseSetupMidiPortText\(option\.dataset\.port \|\| option\.value\)\s*===\s*selectedPort/);
  assert.match(controlsBlock, /if \(matchingOption\)/);
  assert.match(controlsBlock, /djAgentSetupDraft\.midiPort\s*=\s*""/);
  assert.match(controlsBlock, /djAgentSetupDraft\.midiDevice\s*=\s*""/);
  assert.match(controlsBlock, /djAgentMidiOutputEl\.value\s*=\s*""/);
  assert.doesNotMatch(controlsBlock, /matchingDevice/);
  assert.doesNotMatch(controlsBlock, /if \(!djAgentSetupDraft\.midiPort &&/);
});

test("setup preview remains empty for an unselected MIDI pair", () => {
  const previewBlock = app.slice(app.indexOf("function updateDjAgentConfigPreviewFromDraft"), app.indexOf("function getDjAgentConfigPreview"));
  assert.match(previewBlock, /const midiPort\s*=\s*parseSetupMidiPortText\(djAgentSetupDraft\.midiPort\)/);
  assert.match(previewBlock, /const midiDevice\s*=\s*midiPort === null \? ""/);
  assert.match(previewBlock, /device:\s*midiDevice/);
  assert.match(previewBlock, /port:\s*midiPort/);
  assert.match(previewBlock, /adapter: djAgentSetupDraft\.adapter/);
});

test("setup preview keeps the v1.1.11 strict schema shape with MIDI macro nesting", () => {
  const sourceStart = app.indexOf("const DEFAULT_DJ_AGENT_CONFIG_TEMPLATE");
  const sourceEnd = app.indexOf("async function fetchDjAgentSetup");
  assert.ok(sourceStart >= 0 && sourceEnd > sourceStart);
  const previewElement = { textContent: "" };
  const api = vm.runInNewContext(
    `${app.slice(sourceStart, sourceEnd)}
;({
  normalizeDjAgentConfigTemplate,
  setTemplate(value) { djAgentSetupTemplate = value; },
  setDraft(value) { Object.assign(djAgentSetupDraft, value); },
  updateDjAgentConfigPreviewFromDraft,
  getPreview() { return djAgentConfigPreviewEl.textContent; },
})`,
    { djAgentConfigPreviewEl: previewElement },
  );
  const template = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "config", "dj-agent-v1.1.11.example.json"),
    "utf8",
  ));
  const legacyRoot = {
    ...template,
    releaseMacro: { enabled: true, sequence: "filter-then-stop" },
    releaseFade: { enabled: true, mapping: "releaseFade", target: "deck" },
  };
  const normalizedLegacy = api.normalizeDjAgentConfigTemplate(legacyRoot);
  assert.equal(Object.hasOwn(normalizedLegacy, "releaseMacro"), false);
  assert.equal(Object.hasOwn(normalizedLegacy, "releaseFade"), false);
  assert.equal(normalizedLegacy.midi.releaseMacro.sequence, "filter-then-fade-then-stop");

  api.setTemplate(template);
  api.setDraft({
    host: template.syndocal.host,
    nic: template.syndocal.nic,
    adapter: template.syndocal.adapter,
    midiDevice: template.midi.device,
    midiPort: String(template.midi.port),
  });
  api.updateDjAgentConfigPreviewFromDraft();
  const preview = JSON.parse(api.getPreview());
  assert.deepEqual(Object.keys(preview).sort(), ["enabled", "midi", "pedal", "syndocal", "trackActivity", "version"]);
  assert.deepEqual(Object.keys(preview.midi).sort(), [
    "deckChannels", "device", "enabled", "filter", "mappings", "port", "releaseFade", "releaseMacro",
  ]);
  assert.equal(Object.hasOwn(preview, "releaseMacro"), false);
  assert.equal(Object.hasOwn(preview, "releaseFade"), false);
  assert.deepEqual(preview.trackActivity.ownerSelection, {
    mode: "titleContains",
    titleNeedle: "人生オーバー",
    deck1MetadataWaitMs: 1400,
  });
  // Setup deliberately omits the secret. Restoring the documented placeholder
  // here models the operator's final external file without testing secret
  // transport or persistence in the browser.
  preview.syndocal.token = "<SYNDOCAL_ONE_TIME_TOKEN>";
  assert.equal(validateFilterThenFadeThenStopShowConfig(preview, { allowTokenPlaceholder: true }), true);
});

test("setup styling keeps normal hit targets and provides responsive/internal flow", () => {
  assert.match(styles, /\.dj-agent-setup-controls\s*\{[\s\S]*grid-template-columns/);
  assert.match(styles, /\.dj-agent-table-scroll\s*\{[\s\S]*overflow-x: auto/);
  assert.match(styles, /\.dj-agent-config-preview\s*\{[\s\S]*max-height: 240px[\s\S]*overflow: auto/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*\.dj-agent-setup-controls,[\s\S]*\.dj-agent-setup-grid/);
});
