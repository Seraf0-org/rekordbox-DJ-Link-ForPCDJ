const LOOP_FIELDS = [
  "deck",
  "trackIdentity",
  "active",
  "activeKnown",
  "activeSource",
  "startMs",
  "endMs",
  "startBeat",
  "endBeat",
  "lengthBeats",
  "revision",
  "updatedAt",
  "source",
];

// Packet presence is intentionally kept out of the JSON contract.  A native
// loop update may contain only one boundary, so mergeLoopState needs to know
// whether a null means "not sent" or "explicitly cleared" without publishing
// another compatibility field to clients.
const LOOP_UPDATE_META = Symbol("loopStateUpdateMeta");

function defineLoopUpdateMeta(target, meta = {}) {
  if (!target || typeof target !== "object") {
    return target;
  }
  Object.defineProperty(target, LOOP_UPDATE_META, {
    value: Object.freeze({ ...meta }),
    enumerable: false,
    configurable: true,
  });
  return target;
}

function loopUpdateMeta(value) {
  return value && typeof value === "object" && value[LOOP_UPDATE_META]
    ? value[LOOP_UPDATE_META]
    : null;
}

function finiteOrNull(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    return null;
  }
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstValue(payload, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(payload, name) && payload[name] != null) {
      return payload[name];
    }
  }
  return null;
}

function firstBoolean(payload, names) {
  for (const name of names) {
    if (!Object.prototype.hasOwnProperty.call(payload, name)) {
      continue;
    }
    const value = payload[name];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value !== 0;
    }
    if (typeof value === "string") {
      if (/^(true|yes|on|active|playing)$/i.test(value.trim())) return true;
      if (/^(false|no|off|inactive|stopped)$/i.test(value.trim())) return false;
    }
  }
  return null;
}

function firstIdentity(payload) {
  for (const name of [
    "trackIdentity",
    "track_identity",
    "trackId",
    "track_id",
    "contentId",
    "content_id",
    "trackBrowserId",
    "track_browser_id",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(payload, name) || payload[name] == null) {
      continue;
    }
    const value = String(payload[name]).trim();
    if (value) {
      return value;
    }
  }
  return null;
}

/**
 * Normalize a native hook loop_state packet to the public API contract.
 * Deck numbers are one-based. Missing optional values are represented as null.
 */
function normalizeLoopState(payload, { maxDeck = 4, source = "rekordbox-hook" } = {}) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const deck = finiteOrNull(firstValue(payload, ["deck", "deckNumber", "player"]));
  if (!Number.isInteger(deck) || deck < 1 || deck > maxDeck) {
    return null;
  }

  const hasStartMs = ["startMs", "start_ms", "loopStartMs", "loop_start_ms", "inMs", "in_ms"]
    .some((name) => Object.prototype.hasOwnProperty.call(payload, name));
  const hasEndMs = ["endMs", "end_ms", "loopEndMs", "loop_end_ms", "outMs", "out_ms"]
    .some((name) => Object.prototype.hasOwnProperty.call(payload, name));
  const hasStartBeat = ["startBeat", "start_beat", "loopStartBeat", "loop_start_beat", "inBeat", "in_beat"]
    .some((name) => Object.prototype.hasOwnProperty.call(payload, name));
  const hasEndBeat = ["endBeat", "end_beat", "loopEndBeat", "loop_end_beat", "outBeat", "out_beat"]
    .some((name) => Object.prototype.hasOwnProperty.call(payload, name));
  const hasLengthBeats = ["lengthBeats", "length_beats", "loopLengthBeats", "loop_length_beats", "beats"]
    .some((name) => Object.prototype.hasOwnProperty.call(payload, name));

  let startMs = finiteOrNull(
    firstValue(payload, ["startMs", "start_ms", "loopStartMs", "loop_start_ms", "inMs", "in_ms"]),
  );
  let endMs = finiteOrNull(
    firstValue(payload, ["endMs", "end_ms", "loopEndMs", "loop_end_ms", "outMs", "out_ms"]),
  );
  let startBeat = finiteOrNull(
    firstValue(payload, ["startBeat", "start_beat", "loopStartBeat", "loop_start_beat", "inBeat", "in_beat"]),
  );
  let endBeat = finiteOrNull(
    firstValue(payload, ["endBeat", "end_beat", "loopEndBeat", "loop_end_beat", "outBeat", "out_beat"]),
  );
  let lengthBeats = finiteOrNull(
    firstValue(payload, ["lengthBeats", "length_beats", "loopLengthBeats", "loop_length_beats", "beats"]),
  );
  const revision = finiteOrNull(
    firstValue(payload, ["revision", "loopRevision", "loop_revision"]),
  );

  const loopReset = firstBoolean(payload, ["loopReset", "loop_reset", "reset", "clear"]) === true;
  const trackIdentity = firstIdentity(payload);

  // Rekordbox clears an unset loop by publishing 0 for both time boundaries.
  // Treat any complete, non-positive range as absent so the Web UI does not
  // display a misleading `SET · 0.00→0.00s` state after loop-out.
  const boundariesCleared =
    loopReset ||
    (hasStartMs && hasEndMs && Number.isFinite(startMs) && Number.isFinite(endMs) && endMs <= startMs);
  if (boundariesCleared) {
    startMs = null;
    endMs = null;
    startBeat = null;
    endBeat = null;
    lengthBeats = null;
  }
  if (Number.isFinite(startBeat) && Number.isFinite(endBeat) && endBeat <= startBeat) {
    startBeat = null;
    endBeat = null;
  }

  if (Number.isFinite(startBeat) && Number.isFinite(endBeat) && !Number.isFinite(lengthBeats)) {
    lengthBeats = endBeat - startBeat;
  }
  if (Number.isFinite(startBeat) && Number.isFinite(lengthBeats) && !Number.isFinite(endBeat)) {
    endBeat = startBeat + lengthBeats;
  }
  if (Number.isFinite(lengthBeats) && lengthBeats < 0) {
    lengthBeats = Math.abs(lengthBeats);
  }

  const activeNames = ["active", "isActive", "loopActive", "loop_active"];
  const active = firstBoolean(payload, activeNames);
  const activeKnownValue = firstBoolean(payload, ["activeKnown", "active_known"]);
  const hasActiveField = activeNames.some((name) => Object.prototype.hasOwnProperty.call(payload, name));
  const activeKnown = activeKnownValue == null
    ? hasActiveField
      ? active != null
      : null
    : activeKnownValue;
  const updatedAt =
    typeof payload.updatedAt === "string" && payload.updatedAt.trim()
      ? payload.updatedAt
      : new Date().toISOString();

  const normalized = {
    deck,
    trackIdentity,
    active: activeKnown === false ? null : active,
    activeKnown,
    activeSource:
      typeof payload.activeSource === "string" && payload.activeSource.trim()
        ? payload.activeSource
        : null,
    startMs,
    endMs,
    startBeat,
    endBeat,
    lengthBeats,
    revision: Number.isSafeInteger(revision) && revision >= 1 ? revision : null,
    updatedAt,
    source: typeof payload.source === "string" && payload.source.trim() ? payload.source : source,
  };
  defineLoopUpdateMeta(normalized, {
    hasStartMs,
    hasEndMs,
    hasStartBeat,
    hasEndBeat,
    hasLengthBeats,
    boundariesCleared,
    loopReset,
  });
  return normalized;
}

/**
 * Merge a partial loop update into a deck's last known state.
 * Native implementations commonly send only active:false when a loop ends;
 * retaining the last boundaries makes the transition observable to clients.
 */
function mergeLoopState(previous, next) {
  if (!next || typeof next !== "object") {
    return previous || null;
  }
  const previousIdentity = previous?.trackIdentity == null ? null : String(previous.trackIdentity);
  const nextIdentity = next?.trackIdentity == null ? null : String(next.trackIdentity);
  const sameTrackIdentity =
    previousIdentity !== null && nextIdentity !== null && previousIdentity === nextIdentity;
  const identityChanged =
    Boolean(previous) && nextIdentity !== null && (previousIdentity === null || previousIdentity !== nextIdentity);
  const meta = loopUpdateMeta(next);
  const hasStartMs = meta?.hasStartMs ?? Number.isFinite(next.startMs);
  const hasEndMs = meta?.hasEndMs ?? Number.isFinite(next.endMs);
  const hasStartBeat = meta?.hasStartBeat ?? Number.isFinite(next.startBeat);
  const hasEndBeat = meta?.hasEndBeat ?? Number.isFinite(next.endBeat);
  const hasLengthBeats = meta?.hasLengthBeats ?? Number.isFinite(next.lengthBeats);
  const boundaryPatch = hasStartMs || hasEndMs;
  const boundaryChanged =
    boundaryPatch &&
    (identityChanged ||
      (hasStartMs && Number(next.startMs) !== Number(previous?.startMs)) ||
      (hasEndMs && Number(next.endMs) !== Number(previous?.endMs)) ||
      (!previous || !Number.isFinite(previous?.startMs) || !Number.isFinite(previous?.endMs)));
  const resetBoundaries = meta?.boundariesCleared === true || meta?.loopReset === true;
  const coherentBeatTuple =
    Number.isFinite(next.startBeat) &&
    Number.isFinite(next.endBeat) &&
    Number.isFinite(next.lengthBeats) &&
    next.startBeat >= 0 &&
    next.endBeat > next.startBeat &&
    next.lengthBeats > 0 &&
    Math.abs(next.endBeat - next.startBeat - next.lengthBeats) <= 1 / 64;
  const coherentMeasuredLengthOnly =
    meta?.beatProjection === true &&
    !Number.isFinite(next.startBeat) &&
    !Number.isFinite(next.endBeat) &&
    Number.isFinite(next.lengthBeats) &&
    next.lengthBeats > 0 &&
    Number.isFinite(next.startMs) &&
    Number.isFinite(next.endMs) &&
    next.endMs > next.startMs;
  const beatPatch = hasStartBeat || hasEndBeat || hasLengthBeats;
  const invalidBeatPatch = beatPatch && !coherentBeatTuple && !coherentMeasuredLengthOnly;
  const resetBeatTuple = identityChanged || resetBoundaries || boundaryChanged || invalidBeatPatch;

  const merged = identityChanged
    ? {
        deck: next.deck,
        trackIdentity: nextIdentity,
        active: null,
        activeKnown: null,
        activeSource: null,
        startMs: null,
        endMs: null,
        startBeat: null,
        endBeat: null,
        lengthBeats: null,
        revision: null,
        updatedAt: null,
        source: null,
      }
    : previous
      ? { ...previous }
      : {
          deck: next.deck,
          trackIdentity: null,
          active: null,
          activeKnown: null,
          activeSource: null,
          startMs: null,
          endMs: null,
          startBeat: null,
          endBeat: null,
          lengthBeats: null,
          revision: null,
          updatedAt: null,
          source: null,
      };
  for (const field of LOOP_FIELDS) {
    if (field === "deck" || field === "updatedAt" || field === "source" || field === "trackIdentity") {
      if (next[field] != null) merged[field] = next[field];
      continue;
    }

    if (resetBoundaries && (field === "active" || field === "activeKnown" || field === "activeSource")) {
      merged[field] = field === "activeKnown" ? false : null;
      continue;
    }
    if (resetBoundaries && (field === "startMs" || field === "endMs")) {
      merged[field] = null;
      continue;
    }
    if (boundaryChanged && !identityChanged && (field === "startMs" || field === "endMs")) {
      // Do not combine a newly observed one-sided boundary with the previous
      // side. The next complete packet can establish the range again.
      merged[field] = field === "startMs" ? (hasStartMs ? next.startMs : null) : (hasEndMs ? next.endMs : null);
      continue;
    }
    if (resetBeatTuple && ["startBeat", "endBeat", "lengthBeats"].includes(field)) {
      // A length-only projection is still safe to display, but absolute beat
      // endpoints are unavailable when the track beat-zero offset is unknown.
      if (boundaryChanged && !identityChanged && !resetBoundaries && field === "lengthBeats" && hasLengthBeats && Number.isFinite(next.lengthBeats)) {
        merged[field] = next[field];
      } else if (!boundaryChanged || !coherentBeatTuple || !(hasStartBeat && hasEndBeat && hasLengthBeats)) {
        merged[field] = null;
      } else {
        merged[field] = next[field];
      }
      continue;
    }
    if (field === "active" && next.activeKnown === false) {
      // A same-track boundary packet with unknown activity is partial, not a
      // command to turn a known active loop into SET.  Native loop-off emits a
      // complete activeKnown=true/active=false packet, and track replacement
      // uses the explicit reset/identity path above.
      if (sameTrackIdentity && previous?.active === true && !resetBoundaries) {
        merged.active = true;
      } else {
        merged.active = null;
      }
    } else if (field === "activeKnown" && next.activeKnown === false && previous?.active === true && !resetBoundaries && sameTrackIdentity) {
      merged.activeKnown = true;
    } else if (field === "activeSource" && next.activeKnown === false && previous?.active === true && !resetBoundaries && sameTrackIdentity) {
      // Retain the source of the authoritative ACTIVE edge.
      continue;
    } else if (next[field] != null || (field === "active" && next[field] !== null)) {
      merged[field] = next[field];
    } else if (!Object.prototype.hasOwnProperty.call(merged, field)) {
      merged[field] = null;
    }
  }
  if (identityChanged) {
    merged.active = next.activeKnown === true ? next.active : null;
    merged.activeKnown = next.activeKnown;
    merged.activeSource = next.activeSource;
    merged.startMs = next.startMs;
    merged.endMs = next.endMs;
    merged.startBeat = null;
    merged.endBeat = null;
    merged.lengthBeats = null;
    merged.revision = next.revision;
    merged.updatedAt = next.updatedAt;
    merged.source = next.source;
  }
  if (previous?.active === true && !sameTrackIdentity && next.active == null) {
    // An activity-less partial packet without an exact identity cannot be
    // proven to describe the same track. Do not carry an old ACTIVE state
    // across that ambiguity; only exact non-empty identity may preserve it.
    merged.active = null;
    merged.activeKnown = next.activeKnown;
    merged.activeSource = next.activeSource;
  }
  // Keep packet-presence/projection metadata on the internal merged value.
  // The provider emits this object both directly and through a later full
  // snapshot; dropping the non-enumerable marker makes that second merge
  // treat a measured length-only projection as an invalid beat patch.
  if (meta) {
    defineLoopUpdateMeta(merged, meta);
  }
  return merged;
}

function upsertLoopState(states, incoming) {
  const list = Array.isArray(states) ? states : [];
  if (!incoming || !Number.isInteger(Number(incoming.deck))) {
    return list;
  }
  const deck = Number(incoming.deck);
  const index = list.findIndex((item) => Number(item?.deck) === deck);
  const merged = mergeLoopState(index >= 0 ? list[index] : null, incoming);
  const next = list.slice();
  if (index >= 0) next[index] = merged;
  else next.push(merged);
  next.sort((a, b) => Number(a.deck) - Number(b.deck));
  return next;
}

module.exports = {
  LOOP_FIELDS,
  LOOP_UPDATE_META,
  defineLoopUpdateMeta,
  loopUpdateMeta,
  normalizeLoopState,
  mergeLoopState,
  upsertLoopState,
};
