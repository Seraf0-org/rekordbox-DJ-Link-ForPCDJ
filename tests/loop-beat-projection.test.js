const test = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const {
  MAX_BPM_SAMPLE_AGE_MS,
  projectMeasuredLoopBeats,
} = require("../server/providers/loopBeatProjection");
const { createHookUdpProvider } = require("../server/providers/hookUdpProvider");
const { upsertLoopState } = require("../server/loopState");

function project({ startMs = 16_000, lengthBeats, bpm = 120, bpmObservedAt = 50_000, now = 50_000, explicit = {}, ...packet } = {}) {
  const endMs = Math.round(startMs + (lengthBeats * 60_000) / bpm);
  return projectMeasuredLoopBeats({
    packet: { type: "loop_state", deck: 1, startMs, endMs, ...packet, ...explicit },
    loop: { startMs, endMs },
    bpm,
    bpmObservedAt,
    now,
  });
}

async function runningProvider(t) {
  const port = 49_000 + Math.floor(Math.random() * 1_000);
  const provider = createHookUdpProvider({ enabled: true, port });
  const sender = dgram.createSocket("udp4");
  t.after(() => {
    sender.close();
    provider.stop();
  });

  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Hook provider did not bind")), 1_000);
    provider.on("status", (status) => {
      if (!status.message?.includes("listener started")) return;
      clearTimeout(timer);
      resolve();
    });
  });
  provider.start();
  await started;

  const send = (packet) => new Promise((resolve, reject) => {
    sender.send(Buffer.from(JSON.stringify(packet)), port, "127.0.0.1", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return { provider, send };
}

test("projects measured Rekordbox loop lengths through the 1/64 beat grid", () => {
  for (const lengthBeats of [8, 4, 2, 1, 1 / 2, 1 / 4, 1 / 8, 1 / 16, 1 / 32, 1 / 64]) {
    const projected = project({ lengthBeats });
    assert.deepEqual(projected, {
      startBeat: 32,
      endBeat: 32 + lengthBeats,
      lengthBeats,
    }, `${lengthBeats}-beat loop`);
  }
});

test("rounds only within the 1/64 beat measurement tolerance", () => {
  const rounded = project({ lengthBeats: 1 / 2, startMs: 10_001 });
  assert.deepEqual(rounded, { startBeat: 20, endBeat: 20.5, lengthBeats: 0.5 });

  const rejected = project({ lengthBeats: 0.51 });
  assert.equal(rejected, null);
});

test("projects the measured 106782..107610 ms loop as two beats without inventing beat-zero", () => {
  const projected = projectMeasuredLoopBeats({
    packet: { type: "loop_state", deck: 1, startMs: 106_782, endMs: 107_610 },
    loop: { startMs: 106_782, endMs: 107_610 },
    bpm: 145,
    bpmObservedAt: 50_000,
    now: 50_000,
  });
  assert.deepEqual(projected, {
    startBeat: null,
    endBeat: null,
    lengthBeats: 2,
  });
});

test("fails closed for invalid loop spans, BPM samples, and contradictory native beats", () => {
  assert.equal(project({ lengthBeats: 1, bpm: 0 }), null);
  assert.equal(project({ lengthBeats: 1, bpm: 401 }), null);
  assert.equal(projectMeasuredLoopBeats({ packet: {}, loop: { startMs: 0, endMs: 500 }, now: 0 }), null);
  assert.equal(project({ lengthBeats: 1, bpmObservedAt: 1, now: 1 + MAX_BPM_SAMPLE_AGE_MS + 1 }), null);
  assert.equal(project({ lengthBeats: 1, bpmObservedAt: 100, now: 99 }), null);
  assert.equal(project({ lengthBeats: 0 }), null);
  assert.equal(project({ lengthBeats: 1, startMs: 16_000.5 }), null);
  assert.equal(project({ lengthBeats: 1, explicit: { lengthBeats: 2 } }), null);
  assert.equal(project({ lengthBeats: 1, explicit: { lengthBeats: 1, length_beats: 2 } }), null);
  assert.equal(project({ lengthBeats: 1, explicit: { startBeat: 31 } }), null);
  assert.equal(project({ lengthBeats: 1, explicit: { startBeat: 32, endBeat: 34, lengthBeats: 1 } }), null);
});

test("hook projects fresh same-deck measured BPM without changing source or revision provenance", async (t) => {
  const port = 49_000 + Math.floor(Math.random() * 1_000);
  const provider = createHookUdpProvider({ enabled: true, port });
  const sender = dgram.createSocket("udp4");
  t.after(() => {
    sender.close();
    provider.stop();
  });

  const waitFor = (eventName, predicate, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      provider.off(eventName, listener);
      reject(new Error(`Timed out waiting for ${label}`));
    }, 1_000);
    const listener = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      provider.off(eventName, listener);
      resolve(value);
    };
    provider.on(eventName, listener);
  });
  const send = (packet) => new Promise((resolve, reject) => {
    sender.send(Buffer.from(JSON.stringify(packet)), port, "127.0.0.1", (error) => (error ? reject(error) : resolve()));
  });

  const started = waitFor("status", (status) => status.message?.includes("listener started"), "UDP listener");
  provider.start();
  await started;
  await send({ type: "olvc", deck: 1, name: "@BPM", value: 12_000 });

  for (const [index, lengthBeats] of [8, 4, 2, 1, 1 / 2, 1 / 4, 1 / 8, 1 / 16, 1 / 32, 1 / 64].entries()) {
    const startMs = 16_000;
    const endMs = Math.round(startMs + (lengthBeats * 60_000) / 120);
    const observed = waitFor("loop-state", (loop) => loop.revision === index + 1, `${lengthBeats}-beat loop`);
    await send({ type: "loop_state", deck: 1, active: true, activeKnown: true, startMs, endMs });
    const loop = await observed;
    assert.equal(loop.source, "rekordbox-hook");
    assert.equal(loop.revision, index + 1);
    assert.equal(loop.startBeat, 32);
    assert.equal(loop.endBeat - loop.startBeat, lengthBeats);
    assert.equal(loop.lengthBeats, lengthBeats);
  }
});

test("hook keeps same-track ACTIVE through partial boundaries and never mixes stale loop tuples", async (t) => {
  const { provider, send } = await runningProvider(t);
  const loopEvents = [];
  const snapshots = [];
  provider.on("loop-state", (loop) => loopEvents.push(loop));
  provider.on("snapshot", (snapshot) => snapshots.push(snapshot));
  const waitForRevision = (revision) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for loop revision ${revision}`)), 1_000);
    const listener = (loop) => {
      if (loop.revision !== revision) return;
      clearTimeout(timer);
      provider.off("loop-state", listener);
      resolve(loop);
    };
    provider.on("loop-state", listener);
  });
  const waitForSnapshotRevision = (revision) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for snapshot loop revision ${revision}`)), 1_000);
    const listener = (snapshot) => {
      const loop = snapshot.loopStates?.find((item) => item.revision === revision);
      if (!loop) return;
      clearTimeout(timer);
      provider.off("snapshot", listener);
      resolve(loop);
    };
    provider.on("snapshot", listener);
  });

  await send({ type: "olvc", deck: 1, name: "@TrackBrowserID", value: 501 });
  const bpmReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for BPM")), 1_000);
    const listener = (snapshot) => {
      if (snapshot.realtimeBpm?.value !== 145) return;
      clearTimeout(timer);
      provider.off("snapshot", listener);
      resolve();
    };
    provider.on("snapshot", listener);
  });
  await send({ type: "olvc", deck: 1, name: "@BPM", value: 14_500 });
  await bpmReady;

  const initial = waitForRevision(1);
  const initialSnapshot = waitForSnapshotRevision(1);
  await send({
    type: "loop_state",
    deck: 1,
    active: true,
    activeKnown: true,
    startMs: 106_782,
    endMs: 107_610,
  });
  const [initialLoop, snapshotLoop] = await Promise.all([initial, initialSnapshot]);
  assert.equal(initialLoop.active, true);
  assert.equal(initialLoop.trackIdentity, "501");
  assert.equal(initialLoop.startBeat, null);
  assert.equal(initialLoop.endBeat, null);
  assert.equal(initialLoop.lengthBeats, 2);
  const snapshotHop = upsertLoopState([initialLoop], snapshotLoop)[0];
  assert.equal(snapshotHop.active, true);
  assert.equal(snapshotHop.startMs, 106_782);
  assert.equal(snapshotHop.endMs, 107_610);
  assert.equal(snapshotHop.startBeat, null);
  assert.equal(snapshotHop.endBeat, null);
  assert.equal(snapshotHop.lengthBeats, 2);

  const partialStart = waitForRevision(2);
  await send({ type: "loop_state", deck: 1, activeKnown: false, startMs: 110_000 });
  const startOnly = await partialStart;
  assert.equal(startOnly.active, true);
  assert.equal(startOnly.activeKnown, true);
  assert.equal(startOnly.startMs, 110_000);
  assert.equal(startOnly.endMs, null);
  assert.equal(startOnly.startBeat, null);
  assert.equal(startOnly.endBeat, null);
  assert.equal(startOnly.lengthBeats, null);

  const partialEnd = waitForRevision(3);
  await send({ type: "loop_state", deck: 1, activeKnown: false, endMs: 110_828 });
  const endOnly = await partialEnd;
  assert.equal(endOnly.active, true);
  assert.equal(endOnly.startMs, null);
  assert.equal(endOnly.endMs, 110_828);
  assert.equal(endOnly.startBeat, null);
  assert.equal(endOnly.endBeat, null);
  assert.equal(endOnly.lengthBeats, null);

  const complete = waitForRevision(4);
  await send({
    type: "loop_state",
    deck: 1,
    active: true,
    activeKnown: true,
    startMs: 106_782,
    endMs: 107_610,
  });
  const completeLoop = await complete;
  assert.equal(completeLoop.active, true);
  assert.equal(completeLoop.lengthBeats, 2);
  assert.equal(completeLoop.startBeat, null);
  assert.equal(completeLoop.endBeat, null);
  assert.equal(loopEvents.at(-1).endMs, 107_610);

  const repeated = waitForRevision(5);
  await send({
    type: "loop_state",
    deck: 1,
    active: true,
    activeKnown: true,
    startMs: 106_782,
    endMs: 107_610,
  });
  const repeatedLoop = await repeated;
  assert.equal(repeatedLoop.lengthBeats, 2);
  assert.equal(repeatedLoop.startBeat, null);
  assert.equal(repeatedLoop.endBeat, null);

  const reset = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for track reset")), 1_000);
    const listener = (loop) => {
      if (loop.source !== "rekordbox-hook-track-reset" || loop.trackIdentity !== "502") return;
      clearTimeout(timer);
      provider.off("loop-state", listener);
      resolve(loop);
    };
    provider.on("loop-state", listener);
  });
  await send({ type: "olvc", deck: 1, name: "@TrackBrowserID", value: 502 });
  const resetLoop = await reset;
  assert.equal(resetLoop.active, null);
  assert.equal(resetLoop.startMs, null);
  assert.equal(resetLoop.endMs, null);
  assert.equal(resetLoop.lengthBeats, null);
});

test("explicit playback booleans and one-shot Play/Pause/Stop edges dominate position inference", async (t) => {
  const { provider, send } = await runningProvider(t);
  const snapshots = [];
  provider.on("snapshot", (snapshot) => snapshots.push(snapshot));
  const waitForPlayback = (expected) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for playback=${expected}`)), 1_000);
    const listener = (snapshot) => {
      if (snapshot.playback?.isPlaying !== expected) return;
      clearTimeout(timer);
      provider.off("snapshot", listener);
      resolve(snapshot);
    };
    provider.on("snapshot", listener);
  });
  const sendWithPlayback = async (packet, expected) => {
    const observed = waitForPlayback(expected);
    await send(packet);
    return observed;
  };

  await send({ type: "olvc", deck: 1, name: "@CurrentTime", value: 1_000 });
  await sendWithPlayback({ type: "olvc", deck: 1, name: "@IsPlaying", value: 0 }, false);
  await new Promise((resolve) => setTimeout(resolve, 450));
  const stoppedSnapshot = await sendWithPlayback(
    { type: "olvc", deck: 1, name: "@CurrentTime", value: 1_100 },
    false,
  );
  assert.equal(stoppedSnapshot.playback.isPlaying, false);
  assert.equal(stoppedSnapshot.deckPlaybacks.find((deck) => deck.deck === 1).isPlaying, false);

  await sendWithPlayback({ type: "olvc", deck: 1, name: "@Play", value: 0 }, false);
  await sendWithPlayback({ type: "olvc", deck: 1, name: "@Play", value: 1 }, true);
  await sendWithPlayback({ type: "olvc", deck: 1, name: "@Pause", value: 0 }, true);
  await sendWithPlayback({ type: "olvc", deck: 1, name: "@Pause", value: 1 }, false);
  await sendWithPlayback({ type: "olvc", deck: 1, name: "@Play", value: 1 }, true);
  await sendWithPlayback({ type: "olvc", deck: 1, name: "@Stop", value: 1 }, false);
  assert.ok(snapshots.length >= 8);
});
