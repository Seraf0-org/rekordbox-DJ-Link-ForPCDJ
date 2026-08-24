const LOOP_FIELDS = [
  "deck",
  "active",
  "activeKnown",
  "activeSource",
  "startMs",
  "endMs",
  "startBeat",
  "endBeat",
  "lengthBeats",
  "updatedAt",
  "source",
];

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

  // Rekordbox clears an unset loop by publishing 0 for both time boundaries.
  // Treat any complete, non-positive range as absent so the Web UI does not
  // display a misleading `SET · 0.00→0.00s` state after loop-out.
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs <= startMs) {
    startMs = null;
    endMs = null;
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

  return {
    deck,
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
    updatedAt,
    source: typeof payload.source === "string" && payload.source.trim() ? payload.source : source,
  };
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
  const merged = { ...(previous || {}) };
  for (const field of LOOP_FIELDS) {
    if (field === "deck" || field === "updatedAt" || field === "source") {
      if (next[field] != null) merged[field] = next[field];
      continue;
    }
    if (field === "active" && next.activeKnown === false) {
      merged.active = null;
    } else if (next[field] != null || (field === "active" && next[field] !== null)) {
      merged[field] = next[field];
    } else if (!Object.prototype.hasOwnProperty.call(merged, field)) {
      merged[field] = null;
    }
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
  normalizeLoopState,
  mergeLoopState,
  upsertLoopState,
};
