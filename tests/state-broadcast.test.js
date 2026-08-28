const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createLatestStateBroadcaster } = require("../server/stateBroadcast");

const appSource = fs.readFileSync(path.join(__dirname, "..", "server", "public", "app.js"), "utf8");

function fakeClock() {
  const timers = [];
  return {
    timers,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      if (timer) timer.cleared = true;
    },
    fireNext() {
      const timer = timers.find((candidate) => !candidate.cleared);
      if (!timer) return false;
      timer.cleared = true;
      timer.callback();
      return true;
    },
  };
}

test("latest state broadcaster emits one bounded latest-wins frame", () => {
  const clock = fakeClock();
  let current = "initial";
  const emitted = [];
  const broadcaster = createLatestStateBroadcaster({
    intervalMs: 50,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    emitSnapshot: () => emitted.push(current),
  });

  broadcaster.request();
  current = "latest";
  broadcaster.request();
  broadcaster.request();
  assert.equal(clock.timers.length, 1);
  assert.deepEqual(emitted, []);
  assert.equal(clock.timers[0].delay, 50);
  assert.equal(clock.fireNext(), true);
  assert.deepEqual(emitted, ["latest"]);
  assert.equal(broadcaster.pending, false);
});

test("immediate and stop flush preserve the newest state and never leave a timer", () => {
  const clock = fakeClock();
  let current = "queued";
  const emitted = [];
  const broadcaster = createLatestStateBroadcaster({
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    emitSnapshot: () => emitted.push(current),
  });

  broadcaster.request();
  current = "immediate";
  broadcaster.request({ immediate: true });
  assert.deepEqual(emitted, ["immediate"]);
  assert.equal(clock.timers[0].cleared, true);

  current = "stopped";
  broadcaster.request();
  broadcaster.stop();
  assert.deepEqual(emitted, ["immediate", "stopped"]);
  assert.equal(broadcaster.request(), false);
  assert.equal(broadcaster.stop(), false);
});

test("nested router-style immediate requests stay inside one bounded frame", () => {
  const clock = fakeClock();
  const emitted = [];
  const broadcaster = createLatestStateBroadcaster({
    intervalMs: 50,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    emitSnapshot: () => emitted.push("frame"),
  });

  broadcaster.runDeferred(() => {
    // These represent updateDjAgentStatus()/ACK listeners called synchronously
    // while one Hook snapshot is being fanned out through the router.
    broadcaster.request({ immediate: true });
    broadcaster.request({ immediate: true });
  });
  assert.deepEqual(emitted, []);
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].delay, 50);
  assert.equal(clock.fireNext(), true);
  assert.deepEqual(emitted, ["frame"]);
});

test("UI loop formatter keeps a measured two-beat length without coercing null beats to zero", () => {
  const formatterSource = appSource.slice(
    appSource.indexOf("function finiteLoopNumber"),
    appSource.indexOf("function renderLoopState"),
  );
  const formatLoopState = vm.runInNewContext(`${formatterSource}; formatLoopState`, {});
  const measured = formatLoopState({
    active: true,
    startMs: 106_782,
    endMs: 107_610,
    startBeat: null,
    endBeat: null,
    lengthBeats: 2,
  });
  assert.equal(measured.text, "ACTIVE · 2 beats");
  assert.doesNotMatch(measured.text, /0(?:\.00)?→/);
  const noLength = formatLoopState({
    active: true,
    startMs: 106_782,
    endMs: 107_610,
    startBeat: null,
    endBeat: null,
    lengthBeats: null,
  });
  assert.equal(noLength.text, "ACTIVE · 106.78→107.61s");
});
