const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");

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
    startBeat: Number.isFinite(startBeat) ? startBeat : null,
    endBeat: Number.isFinite(endBeat) ? endBeat : null,
    lengthBeats: Number.isFinite(lengthBeats) ? lengthBeats : null,
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
} = {}) {
  const emitter = new EventEmitter();
  const boundedMaxSampleAgeMs =
    Number.isFinite(maxSampleAgeMs) && maxSampleAgeMs >= 0 ? maxSampleAgeMs : 1_500;
  const decks = new Map();
  let explicitMasterDeck = null;
  let explicitMasterUpdatedAt = null;
  let explicitMasterAuthorityUpdatedAtMs = null;
  let explicitMasterAuthorityRevision = 0;
  let snapshotMasterDeck = null;
  let snapshotMasterSource = "unknown";
  let masterActivationGeneration = 0;
  let knownMasterDeck = null;

  function getDeckState(deck) {
    let state = decks.get(deck);
    if (!state) {
      state = {
        track: null,
        playback: null,
        previousIsPlaying: null,
        playSessionId: null,
        startedAt: null,
        lastActiveSessionId: null,
        lastActiveMasterGeneration: null,
        lastTrackLoadedKey: null,
        awaitingPlayConfirmation: false,
        pendingTrackChange: false,
        loop: null,
        lastSyncPositionRevision: null,
        lastLoopEventRevision: null,
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

  function strictTrackPayload(deck, state) {
    const track = state.track || {};
    const playback = state.playback || {};
    const observedMs = Date.parse(playback.positionObservedAt);
    const sampleAgeMs = Number.isFinite(observedMs) ? now() - observedMs : NaN;
    const effectiveBpm = Number.isFinite(playback.bpm) && playback.bpm > 0
      ? playback.bpm
      : Number.isFinite(track.trackBpm) && track.trackBpm > 0
        ? track.trackBpm
        : null;
    const exactTrackIdentity = track.contentId || (track.title && track.artist);
    if (
      !state.playSessionId ||
      !exactTrackIdentity ||
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
    return {
      deck,
      deckId: `rekordbox-deck-${deck}`,
      masterDeckRevision: masterActivationGeneration,
      contentId: track.contentId || null,
      title: track.title || null,
      artist: track.artist || null,
      trackBpm: Number.isFinite(track.trackBpm) ? track.trackBpm : null,
      positionAtSendSec: playback.positionSec,
      effectiveBpm,
      positionRevision: playback.positionRevision,
      sampleAgeMs,
      isPlaying: true,
      master: true,
      startedAt: state.startedAt || null,
      playSessionId: state.playSessionId || null,
      loop: currentLoopPayload(state.loop),
    };
  }

  function maybeEmitActive(deck, state, { force = false, allowAwaiting = false } = {}) {
    const master = currentMasterDeck();
    if (
      master !== deck ||
      explicitMasterDeck !== deck ||
      state.playback?.isPlaying !== true ||
      !state.track?.identity
    ) {
      return null;
    }
    if (state.awaitingPlayConfirmation && !allowAwaiting) {
      return null;
    }
    if (allowAwaiting) {
      state.awaitingPlayConfirmation = false;
    }
    if (!state.playSessionId) {
      state.playSessionId = idFactory();
      state.startedAt = state.startedAt || new Date(now()).toISOString();
    }
    if (
      !force &&
      state.lastActiveSessionId === state.playSessionId &&
      state.lastActiveMasterGeneration === masterActivationGeneration
    ) {
      return null;
    }
    const payload = strictTrackPayload(deck, state);
    if (!payload) {
      return null;
    }
    state.lastActiveSessionId = state.playSessionId;
    state.lastActiveMasterGeneration = masterActivationGeneration;
    state.lastSyncPositionRevision = payload.positionRevision;
    return emitEvent("DJ_MASTER_TRACK_ACTIVE", payload);
  }

  function maybeEmitSync(deck, state) {
    if (
      currentMasterDeck() !== deck ||
      explicitMasterDeck !== deck ||
      state.playback?.isPlaying !== true ||
      state.lastActiveSessionId !== state.playSessionId ||
      state.lastActiveMasterGeneration !== masterActivationGeneration
    ) {
      return null;
    }
    const payload = strictTrackPayload(deck, state);
    if (!payload || payload.positionRevision <= Number(state.lastSyncPositionRevision || 0)) {
      return null;
    }
    state.lastSyncPositionRevision = payload.positionRevision;
    return emitEvent("DJ_MASTER_TRACK_SYNC", payload);
  }

  function maybeEmitMeasuredLoop(deck, state) {
    const loop = currentLoopPayload(state.loop);
    if (
      !loop ||
      currentMasterDeck() !== deck ||
      explicitMasterDeck !== deck ||
      !state.playSessionId ||
      state.lastActiveSessionId !== state.playSessionId ||
      loop.revision <= Number(state.lastLoopEventRevision || 0)
    ) {
      return null;
    }
    state.lastLoopEventRevision = loop.revision;
    return emitEvent("DJ_LOOP_STATE", {
      deck,
      deckId: `rekordbox-deck-${deck}`,
      masterDeckRevision: masterActivationGeneration,
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

  function explicitMasterTimestampMs(value) {
    if (typeof value !== "string" || !value.trim()) {
      return null;
    }
    const timestampMs = Date.parse(value);
    return Number.isFinite(timestampMs) ? timestampMs : null;
  }

  function acceptExplicitMaster(deck, { updatedAt = null, requireNewerOnDeckChange = false } = {}) {
    const reportedAtMs = explicitMasterTimestampMs(updatedAt);
    const deckChanged = Number.isInteger(explicitMasterDeck) && explicitMasterDeck !== deck;
    if (
      deckChanged &&
      requireNewerOnDeckChange &&
      (!Number.isFinite(reportedAtMs) ||
        !Number.isFinite(explicitMasterAuthorityUpdatedAtMs) ||
        reportedAtMs <= explicitMasterAuthorityUpdatedAtMs)
    ) {
      return false;
    }

    if (!Number.isInteger(explicitMasterDeck) || explicitMasterDeck !== deck) {
      explicitMasterAuthorityRevision += 1;
    }
    explicitMasterDeck = deck;

    const acceptedAtMs = Number.isFinite(reportedAtMs)
      ? Math.max(reportedAtMs, explicitMasterAuthorityUpdatedAtMs || reportedAtMs)
      : Number.isFinite(explicitMasterAuthorityUpdatedAtMs)
        ? explicitMasterAuthorityUpdatedAtMs
        : now();
    explicitMasterAuthorityUpdatedAtMs = acceptedAtMs;
    explicitMasterUpdatedAt = new Date(acceptedAtMs).toISOString();

    if (knownMasterDeck !== deck) {
      knownMasterDeck = deck;
      masterActivationGeneration += 1;
    }
    return true;
  }

  function updateMasterFromSnapshot(snapshot = {}) {
    const explicit = normalizeDeckNumber(snapshot.explicitMasterDeck);
    if (explicit) {
      if (!acceptExplicitMaster(explicit, {
        updatedAt: snapshot.explicitMasterUpdatedAt,
        requireNewerOnDeckChange: true,
      })) {
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
    if (!updateMasterFromSnapshot(snapshot)) {
      return getState();
    }
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
      const nextPlayback = mergePlaybackSample(state.playback, reportedPlayback);
      const trackChanged =
        Boolean(nextTrack && previousTrack && !tracksRepresentSame(nextTrack, previousTrack)) ||
        state.pendingTrackChange;
      const firstTrack = Boolean(nextTrack && !previousTrack);
      const previousIsPlaying = state.playback?.isPlaying ?? state.previousIsPlaying;
      const nextIsPlaying = nextPlayback?.isPlaying ?? null;
      state.track = nextTrack;
      state.playback = nextPlayback;
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
        state.awaitingPlayConfirmation = false;
        state.lastActiveSessionId = null;
        state.lastActiveMasterGeneration = null;
        state.lastSyncPositionRevision = null;
        state.lastLoopEventRevision = null;
        emitEvent("DJ_TRACK_PLAY_STARTED", diagnosticTrackPayload(deck, state));
      } else if (stopped) {
        emitEvent("DJ_TRACK_PLAY_STOPPED", diagnosticTrackPayload(deck, state));
      }
      if ((trackChanged || firstTrack) && nextIsPlaying === true && !started) {
        // A deck can report the old playing state while a newly loaded track
        // is still only preloaded. Do not promote that stale true to a new
        // play session; wait for false/null -> true or explicit master change.
        state.playSessionId = null;
        state.startedAt = null;
        state.awaitingPlayConfirmation = true;
        state.lastActiveSessionId = null;
        state.lastActiveMasterGeneration = null;
        state.lastSyncPositionRevision = null;
        state.lastLoopEventRevision = null;
      } else if ((trackChanged || firstTrack) && !started) {
        state.playSessionId = null;
        state.startedAt = null;
        state.awaitingPlayConfirmation = false;
        state.lastActiveSessionId = null;
        state.lastActiveMasterGeneration = null;
        state.lastSyncPositionRevision = null;
        state.lastLoopEventRevision = null;
      }
      state.pendingTrackChange = false;
      state.previousIsPlaying = nextIsPlaying;
      const active = maybeEmitActive(deck, state);
      if (!active) maybeEmitSync(deck, state);
      maybeEmitMeasuredLoop(deck, state);
    }
    return getState();
  }

  function onTrackLoaded(rawEvent = {}) {
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
    state.track = mergedTrack;
    if (!changed && !firstTrack) {
      // A later contentId/metadata packet can enrich the same playing track.
      // Update the canonical loaded key without emitting another load event.
      state.lastTrackLoadedKey = state.track.identity;
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
    return loadedEvent;
  }

  function onMasterChange(rawEvent = {}) {
    const deck = normalizeDeckNumber(rawEvent.logicalDeck || rawEvent.deck);
    if (!deck) {
      return null;
    }
    acceptExplicitMaster(deck, {
      updatedAt: rawEvent.explicitMasterUpdatedAt || rawEvent.updatedAt,
    });
    const state = getDeckState(deck);
    const hadPendingTrackChange = state.pendingTrackChange;
    state.pendingTrackChange = false;
    state.awaitingPlayConfirmation = false;
    if (hadPendingTrackChange) {
      state.playSessionId = null;
      state.startedAt = null;
      state.lastActiveSessionId = null;
      state.lastActiveMasterGeneration = null;
      state.lastSyncPositionRevision = null;
      state.lastLoopEventRevision = null;
    }
    snapshotMasterSource = "explicit-master-change";
    return maybeEmitActive(deck, state, { allowAwaiting: true });
  }

  function requestCurrentMasterActive() {
    const deck = currentMasterDeck();
    if (!deck) {
      return null;
    }
    const state = getDeckState(deck);
    if (state.pendingTrackChange) {
      state.playSessionId = null;
      state.startedAt = null;
      state.lastActiveSessionId = null;
      state.lastActiveMasterGeneration = null;
      state.lastSyncPositionRevision = null;
      state.lastLoopEventRevision = null;
    }
    state.pendingTrackChange = false;
    return maybeEmitActive(deck, state, { allowAwaiting: true });
  }

  function getState() {
    const deckState = {};
    for (const [deck, state] of decks) {
      deckState[deck] = {
        track: state.track ? { ...state.track } : null,
        playback: state.playback ? { ...state.playback } : null,
        playSessionId: state.playSessionId,
        startedAt: state.startedAt,
        lastActiveSessionId: state.lastActiveSessionId,
        lastActiveMasterGeneration: state.lastActiveMasterGeneration,
        awaitingPlayConfirmation: state.awaitingPlayConfirmation,
        pendingTrackChange: state.pendingTrackChange,
        loop: state.loop ? { ...state.loop } : null,
        lastSyncPositionRevision: state.lastSyncPositionRevision,
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

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    getState,
    onMasterChange,
    onSnapshot,
    onTrackLoaded,
    requestCurrentMasterActive,
    reset,
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
