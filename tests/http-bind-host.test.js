"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "server", "index.js");

function startServer(t, requestedHost) {
  const env = {
    ...process.env,
    PORT: "0",
    HOOK_UDP_ENABLED: "false",
    ABLETON_LINK_ENABLED: "false",
    DJ_AGENT_ENABLED: "false",
  };
  if (requestedHost === undefined) {
    delete env.RB_OUTPUT_HOST;
  } else {
    env.RB_OUTPUT_HOST = requestedHost;
  }

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (!child.killed && child.exitCode === null) child.kill();
  });

  return new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const finish = (error, address) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      if (error) {
        child.kill();
        reject(error);
      } else {
        resolve(address);
      }
    };
    const onData = (chunk) => {
      output += chunk.toString();
      const match = output.match(/rb-output server listening on (https?:\/\/[^\r\n]+)/);
      if (match) finish(null, match[1]);
    };
    const timer = setTimeout(
      () => finish(new Error(`server startup timed out:\n${output}`)),
      10_000,
    );
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (!settled) {
        finish(new Error(`server exited before binding (code=${code}, signal=${signal}):\n${output}`));
      }
    });
  });
}

test("HTTP server preserves the explicit all-interface LAN default", async (t) => {
  const address = await startServer(t);
  assert.match(address, /^http:\/\/0\.0\.0\.0:\d+$/);
});

test("HTTP server accepts an explicit loopback IP opt-in", async (t) => {
  const address = await startServer(t, "127.0.0.1");
  assert.match(address, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("blank and non-IP host settings fall back to the canonical LAN default", async (t) => {
  for (const invalidHost of ["", "not-a-hostname"]) {
    const address = await startServer(t, invalidHost);
    assert.match(
      address,
      /^http:\/\/0\.0\.0\.0:\d+$/,
      `RB_OUTPUT_HOST=${JSON.stringify(invalidHost)}`,
    );
  }
});

test("HTTP server accepts an explicit interface IP", async (t) => {
  const address = await startServer(t, "127.0.0.2");
  assert.match(address, /^http:\/\/127\.0\.0\.2:\d+$/);
});
