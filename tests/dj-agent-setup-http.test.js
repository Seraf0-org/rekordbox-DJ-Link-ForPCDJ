"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "server", "index.js");
const TEST_TOKEN = "setup-test-token-must-never-be-returned";

function nonLoopbackIpv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry?.family === "IPv4" && entry.internal !== true) return entry.address;
    }
  }
  return null;
}

function requestJson(host, port, pathName, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host, port, path: pathName, headers, timeout: 5_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve({ statusCode: response.statusCode, headers: response.headers, body: JSON.parse(body), raw: body });
        } catch (error) {
          reject(new Error(`response was not JSON: ${body}\n${error.message}`));
        }
      });
    });
    request.once("timeout", () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
  });
}

function startServer(t, options = {}) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: "0",
      RB_OUTPUT_HOST: "0.0.0.0",
      HOOK_UDP_ENABLED: "false",
      ABLETON_LINK_ENABLED: "false",
      DJ_AGENT_ENABLED: options.agentEnabled === true ? "true" : "false",
      MIDI_ENABLED: options.midiEnabled === false ? "false" : process.env.MIDI_ENABLED,
      PEDAL_ENABLED: options.pedalEnabled === false ? "false" : process.env.PEDAL_ENABLED,
      SYNDOCAL_ENABLED: options.syndocalEnabled === false ? "false" : process.env.SYNDOCAL_ENABLED,
      SYNDOCAL_TOKEN: TEST_TOKEN,
      ...(options.extraEnv || {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`server startup timed out:\n${output}`)), 10_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/rb-output server listening on http:\/\/0\.0\.0\.0:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]) });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`server exited before bind (code=${code}, signal=${signal}):\n${output}`));
    });
  });
}

test("DJ Agent setup snapshot is localhost-only, token-free, and macro-safe", async (t) => {
  const { port } = await startServer(t);
  const local = await requestJson("127.0.0.1", port, "/api/dj-agent/setup");
  assert.equal(local.statusCode, 200);
  assert.equal(local.body.ok, true);
  assert.equal(local.body.localOnly, true);
  assert.equal(local.body.enabled, false);
  assert.equal(local.body.tokenConfigured, true);
  assert.equal(local.raw.includes(TEST_TOKEN), false);
  assert.equal(Object.hasOwn(local.body.configTemplate.syndocal, "token"), false);
  assert.equal(local.body.configTemplate.midi.releaseMacro.enabled, false);
  assert.equal(local.body.mappingArtifact.valid, true);
  assert.equal(local.body.mappingArtifact.url, "/setup/CustomMIDI1-Syndocal-v1.1.4.csv");
  assert.match(local.body.mappingArtifact.semanticFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(local.body.mappingArtifact.operatorVerified, false);
  assert.equal(local.body.readiness.actions.releaseMacro, false);
  assert.ok(Array.isArray(local.body.networkInterfaces));
  assert.ok(Array.isArray(local.body.midiPorts.ports));
  assert.equal(local.headers["access-control-allow-origin"], undefined);

  const forgedHost = await requestJson("127.0.0.1", port, "/api/dj-agent/setup", {
    Host: "attacker.example",
  });
  assert.equal(forgedHost.statusCode, 403);
  assert.equal(forgedHost.headers["access-control-allow-origin"], undefined);

  const forgedOrigin = await requestJson("127.0.0.1", port, "/api/dj-agent/setup", {
    Origin: "https://attacker.example",
  });
  assert.equal(forgedOrigin.statusCode, 403);
  assert.equal(forgedOrigin.headers["access-control-allow-origin"], undefined);

  const localOrigin = await requestJson("127.0.0.1", port, "/api/dj-agent/setup", {
    Origin: `http://127.0.0.1:${port}`,
  });
  assert.equal(localOrigin.statusCode, 200);

  const lanAddress = nonLoopbackIpv4();
  if (!lanAddress) {
    t.diagnostic("no non-loopback IPv4 NIC; localhost-only positive path was verified");
    return;
  }
  const remote = await requestJson(lanAddress, port, "/api/dj-agent/setup");
  assert.equal(remote.statusCode, 403);
  assert.deepEqual(remote.body, {
    ok: false,
    localOnly: true,
    error: "DJ Agent setup is available only on the DJ PC through localhost",
  });
  assert.equal(remote.raw.includes(TEST_TOKEN), false);
});

test("setup readiness reports the exact bundled mapping as software-ready without physical verification", async (t) => {
  const { port } = await startServer(t, {
    agentEnabled: true,
    midiEnabled: false,
    pedalEnabled: false,
    syndocalEnabled: false,
  });
  const local = await requestJson("127.0.0.1", port, "/api/dj-agent/setup");
  assert.equal(local.statusCode, 200);
  assert.equal(local.body.mappingArtifact.valid, true);
  assert.equal(local.body.mappingArtifact.operatorVerified, false);
  assert.equal(local.body.readiness.gates.mapping.state, "ready");
  assert.equal(local.body.readiness.gates.mapping.allowed, true);
  assert.equal(local.body.readiness.actions.mapping, true);
});

test("invalid injected mapping artifact blocks readiness while the bundled CSV stays untouched", async (t) => {
  const bundledCsvPath = path.join(
    REPO_ROOT,
    "server",
    "public",
    "setup",
    "CustomMIDI1-Syndocal-v1.1.4.csv"
  );
  const bundledBefore = fs.readFileSync(bundledCsvPath);
  // The corrupt fixture lives in the OS temp dir and is injected via
  // RB_OUTPUT_SETUP_MAPPING_PATH; the production artifact is only read, and
  // its bytes are re-compared below as proof it was never mutated.
  const corruptPath = path.join(
    os.tmpdir(),
    `rb-output-invalid-mapping-${process.pid}-${Date.now()}.csv`
  );
  fs.writeFileSync(corruptPath, "not,a,valid,custom,midi,mapping\n");
  t.after(() => {
    fs.rmSync(corruptPath, { force: true });
  });

  const { port } = await startServer(t, {
    agentEnabled: true,
    midiEnabled: false,
    pedalEnabled: false,
    syndocalEnabled: false,
    extraEnv: { RB_OUTPUT_SETUP_MAPPING_PATH: corruptPath },
  });
  const local = await requestJson("127.0.0.1", port, "/api/dj-agent/setup");
  assert.equal(local.statusCode, 200);
  assert.equal(local.body.mappingArtifact.valid, false);
  assert.equal(local.body.mappingArtifact.code, "invalid-header");
  assert.equal(local.body.mappingArtifact.semanticFingerprint, null);
  assert.equal(local.body.mappingArtifact.summary, null);
  assert.equal(local.body.mappingArtifact.url, "/setup/CustomMIDI1-Syndocal-v1.1.4.csv");
  assert.equal(local.body.readiness.gates.mapping.state, "blocked");
  assert.equal(local.body.readiness.gates.mapping.reason, "mapping-invalid");
  assert.equal(local.body.readiness.gates.mapping.allowed, false);
  assert.equal(local.body.readiness.actions.mapping, false);
  assert.equal(local.body.readiness.actions.releaseMacro, false);
  assert.equal(local.body.readiness.ready, false);
  assert.equal(local.body.readiness.state, "blocked");

  assert.ok(fs.readFileSync(bundledCsvPath).equals(bundledBefore));
});

test("unset Syndocal adapter resolves to the shipped strict v2 default in the setup template", async (t) => {
  const { port } = await startServer(t);
  const local = await requestJson("127.0.0.1", port, "/api/dj-agent/setup");
  assert.equal(local.statusCode, 200);
  // No SYNDOCAL_WS_ADAPTER / syndocal.adapter anywhere in the environment:
  // config.js resolves unset to the only supported protocol and the template echoes it.
  assert.equal(local.body.configTemplate.syndocal.adapter, "syndocal-envelope-v2");
});

test("strict v2 round-trips while retired flat/v1 adapters fail closed", async (t) => {
  const envelope = await startServer(t, {
    extraEnv: { SYNDOCAL_WS_ADAPTER: "syndocal-envelope-v2" },
  });
  const envelopeResponse = await requestJson(
    "127.0.0.1",
    envelope.port,
    "/api/dj-agent/setup"
  );
  assert.equal(envelopeResponse.statusCode, 200);
  assert.equal(envelopeResponse.body.configTemplate.syndocal.adapter, "syndocal-envelope-v2");

  for (const retired of ["generic-json", "syndocal-envelope-v1"]) {
    const server = await startServer(t, {
      agentEnabled: true,
      midiEnabled: false,
      pedalEnabled: false,
      extraEnv: { SYNDOCAL_WS_ADAPTER: retired },
    });
    const response = await requestJson("127.0.0.1", server.port, "/api/dj-agent/setup");
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.configTemplate.syndocal.adapter, "");
    assert.equal(response.body.readiness.gates.syndocal.reason, "syndocal-adapter-invalid");
  }
});

test("unknown or hostile adapters fail closed to blank without echoing input or any valid adapter name", async (t) => {
  const injectionAdapter = '"><script>fetch("/api/status")</script>syndocal-envelope-v1';
  const injected = await startServer(t, {
    agentEnabled: true,
    midiEnabled: false,
    pedalEnabled: false,
    extraEnv: {
      SYNDOCAL_ENABLED: "true",
      SYNDOCAL_WS_ADAPTER: injectionAdapter,
    },
  });
  const injectedResponse = await requestJson(
    "127.0.0.1",
    injected.port,
    "/api/dj-agent/setup"
  );
  assert.equal(injectedResponse.statusCode, 200);
  // Fail closed to the blank/unselected template value...
  assert.equal(injectedResponse.body.configTemplate.syndocal.adapter, "");
  // ...never silently rewritten to a valid adapter...
  assert.equal(injectedResponse.raw.includes("syndocal-envelope-v1"), false);
  assert.equal(injectedResponse.raw.includes("generic-json"), false);
  // ...and the caller's hostile input is never reflected anywhere.
  assert.equal(injectedResponse.raw.includes(injectionAdapter), false);
  assert.equal(injectedResponse.raw.includes("<script>"), false);
  // The existing readiness schema reports the invalid adapter truthfully.
  assert.equal(injectedResponse.body.readiness.gates.syndocal.state, "blocked");
  assert.equal(injectedResponse.body.readiness.gates.syndocal.reason, "syndocal-adapter-invalid");
  assert.equal(injectedResponse.body.readiness.gates.syndocal.allowed, false);
  assert.equal(injectedResponse.body.readiness.actions.syndocal, false);

  const plainUnknown = await startServer(t, {
    extraEnv: { SYNDOCAL_WS_ADAPTER: "envelope-v2" },
  });
  const plainUnknownResponse = await requestJson(
    "127.0.0.1",
    plainUnknown.port,
    "/api/dj-agent/setup"
  );
  assert.equal(plainUnknownResponse.statusCode, 200);
  assert.equal(plainUnknownResponse.body.configTemplate.syndocal.adapter, "");
  assert.equal(plainUnknownResponse.raw.includes("envelope-v2"), false);
  assert.equal(plainUnknownResponse.raw.includes("syndocal-envelope-v1"), false);
});
