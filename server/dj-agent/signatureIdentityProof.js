const SIGNATURE_BPM_EPSILON = 0.01;
const SIGNATURE_DURATION_EPSILON_SEC = 0.01;
const CONTENT_LOOKUP_DURATION_TOLERANCE_SEC = 1.5;

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeDeck(value) {
  const deck = Math.trunc(Number(value));
  return Number.isSafeInteger(deck) && deck >= 1 && deck <= 4 ? deck : null;
}

function validIsoTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function sameNumber(left, right, epsilon) {
  return Math.abs(left - right) <= epsilon;
}

function normalizePlaybackSignature(playback, expectedDeck) {
  if (!playback || typeof playback !== "object") {
    return null;
  }
  const deck = normalizeDeck(playback.deck);
  const bpm = finitePositive(playback.bpm);
  const totalSec = finitePositive(playback.totalSec);
  const positionRevision = Number(playback.positionRevision);
  const positionObservedAt = playback.positionObservedAt;
  if (
    deck !== expectedDeck ||
    playback.isPlaying !== true ||
    !bpm ||
    !totalSec ||
    !Number.isSafeInteger(positionRevision) ||
    positionRevision < 1 ||
    !validIsoTimestamp(positionObservedAt)
  ) {
    return null;
  }
  return { deck, isPlaying: true, bpm, totalSec, positionRevision, positionObservedAt };
}

function createSignaturePlaybackProof({
  deck,
  playSessionId,
  startedAt,
  signatureProofGeneration,
  playback,
} = {}) {
  const normalizedDeck = normalizeDeck(deck);
  if (
    !normalizedDeck ||
    typeof playSessionId !== "string" ||
    !playSessionId ||
    !validIsoTimestamp(startedAt) ||
    !Number.isSafeInteger(signatureProofGeneration) ||
    signatureProofGeneration < 0
  ) {
    return null;
  }
  const sample = normalizePlaybackSignature(playback, normalizedDeck);
  if (!sample) {
    return null;
  }
  return {
    version: 1,
    source: "content-lookup-signature",
    deck: normalizedDeck,
    playSessionId,
    startedAt,
    signatureProofGeneration,
    signature: { bpm: sample.bpm, totalSec: sample.totalSec },
    playback: sample,
  };
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const contentId = metadata.contentId != null && String(metadata.contentId).trim()
    ? String(metadata.contentId).trim()
    : null;
  const trackBpm = finitePositive(metadata.trackBpm);
  const durationSec = finitePositive(metadata.durationSec);
  if (!contentId || !trackBpm || !durationSec) {
    return null;
  }
  return {
    contentId,
    title: typeof metadata.title === "string" && metadata.title.trim() ? metadata.title.trim() : null,
    artist: typeof metadata.artist === "string" && metadata.artist.trim() ? metadata.artist.trim() : null,
    trackBpm,
    durationSec,
  };
}

function composeSignatureIdentityProof(playbackProof, metadata) {
  if (!playbackProof || typeof playbackProof !== "object") {
    return null;
  }
  const sample = normalizePlaybackSignature(playbackProof.playback, normalizeDeck(playbackProof.deck));
  const signatureBpm = finitePositive(playbackProof.signature?.bpm);
  const signatureDuration = finitePositive(playbackProof.signature?.totalSec);
  const normalizedMetadata = normalizeMetadata(metadata);
  if (
    !sample ||
    !signatureBpm ||
    !signatureDuration ||
    !normalizedMetadata ||
    playbackProof.version !== 1 ||
    playbackProof.source !== "content-lookup-signature" ||
    !sameNumber(sample.bpm, signatureBpm, SIGNATURE_BPM_EPSILON) ||
    !sameNumber(sample.totalSec, signatureDuration, SIGNATURE_DURATION_EPSILON_SEC) ||
    !sameNumber(normalizedMetadata.trackBpm, signatureBpm, SIGNATURE_BPM_EPSILON) ||
    Math.abs(normalizedMetadata.durationSec - signatureDuration) > CONTENT_LOOKUP_DURATION_TOLERANCE_SEC
  ) {
    return null;
  }
  return { ...playbackProof, metadata: normalizedMetadata };
}

function normalizeSignatureIdentityProof(proof) {
  if (!proof || typeof proof !== "object") {
    return null;
  }
  const playbackProof = createSignaturePlaybackProof(proof);
  if (!playbackProof) {
    return null;
  }
  return composeSignatureIdentityProof(playbackProof, proof.metadata);
}

function currentPlaybackMatchesSignatureProof(proof, playback, { now, maxSampleAgeMs } = {}) {
  const normalizedProof = normalizeSignatureIdentityProof(proof);
  const current = normalizePlaybackSignature(playback, normalizedProof?.deck);
  const nowMs = Number(now);
  const observedMs = current ? Date.parse(current.positionObservedAt) : NaN;
  const proofObservedMs = normalizedProof ? Date.parse(normalizedProof.playback.positionObservedAt) : NaN;
  if (
    !normalizedProof ||
    !current ||
    !Number.isFinite(nowMs) ||
    !Number.isFinite(observedMs) ||
    !Number.isFinite(proofObservedMs) ||
    nowMs - observedMs < 0 ||
    nowMs - observedMs > maxSampleAgeMs ||
    current.positionRevision < normalizedProof.playback.positionRevision ||
    observedMs < proofObservedMs ||
    !sameNumber(current.bpm, normalizedProof.signature.bpm, SIGNATURE_BPM_EPSILON) ||
    !sameNumber(current.totalSec, normalizedProof.signature.totalSec, SIGNATURE_DURATION_EPSILON_SEC)
  ) {
    return false;
  }
  return true;
}

module.exports = {
  CONTENT_LOOKUP_DURATION_TOLERANCE_SEC,
  createSignaturePlaybackProof,
  composeSignatureIdentityProof,
  normalizeSignatureIdentityProof,
  currentPlaybackMatchesSignatureProof,
};
