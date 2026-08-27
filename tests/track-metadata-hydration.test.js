const test = require("node:test");
const assert = require("node:assert/strict");
const {
  metadataMatchesContentId,
  metadataConsistentWithDeckPlayback,
  trackNeedsMetadataHydration,
} = require("../server/trackMetadataHydration");

test("missing duration is not treated as a zero-second mismatch", () => {
  assert.equal(metadataConsistentWithDeckPlayback(
    { totalSec: 172.44, bpm: 128 },
    { title: "Demo Track 1", artist: "Loopmasters", durationSec: null, trackBpm: null },
  ), true);
  assert.equal(metadataConsistentWithDeckPlayback(
    { totalSec: 172.44, bpm: 128 },
    { title: "Demo Track 1", artist: "Loopmasters" },
  ), true);
});

test("positive duration and BPM contradictions still fail closed", () => {
  assert.equal(metadataConsistentWithDeckPlayback(
    { totalSec: 172.44, bpm: 128 },
    { durationSec: 128.05, trackBpm: 120 },
  ), false);
  assert.equal(metadataConsistentWithDeckPlayback(
    { totalSec: 172.44, bpm: 128 },
    { durationSec: 172.4, trackBpm: 90 },
  ), false);
});

test("cached content metadata remains eligible when waveform or duration is missing", () => {
  assert.equal(trackNeedsMetadataHydration({
    contentId: "72863490",
    title: "Demo Track 1",
    artist: "Loopmasters",
    trackBpm: 128,
    durationSec: null,
    waveform: null,
  }), true);
  assert.equal(trackNeedsMetadataHydration({
    contentId: "72863490",
    title: "Demo Track 1",
    artist: "Loopmasters",
    trackBpm: 128,
    durationSec: 172.44,
    waveform: [0, 1],
  }), false);
});

test("signature fallback metadata cannot cross-glue a different content ID", () => {
  assert.equal(metadataMatchesContentId("content-a", { contentId: "content-a" }), true);
  assert.equal(metadataMatchesContentId("content-a", { contentId: "content-b" }), false);
  assert.equal(metadataMatchesContentId("content-a", { contentId: " content-a " }), false);
  assert.equal(metadataMatchesContentId("content-a", { title: "same BPM and duration" }), false);
  assert.equal(metadataMatchesContentId("", { contentId: "content-a" }), false);
});
