"use strict";

const OPERATOR_RETURN_CONFIRMATION_FIELD = "confirmation";
const OPERATOR_RETURN_CONFIRMATION_TOKEN = "return-to-dj-control";

function sameTrackCandidate(left, right) {
  return Boolean(
    left &&
    right &&
    left.deck === right.deck &&
    left.deckId === right.deckId &&
    left.playSessionId === right.playSessionId &&
    left.identity === right.identity,
  );
}

function validDeck1Candidate(candidate) {
  return Boolean(
    candidate &&
    candidate.deck === 1 &&
    candidate.deckId === "rekordbox-deck-1" &&
    candidate.fresh === true &&
    candidate.isPlaying === true &&
    typeof candidate.playSessionId === "string" &&
    candidate.playSessionId.length > 0 &&
    candidate.playSessionId.trim() === candidate.playSessionId &&
    typeof candidate.identity === "string" &&
    candidate.identity.length > 0,
  );
}

function createOperatorDjControlReturn({
  now = () => Date.now(),
  getMode,
  getReleaseMacroActive,
  getCurrentProductionCandidate,
  getProductionCandidateStatus,
  getReleasedPlaySessions,
  getAdmittedTrack,
  getOwnerSource,
  setLocalOwner,
  setReleased,
  getTimelineTarget,
  setMode,
  setLastOperatorOverride,
  emitWarning,
  emitAction,
} = {}) {
  if (
    typeof getMode !== "function" ||
    typeof getCurrentProductionCandidate !== "function" ||
    typeof getReleasedPlaySessions !== "function" ||
    typeof getAdmittedTrack !== "function" ||
    typeof setLocalOwner !== "function" ||
    typeof setReleased !== "function" ||
    typeof getTimelineTarget !== "function" ||
    typeof setMode !== "function" ||
    typeof setLastOperatorOverride !== "function" ||
    typeof emitWarning !== "function" ||
    typeof emitAction !== "function"
  ) {
    throw new TypeError("operatorDjControlReturn requires router state hooks");
  }

  function failure(reason, warning, extra = {}) {
    const status = {
      state: "failed",
      source: "operator",
      action: "return-to-dj-control",
      reason,
      warning,
      modeBefore: getMode(),
      at: new Date(now()).toISOString(),
      ...extra,
    };
    setLastOperatorOverride(status);
    emitWarning(warning, "operator");
    return emitAction({
      action: "return-to-dj-control",
      mode: getMode(),
      target: getTimelineTarget(),
      midiSent: false,
      delivery: null,
      ok: false,
      ignored: false,
      reason,
      operatorOverride: status,
    });
  }

  function unavailableCandidateFailure() {
    const status = getProductionCandidateStatus?.() || null;
    const stage = status?.stage || null;
    const messages = {
      loaded: "track is loaded but its play session has not started",
      "waiting-for-play": "Deck 1 needs a fresh currently-playing play session",
      "waiting-for-fresh-playback": "Deck 1 playback evidence is not fresh",
      "waiting-for-1400ms": "Deck 1 fallback is still inside the 1400ms metadata wait",
      "waiting-for-text-identity": "Deck 1 artist metadata is still required",
      "not-selected": "Deck 1 is not the current production selection",
      "no-track": "no Deck 1 track is loaded",
    };
    return {
      reason: stage === "waiting-for-1400ms"
        ? "deck1-metadata-wait"
        : stage === "waiting-for-play"
          ? "fresh-playing-play-session-required"
          : stage === "waiting-for-fresh-playback"
            ? "fresh-playing-playback-required"
            : "fresh-playing-deck1-candidate-required",
      warning: `Return to DJ control unavailable: ${messages[stage] || "no fresh currently-playing Deck 1 production candidate"}`,
      extra: {
        candidateStage: stage,
        candidateReason: status?.reason || null,
      },
    };
  }

  return function returnToDjControl() {
    const warning = "Timeline may still be running; local DJ control override requires operator confirmation";
    const mode = getMode();
    if (mode !== "handoff-pending" && mode !== "timeline-control") {
      return failure("dj-control-override-unavailable", warning);
    }
    if (getReleaseMacroActive?.() === true) {
      return failure("release-macro-in-progress", warning);
    }

    let candidate = null;
    try {
      candidate = getCurrentProductionCandidate() || null;
    } catch {
      candidate = null;
    }
    if (!validDeck1Candidate(candidate)) {
      const unavailable = unavailableCandidateFailure();
      return failure(unavailable.reason, unavailable.warning, unavailable.extra);
    }

    const releasedPlaySessions = getReleasedPlaySessions();
    if (releasedPlaySessions.has(candidate.playSessionId)) {
      return failure(
        "deck1-candidate-session-released",
        "Return to DJ control unavailable: the Deck 1 play session was already released",
        { targetDeck: 1, playSessionId: candidate.playSessionId },
      );
    }

    const localTarget = {
      deck: candidate.deck,
      deckId: candidate.deckId,
      playSessionId: candidate.playSessionId,
      identity: candidate.identity,
    };
    const admittedTrack = getAdmittedTrack();
    if (
      admittedTrack &&
      !sameTrackCandidate(admittedTrack, localTarget) &&
      !releasedPlaySessions.has(admittedTrack.playSessionId)
    ) {
      return failure(
        "active-admitted-track-present",
        "Return to DJ control unavailable: another live admitted Deck session is still active",
        { targetDeck: candidate.deck, playSessionId: candidate.playSessionId },
      );
    }

    if (!sameTrackCandidate(admittedTrack, localTarget)) {
      setLocalOwner(localTarget);
    }
    setReleased(false);
    const ownerSource = getOwnerSource?.() || "acknowledged-track-candidate";
    const overrideStatus = {
      state: "completed",
      source: "operator",
      action: "return-to-dj-control",
      ownerSource,
      targetDeck: candidate.deck,
      deckId: candidate.deckId,
      playSessionId: candidate.playSessionId,
      candidateKind: candidate.kind || null,
      warning: "Timeline may still be running; local DJ control override was confirmed by the operator",
      modeBefore: mode,
      at: new Date(now()).toISOString(),
    };
    setLastOperatorOverride(overrideStatus);
    setMode("dj-control", "operator-return-to-dj-control");
    emitWarning(overrideStatus.warning, "operator");
    return emitAction({
      action: "return-to-dj-control",
      mode: "dj-control",
      target: {
        targetDeck: candidate.deck,
        deckId: candidate.deckId,
        playSessionId: candidate.playSessionId,
        source: ownerSource,
      },
      targetDeck: candidate.deck,
      playSessionId: candidate.playSessionId,
      midiSent: false,
      delivery: null,
      ok: true,
      ignored: false,
      reason: null,
      operatorOverride: overrideStatus,
    });
  };
}

module.exports = {
  OPERATOR_RETURN_CONFIRMATION_FIELD,
  OPERATOR_RETURN_CONFIRMATION_TOKEN,
  createOperatorDjControlReturn,
};
