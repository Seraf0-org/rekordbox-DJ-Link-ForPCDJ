"use strict";

// Invoked by KDMX's ignored io integration test.  This intentionally uses
// the production client and router against a real Rust listener; only the
// Rekordbox detector and MIDI/pedal hardware are fixtures.
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createSyndocalClient } = require("../server/dj-agent/syndocalClient");
const { createShowEventRouter } = require("../server/dj-agent/showEventRouter");

const TOKEN = "0123456789abcdef0123456789abcdef";
const RETURN_ID = /^syndocal-dj-operator-return-[0-9a-f]{32}-[1-9][0-9]*$/u;

function requiredEnvironment(name) {
  const value = process.env[name];
  assert.equal(typeof value, "string", `${name} is required`);
  assert.notEqual(value.length, 0, `${name} must not be empty`);
  return value;
}

function waitFor(predicate, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error("timed out waiting for accepted DJ_TRACK_ACTIVE owner admission"));
          return;
        }
        setTimeout(poll, 10);
      } catch (error) {
        reject(error);
      }
    };
    poll();
  });
}

async function main() {
  const port = Number(requiredEnvironment("SYNDOCAL_RUST_WIRE_PORT"));
  const oldRequestId = requiredEnvironment("SYNDOCAL_RUST_WIRE_OLD_REQUEST_ID");
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535, "invalid Rust listener port");
  assert.match(oldRequestId, RETURN_ID, "Rust fixture must supply a canonical old request ID");

  const detector = new EventEmitter();
  detector.state = {
    currentMasterDeck: 1,
    masterDeckSource: "explicit",
    decks: { 1: { track: null, playSessionId: "rust-wire-session" } },
  };
  detector.getState = () => detector.state;
  detector.onSnapshot = () => detector.state;
  detector.onTrackLoaded = () => null;
  detector.onMasterChange = () => null;

  let candidateRequests = 0;
  detector.requestCurrentTrackCandidates = () => {
    candidateRequests += 1;
    detector.emit("event", {
      type: "DJ_TRACK_ACTIVE",
      eventId: `rust-wire-active-${candidateRequests}`,
      payload: {
        deck: 1,
        deckId: "rekordbox-deck-1",
        contentId: "rust-wire-content",
        trackBpm: 120,
        positionAtSendSec: 4,
        effectiveBpm: 120,
        positionRevision: 8,
        sampleAgeMs: 0,
        isPlaying: true,
        startedAt: "2026-08-28T00:00:00.000Z",
        playSessionId: "rust-wire-session",
        loop: null,
      },
    });
  };

  const client = createSyndocalClient({
    enabled: true,
    host: "127.0.0.1",
    port,
    path: "/dj-link",
    token: TOKEN,
    reconnectMinMs: 25,
    reconnectMaxMs: 50,
    heartbeatMs: 60_000,
    ackTimeoutMs: 2_000,
    stateSyncProvider: () => ({ released: false }),
  });
  const midi = {
    start() {}, stop() {}, getStatus: () => ({}),
    resolveTarget: (_mapping, deck) => ({ targetDeck: deck, targetChannel: 1 }),
  };
  const pedal = { start() {}, stop() {}, getStatus: () => ({}) };
  const router = createShowEventRouter({ detector, syndocalClient: client, midi, pedal });
  let observedRequestId = null;
  client.on("timeline-state", (state) => {
    observedRequestId = state?.operatorReturnRequestId ?? null;
  });

  try {
    router.start();
    await waitFor(() => router.getStatus().ownerDeck === 1);
    const status = router.getStatus();
    assert.equal(candidateRequests, 1, "fresh operator return must request current candidates exactly once");
    assert.match(observedRequestId, RETURN_ID, "Rust wire response must carry a canonical fresh ID");
    assert.notEqual(observedRequestId, oldRequestId, "replacement snapshot must not reuse the old pending ID");
    assert.equal(status.ownerDeck, 1);
    assert.equal(status.ownerDeckId, "rekordbox-deck-1");
    assert.equal(status.activePlaySessionId, "rust-wire-session");
    assert.equal(status.ownerSource, "acknowledged-track-candidate");
    assert.equal(status.operatorReturnRequestId, observedRequestId);
    process.stdout.write(`${JSON.stringify({
      candidateRequests,
      observedRequestId,
      ownerDeck: status.ownerDeck,
      ownerDeckId: status.ownerDeckId,
      activePlaySessionId: status.activePlaySessionId,
      ownerSource: status.ownerSource,
    })}\n`);
  } finally {
    router.stop();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
