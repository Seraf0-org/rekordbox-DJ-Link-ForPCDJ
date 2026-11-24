"use strict";

const DECK_TRACK_METADATA_FIELDS = Object.freeze([
  "title",
  "artist",
  "album",
  "genre",
  "label",
  "key",
  "origArtist",
  "remixer",
  "composer",
  "comment",
  "mixName",
  "lyricist",
  "trackNo",
  "originalBpm",
]);

const NOW_PLAYING_TRACK_METADATA_FIELDS = Object.freeze([
  "title",
  "artist",
  "album",
  "genre",
  "key",
  "label",
  "origArtist",
  "remixer",
  "composer",
  "comment",
  "mixName",
  "lyricist",
  "waveform",
  "durationSec",
  "trackNo",
  "trackBpm",
]);

function exactContentId(value) {
  if (value == null) return null;
  const contentId = String(value);
  return contentId.length > 0 ? contentId : null;
}

function isDefiniteContentIdentityReplacement(previousContentId, nextContentId) {
  const previous = exactContentId(previousContentId);
  const next = exactContentId(nextContentId);
  return previous !== null && next !== null && previous !== next;
}

function applyDeckTrackLoadIdentity(deckState, nextContentId) {
  const replacement = isDefiniteContentIdentityReplacement(
    deckState?.trackBrowserId,
    nextContentId
  );
  if (replacement) {
    for (const field of DECK_TRACK_METADATA_FIELDS) {
      deckState[field] = null;
    }
    deckState.metadata = {};
  }
  deckState.trackBrowserId = Number(nextContentId);
  return replacement;
}

function applyNowPlayingIdentityPatch(current, patch) {
  const previous = current && typeof current === "object" ? current : {};
  const incoming = patch && typeof patch === "object" ? patch : {};
  if (!isDefiniteContentIdentityReplacement(previous.contentId, incoming.contentId)) {
    return { ...previous, ...incoming };
  }
  const cleared = { ...previous };
  for (const field of NOW_PLAYING_TRACK_METADATA_FIELDS) {
    cleared[field] = null;
  }
  return { ...cleared, ...incoming };
}

module.exports = {
  applyDeckTrackLoadIdentity,
  applyNowPlayingIdentityPatch,
  isDefiniteContentIdentityReplacement,
};
