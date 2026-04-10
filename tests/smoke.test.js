const test = require("node:test");
const assert = require("node:assert/strict");

const { createPythonBridge } = require("../server/providers/pythonBridge");
const { createAbletonLinkProvider } = require("../server/providers/abletonLinkProvider");
const { createHookUdpProvider } = require("../server/providers/hookUdpProvider");

test("python bridge factory returns lifecycle methods", () => {
  const bridge = createPythonBridge({
    pythonBin: "python",
    scriptPath: "python/bridge_stream.py",
    args: [],
  });
  assert.equal(typeof bridge.start, "function");
  assert.equal(typeof bridge.stop, "function");
  assert.equal(typeof bridge.on, "function");
});

test("ableton link provider can be created disabled", () => {
  const provider = createAbletonLinkProvider({ enabled: false });
  assert.equal(typeof provider.start, "function");
  assert.equal(typeof provider.stop, "function");
  assert.equal(typeof provider.on, "function");
});

test("hook udp provider can be created disabled", () => {
  const provider = createHookUdpProvider({ enabled: false });
  assert.equal(typeof provider.start, "function");
  assert.equal(typeof provider.stop, "function");
  assert.equal(typeof provider.on, "function");
});
