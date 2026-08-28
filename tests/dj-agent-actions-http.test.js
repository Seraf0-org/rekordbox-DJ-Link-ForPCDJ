"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(REPO_ROOT, "server", "index.js");
const fs = require("node:fs");
const { STRICT_SHOW_CONFIG_DISABLED_REASON } = require("../server/dj-agent/config");

const TEST_TOKEN = "0123456789abcdef0123456789abcdef";

function nonLoopbackIpv4() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry?.family === "IPv4" && entry.internal !== true) {
        return entry.address;
      }
    }
  }
  return null;
}

function startServer(t, {
  allowRemoteEnv = false,
  configFile = null,
} = {}) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: "0",
      RB_OUTPUT_HOST: "0.0.0.0",
      HOOK_UDP_ENABLED: "false",
      ABLETON_LINK_ENABLED: "false",
      ...(configFile ? { DJ_AGENT_CONFIG_PATH: configFile } : {}),
      ...(allowRemoteEnv ? { DJ_AGENT_ALLOW_REMOTE_ACTIONS: "true" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
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

function writeEnabledConfig(t) {
  const configPath = path.join(
    os.tmpdir(),
    `rb-output-actions-enabled-${process.pid}-${Date.now()}.json`,
  );
  const config = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, "config", "dj-agent-v1.1.10.example.json"),
    "utf8",
  ));
  config.syndocal.token = TEST_TOKEN;
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
  t.after(() => fs.rmSync(configPath, { force: true }));
  return configPath;
}

function requestJson(connectHost, port, pathName, {
  method = "POST",
  headers = {},
  body = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : body == null ? "" : JSON.stringify(body);
    const request = http.request({
      host: connectHost,
      port,
      path: pathName,
      method,
      headers: {
        ...(method === "POST" && typeof body !== "string" ? { "Content-Type": "application/json" } : {}),
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout: 5_000,
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        let bodyValue = null;
        if (raw) {
          try {
            bodyValue = JSON.parse(raw);
          } catch (error) {
            reject(new Error(`response was not JSON: ${raw}\n${error.message}`));
            return;
          }
        }
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: bodyValue,
          raw,
        });
      });
    });
    request.once("timeout", () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

function requestRaw(connectHost, port, pathName, {
  method = "POST",
  headers = {},
  body = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : body == null ? "" : JSON.stringify(body);
    const request = http.request({
      host: connectHost,
      port,
      path: pathName,
      method,
      headers: {
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        ...headers,
      },
      timeout: 5_000,
    }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          raw,
        });
      });
    });
    request.once("timeout", () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}

test("action HTTP POST and preflight reject cross-site requests without wildcard CORS", async (t) => {
  const { port } = await startServer(t, { allowRemoteEnv: false });
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;

  const local = await requestJson("127.0.0.1", port, "/api/dj-agent/actions/filter-close", {
    headers: { Host: host },
    body: {},
  });
  assert.notEqual(local.statusCode, 403);
  assert.equal(local.headers["access-control-allow-origin"], undefined);
  assert.equal(local.statusCode, 404);

  const sameOrigin = await requestJson("127.0.0.1", port, "/api/dj-agent/actions/filter-close", {
    headers: { Host: host, Origin: origin },
    body: {},
  });
  assert.notEqual(sameOrigin.statusCode, 403);
  assert.equal(sameOrigin.headers["access-control-allow-origin"], undefined);

  const crossSite = await requestJson("127.0.0.1", port, "/api/dj-agent/actions/filter-close", {
    headers: { Host: host, Origin: "https://attacker.example" },
    body: {},
  });
  assert.equal(crossSite.statusCode, 403);
  assert.equal(crossSite.headers["access-control-allow-origin"], undefined);

  const forgedHost = await requestJson("127.0.0.1", port, "/api/dj-agent/actions/filter-close", {
    headers: { Host: `attacker.example:${port}` },
    body: {},
  });
  assert.equal(forgedHost.statusCode, 403);
  assert.equal(forgedHost.headers["access-control-allow-origin"], undefined);

  const preflight = await requestJson("127.0.0.1", port, "/api/dj-agent/actions/filter-close", {
    method: "OPTIONS",
    headers: {
      Host: host,
      Origin: "https://attacker.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(preflight.statusCode, 403);
  assert.equal(preflight.headers["access-control-allow-origin"], undefined);

  const safePreflight = await requestJson("127.0.0.1", port, "/api/dj-agent/actions/filter-close", {
    method: "OPTIONS",
    headers: {
      Host: host,
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(safePreflight.statusCode, 204);
  assert.equal(safePreflight.headers["access-control-allow-origin"], origin);
  assert.notEqual(safePreflight.headers["access-control-allow-origin"], "*");

  const lanAddress = nonLoopbackIpv4();
  if (lanAddress) {
    const forgedProxyIdentity = await requestJson(lanAddress, port, "/api/dj-agent/actions/filter-close", {
      headers: {
        Host: `${lanAddress}:${port}`,
        "X-Forwarded-For": "127.0.0.1",
      },
      body: {},
    });
    assert.equal(forgedProxyIdentity.statusCode, 403);
    assert.equal(forgedProxyIdentity.headers["access-control-allow-origin"], undefined);
  }
});

test("action CORS fence covers every Express-routable path variant without wildcard inheritance", async (t) => {
  const { port } = await startServer(t, { allowRemoteEnv: false });
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  const attackerOrigin = "https://attacker.example";
  // Every entry here reaches the Express 5 action routes: routing is
  // case-insensitive and tolerates one trailing slash.
  const variants = [
    "/API/DJ-AGENT/ACTIONS/FILTER-CLOSE",
    "/Api/Dj-Agent/Actions/Filter-Close",
    "/api/dj-agent/actions/filter-close/",
    "/API/DJ-AGENT/ACTIONS/FILTER-CLOSE/",
    "/api/dj-agent/actions/return-to-dj-control",
  ];

  for (const variant of variants) {
    const localPost = await requestJson("127.0.0.1", port, variant, {
      headers: { Host: host },
      body: {},
    });
    assert.notEqual(
      localPost.statusCode,
      403,
      `${variant}: local POST must still reach the action handler`
    );
    assert.equal(localPost.statusCode, 404, variant);
    assert.equal(localPost.headers["access-control-allow-origin"], undefined, variant);
    assert.notEqual(localPost.headers["access-control-allow-origin"], "*", variant);

    const crossSitePost = await requestJson("127.0.0.1", port, variant, {
      headers: { Host: host, Origin: attackerOrigin },
      body: {},
    });
    assert.equal(crossSitePost.statusCode, 403, variant);
    assert.equal(crossSitePost.headers["access-control-allow-origin"], undefined, variant);
    assert.notEqual(crossSitePost.headers["access-control-allow-origin"], "*", variant);

    const crossSitePreflight = await requestJson("127.0.0.1", port, variant, {
      method: "OPTIONS",
      headers: {
        Host: host,
        Origin: attackerOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(
      crossSitePreflight.statusCode,
      403,
      `${variant}: cross-site preflight must be judged by the action fence`
    );
    assert.equal(crossSitePreflight.headers["access-control-allow-origin"], undefined, variant);
    assert.notEqual(crossSitePreflight.headers["access-control-allow-origin"], "*", variant);

    const localPreflight = await requestJson("127.0.0.1", port, variant, {
      method: "OPTIONS",
      headers: {
        Host: host,
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(localPreflight.statusCode, 204, variant);
    assert.equal(localPreflight.headers["access-control-allow-origin"], origin, variant);
  }

  // A cross-site "simple" text/plain POST never triggers a browser preflight,
  // so the server itself must refuse it and grant no wildcard read access.
  const simpleCrossSite = await requestJson("127.0.0.1", port, "/api/dj-agent/actions/filter-close", {
    headers: {
      Host: host,
      Origin: attackerOrigin,
      "Content-Type": "text/plain;charset=UTF-8",
    },
    body: "{}",
  });
  assert.equal(simpleCrossSite.statusCode, 403);
  assert.equal(simpleCrossSite.headers["access-control-allow-origin"], undefined);
  assert.notEqual(simpleCrossSite.headers["access-control-allow-origin"], "*");

  // Encoded or malformed lookalikes cannot match an Express route, but the
  // fence must still fail closed instead of answering with wildcard CORS.
  for (const lookalike of [
    "/api/dj-agent/%61ctions/filter-close",
    "/api/dj-agent/actions/filter%2Dclose",
    "/api/dj-agent/actions/filter-close%",
  ]) {
    const encodedPreflight = await requestJson("127.0.0.1", port, lookalike, {
      method: "OPTIONS",
      headers: {
        Host: host,
        Origin: attackerOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(encodedPreflight.statusCode, 403, lookalike);
    assert.equal(encodedPreflight.headers["access-control-allow-origin"], undefined, lookalike);
    assert.notEqual(encodedPreflight.headers["access-control-allow-origin"], "*", lookalike);
  }
});

test("env DJ_AGENT_ALLOW_REMOTE_ACTIONS=true keeps the Agent disabled while LAN action access stays fenced", async (t) => {
  const { port } = await startServer(t, { allowRemoteEnv: true });
  const lanAddress = nonLoopbackIpv4();
  assert.ok(lanAddress, "a non-loopback IPv4 NIC is required to prove the fence");

  // Non-browser LAN request with a literal Host and a forged loopback proxy
  // identity: the socket peer decides, so this must stay 403.
  const lanNonBrowser = await requestJson(lanAddress, port, "/api/dj-agent/actions/filter-close", {
    headers: {
      Host: `${lanAddress}:${port}`,
      "X-Forwarded-For": "127.0.0.1",
      "X-Real-IP": "127.0.0.1",
    },
    body: {},
  });
  assert.equal(lanNonBrowser.statusCode, 403);
  assert.equal(lanNonBrowser.headers["access-control-allow-origin"], undefined);

  // Same-origin browser POST from the LAN stays rejected too.
  const lanSameOrigin = await requestJson(lanAddress, port, "/api/dj-agent/actions/filter-close", {
    headers: {
      Host: `${lanAddress}:${port}`,
      Origin: `http://${lanAddress}:${port}`,
    },
    body: {},
  });
  assert.equal(lanSameOrigin.statusCode, 403);
  assert.equal(lanSameOrigin.headers["access-control-allow-origin"], undefined);

  const lanPreflight = await requestJson(lanAddress, port, "/api/dj-agent/actions/filter-close", {
    method: "OPTIONS",
    headers: {
      Host: `${lanAddress}:${port}`,
      Origin: `http://${lanAddress}:${port}`,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(lanPreflight.statusCode, 403);
  assert.equal(lanPreflight.headers["access-control-allow-origin"], undefined);
  assert.notEqual(lanPreflight.headers["access-control-allow-origin"], "*");

  // Loopback reaches the action route but cannot bypass the runtime config gate.
  const localPost = await requestJson("127.0.0.1", port, "/api/dj-agent/actions/filter-close", {
    headers: { Host: `localhost:${port}` },
    body: {},
  });
  assert.notEqual(localPost.statusCode, 403);
  assert.equal(localPost.statusCode, 404);
  assert.equal(localPost.headers["access-control-allow-origin"], undefined);

  // The runtime never reports remote actions as enabled.
  const status = await requestJson("127.0.0.1", port, "/api/dj-agent/status", { method: "GET" });
  assert.equal(status.statusCode, 200);
  assert.equal(status.body?.allowRemoteActions, false);
});

test("local operator return requires the exact server confirmation before router invocation", async (t) => {
  const configPath = writeEnabledConfig(t);
  const { port } = await startServer(t, { configFile: configPath });
  const host = `localhost:${port}`;
  const route = "/api/dj-agent/actions/return-to-dj-control";
  const statusBefore = await requestJson("127.0.0.1", port, "/api/dj-agent/status", { method: "GET" });
  assert.equal(statusBefore.statusCode, 200);
  assert.equal(statusBefore.body?.enabled, true);
  const stateProjection = (body) => {
    const state = body?.state || {};
    return {
      mode: state.mode,
      ownerDeck: state.ownerDeck,
      ownerDeckId: state.ownerDeckId,
      activePlaySessionId: state.activePlaySessionId,
      ownerSource: state.ownerSource,
      admittedTrack: state.admittedTrack,
      lastOperatorOverride: state.lastOperatorOverride,
    };
  };
  const initialProjection = stateProjection(statusBefore.body);

  for (const body of [
    {},
    { confirmation: "wrong-token" },
    { confirmation: "return-to-dj-control", extra: true },
  ]) {
    const rejected = await requestJson("127.0.0.1", port, route, {
      headers: { Host: host },
      body,
    });
    assert.equal(rejected.statusCode, 400);
    assert.equal(rejected.body?.error, "operator-confirmation-required");
    assert.equal(rejected.body?.action, "return-to-dj-control");
    const statusAfter = await requestJson("127.0.0.1", port, "/api/dj-agent/status", { method: "GET" });
    assert.deepEqual(stateProjection(statusAfter.body), initialProjection);
  }

  // The exact token passes the HTTP confirmation gate and reaches the router.
  // This server starts in DJ control with no candidate, so the router's own
  // mode/candidate guard is the expected visible failure rather than a 400.
  const accepted = await requestJson("127.0.0.1", port, route, {
    headers: { Host: host },
    body: { confirmation: "return-to-dj-control" },
  });
  assert.equal(accepted.statusCode, 503);
  assert.equal(accepted.body?.result?.reason, "dj-control-override-unavailable");
  assert.equal(accepted.body?.result?.operatorOverride?.reason, "dj-control-override-unavailable");
});

test("invalid config-file content keeps the Agent disabled and leaks no caller values", async (t) => {
  const FILE_MARKER = `file-secret-${Date.now()}-never-echoed`;
  const configPath = path.join(
    os.tmpdir(),
    `rb-output-actions-config-${process.pid}-${Date.now()}.json`
  );
  fs.writeFileSync(configPath, JSON.stringify({
    enabled: true,
    allowRemoteActions: true,
    note: FILE_MARKER,
  }));
  t.after(() => {
    fs.rmSync(configPath, { force: true });
  });

  const { port } = await startServer(t, { configFile: configPath });
  const lanAddress = nonLoopbackIpv4();
  if (lanAddress) {
    const lanNonBrowser = await requestJson(lanAddress, port, "/api/dj-agent/actions/filter-close", {
      headers: {
        Host: `${lanAddress}:${port}`,
        "X-Forwarded-For": "127.0.0.1",
      },
      body: {},
    });
    assert.equal(lanNonBrowser.statusCode, 403);
    assert.equal(lanNonBrowser.headers["access-control-allow-origin"], undefined);
  } else {
    t.diagnostic("no non-loopback IPv4 NIC; only the loopback positive path was verified");
  }

  const localPost = await requestJson("127.0.0.1", port, "/api/dj-agent/actions/loop-half", {
    headers: { Host: `localhost:${port}` },
    body: {},
  });
  assert.notEqual(localPost.statusCode, 403);
  assert.equal(localPost.statusCode, 404);

  const fullStatus = await requestJson("127.0.0.1", port, "/api/status", { method: "GET" });
  assert.equal(fullStatus.statusCode, 200);
  const warnings = Array.isArray(fullStatus.body?.warnings) ? fullStatus.body.warnings : [];
  const matches = warnings.filter((warning) => warning === STRICT_SHOW_CONFIG_DISABLED_REASON);
  assert.equal(matches.length, 1, "exactly one fixed disabled reason must be present");
  // The public payload must not echo the config path or any file content.
  assert.equal(fullStatus.raw.includes(configPath), false);
  assert.equal(fullStatus.raw.includes(FILE_MARKER), false);

  const agentStatus = await requestJson("127.0.0.1", port, "/api/dj-agent/status", { method: "GET" });
  assert.equal(agentStatus.statusCode, 200);
  assert.equal(agentStatus.body?.enabled, false);
  assert.equal(agentStatus.body?.allowRemoteActions, false);
});

test("double, deeper, depth-exhausted, and malformed encodings stay fenced and handlers never execute", async (t) => {
  const { port } = await startServer(t, { allowRemoteEnv: false });
  const host = `127.0.0.1:${port}`;
  const origin = `http://${host}`;
  // Every raw path below contains percent-encoding, so Express 5 routing can
  // never match the literal action routes: a 404 with the default HTML body
  // proves the action handler never executed (it would answer JSON).
  const lookalikes = [
    ["/api/dj-agent/%2561ctions/filter-close", "double-encoded actions segment"],
    ["/api/dj-agent/%252561ctions/filter-close", "triple-encoded actions segment"],
    ["/api/dj-agent/%25252561ctions/filter-close", "quadruple-encoded at decode limit"],
    ["/api/dj-agent/%2525252561ctions/filter-close", "beyond the bounded decode limit"],
    ["/api/dj-agent/actions%2Ffilter-close", "encoded slash separator"],
    ["/api/dj-agent/actions%2ffilter-close", "lowercase encoded slash separator"],
    ["/api/dj-agent/actions/filter%2Dclose", "encoded hyphen"],
    ["/API/DJ-AGENT/%41CTIONS/FILTER-CLOSE", "case restored only by decoding"],
    ["/api/dj-agent/%2561ctions/filter%2Dclose", "mixed nested encoding"],
    ["/api/dj-agent/actions/filter-close%", "trailing malformed percent"],
    ["/api/dj-agent/actions%ZZ", "malformed hex digits"],
    ["/api/dj-agent/%", "bare percent after namespace"],
    ["/api/dj-agent/%2", "truncated escape"],
    ["/api/dj-agent/%2561ctions/fil%ter-close", "malformed escape after nested round"],
  ];

  for (const [variant, label] of lookalikes) {
    const post = await requestRaw("127.0.0.1", port, variant, {
      headers: { Host: host },
      body: {},
    });
    assert.equal(post.statusCode, 404, `${variant} (${label})`);
    assert.ok(post.raw.includes("Cannot POST"), `handler executed for ${variant} (${label})`);
    assert.equal(post.headers["access-control-allow-origin"], undefined, `${variant} (${label})`);

    const crossSitePreflight = await requestRaw("127.0.0.1", port, variant, {
      method: "OPTIONS",
      headers: {
        Host: host,
        Origin: "https://attacker.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    assert.equal(crossSitePreflight.statusCode, 403, `${variant} (${label})`);
    assert.equal(crossSitePreflight.headers["access-control-allow-origin"], undefined, `${variant} (${label})`);
  }

  // A local same-origin preflight is still answered by the strict action
  // fence (specific origin), never by the wildcard viewer policy.
  const localPreflight = await requestJson("127.0.0.1", port, "/api/dj-agent/%2561ctions/filter-close", {
    method: "OPTIONS",
    headers: {
      Host: host,
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(localPreflight.statusCode, 204);
  assert.equal(localPreflight.headers["access-control-allow-origin"], origin);
});

test("unrelated read-only LAN surfaces keep wildcard CORS while namespace lookalikes stay strict", async (t) => {
  const { port } = await startServer(t, { allowRemoteEnv: false });
  const host = `127.0.0.1:${port}`;

  const state = await requestJson("127.0.0.1", port, "/api/state", { method: "GET" });
  assert.equal(state.statusCode, 200);
  assert.equal(state.headers["access-control-allow-origin"], "*");

  // Sibling read-only endpoint inside the DJ-agent namespace keeps the
  // viewer policy: the fence must not strip more than action surface.
  const agentStatus = await requestJson("127.0.0.1", port, "/api/dj-agent/status", { method: "GET" });
  assert.equal(agentStatus.statusCode, 200);
  assert.equal(agentStatus.headers["access-control-allow-origin"], "*");

  const missing = await requestRaw("127.0.0.1", port, "/definitely-not-a-real-route", { method: "GET" });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.headers["access-control-allow-origin"], "*");

  // Malformed targets OUTSIDE the namespace keep the LAN viewer policy:
  // the corrected catch policy is scoped, not globally overbroad.
  const malformedOutside = await requestRaw("127.0.0.1", port, "/elsewhere%zz", { method: "GET" });
  assert.equal(malformedOutside.statusCode, 404);
  assert.equal(malformedOutside.headers["access-control-allow-origin"], "*");

  const malformedOutsidePost = await requestRaw("127.0.0.1", port, "/elsewhere%/nope", {
    headers: { Host: host },
    body: {},
  });
  assert.equal(malformedOutsidePost.statusCode, 404);
  assert.ok(malformedOutsidePost.raw.includes("Cannot POST"));
  assert.equal(malformedOutsidePost.headers["access-control-allow-origin"], "*");

  // Positive control on this build: a literal routable action still executes.
  const localAction = await requestJson("127.0.0.1", port, "/api/dj-agent/actions/filter-close", {
    headers: { Host: host },
    body: {},
  });
  assert.notEqual(localAction.statusCode, 403);
  assert.equal(localAction.statusCode, 404);
});
