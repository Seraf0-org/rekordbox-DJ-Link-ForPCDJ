const test = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("node:dgram");
const {
  MAX_BPM_SAMPLE_AGE_MS,
  projectMeasuredLoopBeats,
} = require("../server/providers/loopBeatProjection");
const { createHookUdpProvider } = require("../server/providers/hookUdpProvider");

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
