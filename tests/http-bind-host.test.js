"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const { spawn } = require("node:child_process");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "server", "index.js");

function serverEnvironment(requestedHost) {
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
  return env;
}

function spawnServer(requestedHost) {
  return spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: serverEnvironment(requestedHost),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

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

function startServer(t, requestedHost) {
  const child = spawnServer(requestedHost);
  t.after(() => stopServer(child));

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
        stopServer(child).finally(() => reject(error));
      } else {
        resolve({ address, output });
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

function expectStartupFailure(requestedHost) {
  const child = spawnServer(requestedHost);
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      stopServer(child).finally(() => reject(new Error(`invalid host did not fail startup:\n${output}`)));
    }, 10_000);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
}

function healthRequest(host, port, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host, port, path: "/api/health", timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve({ statusCode: response.statusCode, body: JSON.parse(body) });
        } catch (error) {
          reject(new Error(`health response was not JSON: ${body}\n${error.message}`));
        }
      });
    });
    request.once("timeout", () => request.destroy(new Error(`health request timed out for ${host}:${port}`)));
    request.once("error", reject);
  });
}

function portFromAddress(address) {
  return Number(new URL(address).port);
}

function nonLoopbackIpv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry && entry.family === "IPv4" && entry.internal !== true) {
        return entry.address;
      }
    }
  }
  return null;
}

async function assertHealthy(host, port) {
  const response = await healthRequest(host, port);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(typeof response.body.time, "string");
}

test("HTTP server preserves the explicit IPv4 all-interface LAN default", async (t) => {
  const { address } = await startServer(t);
  assert.match(address, /^http:\/\/0\.0\.0\.0:\d+$/);
  const lanAddress = nonLoopbackIpv4();
  await assertHealthy(lanAddress || "127.0.0.1", portFromAddress(address));
  if (!lanAddress) t.diagnostic("no non-loopback IPv4 NIC; verified the wildcard bind through IPv4 loopback");
});

test("HTTP server accepts blank as the canonical IPv4 LAN default", async (t) => {
  const { address } = await startServer(t, "  ");
  assert.match(address, /^http:\/\/0\.0\.0\.0:\d+$/);
  await assertHealthy("127.0.0.1", portFromAddress(address));
});

test("HTTP server accepts explicit IPv4 loopback and rejects non-loopback ingress", async (t) => {
  const { address } = await startServer(t, "127.0.0.1");
  assert.match(address, /^http:\/\/127\.0\.0\.1:\d+$/);
  const port = portFromAddress(address);
  await assertHealthy("127.0.0.1", port);
  const lanAddress = nonLoopbackIpv4();
  if (!lanAddress) {
    t.skip("no non-loopback IPv4 NIC is available for the negative ingress check");
    return;
  }
  await assert.rejects(healthRequest(lanAddress, port), /ECONNREFUSED|EHOSTUNREACH|timed out/i);
});

test("HTTP server accepts explicit raw and bracketed IPv6 loopback literals", async (t) => {
  for (const requestedHost of ["::1", "[::1]"]) {
    await t.test(requestedHost, async (t) => {
      const { address } = await startServer(t, requestedHost);
      assert.match(address, /^http:\/\/\[::1\]:\d+$/);
      await assertHealthy("::1", portFromAddress(address));
    });
  }
});

test("HTTP server accepts an explicit IPv4 interface literal", async (t) => {
  const { address } = await startServer(t, "127.0.0.2");
  assert.match(address, /^http:\/\/127\.0\.0\.2:\d+$/);
  await assertHealthy("127.0.0.2", portFromAddress(address));
});

test("non-empty invalid and hostname bind settings fail closed", async () => {
  for (const invalidHost of ["localhost", "not-a-hostname", "127.0.0.1 typo", "[127.0.0.1]", "[::1", "::1]"]) {
    const result = await expectStartupFailure(invalidHost);
    assert.notEqual(result.code, 0, `RB_OUTPUT_HOST=${JSON.stringify(invalidHost)} unexpectedly started`);
    assert.match(result.output, /RB_OUTPUT_HOST must be an IPv4 or IPv6 address literal/);
    assert.doesNotMatch(result.output, /rb-output server listening on/);
  }
});
