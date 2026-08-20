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

function tracksRepresentSame(left, right) {
  if (!left || !right) {
    return false;
  }
  if (left.contentId && right.contentId) {
    return left.contentId === right.contentId;
  }
  const leftText = normalizedTrackText(left);
  const rightText = normalizedTrackText(right);
  return Boolean(leftText && leftText === rightText);
}

function mergeTrackIdentity(previous, reported) {
  if (!reported) {
    return previous || null;
  }
  if (
    previous &&
    !previous.contentId &&
    reported.contentId &&
    !reported.title &&
    !reported.artist
  ) {
    // Hook track_load is often emitted between title/artist metadata and the
    // following snapshot. Treat its contentId-only packet as enrichment until
    // the snapshot can prove a real title/artist transition.
    return normalizeTrack({ ...previous, contentId: reported.contentId });
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
    updatedAt: entry.updatedAt || null,
  };
}

function createTrackActivityDetector({
  now = () => Date.now(),
  idFactory = defaultIdFactory,
  maxDeck = 4,
} = {}) {
  const emitter = new EventEmitter();
  const decks = new Map();
  let explicitMasterDeck = null;
  let explicitMasterUpdatedAt = null;
  let snapshotMasterDeck = null;
  let snapshotMasterSource = "unknown";
  let lastMasterChangedEventDeck = null;
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

  function trackPayload(deck, state) {
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

  function maybeEmitActive(deck, state, { force = false, allowAwaiting = false } = {}) {
    const master = currentMasterDeck();
    if (master !== deck || state.playback?.isPlaying !== true || !state.track?.identity) {
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
    state.lastActiveSessionId = state.playSessionId;
    state.lastActiveMasterGeneration = masterActivationGeneration;
    return emitEvent("DJ_MASTER_TRACK_ACTIVE", trackPayload(deck, state));
  }

  function setSnapshotMaster(deck, source) {
    if (!Number.isInteger(deck)) {
      return;
    }
    if (knownMasterDeck !== deck) {
      knownMasterDeck = deck;
      masterActivationGeneration += 1;
    }
    snapshotMasterDeck = deck;
    snapshotMasterSource = source;
  }

  function updateMasterFromSnapshot(snapshot = {}) {
    const explicit = normalizeDeckNumber(snapshot.explicitMasterDeck);
    if (explicit) {
      explicitMasterDeck = explicit;
      explicitMasterUpdatedAt = snapshot.explicitMasterUpdatedAt || explicitMasterUpdatedAt || new Date(now()).toISOString();
      snapshotMasterSource = "explicit-state";
      if (knownMasterDeck !== explicit) {
        knownMasterDeck = explicit;
        masterActivationGeneration += 1;
      }
      return;
    }
    const reported = normalizeDeckNumber(snapshot.masterDeck);
    if (reported) {
      const source = String(snapshot.masterDeckSource || "").trim().toLowerCase();
      if (source === "playback-fallback" && !shouldAcceptFallbackMaster(snapshot, reported)) {
        return;
      }
      setSnapshotMaster(reported, snapshot.masterDeckSource || "snapshot");
      return;
    }
    const playbackDeck = normalizeDeckNumber(snapshot.playback?.deck);
    if (playbackDeck) {
      setSnapshotMaster(playbackDeck, "playback-fallback");
    }
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
    updateMasterFromSnapshot(snapshot);
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
      const nextPlayback = playbacks.get(deck) || state.playback;
      const trackChanged =
        Boolean(nextTrack && previousTrack && !tracksRepresentSame(nextTrack, previousTrack)) ||
        state.pendingTrackChange;
      const firstTrack = Boolean(nextTrack && !previousTrack);
      const previousIsPlaying = state.playback?.isPlaying ?? state.previousIsPlaying;
      const nextIsPlaying = nextPlayback?.isPlaying ?? null;
      state.track = nextTrack;
      state.playback = nextPlayback;

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
        emitEvent("DJ_TRACK_PLAY_STARTED", trackPayload(deck, state));
      } else if (stopped) {
        emitEvent("DJ_TRACK_PLAY_STOPPED", trackPayload(deck, state));
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
      } else if ((trackChanged || firstTrack) && !started) {
        state.playSessionId = null;
        state.startedAt = null;
        state.awaitingPlayConfirmation = false;
        state.lastActiveSessionId = null;
        state.lastActiveMasterGeneration = null;
      }
      state.pendingTrackChange = false;
      state.previousIsPlaying = nextIsPlaying;
      maybeEmitActive(deck, state);
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
    if (knownMasterDeck !== deck) {
      knownMasterDeck = deck;
      masterActivationGeneration += 1;
    }
    explicitMasterDeck = deck;
    const state = getDeckState(deck);
    const hadPendingTrackChange = state.pendingTrackChange;
    state.pendingTrackChange = false;
    state.awaitingPlayConfirmation = false;
    if (hadPendingTrackChange) {
      state.playSessionId = null;
      state.startedAt = null;
      state.lastActiveSessionId = null;
      state.lastActiveMasterGeneration = null;
    }
    explicitMasterUpdatedAt = rawEvent.updatedAt || new Date(now()).toISOString();
    snapshotMasterSource = "explicit-master-change";
    const changed = lastMasterChangedEventDeck !== deck;
    lastMasterChangedEventDeck = deck;
    const masterEvent = changed
      ? emitEvent("DJ_MASTER_CHANGED", {
          deck,
          source: "explicit-master-change",
          updatedAt: explicitMasterUpdatedAt,
        })
      : null;
    const activeEvent = maybeEmitActive(deck, state, { allowAwaiting: true });
    return activeEvent || masterEvent;
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
    }
    state.pendingTrackChange = false;
    return maybeEmitActive(deck, state, { force: true, allowAwaiting: true });
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
      };
    }
    const masterDeck = currentMasterDeck();
    return {
      currentMasterDeck: masterDeck,
      masterDeckSource: Number.isInteger(explicitMasterDeck) ? "explicit" : snapshotMasterSource,
      explicitMasterDeck,
      explicitMasterUpdatedAt,
      decks: deckState,
    };
  }

  function reset() {
    decks.clear();
    explicitMasterDeck = null;
    explicitMasterUpdatedAt = null;
    snapshotMasterDeck = null;
    snapshotMasterSource = "unknown";
    lastMasterChangedEventDeck = null;
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
