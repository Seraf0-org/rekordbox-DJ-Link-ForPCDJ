"use strict";

// Stage 1 is intentionally conservative: MIDI is an intent transport, while
// the Rekordbox hook remains the only source of measured loop truth.  This
// helper owns only the bounded gap between those two signals.  It never
// manufactures a measured loop and it never changes the active Rekordbox
// loop state.

const STAGE1_LOOP_LENGTH_PROFILE = Object.freeze([
  8,
  4,
  2,
  1,
  1 / 2,
  1 / 4,
  1 / 8,
  1 / 16,
  1 / 32,
  1 / 64,
]);

const FALLBACK_SOURCE = "pedal-no-response-predicted";
const MEASURED_SOURCE = "rekordbox-hook-measured";
const DEFAULT_RESPONSE_WINDOW_MS = 500;
const MIN_RESPONSE_WINDOW_MS = 50;
const MAX_RESPONSE_WINDOW_MS = 1_500;
const MAX_MEASURED_SAMPLE_AGE_MS = 1_500;
const LOOP_SPAN_TOLERANCE_BEATS = 0.001;
const MAX_LOOP_DIVISION = STAGE1_LOOP_LENGTH_PROFILE.length - 1;

const DEFAULT_TIMER_API = Object.freeze({
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    clearTimeout(handle);
  },
});

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function strictInteger(value, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function boundedResponseWindowMs(value) {
  const parsed = strictInteger(value, {
    min: MIN_RESPONSE_WINDOW_MS,
    max: MAX_RESPONSE_WINDOW_MS,
  });
  return parsed == null ? null : parsed;
}

function isProfileLength(value) {
  return typeof value === "number" && Number.isFinite(value) && STAGE1_LOOP_LENGTH_PROFILE.includes(value);
}

function exactFallbackPayload(payload) {
  const fields = [
    "deck",
    "deckId",
    "masterDeckRevision",
    "playSessionId",
    "pedalIntentId",
    "baseMeasuredLoopRevision",
    "baseLoopDivision",
    "targetLengthBeats",
    "responseWindowMs",
    "source",
  ];
  if (!isPlainRecord(payload)) return null;
  const keys = Reflect.ownKeys(payload);
  if (
    keys.length !== fields.length ||
    !keys.every((key) => typeof key === "string" && fields.includes(key)) ||
    !fields.every((field) => Object.hasOwn(payload, field))
  ) {
    return null;
  }
  const deck = strictInteger(payload.deck, { min: 1, max: 4 });
  const masterDeckRevision = strictInteger(payload.masterDeckRevision, { min: 1 });
  const pedalIntentId = strictInteger(payload.pedalIntentId, { min: 1 });
  const baseMeasuredLoopRevision = payload.baseMeasuredLoopRevision === null
    ? null
    : strictInteger(payload.baseMeasuredLoopRevision, { min: 1 });
  const baseLoopDivision = payload.baseLoopDivision === null
    ? null
    : strictInteger(payload.baseLoopDivision, { min: 0, max: MAX_LOOP_DIVISION });
  const responseWindowMs = boundedResponseWindowMs(payload.responseWindowMs);
  const expectedTargetLengthBeats = STAGE1_LOOP_LENGTH_PROFILE[
    baseLoopDivision == null ? 0 : Math.min(baseLoopDivision + 1, MAX_LOOP_DIVISION)
  ];
  if (
    deck == null ||
    payload.deckId !== `rekordbox-deck-${deck}` ||
    masterDeckRevision == null ||
    pedalIntentId == null ||
    (payload.baseMeasuredLoopRevision !== null && baseMeasuredLoopRevision == null) ||
    (payload.baseLoopDivision !== null && baseLoopDivision == null) ||
    !isIdentity(payload.playSessionId) ||
    !isProfileLength(payload.targetLengthBeats) ||
    payload.targetLengthBeats !== expectedTargetLengthBeats ||
    responseWindowMs == null ||
    payload.source !== FALLBACK_SOURCE
  ) {
    return null;
  }
  return {
    deck,
    deckId: payload.deckId,
    masterDeckRevision,
    playSessionId: payload.playSessionId,
    pedalIntentId,
    baseMeasuredLoopRevision,
    baseLoopDivision,
    targetLengthBeats: payload.targetLengthBeats,
    responseWindowMs,
    source: FALLBACK_SOURCE,
  };
}

function strictIntent(intent, responseWindowMs) {
  if (!isPlainRecord(intent)) return null;
  const deck = strictInteger(intent.deck, { min: 1, max: 4 });
  const masterDeckRevision = strictInteger(intent.masterDeckRevision, { min: 1 });
  if (
    deck == null ||
    intent.deckId !== `rekordbox-deck-${deck}` ||
    masterDeckRevision == null ||
    !isIdentity(intent.playSessionId)
  ) {
    return null;
  }
  return {
    deck,
    deckId: intent.deckId,
    masterDeckRevision,
    playSessionId: intent.playSessionId,
    responseWindowMs,
  };
}

function loopResponseLineage(event) {
  if (!isPlainRecord(event) || event.type !== "DJ_LOOP_STATE" || !isPlainRecord(event.payload)) {
    return null;
  }
  const payload = event.payload;
  const deck = strictInteger(payload.deck, { min: 1, max: 4 });
  const masterDeckRevision = strictInteger(payload.masterDeckRevision, { min: 1 });
  if (
    deck == null ||
    payload.deckId !== "rekordbox-deck-" + deck ||
    masterDeckRevision == null ||
    !isIdentity(payload.playSessionId)
  ) {
    return null;
  }
  return {
    deck,
    deckId: payload.deckId,
    masterDeckRevision,
    playSessionId: payload.playSessionId,
  };
}

function measuredLoop(event) {
  if (!isPlainRecord(event) || event.type !== "DJ_LOOP_STATE" || !isPlainRecord(event.payload)) return null;
  const payload = event.payload;
  const deck = strictInteger(payload.deck, { min: 1, max: 4 });
  const masterDeckRevision = strictInteger(payload.masterDeckRevision, { min: 1 });
  const revision = strictInteger(payload.revision, { min: 1 });
  const sampleAgeMs = strictInteger(payload.sampleAgeMs, {
    min: 0,
    max: MAX_MEASURED_SAMPLE_AGE_MS,
  });
  if (
    deck == null ||
    payload.deckId !== `rekordbox-deck-${deck}` ||
    masterDeckRevision == null ||
    !isIdentity(payload.playSessionId) ||
    revision == null ||
    sampleAgeMs == null ||
    payload.source !== MEASURED_SOURCE ||
    typeof payload.active !== "boolean"
  ) {
    return null;
  }
  const startBeat = payload.startBeat;
  const endBeat = payload.endBeat;
  const lengthBeats = payload.lengthBeats;
  if (payload.active === true) {
    if (
      typeof startBeat !== "number" ||
      !Number.isFinite(startBeat) ||
      startBeat < 0 ||
      typeof endBeat !== "number" ||
      !Number.isFinite(endBeat) ||
      endBeat <= startBeat ||
      typeof lengthBeats !== "number" ||
      !Number.isFinite(lengthBeats) ||
      lengthBeats <= 0 ||
      Math.abs((endBeat - startBeat) - lengthBeats) > LOOP_SPAN_TOLERANCE_BEATS
    ) {
      return null;
    }
  } else if (startBeat !== null || endBeat !== null || lengthBeats !== null) {
    // An explicit loop-off is measured authority too, but only in the exact
    // inactive shape accepted by the v3 peer.
    return null;
  }
  return {
    deck,
    deckId: payload.deckId,
    masterDeckRevision,
    playSessionId: payload.playSessionId,
    revision,
    sampleAgeMs,
    active: payload.active,
    lengthBeats,
  };
}

function lineageKey(value) {
  return `${value.deck}|${value.deckId}|${value.masterDeckRevision}|${value.playSessionId}`;
}

function sameLineage(left, right) {
  return lineageKey(left) === lineageKey(right);
}

function resolveTimerApi(timerApi) {
  if (timerApi == null) return DEFAULT_TIMER_API;
  if (
    (typeof timerApi !== "object" && typeof timerApi !== "function") ||
    typeof timerApi.setTimeout !== "function" ||
    typeof timerApi.clearTimeout !== "function"
  ) {
    throw new TypeError("stage1LoopFallback timerApi must provide setTimeout and clearTimeout");
  }
  return timerApi;
}

function createStage1LoopFallback({
  responseWindowMs = DEFAULT_RESPONSE_WINDOW_MS,
  timerApi = null,
  now = () => Date.now(),
  onFallback = () => {},
} = {}) {
  const windowMs = boundedResponseWindowMs(responseWindowMs);
  if (windowMs == null) {
    throw new TypeError(
      `stage1LoopFallback responseWindowMs must be an integer from ${MIN_RESPONSE_WINDOW_MS} to ${MAX_RESPONSE_WINDOW_MS}`,
    );
  }
  if (typeof now !== "function" || typeof onFallback !== "function") {
    throw new TypeError("stage1LoopFallback requires now and onFallback functions");
  }
  const timers = resolveTimerApi(timerApi);
  // This is the exact measured authority we have already accepted from the
  // hook. A null revision is materially different from revision zero: it
  // means Rekordbox supplied no accepted loop sample for this lineage.
  const measuredAuthorityByLineage = new Map();
  let pending = null;
  let lastFallback = null;
  let nextProfileIndex = 0;
  let intentCounter = 0;

  function targetAt(index) {
    // The validated profile has a real floor (1/64); unlike the retired
    // loopDivision counter, it never wraps back to a larger division or caps
    // at 2 beats.
    return STAGE1_LOOP_LENGTH_PROFILE[Math.min(index, STAGE1_LOOP_LENGTH_PROFILE.length - 1)];
  }

  function rebaseFromMeasured(measured) {
    const index = STAGE1_LOOP_LENGTH_PROFILE.indexOf(measured.lengthBeats);
    if (index >= 0) {
      nextProfileIndex = Math.min(index + 1, STAGE1_LOOP_LENGTH_PROFILE.length - 1);
      return true;
    }
    // A valid but unsupported measured value is authoritative yet cannot be
    // projected exactly.  The next physical intent starts the published
    // profile again rather than guessing a fractional relationship.
    nextProfileIndex = 0;
    return false;
  }

  function divisionForMeasured(measured) {
    if (!measured.active) return null;
    const division = STAGE1_LOOP_LENGTH_PROFILE.indexOf(measured.lengthBeats);
    return division >= 0 ? division : null;
  }

  function baseAuthorityFor(identity) {
    const measured = measuredAuthorityByLineage.get(lineageKey(identity));
    // A prior no-response prediction has no measured revision, but it is the
    // exact current Syndocal division when this same lineage has not yet been
    // rebased by a fresh hook sample. Keep a measured revision when one exists:
    // predictions change the runtime division but never advance measured truth.
    if (lastFallback && sameLineage(lastFallback, identity)) {
      return {
        revision: measured?.revision ?? null,
        division: STAGE1_LOOP_LENGTH_PROFILE.indexOf(lastFallback.targetLengthBeats),
      };
    }
    if (measured) return measured;
    return { revision: null, division: null };
  }

  function clearPending(reason = "cleared") {
    if (!pending) return null;
    const previous = pending;
    if (previous.timerArmed) {
      timers.clearTimeout(previous.timer);
    }
    pending = null;
    return { ...previous, reason };
  }

  function onTimeout(intentId) {
    if (!pending || pending.intentId !== intentId) return;
    const intent = pending;
    pending = null;
    // Rapid F14 presses still represent separate physical intents. If no
    // measured response arrived for any of them, publish their unresolved
    // predictions in physical order so each wire frame remains exactly one
    // downward step from the preceding accepted/predicted base.
    const lastEmittedIntentId = lastFallback?.intentId ?? 0;
    const unresolved = [
      ...intent.partialTargets,
      { intentId: intent.intentId, targetLengthBeats: intent.targetLengthBeats },
    ]
      .filter((candidate) => candidate.intentId > lastEmittedIntentId)
      .sort((left, right) => left.intentId - right.intentId);
    let base = baseAuthorityFor(intent);
    for (const candidate of unresolved) {
      const payload = exactFallbackPayload({
        deck: intent.deck,
        deckId: intent.deckId,
        masterDeckRevision: intent.masterDeckRevision,
        playSessionId: intent.playSessionId,
        pedalIntentId: candidate.intentId,
        baseMeasuredLoopRevision: base.revision,
        baseLoopDivision: base.division,
        targetLengthBeats: candidate.targetLengthBeats,
        responseWindowMs: intent.responseWindowMs,
        source: FALLBACK_SOURCE,
      });
      // This is internal construction from validated fields. Keep a
      // fail-closed guard so malformed/intentionally skipped causal batches
      // cannot emit a later candidate out of order.
      if (!payload) return;
      lastFallback = {
        ...intent,
        intentId: candidate.intentId,
        targetLengthBeats: candidate.targetLengthBeats,
        emittedAtMs: now(),
        payload,
      };
      onFallback(payload, {
        intentId: candidate.intentId,
        baseMeasuredLoopRevision: base.revision,
        baseLoopDivision: base.division,
        emittedAtMs: lastFallback.emittedAtMs,
      });
      base = {
        revision: base.revision,
        division: STAGE1_LOOP_LENGTH_PROFILE.indexOf(candidate.targetLengthBeats),
      };
    }
  }

  function begin(intent) {
    const identity = strictIntent(intent, windowMs);
    if (!identity) return null;
    const superseded = clearPending("superseded");
    const lateFallbackTarget = lastFallback && sameLineage(lastFallback, identity)
      ? { intentId: lastFallback.intentId, targetLengthBeats: lastFallback.targetLengthBeats }
      : null;
    const partialTargets = [
      ...(lateFallbackTarget ? [lateFallbackTarget] : []),
      ...(superseded && sameLineage(superseded, identity) && Array.isArray(superseded.partialTargets)
        ? superseded.partialTargets
        : []),
      ...(superseded && sameLineage(superseded, identity)
        ? [{ intentId: superseded.intentId, targetLengthBeats: superseded.targetLengthBeats }]
        : []),
    ].filter((candidate, index, all) =>
      all.findIndex((other) => other.intentId === candidate.intentId) === index
    );
    intentCounter += 1;
    const targetLengthBeats = targetAt(nextProfileIndex);
    const baseAuthority = baseAuthorityFor(identity);
    const candidate = {
      ...identity,
      intentId: intentCounter,
      profileIndex: nextProfileIndex,
      targetLengthBeats,
      startedAtMs: now(),
      baseMeasuredLoopRevision: baseAuthority.revision,
      baseLoopDivision: baseAuthority.division,
      // A rapid second press owns the only live timer, but an intermediate
      // measured result may still prove the prior physical press.  Preserve
      // those exact prior targets so that result is partial satisfaction, not
      // a contradictory result that would suppress the newest prediction.
      partialTargets,
      timer: null,
      timerArmed: false,
    };
    nextProfileIndex = Math.min(nextProfileIndex + 1, STAGE1_LOOP_LENGTH_PROFILE.length - 1);
    candidate.timer = timers.setTimeout(() => onTimeout(candidate.intentId), windowMs);
    candidate.timerArmed = true;
    pending = candidate;
    return {
      intentId: candidate.intentId,
      targetLengthBeats,
      responseWindowMs: windowMs,
      baseMeasuredLoopRevision: candidate.baseMeasuredLoopRevision,
      baseLoopDivision: candidate.baseLoopDivision,
    };
  }

  function observeMeasured(event) {
    const measured = measuredLoop(event);
    if (!measured) {
      const isLoopResponse = isPlainRecord(event) && event.type === "DJ_LOOP_STATE";
      const responseLineage = loopResponseLineage(event);
      // A malformed response with a provably different lineage is unrelated
      // traffic and must not cancel the current deck's timer. If identity is
      // absent/ambiguous, fail closed by suppressing the only pending
      // prediction: treating it as "no response" could invent a loop change.
      const suppressPending = pending && isLoopResponse
        && (!responseLineage || sameLineage(pending, responseLineage));
      const suppressed = suppressPending
        ? clearPending("invalid-measured-response")
        : null;
      return {
        accepted: false,
        reason: "invalid-measured-loop",
        fallbackSuppressed: Boolean(suppressed),
      };
    }
    const key = lineageKey(measured);
    const previousAuthority = measuredAuthorityByLineage.get(key);
    const seenRevision = previousAuthority?.revision || 0;
    if (measured.revision <= seenRevision) {
      const suppressed = pending && sameLineage(pending, measured)
        ? clearPending("stale-measured-response")
        : null;
      return {
        accepted: false,
        reason: "stale-measured-loop",
        fallbackSuppressed: Boolean(suppressed),
      };
    }
    measuredAuthorityByLineage.set(key, {
      revision: measured.revision,
      division: divisionForMeasured(measured),
    });

    if (pending && sameLineage(pending, measured)) {
      const fallback = lastFallback && sameLineage(lastFallback, measured)
        ? lastFallback
        : null;
      const matches = measured.active === true && measured.lengthBeats === pending.targetLengthBeats;
      if (matches) {
        const resolved = clearPending("measured-match");
        if (fallback) lastFallback = null;
        const rebased = rebaseFromMeasured(measured);
        return {
          accepted: true,
          state: "matched",
          intentId: resolved.intentId,
          targetLengthBeats: resolved.targetLengthBeats,
          rebased,
        };
      }
      const partialIndex = pending.partialTargets.findIndex((candidate) =>
        measured.active === true && candidate.targetLengthBeats === measured.lengthBeats
      );
      if (partialIndex >= 0) {
        const partial = pending.partialTargets.splice(partialIndex, 1)[0];
        if (fallback) lastFallback = null;
        // The fresh sample is now the only authoritative base. Superseded
        // targets before that physical intent must not replay, while later
        // unresolved F14 intents still need sequential prediction.
        pending.partialTargets = pending.partialTargets.filter(
          (candidate) => candidate.intentId > partial.intentId,
        );
        const rebased = rebaseFromMeasured(measured);
        // The newest F14 still owns the live timer. A delayed response for any
        // exact superseded target is only partial satisfaction, even when it
        // is newer than the last emitted fallback (for example 8 timeout,
        // then rapid 4 and 2 presses, followed by measured 4).
        nextProfileIndex = Math.max(
          nextProfileIndex,
          Math.min(pending.profileIndex + 1, STAGE1_LOOP_LENGTH_PROFILE.length - 1),
        );
        return {
          accepted: true,
          state: fallback ? "late-partial-match" : "partial-match",
          intentId: partial.intentId,
          targetLengthBeats: partial.targetLengthBeats,
          pendingIntentId: pending.intentId,
          pendingTargetLengthBeats: pending.targetLengthBeats,
          rebased,
        };
      }
      const resolved = clearPending(
        fallback
          ? "late-measured-overrode-pending-prediction"
          : "contradictory-measured-loop",
      );
      if (fallback) lastFallback = null;
      const rebased = rebaseFromMeasured(measured);
      return {
        accepted: true,
        state: fallback ? "late-measured-overrode-pending" : "contradictory",
        intentId: fallback ? fallback.intentId : resolved.intentId,
        targetLengthBeats: fallback ? fallback.targetLengthBeats : resolved.targetLengthBeats,
        ...(fallback ? { suppressedIntentId: resolved.intentId } : {}),
        rebased,
      };
    }

    // With no newer F14 pending, a same-lineage sample after a predicted
    // fallback is authoritative late measurement and rebases the next intent.
    if (lastFallback && sameLineage(lastFallback, measured)) {
      const fallback = lastFallback;
      lastFallback = null;
      const rebased = rebaseFromMeasured(measured);
      return {
        accepted: true,
        state: "late-measured",
        intentId: fallback.intentId,
        targetLengthBeats: fallback.targetLengthBeats,
        rebased,
      };
    }

    return { accepted: true, state: "observed", rebased: rebaseFromMeasured(measured) };
  }

  function clear(reason = "cleared", { resetProfile = false } = {}) {
    const previous = clearPending(reason);
    lastFallback = null;
    if (resetProfile) {
      nextProfileIndex = 0;
    }
    return previous;
  }

  function resetForSession() {
    return clear("session-replaced", { resetProfile: true });
  }

  function getState() {
    return {
      responseWindowMs: windowMs,
      nextTargetLengthBeats: targetAt(nextProfileIndex),
      pending: pending
        ? {
            deck: pending.deck,
            deckId: pending.deckId,
            masterDeckRevision: pending.masterDeckRevision,
            playSessionId: pending.playSessionId,
            targetLengthBeats: pending.targetLengthBeats,
            responseWindowMs: pending.responseWindowMs,
            intentId: pending.intentId,
            baseMeasuredLoopRevision: pending.baseMeasuredLoopRevision,
            baseLoopDivision: pending.baseLoopDivision,
          }
        : null,
      lastFallback: lastFallback
        ? { ...lastFallback.payload }
        : null,
    };
  }

  return {
    begin,
    clear,
    getState,
    observeMeasured,
    resetForSession,
  };
}

module.exports = {
  DEFAULT_RESPONSE_WINDOW_MS,
  FALLBACK_SOURCE,
  MAX_RESPONSE_WINDOW_MS,
  MIN_RESPONSE_WINDOW_MS,
  STAGE1_LOOP_LENGTH_PROFILE,
  createStage1LoopFallback,
  exactFallbackPayload,
};
