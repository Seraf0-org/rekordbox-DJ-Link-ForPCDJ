"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { RUNTIME_SHOW_OVERRIDE_KEYS } = require("../server/dj-agent/config");

const REPO_ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "server", "index.js");

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
  const env = { ...process.env };
  for (const key of [...RUNTIME_SHOW_OVERRIDE_KEYS, "DJ_AGENT_CONFIG_PATH"]) delete env[key];
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...env,
      PORT: "0",
      RB_OUTPUT_HOST: "0.0.0.0",
      HOOK_UDP_ENABLED: "false",
      ABLETON_LINK_ENABLED: "false",
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
  assert.equal(local.body.tokenConfigured, false);
  assert.equal(Object.hasOwn(local.body.configTemplate.syndocal, "token"), false);
  assert.deepEqual(Object.keys(local.body.configTemplate).sort(), ["enabled", "midi", "pedal", "syndocal", "trackActivity", "version"]);
  assert.deepEqual(Object.keys(local.body.configTemplate.midi).sort(), [
    "deckChannels", "device", "enabled", "filter", "mappings", "port", "releaseFade", "releaseMacro",
  ]);
  assert.equal(local.body.configTemplate.midi.releaseMacro.enabled, true);
  assert.equal(local.body.configTemplate.midi.releaseMacro.sequence, "filter-then-fade-then-stop");
  assert.equal(local.body.mappingArtifact.valid, true);
  assert.equal(local.body.mappingArtifact.url, "/setup/CustomMIDI1-Syndocal-v1.1.11.csv");
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
});

test("read-only first-run setup exposes the exact bundled mapping while Agent actions stay disabled", async (t) => {
  const { port } = await startServer(t);
  const local = await requestJson("127.0.0.1", port, "/api/dj-agent/setup");
  assert.equal(local.statusCode, 200);
  assert.equal(local.body.mappingArtifact.valid, true);
  assert.equal(local.body.mappingArtifact.operatorVerified, false);
  assert.equal(local.body.readiness.gates.mapping.state, "disabled");
  assert.equal(local.body.readiness.gates.mapping.reason, "root-disabled");
  assert.equal(local.body.readiness.actions.mapping, false);
  assert.equal(local.body.readiness.state, "disabled");
});

test("invalid injected mapping artifact remains observable while first-run actions stay disabled", async (t) => {
  const bundledCsvPath = path.join(
    REPO_ROOT,
    "server",
    "public",
    "setup",
    "CustomMIDI1-Syndocal-v1.1.11.csv"
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

  const { port } = await startServer(t, { extraEnv: { RB_OUTPUT_SETUP_MAPPING_PATH: corruptPath } });
  const local = await requestJson("127.0.0.1", port, "/api/dj-agent/setup");
  assert.equal(local.statusCode, 200);
  assert.equal(local.body.mappingArtifact.valid, false);
  assert.equal(local.body.mappingArtifact.code, "invalid-header");
  assert.equal(local.body.mappingArtifact.semanticFingerprint, null);
  assert.equal(local.body.mappingArtifact.summary, null);
  assert.equal(local.body.mappingArtifact.url, "/setup/CustomMIDI1-Syndocal-v1.1.11.csv");
  assert.equal(local.body.readiness.gates.mapping.state, "disabled");
  assert.equal(local.body.readiness.gates.mapping.reason, "root-disabled");
  assert.equal(local.body.readiness.gates.mapping.allowed, false);
  assert.equal(local.body.readiness.actions.mapping, false);
  assert.equal(local.body.readiness.actions.releaseMacro, false);
  assert.equal(local.body.readiness.ready, false);
  assert.equal(local.body.readiness.state, "disabled");

  assert.ok(fs.readFileSync(bundledCsvPath).equals(bundledBefore));
});

test("unset Syndocal adapter resolves to the shipped strict v3 default in the setup template", async (t) => {
  const { port } = await startServer(t);
  const local = await requestJson("127.0.0.1", port, "/api/dj-agent/setup");
  assert.equal(local.statusCode, 200);
  // No SYNDOCAL_WS_ADAPTER / syndocal.adapter anywhere in the environment:
  // config.js resolves unset to the only supported protocol and the template echoes it.
  assert.equal(local.body.configTemplate.syndocal.adapter, "syndocal-envelope-v3");
});
