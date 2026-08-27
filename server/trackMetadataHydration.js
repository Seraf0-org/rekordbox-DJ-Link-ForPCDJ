function positiveFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function metadataConsistentWithDeckPlayback(playback, metadata) {
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  const deckTotal = positiveFinite(playback?.totalSec);
  const trackDuration = positiveFinite(metadata.durationSec);
  if (
    deckTotal != null &&
    trackDuration != null &&
    deckTotal > 30 &&
    deckTotal < 1200 &&
    Math.abs(deckTotal - trackDuration) > 8
  ) {
    return false;
  }
  const deckBpm = positiveFinite(playback?.bpm);
  const trackBpm = positiveFinite(metadata.trackBpm);
  if (
    deckBpm != null &&
    trackBpm != null &&
    deckBpm > 60 &&
    trackBpm > 60 &&
    Math.abs(deckBpm - trackBpm) > 20
  ) {
    return false;
  }
  return true;
}

function trackNeedsMetadataHydration(entry) {
  return Boolean(entry?.contentId) && (
    !entry.title ||
    !entry.artist ||
    positiveFinite(entry.trackBpm) == null ||
    positiveFinite(entry.durationSec) == null ||
    !entry.waveform
  );
}

function metadataMatchesContentId(expectedContentId, metadata) {
  const expected = expectedContentId == null ? "" : String(expectedContentId);
  const actual = metadata?.contentId == null ? "" : String(metadata.contentId);
  return Boolean(expected) && Boolean(actual) && actual === expected;
}

module.exports = {
  metadataMatchesContentId,
  metadataConsistentWithDeckPlayback,
  trackNeedsMetadataHydration,
};
