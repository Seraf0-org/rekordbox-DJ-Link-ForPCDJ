"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { RUNTIME_SHOW_OVERRIDE_KEYS } = require("../server/dj-agent/config");

const REPO_ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "server", "index.js");
const TEST_TOKEN = "0123456789abcdef0123456789abcdef0123456789abc";

function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

async function startServer(t, hookPort, configPath) {
  const env = { ...process.env };
  for (const key of [...RUNTIME_SHOW_OVERRIDE_KEYS, "DJ_AGENT_CONFIG_PATH"]) {
    delete env[key];
  }
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...env,
      PORT: "0",
      RB_OUTPUT_HOST: "127.0.0.1",
      HOOK_UDP_ENABLED: "true",
      HOOK_UDP_PORT: String(hookPort),
      ABLETON_LINK_ENABLED: "false",
      DJ_AGENT_CONFIG_PATH: configPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => stopServer(child));

  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (error, port) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      if (error) {
        stopServer(child).finally(() => reject(error));
      } else {
        resolve({ child, port, output });
      }
    };
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/rb-output server listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) finish(null, Number(match[1]));
    };
    const timer = setTimeout(() => finish(new Error(`server startup timed out:\n${output}`)), 10_000);
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`server exited before bind (code=${code}, signal=${signal}):\n${output}`));
    });
  });
}

function connectEventStream(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/api/stream" }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`SSE status ${response.statusCode}`));
        return;
      }
      response.setEncoding("utf8");
      resolve({ request, response });
    });
    request.once("error", reject);
  });
}

function fetchState(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/api/state" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.once("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`state status ${response.statusCode}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once("error", reject);
  });
}

test("enabled Hook plus synchronous router updates stay bounded on the public SSE stream", async (t) => {
  const hookPort = 45_000 + Math.floor(Math.random() * 1_000);
  const configPath = path.join(os.tmpdir(), `rb-output-broadcast-${process.pid}-${Date.now()}.json`);
  const config = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, "config", "dj-agent-v1.1.11.example.json"),
    "utf8",
  ));
  config.syndocal.token = TEST_TOKEN;
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
  t.after(() => fs.rmSync(configPath, { force: true }));

  const { port } = await startServer(t, hookPort, configPath);
  const { request, response } = await connectEventStream(port);
  t.after(() => request.destroy());
  let stateEvents = 0;
  let buffer = "";
  const stateEventMarker = "event: state\n";
  response.on("data", (chunk) => {
    buffer += chunk;
    let markerIndex;
    while ((markerIndex = buffer.indexOf(stateEventMarker)) !== -1) {
      stateEvents += 1;
      buffer = buffer.slice(markerIndex + stateEventMarker.length);
    }
    // Retain only a possible split marker; the count is cumulative and the
    // parser remains bounded during this deliberately high-rate test.
    if (buffer.length > stateEventMarker.length - 1) {
      buffer = buffer.slice(-(stateEventMarker.length - 1));
    }
  });

  const sender = dgram.createSocket("udp4");
  t.after(() => sender.close());
  const packet = Buffer.from(JSON.stringify({
    type: "olvc",
    deck: 1,
    name: "@CurrentTime",
    value: 1_000,
  }));
  await Promise.all(Array.from({ length: 500 }, () => new Promise((resolve, reject) => {
    sender.send(packet, hookPort, "127.0.0.1", (error) => {
      if (error) reject(error);
      else resolve();
    });
  })));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const state = await fetchState(port);
  response.destroy();

  assert.equal(
    state.deckPlaybacks.find((deck) => deck.deck === 1)?.positionRevision,
    500,
    "the server must ingest every packet used by the broadcast bound assertion",
  );
  assert.ok(stateEvents > 0, "the stream should include the initial state");
  assert.ok(
    stateEvents <= 10,
    `latest-wins stream emitted ${stateEvents} state frames for 500 Hook packets`,
  );
});
