"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const { RUNTIME_SHOW_OVERRIDE_KEYS, STRICT_SHOW_CONFIG_DISABLED_REASON } = require("../server/dj-agent/config");

const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "server", "index.js");

function strictShowConfig() {
  return {
    version: "1.1.8",
    enabled: true,
    syndocal: {
      enabled: true,
      host: "192.168.50.1",
      port: 9100,
      path: "/dj-link",
      nic: "192.168.50.2",
      token: "0123456789abcdef0123456789abcdef",
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

function cleanRuntimeEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of [...RUNTIME_SHOW_OVERRIDE_KEYS, "DJ_AGENT_CONFIG_PATH"]) {
    delete env[key];
  }
  return {
    ...env,
    PORT: "0",
    RB_OUTPUT_HOST: "127.0.0.1",
    HOOK_UDP_ENABLED: "false",
    ABLETON_LINK_ENABLED: "false",
    ...extra,
  };
}

function startDisabledSourceServer(t, { source = null, env = {}, cwd = REPO_ROOT } = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-output-runtime-gate-"));
  const configPath = path.join(tempRoot, "show.json");
  if (source != null) {
    fs.writeFileSync(configPath, JSON.stringify(source), "utf8");
  }
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd,
    env: cleanRuntimeEnv({ ...(source != null ? { DJ_AGENT_CONFIG_PATH: configPath } : {}), ...env }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill();
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`source server startup timed out: ${output}`)), 10_000);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/rb-output server listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve({ child, port: Number(match[1]), configPath });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`source server exited early (${code}/${signal}): ${output}`)));
  });
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: pathname, timeout: 5_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode, raw: body, body: JSON.parse(body) }));
    }).once("error", reject);
  });
}

test("source-direct server keeps missing and retired raw show configs disabled", async (t) => {
  for (const source of [null, { version: "1.1.6", enabled: true }]) {
    const { port } = await startDisabledSourceServer(t, { source });
    const status = await getJson(port, "/api/dj-agent/status");
    assert.equal(status.statusCode, 200);
    assert.equal(status.body.enabled, false);
    assert.equal(status.body.status.message, STRICT_SHOW_CONFIG_DISABLED_REASON);
    assert.equal(status.raw.includes("1.1.6"), false);
  }
});

test("source-direct server rejects a valid raw show config when any activation env override is present", async (t) => {
  const { port } = await startDisabledSourceServer(t, {
    source: strictShowConfig(),
    env: { DJ_AGENT_ENABLED: "true" },
  });
  const status = await getJson(port, "/api/dj-agent/status");
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.enabled, false);
  assert.equal(status.body.status.message, STRICT_SHOW_CONFIG_DISABLED_REASON);
  assert.equal(status.raw.includes("0123456789abcdef0123456789abcdef"), false);
});

test("source-direct server from another cwd rejects a checkout-internal show source", async (t) => {
  const otherCwd = fs.mkdtempSync(path.join(os.tmpdir(), "rb-output-direct-cwd-"));
  const { port, child } = await startDisabledSourceServer(t, {
    cwd: otherCwd,
    env: {
      DJ_AGENT_CONFIG_PATH: path.join(REPO_ROOT, "config", "dj-agent-v1.1.8.example.json"),
    },
  });
  const status = await getJson(port, "/api/dj-agent/status");
  assert.equal(status.statusCode, 200);
  assert.equal(status.body.enabled, false);
  assert.equal(status.body.status.message, STRICT_SHOW_CONFIG_DISABLED_REASON);
  t.after(async () => {
    if (child.exitCode == null && child.signalCode == null) {
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill();
      });
    }
    fs.rmSync(otherCwd, { recursive: true, force: true });
  });
});
