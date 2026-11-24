const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const {
  currentPlaybackMatchesSignatureProof,
  normalizeSignatureIdentityProof,
} = require("./signatureIdentityProof");
const {
  normalizeOwnerSelectionPolicy,
  productionFallbackReevaluationDelayMs,
  selectProductionOwnerCandidate,
} = require("./ownerSelectionPolicy");

function defaultIdFactory() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function finiteNumber(value) {
  if (value == null || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeDeckNumber(value) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) && number >= 1 && number <= 4 ? number : null;
}

function normalizeTrack(entry = {}) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const contentId = entry.contentId != null && String(entry.contentId).trim()
    ? String(entry.contentId).trim()
    : null;
  const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : null;
  const artist = typeof entry.artist === "string" && entry.artist.trim() ? entry.artist.trim() : null;
  if (!contentId && !title && !artist) {
    return null;
  }
  const identity = contentId
    ? `content:${contentId}`
    : `text:${[title || "", artist || ""].join("\u0000").toLocaleLowerCase()}`;
  return {
    contentId,
    title,
    artist,
    trackBpm: finiteNumber(entry.trackBpm),
    identity,
  };
}

function normalizedTrackText(track) {
  return track?.title && track?.artist
    ? [track.title, track.artist].join("\u0000").toLocaleLowerCase()
    : "";
}

function compatibleTrackText(left, right) {
  let shared = false;
  for (const field of ["title", "artist"]) {
    const leftValue = typeof left?.[field] === "string" ? left[field].toLocaleLowerCase() : null;
    const rightValue = typeof right?.[field] === "string" ? right[field].toLocaleLowerCase() : null;
    if (leftValue && rightValue) {
      if (leftValue !== rightValue) return false;
      shared = true;
    }
  }
  return shared;
}

function tracksRepresentSame(left, right) {
  if (!left || !right) {
    return false;
  }
  if (left.contentId && right.contentId) {
    return left.contentId === right.contentId;
  }
  if (left.contentId || right.contentId) {
    const leftText = normalizedTrackText(left);
    const rightText = normalizedTrackText(right);
    return Boolean(leftText && leftText === rightText);
  }
  return compatibleTrackText(left, right);
}

function mergeTrackIdentity(previous, reported) {
  if (!reported) {
    return previous || null;
  }
  if (!previous || !tracksRepresentSame(previous, reported)) {
    return reported;
  }
  return normalizeTrack({
    ...previous,
    ...reported,
    contentId: reported.contentId || previous.contentId || null,
    title: reported.title || previous.title || null,
    artist: reported.artist || previous.artist || null,
    trackBpm: reported.trackBpm == null ? previous.trackBpm : reported.trackBpm,
  });
}

function wireIdentityForTrack(track) {
  if (track?.contentId) {
    return { contentId: track.contentId };
  }
  if (track?.title && track?.artist) {
    return { title: track.title, artist: track.artist };
  }
  return null;
}

function normalizePlayback(entry = {}) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const deck = normalizeDeckNumber(entry.deck);
  if (!deck) {
    return null;
  }
  return {
    deck,
    isPlaying: typeof entry.isPlaying === "boolean" ? entry.isPlaying : null,
    positionSec: finiteNumber(entry.positionSec),
    bpm: finiteNumber(entry.bpm),
    totalSec: finiteNumber(entry.totalSec),
    positionObservedAt:
      typeof entry.positionObservedAt === "string" && entry.positionObservedAt.trim()
        ? entry.positionObservedAt
        : null,
    positionRevision:
      Number.isSafeInteger(entry.positionRevision) && entry.positionRevision >= 1
        ? entry.positionRevision
        : null,
    updatedAt: entry.updatedAt || null,
  };
}

function mergePlaybackSample(previous, reported) {
  if (!reported) return previous || null;
  if (!previous) return reported;
  const previousRevision = previous.positionRevision;
  const reportedRevision = reported.positionRevision;
  if (
    Number.isSafeInteger(previousRevision) &&
    Number.isSafeInteger(reportedRevision) &&
    reportedRevision < previousRevision
  ) {
    return previous;
  }
  if (
    Number.isSafeInteger(previousRevision) &&
    Number.isSafeInteger(reportedRevision) &&
    reportedRevision === previousRevision
  ) {
    const positionConflict =
      Number.isFinite(previous.positionSec) &&
      Number.isFinite(reported.positionSec) &&
      previous.positionSec !== reported.positionSec;
    if (positionConflict) return previous;
    return {
      ...previous,
      bpm: Number.isFinite(reported.bpm) ? reported.bpm : previous.bpm,
      isPlaying:
        typeof reported.isPlaying === "boolean" ? reported.isPlaying : previous.isPlaying,
      updatedAt: reported.updatedAt || previous.updatedAt,
    };
  }
  if (Number.isSafeInteger(previousRevision) && !Number.isSafeInteger(reportedRevision)) {
    return {
      ...previous,
      bpm: Number.isFinite(reported.bpm) ? reported.bpm : previous.bpm,
      isPlaying:
        typeof reported.isPlaying === "boolean" ? reported.isPlaying : previous.isPlaying,
      updatedAt: reported.updatedAt || previous.updatedAt,
    };
  }
  return { ...previous, ...reported };
}

function hasEqualRevisionSignatureConflict(previous, reported) {
  if (!previous || !reported || previous.positionRevision !== reported.positionRevision) {
    return false;
  }
  if (!Number.isSafeInteger(previous.positionRevision) || previous.positionRevision < 1) {
    return false;
  }
  const finiteConflict = (left, right) =>
    Number.isFinite(left) && Number.isFinite(right) && left !== right;
  return (
    (typeof previous.isPlaying === "boolean" &&
      typeof reported.isPlaying === "boolean" &&
      previous.isPlaying !== reported.isPlaying) ||
    finiteConflict(previous.bpm, reported.bpm) ||
    finiteConflict(previous.totalSec, reported.totalSec) ||
    finiteConflict(previous.positionSec, reported.positionSec) ||
    (typeof previous.positionObservedAt === "string" &&
      typeof reported.positionObservedAt === "string" &&
      previous.positionObservedAt !== reported.positionObservedAt)
  );
}

function normalizeMeasuredLoop(entry, { nowMs, maxSampleAgeMs }) {
  if (
    !entry ||
    typeof entry !== "object" ||
    entry.activeKnown !== true ||
    entry.source !== "rekordbox-hook"
  ) {
    return null;
  }
  if (typeof entry.active !== "boolean") {
    return null;
  }
  if (!Number.isSafeInteger(entry.revision) || entry.revision < 1) {
    return null;
  }
  const observedMs = Date.parse(entry.updatedAt);
  const sampleAgeMs = Number.isFinite(observedMs) ? nowMs - observedMs : NaN;
  if (!Number.isFinite(sampleAgeMs) || sampleAgeMs < 0 || sampleAgeMs > maxSampleAgeMs) {
    return null;
  }
  const startBeat = finiteNumber(entry.startBeat);
  const endBeat = finiteNumber(entry.endBeat);
  const lengthBeats = finiteNumber(entry.lengthBeats);
  if (
    entry.active === true &&
    (!Number.isFinite(startBeat) ||
      !Number.isFinite(endBeat) ||
      !Number.isFinite(lengthBeats) ||
      startBeat < 0 ||
      endBeat <= startBeat ||
      lengthBeats <= 0 ||
      Math.abs(endBeat - startBeat - lengthBeats) > 0.001)
  ) {
    return null;
  }
  return {
    active: entry.active,
    // The general rb-output snapshot intentionally retains the last visible
    // boundaries after loop-off. The strict v3 peer contract does not: an
    // authoritative inactive measurement must carry three exact nulls.
    startBeat: entry.active ? startBeat : null,
    endBeat: entry.active ? endBeat : null,
    lengthBeats: entry.active ? lengthBeats : null,
    revision: entry.revision,
    sampleAgeMs,
    observedAtMs: observedMs,
    source: "rekordbox-hook-measured",
  };
}

function createTrackActivityDetector({
  now = () => Date.now(),
  idFactory = defaultIdFactory,
  maxDeck = 4,
  maxSampleAgeMs = 1_500,
  ownerSelectionPolicy = null,
  ownerSelectionTimerApi = globalThis,
} = {}) {
  const emitter = new EventEmitter();
  const boundedMaxSampleAgeMs =
    Number.isFinite(maxSampleAgeMs) && maxSampleAgeMs >= 0 ? maxSampleAgeMs : 1_500;
  const configuredOwnerSelectionPolicy = normalizeOwnerSelectionPolicy(ownerSelectionPolicy);
  const ownerSelectionTimers = (
    ownerSelectionTimerApi &&
    typeof ownerSelectionTimerApi.setTimeout === "function" &&
    typeof ownerSelectionTimerApi.clearTimeout === "function"
  ) ? ownerSelectionTimerApi : globalThis;
  const decks = new Map();
  let explicitMasterDeck = null;
  let explicitMasterUpdatedAt = null;
  let explicitMasterAuthorityUpdatedAtMs = null;
  let explicitMasterAuthorityRevision = 0;
  let snapshotMasterDeck = null;
  let snapshotMasterSource = "unknown";
  let masterActivationGeneration = 0;
  let knownMasterDeck = null;
  let ownerSelectionTimer = null;
  let ownerSelectionTimerGeneration = 0;
  let stopped = false;
  // A router restart is not a fresh Rekordbox observation. Each production
  // candidate must instead prove that *its own deck* received current track
  // identity plus a fresh playing sample after this generation began. Do not
  // replace this with a global-ready flag: a Deck 2 snapshot must never revive
  // a stale Deck 1 owner after reconnect.
  let productionSnapshotGeneration = 0;

  function getDeckState(deck) {
    let state = decks.get(deck);
    if (!state) {
      state = {
        track: null,
        playback: null,
        previousIsPlaying: null,
        playSessionId: null,
        startedAt: null,
        wireIdentity: null,
        lastCandidateActiveSessionId: null,
        lastCandidateSyncPositionRevision: null,
        lastTrackLoadedKey: null,
        awaitingPlayConfirmation: false,
        pendingTrackChange: false,
        signatureProofGeneration: 0,
        signatureProofConflictRevision: null,
        loop: null,
        lastLoopEventRevision: null,
        productionSnapshotGeneration: null,
      };
      decks.set(deck, state);
    }
    return state;
  }

  function event(type, payload = {}) {
    return {
      type,
      eventId: idFactory(),
      occurredAt: new Date(now()).toISOString(),
      payload: { ...payload },
    };
  }

  function emitEvent(type, payload = {}) {
    const next = event(type, payload);
    emitter.emit("event", next);
    return next;
  }

  function currentMasterDeck() {
    if (Number.isInteger(explicitMasterDeck)) {
      return explicitMasterDeck;
    }
    if (Number.isInteger(snapshotMasterDeck)) {
      return snapshotMasterDeck;
    }
    return null;
  }

  function diagnosticTrackPayload(deck, state) {
    const track = state.track || {};
    const playback = state.playback || {};
    return {
      deck,
      contentId: track.contentId || null,
      title: track.title || null,
      artist: track.artist || null,
      trackBpm: Number.isFinite(track.trackBpm) ? track.trackBpm : null,
      positionSec: Number.isFinite(playback.positionSec) ? playback.positionSec : null,
      isPlaying: playback.isPlaying === true,
      startedAt: state.startedAt || null,
      playSessionId: state.playSessionId || null,
    };
  }

  function currentLoopPayload(loop) {
    if (!loop) return null;
    const sampleAgeMs = now() - loop.observedAtMs;
    if (!Number.isFinite(sampleAgeMs) || sampleAgeMs < 0 || sampleAgeMs > boundedMaxSampleAgeMs) {
      return null;
    }
    return {
      active: loop.active,
      startBeat: loop.startBeat,
      endBeat: loop.endBeat,
      lengthBeats: loop.lengthBeats,
      revision: loop.revision,
      sampleAgeMs,
      source: loop.source,
    };
  }

  // Candidate frames use the strict current wire identity: a contentId is
  // authoritative and must not travel alongside display text. If no contentId
  // is available, title and artist together are the only permitted fallback.
  function candidatePlaybackContext(state) {
    const track = state.track || {};
    const playback = state.playback || {};
    const observedMs = Date.parse(playback.positionObservedAt);
    const sampleAgeMs = Number.isFinite(observedMs) ? now() - observedMs : NaN;
    const effectiveBpm = Number.isFinite(playback.bpm) && playback.bpm > 0
      ? playback.bpm
      : Number.isFinite(track.trackBpm) && track.trackBpm > 0
        ? track.trackBpm
        : null;
    const startedAt = typeof state.startedAt === "string" && Number.isFinite(Date.parse(state.startedAt))
      ? state.startedAt
      : null;
    if (
      !state.playSessionId ||
      !startedAt ||
      !Number.isFinite(playback.positionSec) ||
      playback.positionSec < 0 ||
      !Number.isFinite(effectiveBpm) ||
      effectiveBpm <= 0 ||
      !Number.isSafeInteger(playback.positionRevision) ||
      playback.positionRevision < 1 ||
      !Number.isFinite(sampleAgeMs) ||
      sampleAgeMs < 0 ||
      sampleAgeMs > boundedMaxSampleAgeMs
    ) {
      return null;
    }
    return { track, playback, effectiveBpm, startedAt, sampleAgeMs };
  }

  function strictCandidateTrackPayload(deck, state, preferredWireIdentity = null) {
    const context = candidatePlaybackContext(state);
    if (!context) return null;
    const { track, playback, effectiveBpm, startedAt, sampleAgeMs } = context;
    // The first emitted candidate fixes the one-of wire identity for the
    // session. Later Hook metadata may enrich state.track for diagnostics,
    // but must never launder the same wire session from title+artist to a
    // contentId (or the reverse).
    const identity = state.wireIdentity || preferredWireIdentity || wireIdentityForTrack(track);
    if (!identity) return null;
    return {
      deck,
      deckId: `rekordbox-deck-${deck}`,
      ...identity,
      ...(Number.isFinite(track.trackBpm) && track.trackBpm > 0
        ? { trackBpm: track.trackBpm }
        : {}),
      positionAtSendSec: playback.positionSec,
      effectiveBpm,
      positionRevision: playback.positionRevision,
      sampleAgeMs,
      isPlaying: true,
      startedAt,
      playSessionId: state.playSessionId,
      loop: currentLoopPayload(state.loop),
    };
  }

  function currentProductionSnapshotDescriptor(deck, state) {
    if (
      state.playback?.isPlaying !== true ||
      state.pendingTrackChange ||
      state.awaitingPlayConfirmation
    ) return null;
    const context = candidatePlaybackContext(state);
    if (!context) return null;
    const startedAtMs = Date.parse(context.startedAt);
    const sessionAgeMs = now() - startedAtMs;
    if (!Number.isFinite(sessionAgeMs) || sessionAgeMs < 0) return null;
    return {
      deck,
      fresh: true,
      isPlaying: true,
      title: context.track.title || null,
      artist: context.track.artist || null,
      contentId: context.track.contentId || null,
      sessionAgeMs,
    };
  }

  function productionCandidateDescriptor(deck, state) {
    if (state.productionSnapshotGeneration !== productionSnapshotGeneration) {
      return null;
    }
    return currentProductionSnapshotDescriptor(deck, state);
  }

  function freshReportedProductionPlayback(playback) {
    const observedAtMs = Date.parse(playback?.positionObservedAt);
    const sampleAgeMs = Number.isFinite(observedAtMs) ? now() - observedAtMs : NaN;
    return Boolean(
      playback?.isPlaying === true &&
      Number.isFinite(playback.positionSec) &&
      playback.positionSec >= 0 &&
      Number.isSafeInteger(playback.positionRevision) &&
      playback.positionRevision >= 1 &&
      Number.isFinite(sampleAgeMs) &&
      sampleAgeMs >= 0 &&
      sampleAgeMs <= boundedMaxSampleAgeMs
    );
  }

  function recordProductionSnapshotProvenance(
    deck,
    state,
    tracks,
    playbacks,
    equalRevisionSignatureConflict,
  ) {
    if (!usesProductionOwnerSelection() || !tracks.has(deck) || !playbacks.has(deck)) {
      return;
    }
    // The actual snapshot supplied both fields for this deck. Mark it only
    // after merge/session handling proves the resulting state is transport
    // fresh and playing; stale/stopped/replacement input clears prior proof.
    state.productionSnapshotGeneration = (
      !equalRevisionSignatureConflict &&
      freshReportedProductionPlayback(playbacks.get(deck)) &&
      currentProductionSnapshotDescriptor(deck, state)
    )
      ? productionSnapshotGeneration
      : null;
  }

  function maybeEmitCandidateActive(deck, state) {
    if (
      state.playback?.isPlaying !== true ||
      !state.playSessionId ||
      state.lastCandidateActiveSessionId === state.playSessionId
    ) {
      return null;
    }
    const payload = strictCandidateTrackPayload(deck, state);
    if (!payload) {
      return null;
    }
    state.wireIdentity ||= wireIdentityForTrack(payload);
    state.lastCandidateActiveSessionId = state.playSessionId;
    state.lastCandidateSyncPositionRevision = payload.positionRevision;
    return emitEvent("DJ_TRACK_ACTIVE", payload);
  }

  function maybeEmitCandidateSync(deck, state) {
    if (
      state.playback?.isPlaying !== true ||
      !state.playSessionId ||
      state.lastCandidateActiveSessionId !== state.playSessionId
    ) {
      return null;
    }
    const payload = strictCandidateTrackPayload(deck, state);
    if (
      !payload ||
      payload.positionRevision <= Number(state.lastCandidateSyncPositionRevision || 0)
    ) {
      return null;
    }
    state.lastCandidateSyncPositionRevision = payload.positionRevision;
    return emitEvent("DJ_TRACK_SYNC", payload);
  }

  function emitConfiguredProductionCandidate({ forceActive = false } = {}) {
    const candidates = [];
    for (const [deck, state] of decks) {
      if (deck <= maxDeck) {
        const candidate = productionCandidateDescriptor(deck, state);
        if (candidate) candidates.push(candidate);
      }
    }
    const selected = selectProductionOwnerCandidate(candidates, configuredOwnerSelectionPolicy);
    if (!selected || selected.kind === "wait-for-text-identity") return null;
    const state = decks.get(selected.deck);
    if (!state) return null;
    const payload = strictCandidateTrackPayload(selected.deck, state, selected.wireIdentity);
    if (!payload) return null;
    state.wireIdentity ||= { ...selected.wireIdentity };
    if (forceActive || state.lastCandidateActiveSessionId !== state.playSessionId) {
      state.lastCandidateActiveSessionId = state.playSessionId;
      state.lastCandidateSyncPositionRevision = payload.positionRevision;
      const active = emitEvent("DJ_TRACK_ACTIVE", payload);
      maybeEmitMeasuredLoop(selected.deck, state);
      return active;
    }
    if (payload.positionRevision <= Number(state.lastCandidateSyncPositionRevision || 0)) {
      return null;
    }
    state.lastCandidateSyncPositionRevision = payload.positionRevision;
    return emitEvent("DJ_TRACK_SYNC", payload);
  }

  function usesProductionOwnerSelection() {
    return configuredOwnerSelectionPolicy.mode === "titleContains";
  }

  function productionCandidateDescriptors() {
    const candidates = [];
    for (const [deck, state] of decks) {
      if (deck <= maxDeck) {
        const candidate = productionCandidateDescriptor(deck, state);
        if (candidate) candidates.push(candidate);
      }
    }
    return candidates;
  }

  function cancelOwnerSelectionReevaluation() {
    ownerSelectionTimerGeneration += 1;
    if (ownerSelectionTimer !== null) {
      ownerSelectionTimers.clearTimeout(ownerSelectionTimer);
      ownerSelectionTimer = null;
    }
  }

  function scheduleOwnerSelectionReevaluation() {
    if (stopped || !usesProductionOwnerSelection()) return;
    const delayMs = productionFallbackReevaluationDelayMs(
      productionCandidateDescriptors(),
      configuredOwnerSelectionPolicy,
    );
    if (!Number.isInteger(delayMs) || delayMs <= 0) return;
    const generation = ownerSelectionTimerGeneration + 1;
    const snapshotGeneration = productionSnapshotGeneration;
    cancelOwnerSelectionReevaluation();
    ownerSelectionTimerGeneration = generation;
    ownerSelectionTimer = ownerSelectionTimers.setTimeout(() => {
      if (
        stopped ||
        generation !== ownerSelectionTimerGeneration ||
        snapshotGeneration !== productionSnapshotGeneration
      ) return;
      ownerSelectionTimer = null;
      emitConfiguredProductionCandidate();
    }, delayMs);
  }

  function maybeEmitMeasuredLoop(deck, state, { force = false } = {}) {
    const loop = currentLoopPayload(state.loop);
    if (
      !loop ||
      !state.playSessionId ||
      state.lastCandidateActiveSessionId !== state.playSessionId ||
      (!force && loop.revision <= Number(state.lastLoopEventRevision || 0))
    ) {
      return null;
    }
    state.lastLoopEventRevision = loop.revision;
    return emitEvent("DJ_LOOP_STATE", {
      deck,
      deckId: `rekordbox-deck-${deck}`,
      playSessionId: state.playSessionId,
      ...loop,
    });
  }

  function setSnapshotMaster(deck, source) {
    if (!Number.isInteger(deck)) {
      return;
    }
    if (Number.isInteger(explicitMasterDeck)) {
      return;
    }
    if (knownMasterDeck !== deck) {
      knownMasterDeck = deck;
      masterActivationGeneration += 1;
    }
    snapshotMasterDeck = deck;
    snapshotMasterSource = source;
  }

  function explicitMasterTimestamp(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const timestampMs = Date.parse(value);
    return Number.isFinite(timestampMs) ? timestampMs : null;
  }

  function authorityReceiveNowMs() {
    const receivedAtMs = now();
    return Number.isFinite(receivedAtMs) ? receivedAtMs : null;
  }

  function isFutureExplicitAuthorityTimestamp(timestampMs, receivedAtMs) {
    // The hook creates authority timestamps in this process immediately before
    // emitting its event, so any timestamp after receipt is unverifiable. Do
    // not let it advance the high-water mark and poison later recovery.
    return !Number.isFinite(receivedAtMs) || timestampMs > receivedAtMs;
  }

  function establishExplicitMaster(deck, timestampMs) {
    if (!Number.isInteger(explicitMasterDeck) || explicitMasterDeck !== deck) {
      explicitMasterAuthorityRevision += 1;
    }
    explicitMasterDeck = deck;
    explicitMasterAuthorityUpdatedAtMs = timestampMs;
    explicitMasterUpdatedAt = new Date(timestampMs).toISOString();

    if (knownMasterDeck !== deck) {
      knownMasterDeck = deck;
      masterActivationGeneration += 1;
    }
  }

  function advanceExplicitMasterHighWater(timestampMs) {
    explicitMasterAuthorityUpdatedAtMs = timestampMs;
    explicitMasterUpdatedAt = new Date(timestampMs).toISOString();
  }

  function acceptSnapshotExplicitMaster(deck, updatedAt) {
    const timestampMs = explicitMasterTimestamp(updatedAt);
    const receivedAtMs = authorityReceiveNowMs();
    const hasAuthority = Number.isInteger(explicitMasterDeck);
    const sameDeck = hasAuthority && explicitMasterDeck === deck;

    if (!Number.isFinite(timestampMs) || isFutureExplicitAuthorityTimestamp(timestampMs, receivedAtMs)) {
      return false;
    }
    if (!hasAuthority) {
      establishExplicitMaster(deck, timestampMs);
      return true;
    }

    const highWaterMs = explicitMasterAuthorityUpdatedAtMs;
    if (!Number.isFinite(highWaterMs) || timestampMs < highWaterMs) {
      return false;
    }
    if (timestampMs === highWaterMs) {
      // The provider emits this equal snapshot immediately after a valid
      // master_change. It confirms the same authority only.
      return sameDeck;
    }
    if (sameDeck) {
      advanceExplicitMasterHighWater(timestampMs);
      return true;
    }

    establishExplicitMaster(deck, timestampMs);
    return true;
  }

  function acceptMasterChange(deck, updatedAt) {
    const timestampMs = explicitMasterTimestamp(updatedAt);
    const receivedAtMs = authorityReceiveNowMs();
    const hasAuthority = Number.isInteger(explicitMasterDeck);

    if (!Number.isFinite(timestampMs) || isFutureExplicitAuthorityTimestamp(timestampMs, receivedAtMs)) {
      return false;
    }
    if (
      hasAuthority &&
      (!Number.isFinite(explicitMasterAuthorityUpdatedAtMs) ||
        timestampMs <= explicitMasterAuthorityUpdatedAtMs)
    ) {
      return false;
    }

    establishExplicitMaster(deck, timestampMs);
    return true;
  }

  function updateMasterFromSnapshot(snapshot = {}) {
    const explicit = normalizeDeckNumber(snapshot.explicitMasterDeck);
    if (explicit) {
      if (!acceptSnapshotExplicitMaster(explicit, snapshot.explicitMasterUpdatedAt)) {
        return false;
      }
      snapshotMasterSource = "explicit-state";
      return true;
    }
    const reported = normalizeDeckNumber(snapshot.masterDeck);
    if (reported) {
      const source = String(snapshot.masterDeckSource || "").trim().toLowerCase();
      if (source === "playback-fallback" && !shouldAcceptFallbackMaster(snapshot, reported)) {
        return true;
      }
      setSnapshotMaster(reported, snapshot.masterDeckSource || "snapshot");
      return true;
    }
    const playbackDeck = normalizeDeckNumber(snapshot.playback?.deck);
    if (playbackDeck) {
      setSnapshotMaster(playbackDeck, "playback-fallback");
    }
    return true;
  }

  function snapshotPlaybackForDeck(snapshot, deck) {
    const topLevel = normalizePlayback(snapshot.playback);
    if (topLevel?.deck === deck) {
      return topLevel;
    }
    for (const entry of Array.isArray(snapshot.deckPlaybacks) ? snapshot.deckPlaybacks : []) {
      const playback = normalizePlayback(entry);
      if (playback?.deck === deck) {
        return playback;
      }
    }
    return null;
  }

  function shouldAcceptFallbackMaster(snapshot, reported) {
    const current = currentMasterDeck();
    if (!current || current === reported) {
      return true;
    }
    const currentState = decks.get(current);
    if (currentState?.playback?.isPlaying === true) {
      // A playback-fallback candidate is not authoritative while the current
      // master is demonstrably playing. Explicit master_change remains the
      // only immediate way to switch in this ambiguous path.
      return false;
    }
    const candidatePlayback = snapshotPlaybackForDeck(snapshot, reported);
    return candidatePlayback?.isPlaying !== false;
  }

  function onSnapshot(snapshot = {}) {
    if (stopped) return getState();
    cancelOwnerSelectionReevaluation();
    // MASTER is a diagnostic input only in generic v3. A stale or malformed
    // MASTER assertion must fail closed for that diagnostic, never suppress
    // independently valid per-deck playback candidates in this snapshot.
    updateMasterFromSnapshot(snapshot);
    const measuredLoops = new Map();
    for (const entry of Array.isArray(snapshot.loopStates) ? snapshot.loopStates : []) {
      const deck = normalizeDeckNumber(entry?.deck);
      const loop = normalizeMeasuredLoop(entry, { nowMs: now(), maxSampleAgeMs: boundedMaxSampleAgeMs });
      if (deck && loop) measuredLoops.set(deck, loop);
    }
    const tracks = new Map();
    for (const entry of Array.isArray(snapshot.deckNowPlaying) ? snapshot.deckNowPlaying : []) {
      const deck = normalizeDeckNumber(entry?.deck);
      const track = normalizeTrack(entry);
      if (deck && track) {
        tracks.set(deck, track);
      }
    }
    const playbacks = new Map();
    for (const entry of Array.isArray(snapshot.deckPlaybacks) ? snapshot.deckPlaybacks : []) {
      const playback = normalizePlayback(entry);
      if (playback) {
        playbacks.set(playback.deck, playback);
      }
    }
    const fallbackPlayback = normalizePlayback(snapshot.playback);
    if (fallbackPlayback && !playbacks.has(fallbackPlayback.deck)) {
      playbacks.set(fallbackPlayback.deck, fallbackPlayback);
    }

    const deckNumbers = new Set([...decks.keys(), ...tracks.keys(), ...playbacks.keys()]);
    for (const deck of deckNumbers) {
      if (deck > maxDeck) {
        continue;
      }
      const state = getDeckState(deck);
      const previousTrack = state.track;
      const reportedTrack = tracks.get(deck);
      const nextTrack = mergeTrackIdentity(previousTrack, reportedTrack);
      const reportedPlayback = playbacks.get(deck) || null;
      const previousPlaybackRevision = state.playback?.positionRevision;
      const equalRevisionSignatureConflict = hasEqualRevisionSignatureConflict(
        state.playback,
        reportedPlayback
      );
      const nextPlayback = mergePlaybackSample(state.playback, reportedPlayback);
      const trackChanged =
        Boolean(nextTrack && previousTrack && !tracksRepresentSame(nextTrack, previousTrack)) ||
        state.pendingTrackChange;
      const firstTrack = Boolean(nextTrack && !previousTrack);
      const previousIsPlaying = state.playback?.isPlaying ?? state.previousIsPlaying;
      const nextIsPlaying = nextPlayback?.isPlaying ?? null;
      state.track = nextTrack;
      state.playback = nextPlayback;
      if (equalRevisionSignatureConflict) {
        state.signatureProofGeneration += 1;
        state.signatureProofConflictRevision = previousPlaybackRevision;
      } else if (
        Number.isSafeInteger(state.signatureProofConflictRevision) &&
        Number.isSafeInteger(nextPlayback?.positionRevision) &&
        nextPlayback.positionRevision > state.signatureProofConflictRevision
      ) {
        state.signatureProofConflictRevision = null;
      }
      if (measuredLoops.has(deck)) {
        const measured = measuredLoops.get(deck);
        if (!state.loop || measured.revision > state.loop.revision) {
          state.loop = measured;
        }
      }

      if ((trackChanged || firstTrack) && nextTrack && state.lastTrackLoadedKey !== nextTrack.identity) {
        state.lastTrackLoadedKey = nextTrack.identity;
        emitEvent("DJ_TRACK_LOADED", {
          deck,
          contentId: nextTrack.contentId,
          title: nextTrack.title,
          artist: nextTrack.artist,
          trackBpm: nextTrack.trackBpm,
        });
      }

      const started = nextIsPlaying === true && previousIsPlaying !== true;
      const stopped = nextIsPlaying === false && previousIsPlaying === true;
      if (started) {
        state.playSessionId = idFactory();
        state.startedAt = new Date(now()).toISOString();
        state.wireIdentity = null;
        state.awaitingPlayConfirmation = false;
        state.lastCandidateActiveSessionId = null;
        state.lastCandidateSyncPositionRevision = null;
        state.lastLoopEventRevision = null;
        if (!equalRevisionSignatureConflict) {
          state.signatureProofGeneration = 0;
          state.signatureProofConflictRevision = null;
        }
        emitEvent("DJ_TRACK_PLAY_STARTED", diagnosticTrackPayload(deck, state));
      } else if (stopped) {
        emitEvent("DJ_TRACK_PLAY_STOPPED", diagnosticTrackPayload(deck, state));
      }
      if ((trackChanged || firstTrack) && nextIsPlaying === true && !started) {
        // A deck can report the old playing state while a newly loaded track
        // is still only preloaded. Do not promote that stale true to a new
        // play session; wait for fresh false/null -> true evidence.
        state.playSessionId = null;
        state.startedAt = null;
        state.wireIdentity = null;
        state.awaitingPlayConfirmation = true;
        state.lastCandidateActiveSessionId = null;
        state.lastCandidateSyncPositionRevision = null;
        state.lastLoopEventRevision = null;
      } else if ((trackChanged || firstTrack) && !started) {
        state.playSessionId = null;
        state.startedAt = null;
        state.wireIdentity = null;
        state.awaitingPlayConfirmation = false;
        state.lastCandidateActiveSessionId = null;
        state.lastCandidateSyncPositionRevision = null;
        state.lastLoopEventRevision = null;
      }
      state.pendingTrackChange = false;
      state.previousIsPlaying = nextIsPlaying;
      recordProductionSnapshotProvenance(
        deck,
        state,
        tracks,
        playbacks,
        equalRevisionSignatureConflict,
      );
      if (!usesProductionOwnerSelection()) {
        const candidateActive = maybeEmitCandidateActive(deck, state);
        if (!candidateActive) maybeEmitCandidateSync(deck, state);
      }
      maybeEmitMeasuredLoop(deck, state);
    }
    if (usesProductionOwnerSelection()) {
      emitConfiguredProductionCandidate();
      scheduleOwnerSelectionReevaluation();
    }
    return getState();
  }

  function onTrackLoaded(rawEvent = {}) {
    if (stopped) return null;
    const deck = normalizeDeckNumber(rawEvent.logicalDeck || rawEvent.deck);
    if (!deck) {
      return null;
    }
    const state = getDeckState(deck);
    const nextTrack = normalizeTrack(rawEvent);
    if (!nextTrack) {
      return null;
    }
    const mergedTrack = mergeTrackIdentity(state.track, nextTrack);
    const changed = Boolean(state.track && !tracksRepresentSame(state.track, mergedTrack));
    const firstTrack = !state.track;
    // A valid metadata input can replace the current selection or enrich the
    // same session. Fence the old callback only after identifying the input;
    // malformed/no-op packets must not erase the only bounded fallback timer.
    cancelOwnerSelectionReevaluation();
    state.track = mergedTrack;
    if (!changed && !firstTrack) {
      // A later contentId/metadata packet can enrich the same playing track.
      // Update the canonical loaded key without emitting another load event.
      state.lastTrackLoadedKey = state.track.identity;
      if (usesProductionOwnerSelection()) {
        emitConfiguredProductionCandidate();
        scheduleOwnerSelectionReevaluation();
      }
      return null;
    }
    if (changed || firstTrack) {
      // Track-loaded is diagnostic/identity information only. Defer any
      // play-session decision to the next snapshot's explicit play evidence.
      state.pendingTrackChange = true;
    }
    state.lastTrackLoadedKey = state.track.identity;
    const loadedEvent = emitEvent("DJ_TRACK_LOADED", {
      deck,
      contentId: state.track.contentId,
      title: state.track.title,
      artist: state.track.artist,
      trackBpm: state.track.trackBpm,
    });
    if (usesProductionOwnerSelection()) {
      // A replacement remains pending until an explicit fresh play snapshot.
      // Re-evaluate other decks only; productionCandidateDescriptor excludes
      // this pending deck so an old session can never be promoted by timer.
      scheduleOwnerSelectionReevaluation();
    }
    return loadedEvent;
  }

  function onSignatureIdentityProof(rawProof = {}) {
    if (stopped) return null;
    const proof = normalizeSignatureIdentityProof(rawProof);
    if (!proof) {
      return null;
    }
    const state = decks.get(proof.deck);
    if (!state) {
      return null;
    }
    const candidateTrack = normalizeTrack(proof.metadata);
    if (
      !candidateTrack ||
      state.playSessionId !== proof.playSessionId ||
      state.startedAt !== proof.startedAt ||
      state.track ||
      state.wireIdentity ||
      state.pendingTrackChange ||
      state.signatureProofGeneration !== proof.signatureProofGeneration ||
      state.signatureProofConflictRevision !== null ||
      state.awaitingPlayConfirmation ||
      state.lastCandidateActiveSessionId ||
      !currentPlaybackMatchesSignatureProof(proof, state.playback, {
        now: now(),
        maxSampleAgeMs: boundedMaxSampleAgeMs,
      })
    ) {
      return null;
    }
    state.track = candidateTrack;
    state.lastTrackLoadedKey = candidateTrack.identity;
    emitEvent("DJ_TRACK_LOADED", {
      deck: proof.deck,
      contentId: candidateTrack.contentId,
      title: candidateTrack.title,
      artist: candidateTrack.artist,
      trackBpm: candidateTrack.trackBpm,
    });
    return usesProductionOwnerSelection()
      ? emitConfiguredProductionCandidate()
      : maybeEmitCandidateActive(proof.deck, state);
  }

  function onMasterChange(rawEvent = {}) {
    if (stopped) return null;
    const deck = normalizeDeckNumber(rawEvent.logicalDeck || rawEvent.deck);
    if (!deck) {
      return null;
    }
    if (!acceptMasterChange(deck, rawEvent.explicitMasterUpdatedAt)) {
      return null;
    }
    snapshotMasterSource = "explicit-master-change";
    return null;
  }

  function requestMeasuredLoopForSession(rawOwner = {}) {
    if (stopped) return null;
    const deck = normalizeDeckNumber(rawOwner.deck);
    if (!deck || rawOwner.deckId !== `rekordbox-deck-${deck}`) {
      return null;
    }
    const state = getDeckState(deck);
    if (
      state.playSessionId !== rawOwner.playSessionId ||
      state.lastCandidateActiveSessionId !== state.playSessionId
    ) {
      return null;
    }
    return maybeEmitMeasuredLoop(deck, state, { force: true });
  }

  // A new Syndocal receiver has no durable knowledge of a currently playing
  // session. Reannounce only the exact, fresh candidates that are observable
  // now; this deliberately does not manufacture a start, advance revisions,
  // or revive a stopped/ambiguous deck.
  function requestCurrentTrackCandidates() {
    if (stopped) return [];
    if (usesProductionOwnerSelection()) {
      // Reconnect is an explicit receiver-knowledge boundary: reannounce the
      // currently selected, fresh owner as ACTIVE even if normal snapshot
      // dedupe already emitted the same revision. The selection and frozen
      // wire identity are revalidated here; ordinary snapshots still use the
      // non-forcing path above.
      const candidate = emitConfiguredProductionCandidate({ forceActive: true });
      return candidate ? [candidate] : [];
    }
    const candidates = [];
    for (const [deck, state] of decks) {
      if (state.playback?.isPlaying !== true || !state.playSessionId) {
        continue;
      }
      const payload = strictCandidateTrackPayload(deck, state);
      if (!payload) {
        continue;
      }
      state.wireIdentity ||= wireIdentityForTrack(payload);
      candidates.push(emitEvent("DJ_TRACK_ACTIVE", payload));
    }
    return candidates;
  }

  // Read the exact production candidate that is selectable right now without
  // emitting a candidate event. The router uses this for authority diagnostics
  // and explicit Syndocal reconciliation; it must not turn a local observation
  // into a Syndocal admission or replay a previously ACKed event. Reuse the same
  // provenance, freshness, titleContains, and bounded Deck 1 fallback
  // selector as the normal production path above.
  function getCurrentProductionCandidate() {
    if (stopped || !usesProductionOwnerSelection()) return null;
    const descriptors = productionCandidateDescriptors();
    const selected = selectProductionOwnerCandidate(
      descriptors,
      configuredOwnerSelectionPolicy,
    );
    if (!selected || selected.kind === "wait-for-text-identity") return null;
    const state = decks.get(selected.deck);
    if (!state) return null;
    const selectedDescriptor = descriptors.find((candidate) => candidate.deck === selected.deck);
    if (!selectedDescriptor) return null;
    const payload = strictCandidateTrackPayload(selected.deck, state, selected.wireIdentity);
    if (!payload) return null;
    const wireIdentity = Object.hasOwn(payload, "contentId")
      ? { contentId: payload.contentId }
      : Object.hasOwn(payload, "title") && Object.hasOwn(payload, "artist")
        ? { title: payload.title, artist: payload.artist }
        : null;
    if (!wireIdentity) return null;
    const identity = Object.hasOwn(wireIdentity, "contentId")
      ? `content:${wireIdentity.contentId}`
      : `text:${wireIdentity.title.toLocaleLowerCase()}\u0000${wireIdentity.artist.toLocaleLowerCase()}`;
    return {
      kind: selected.kind,
      deck: payload.deck,
      deckId: payload.deckId,
      playSessionId: payload.playSessionId,
      wireIdentity,
      identity,
      fresh: payload.sampleAgeMs >= 0 && payload.sampleAgeMs <= boundedMaxSampleAgeMs,
      isPlaying: payload.isPlaying === true,
      title: state.track?.title || null,
      artist: state.track?.artist || null,
      contentId: state.track?.contentId || null,
      trackBpm: Number.isFinite(state.track?.trackBpm) ? state.track.trackBpm : null,
      startedAt: payload.startedAt,
      sessionAgeMs: selectedDescriptor.sessionAgeMs,
      sampleAgeMs: payload.sampleAgeMs,
      positionAtSendSec: payload.positionAtSendSec,
      effectiveBpm: payload.effectiveBpm,
      positionRevision: payload.positionRevision,
    };
  }

  // A compact diagnostic for the local UI. It deliberately reports why the
  // exact production selector is not ready instead of treating a loaded
  // title as an admitted playing owner.
  function getProductionCandidateStatus() {
    if (stopped || !usesProductionOwnerSelection()) {
      return { stage: "unavailable", reason: "production-owner-selection-disabled" };
    }
    const state = decks.get(1);
    if (!state?.track) {
      return { stage: "no-track", reason: "track-not-loaded", deck: 1 };
    }
    if (!state.playback) {
      return { stage: "loaded", reason: "waiting-for-playback-sample", deck: 1 };
    }
    if (
      state.pendingTrackChange ||
      state.awaitingPlayConfirmation ||
      state.playback.isPlaying !== true ||
      !state.playSessionId ||
      !state.startedAt
    ) {
      return {
        stage: "waiting-for-play",
        reason: "fresh-playing-play-session-required",
        deck: 1,
        playSessionId: state.playSessionId || null,
      };
    }
    const production = currentProductionSnapshotDescriptor(1, state);
    if (!production || state.productionSnapshotGeneration !== productionSnapshotGeneration) {
      return {
        stage: "waiting-for-fresh-playback",
        reason: "fresh-playing-playback-required",
        deck: 1,
        playSessionId: state.playSessionId,
      };
    }
    const selected = selectProductionOwnerCandidate(
      productionCandidateDescriptors(),
      configuredOwnerSelectionPolicy,
    );
    if (selected?.kind === "wait-for-text-identity") {
      return {
        stage: "waiting-for-text-identity",
        reason: "artist-metadata-required",
        deck: selected.deck,
        playSessionId: state.playSessionId,
        sessionAgeMs: production.sessionAgeMs,
      };
    }
    if (!selected) {
      const waitMs = configuredOwnerSelectionPolicy.deck1MetadataWaitMs;
      if (
        Number.isInteger(waitMs) &&
        production.sessionAgeMs < waitMs
      ) {
        return {
          stage: "waiting-for-1400ms",
          reason: "deck1-metadata-wait",
          deck: 1,
          playSessionId: state.playSessionId,
          sessionAgeMs: production.sessionAgeMs,
          waitMs,
        };
      }
      return {
        stage: "not-selected",
        reason: "deck1-production-selection-unproven",
        deck: 1,
        playSessionId: state.playSessionId,
        sessionAgeMs: production.sessionAgeMs,
      };
    }
    const candidate = getCurrentProductionCandidate();
    if (!candidate) {
      return {
        stage: selected.deck === 1 ? "candidate-pending" : "not-selected",
        reason: selected.deck === 1
          ? "production-candidate-not-ready"
          : "deck1-not-selected",
        deck: selected.deck,
        playSessionId: state.playSessionId,
        sessionAgeMs: production.sessionAgeMs,
      };
    }
    return {
      stage: "candidate-ready",
      reason: null,
      deck: candidate.deck,
      playSessionId: candidate.playSessionId,
      sessionAgeMs: candidate.sessionAgeMs,
      candidateKind: candidate.kind,
    };
  }

  function getState() {
    const deckState = {};
    for (const [deck, state] of decks) {
      deckState[deck] = {
        track: state.track ? { ...state.track } : null,
        playback: state.playback ? { ...state.playback } : null,
        playSessionId: state.playSessionId,
        startedAt: state.startedAt,
        wireIdentity: state.wireIdentity ? { ...state.wireIdentity } : null,
        lastCandidateActiveSessionId: state.lastCandidateActiveSessionId,
        lastCandidateSyncPositionRevision: state.lastCandidateSyncPositionRevision,
        awaitingPlayConfirmation: state.awaitingPlayConfirmation,
        pendingTrackChange: state.pendingTrackChange,
        signatureProofGeneration: state.signatureProofGeneration,
        signatureProofConflictRevision: state.signatureProofConflictRevision,
        loop: state.loop ? { ...state.loop } : null,
        lastLoopEventRevision: state.lastLoopEventRevision,
      };
    }
    const masterDeck = currentMasterDeck();
    return {
      currentMasterDeck: masterDeck,
      masterDeckRevision: masterActivationGeneration,
      masterDeckSource: Number.isInteger(explicitMasterDeck) ? "explicit" : snapshotMasterSource,
      explicitMasterDeck,
      explicitMasterUpdatedAt,
      explicitMasterAuthorityRevision,
      decks: deckState,
    };
  }

  function reset() {
    cancelOwnerSelectionReevaluation();
    stopped = false;
    productionSnapshotGeneration += 1;
    decks.clear();
    explicitMasterDeck = null;
    explicitMasterUpdatedAt = null;
    explicitMasterAuthorityUpdatedAtMs = null;
    explicitMasterAuthorityRevision = 0;
    snapshotMasterDeck = null;
    snapshotMasterSource = "unknown";
    masterActivationGeneration = 0;
    knownMasterDeck = null;
  }

  function start() {
    cancelOwnerSelectionReevaluation();
    stopped = false;
    productionSnapshotGeneration += 1;
  }

  function stop() {
    stopped = true;
    cancelOwnerSelectionReevaluation();
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    getState,
    onMasterChange,
    onSnapshot,
    onSignatureIdentityProof,
    onTrackLoaded,
    requestMeasuredLoopForSession,
    requestCurrentTrackCandidates,
    getCurrentProductionCandidate,
    getProductionCandidateStatus,
    reset,
    start,
    stop,
  };
}

module.exports = {
  createTrackActivityDetector,
  normalizeDeckNumber,
  normalizePlayback,
  normalizeTrack,
  finiteNumber,
  tracksRepresentSame,
};
