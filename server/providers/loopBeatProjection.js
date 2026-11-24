const REKORDBOX_BEAT_GRID = 64;
const MIN_BPM = 20;
const MAX_BPM = 400;
const MAX_BPM_SAMPLE_AGE_MS = 1_500;
const MAX_LENGTH_BEATS = 512;
const MAX_LOOP_TIME_MS = 24 * 60 * 60 * 1_000;
// Millisecond loop boundaries and two-decimal BPM samples can be quantized,
// but a value more than one quarter of a 1/64 step away is not evidence of
// the Rekordbox grid and must not be promoted to an exact beat boundary.
const GRID_TOLERANCE_BEATS = 1 / (REKORDBOX_BEAT_GRID * 4);

const EXPLICIT_BEAT_FIELD_NAMES = {
  startBeat: ["startBeat", "start_beat", "loopStartBeat", "loop_start_beat", "inBeat", "in_beat"],
  endBeat: ["endBeat", "end_beat", "loopEndBeat", "loop_end_beat", "outBeat", "out_beat"],
  lengthBeats: ["lengthBeats", "length_beats", "loopLengthBeats", "loop_length_beats", "beats"],
};

function finiteNumber(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) {
    return null;
  }
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteInteger(value) {
  const number = finiteNumber(value);
  return Number.isSafeInteger(number) ? number : null;
}

function explicitBeatFields(packet) {
  const fields = {};
  for (const [field, names] of Object.entries(EXPLICIT_BEAT_FIELD_NAMES)) {
    const values = names
      .filter((candidate) => Object.prototype.hasOwnProperty.call(packet, candidate))
      .map((name) => finiteNumber(packet[name]));
    if (values.length === 0) {
      continue;
    }
    if (
      values.some((value) => !Number.isFinite(value)) ||
      values.some((value) => !closeEnough(value, values[0]))
    ) {
      return null;
    }
    fields[field] = values[0];
  }
  return fields;
}

function quantizeBeat(value) {
  const units = Math.round(value * REKORDBOX_BEAT_GRID);
  if (!Number.isSafeInteger(units)) {
    return null;
  }
  return units / REKORDBOX_BEAT_GRID;
}

function closeEnough(actual, expected) {
  return Math.abs(actual - expected) <= GRID_TOLERANCE_BEATS;
}

/**
 * Project a measured Rekordbox loop range onto its documented 1/64-beat grid.
 * No playhead, active-state, or track BPM fallback is used: the caller must
 * provide a fresh positive realtime BPM measured on the same deck.
 */
function projectMeasuredLoopBeats({ packet, loop, bpm, bpmObservedAt, now = Date.now() } = {}) {
  if (!packet || typeof packet !== "object" || !loop || typeof loop !== "object") {
    return null;
  }
  const startMs = finiteInteger(loop.startMs);
  const endMs = finiteInteger(loop.endMs);
  const measuredBpm = finiteNumber(bpm);
  const observedAt = finiteNumber(bpmObservedAt);
  const nowMs = finiteNumber(now);
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs) ||
    startMs < 0 ||
    endMs <= startMs ||
    startMs > MAX_LOOP_TIME_MS ||
    endMs > MAX_LOOP_TIME_MS ||
    !Number.isFinite(measuredBpm) ||
    measuredBpm < MIN_BPM ||
    measuredBpm > MAX_BPM ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(nowMs) ||
    nowMs < observedAt ||
    nowMs - observedAt > MAX_BPM_SAMPLE_AGE_MS
  ) {
    return null;
  }

  const rawStartBeat = (startMs * measuredBpm) / 60_000;
  const rawEndBeat = (endMs * measuredBpm) / 60_000;
  const rawLengthBeats = ((endMs - startMs) * measuredBpm) / 60_000;
  if (
    !Number.isFinite(rawStartBeat) ||
    !Number.isFinite(rawEndBeat) ||
    !Number.isFinite(rawLengthBeats) ||
    rawStartBeat < 0 ||
    rawEndBeat <= rawStartBeat ||
    rawLengthBeats <= 0
  ) {
    return null;
  }

  // The Hook gives us absolute millisecond boundaries but not the track's
  // beat-zero offset.  Consequently the absolute start/end values can be
  // between grid lines even when the measured *duration* is an exact loop.
  // Project the duration independently; expose absolute beat boundaries only
  // when both measurements are themselves on the documented grid.  This
  // prevents an unavailable absolute origin from turning a valid 2-beat loop
  // into a stale or invented range.
  const projectedLengthBeats = quantizeBeat(rawLengthBeats);
  if (!Number.isFinite(projectedLengthBeats) || projectedLengthBeats <= 0) {
    return null;
  }
  if (
    !closeEnough(rawLengthBeats, projectedLengthBeats) ||
    projectedLengthBeats < 1 / REKORDBOX_BEAT_GRID ||
    projectedLengthBeats > MAX_LENGTH_BEATS ||
    !Number.isSafeInteger(Math.round(projectedLengthBeats * REKORDBOX_BEAT_GRID))
  ) {
    return null;
  }

  const quantizedStartBeat = quantizeBeat(rawStartBeat);
  const quantizedEndBeat = quantizeBeat(rawEndBeat);
  const absoluteBoundariesAvailable =
    Number.isFinite(quantizedStartBeat) &&
    Number.isFinite(quantizedEndBeat) &&
    quantizedEndBeat > quantizedStartBeat &&
    closeEnough(rawStartBeat, quantizedStartBeat) &&
    closeEnough(rawEndBeat, quantizedEndBeat) &&
    closeEnough(quantizedEndBeat - quantizedStartBeat, projectedLengthBeats);
  const startBeat = absoluteBoundariesAvailable ? quantizedStartBeat : null;
  const endBeat = absoluteBoundariesAvailable ? quantizedEndBeat : null;
  const lengthBeats = projectedLengthBeats;

  const explicit = explicitBeatFields(packet);
  if (!explicit) {
    return null;
  }
  if (
    (Number.isFinite(explicit.startBeat) &&
      (!Number.isFinite(startBeat) || !closeEnough(explicit.startBeat, startBeat) || explicit.startBeat < 0)) ||
    (Number.isFinite(explicit.endBeat) &&
      (!Number.isFinite(endBeat) || !closeEnough(explicit.endBeat, endBeat) || explicit.endBeat <= startBeat)) ||
    (Number.isFinite(explicit.lengthBeats) &&
      (!closeEnough(explicit.lengthBeats, lengthBeats) || explicit.lengthBeats <= 0)) ||
    (Number.isFinite(explicit.startBeat) && Number.isFinite(explicit.endBeat) && explicit.endBeat <= explicit.startBeat) ||
    (Number.isFinite(explicit.startBeat) && Number.isFinite(explicit.endBeat) && Number.isFinite(explicit.lengthBeats) &&
      !closeEnough(explicit.endBeat - explicit.startBeat, explicit.lengthBeats))
  ) {
    return null;
  }

  return { startBeat, endBeat, lengthBeats };
}

module.exports = {
  REKORDBOX_BEAT_GRID,
  MIN_BPM,
  MAX_BPM,
  MAX_BPM_SAMPLE_AGE_MS,
  MAX_LENGTH_BEATS,
  MAX_LOOP_TIME_MS,
  GRID_TOLERANCE_BEATS,
  projectMeasuredLoopBeats,
};
