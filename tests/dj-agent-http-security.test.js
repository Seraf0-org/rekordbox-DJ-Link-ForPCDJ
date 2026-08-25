const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isActionPreflightAllowed,
  isActionRequestAllowed,
  isLocalHostHeader,
  isLocalOriginHeader,
  isLocalSetupRequest,
  parseHeaderHostname,
} = require("../server/dj-agent/httpSecurity");

test("setup Host validation accepts only localhost and loopback literals", () => {
  for (const host of ["localhost:8787", "127.0.0.1:8787", "127.99.1.2", "[::1]:8787"]) {
    assert.equal(isLocalHostHeader(host), true, host);
  }
  for (const host of ["", "attacker.example", "192.168.50.2:8787", "[::2]:8787", "localhost.example"]) {
    assert.equal(isLocalHostHeader(host), false, host);
  }
  assert.equal(parseHeaderHostname("[::1]:8787"), "[::1]");
});

test("setup Origin validation permits absent or local web origins only", () => {
  for (const origin of [undefined, "", "http://localhost:8787", "http://127.0.0.1:8787", "https://[::1]", "http://[::ffff:127.0.0.1]:8787"]) {
    assert.equal(isLocalOriginHeader(origin), true, String(origin));
  }
  for (const origin of ["null", "file:///C:/private", "https://attacker.example", "http://192.168.50.2:8787", "not a URL"]) {
    assert.equal(isLocalOriginHeader(origin), false, origin);
  }
});

test("setup request requires loopback peer, local Host, and local or absent Origin", () => {
  const request = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "localhost:8787" },
  };
  assert.equal(isLocalSetupRequest(request), true);
  assert.equal(isLocalSetupRequest({ ...request, socket: { remoteAddress: "192.168.50.2" } }), false);
  assert.equal(isLocalSetupRequest({ ...request, headers: { host: "attacker.example" } }), false);
  assert.equal(isLocalSetupRequest({ ...request, headers: { ...request.headers, origin: "https://attacker.example" } }), false);
});

test("action admission requires the actual socket peer to be loopback regardless of env, config, or headers", () => {
  // The former DJ_AGENT_ALLOW_REMOTE_ACTIONS/allowRemoteActions parameter no
  // longer exists: there is no argument that can widen the fence.
  assert.equal(isActionRequestAllowed.length, 1);
  assert.equal(isActionPreflightAllowed.length, 1);

  const local = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "localhost:8787" },
  };
  assert.equal(isActionRequestAllowed(local), true);
  assert.equal(isActionRequestAllowed({
    ...local,
    headers: { ...local.headers, origin: "http://localhost:8787" },
  }), true);
  assert.equal(isActionRequestAllowed({
    socket: { remoteAddress: "::1" },
    headers: { host: "[::1]:8787" },
  }), true);
  assert.equal(isActionRequestAllowed({
    socket: { remoteAddress: "::ffff:127.0.0.1" },
    headers: { host: "127.0.0.1:8787" },
  }), true);

  for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787", "192.168.50.2:8787"]) {
    assert.equal(isActionRequestAllowed({
      socket: { remoteAddress: "192.168.50.9" },
      headers: { host },
    }), false, host);
    assert.equal(isActionRequestAllowed({
      socket: { remoteAddress: "2001:db8::20" },
      headers: { host },
    }), false, host);
  }
});

test("proxy headers and Express identity fields never override the socket peer for actions", () => {
  const lanPeer = { socket: { remoteAddress: "192.168.50.9" } };
  assert.equal(isActionRequestAllowed({
    ...lanPeer,
    connection: { remoteAddress: "127.0.0.1" },
    ip: "127.0.0.1",
    headers: {
      host: "localhost:8787",
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-host": "localhost:8787",
      "x-forwarded-proto": "http",
      "x-real-ip": "127.0.0.1",
    },
  }), false);
  assert.equal(isActionRequestAllowed({
    ...lanPeer,
    headers: {
      host: "localhost:8787",
      "x-forwarded-for": "10.0.0.1, 127.0.0.1",
    },
  }), false);

  // The permanent fence also rejects forged hosts and cross-site browser
  // requests that arrive from a genuine loopback peer.
  const loopbackPeer = { socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(isActionRequestAllowed({
    ...loopbackPeer,
    headers: { host: "192.168.50.2:8787" },
  }), false);
  assert.equal(isActionRequestAllowed({
    ...loopbackPeer,
    headers: { host: "attacker.example:8787" },
  }), false);
  assert.equal(isActionRequestAllowed({
    ...loopbackPeer,
    headers: { host: "localhost:8787", origin: "https://attacker.example" },
  }), false);
});

test("action preflight accepts only a safe POST request through the permanent loopback fence", () => {
  const local = {
    method: "OPTIONS",
    socket: { remoteAddress: "127.0.0.1" },
    headers: {
      host: "localhost:8787",
      origin: "http://localhost:8787",
      "access-control-request-method": "POST",
      "access-control-request-headers": "content-type",
    },
  };
  assert.equal(isActionPreflightAllowed(local), true);
  assert.equal(isActionPreflightAllowed({
    ...local,
    socket: { remoteAddress: "192.168.50.9" },
  }), false);
  assert.equal(isActionPreflightAllowed({
    ...local,
    headers: { ...local.headers, origin: "https://attacker.example" },
  }), false);
  assert.equal(isActionPreflightAllowed({
    ...local,
    headers: { ...local.headers, "access-control-request-method": "GET" },
  }), false);
  assert.equal(isActionPreflightAllowed({
    ...local,
    headers: { ...local.headers, "access-control-request-headers": "x-forged-header" },
  }), false);
});
