const { EventEmitter } = require("node:events");
const { createStage1LoopFallback } = require("./stage1LoopFallback");

const TIMELINE_MODES = new Set(["dj-control", "handoff-pending", "timeline-control"]);
const TIMELINE_STATES = new Set(["idle", "running", "stopped", "ended", "reset"]);
const DEFAULT_TIMER_API = Object.freeze({
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clearTimeout(timer) {
    clearTimeout(timer);
  },
});

function resolveTimerApi(timerApi) {
  return {
    setTimeout: typeof timerApi?.setTimeout === "function"
      ? timerApi.setTimeout.bind(timerApi)
      : DEFAULT_TIMER_API.setTimeout,
    clearTimeout: typeof timerApi?.clearTimeout === "function"
      ? timerApi.clearTimeout.bind(timerApi)
      : DEFAULT_TIMER_API.clearTimeout,
  };
}

function createShowEventRouter({
  detector,
  syndocalClient,
  midi,
  pedal,
  releaseMacro = { enabled: false },
  loopFallback = {},
  timerApi,
  now = () => Date.now(),
} = {}) {
  if (!detector || !syndocalClient || !midi || !pedal) {
    throw new TypeError("showEventRouter requires detector, syndocalClient, midi, and pedal");
  }
  const emitter = new EventEmitter();
  const releaseTimerApi = resolveTimerApi(timerApi);
  const resetTimers = new Set();
  let currentSnapshot = {};
  let loopDivision = 0;
  let released = false;
  let lastRoutedEvent = null;
  const routedEvents = new Map();

  let mode = "dj-control";
  let timelineState = "unknown";
  let timelineLoopActive = null;
  let timelineId = null;
  let timelinePositionBars = null;
  let timelinePlaySessionId = null;
  let timelinePedalOwner = "dj";
  let timelineReleaseEventId = null;
  let timelineStateUpdatedAt = null;
  let timelineSnapshotReady = false;
  let lastSyndocalState = syndocalClient.getStatus?.().state || "unknown";
  let pendingLoopDesired = null;
  let pendingHandoffEventId = null;
  let lastTimelineAction = null;
  let lastTimelineWarning = null;
  let releaseMacroActive = false;
  const releaseMacroSequence = releaseMacro.sequence === "filter-then-stop"
    ? "filter-then-stop"
    : null;
  const releaseMacroConfigured = releaseMacro.enabled === true &&
    releaseMacroSequence === "filter-then-stop" &&
    releaseMacro.filter?.startValue === 64 &&
    releaseMacro.filter?.endValue === 127 &&
    releaseMacro.filter?.durationMs === 1_000 &&
    releaseMacro.filter?.updateIntervalMs === 50 &&
    releaseMacro.filter?.resetValue === 64 &&
    releaseMacro.resetAfterStop === true &&
    releaseMacro.resetDelayMs === 0;
  let releaseMacroPhase = "idle";
  let releaseMacroReason = null;
  let lastReleaseReset = null;
  let activeReleaseAction = null;
  let lastAction = null;
  let releaseMacroGeneration = 0;
  let activePlaySessionId = null;
  let admittedTrack = null;
  const releasedPlaySessions = new Set();
  // The first WS connection can arrive after Rekordbox has already emitted a
  // candidate. Reannounce only after the peer's fresh timeline snapshot, for
  // the initial connection as well as every replacement connection.
  let reannounceCandidatesAfterTimelineState = syndocalEnabled() && syndocalState() === "connected";
  // Same-session staleness fence for authoritative DJ_TIMELINE_STATE frames.
  // connectionGeneration comes from the client's status events and resets the
  // fence on connection replacement; sessionId+sequence come from the decoded
  // v3 envelope and fence stale/equal replays within one session.
  let timelineStateFence = null;
  const stage1LoopFallback = createStage1LoopFallback({
    responseWindowMs: loopFallback?.responseWindowMs,
    timerApi: loopFallback?.timerApi,
    now,
    onFallback(payload, context) {
      if (!sameTrackLineage(admittedTrack, payload)) {
        return;
      }
      const routedEvent = routeEvent({
        type: "DJ_LOOP_FALLBACK",
        source: "action",
        payload,
      });
      // One action result carries two independent facts: the physical MIDI
      // send made at F14 time and the later Syndocal delivery of the bounded,
      // explicitly predicted fallback.  Never collapse either into the other.
      if (lastAction?.action === "loop-half" && lastAction.loopFallbackIntentId === context.intentId) {
        lastAction = {
          ...lastAction,
          fallback: { payload, delivery: routedEvent.delivery },
          delivery: routedEvent.delivery,
          syndocalSent: routedEvent.delivery?.sent === true,
          ok: lastAction.midiSent === true && routedEvent.delivery?.ok === true,
          reason: routedEvent.delivery?.ok === true
            ? null
            : routedEvent.delivery?.reason || routedEvent.delivery?.state || "loop-fallback-delivery-failed",
        };
        emitter.emit("action", lastAction);
      }
      emitState();
    },
  });

  function fenceReleasedSession(playSessionId) {
    if (!playSessionId) return;
    releasedPlaySessions.add(playSessionId);
    while (releasedPlaySessions.size > 64) {
      releasedPlaySessions.delete(releasedPlaySessions.values().next().value);
    }
  }

  function syndocalEnabled() {
    return syndocalClient.getStatus?.().enabled === true;
  }

  function syndocalState() {
    return syndocalClient.getStatus?.().state || "unknown";
  }

  function trackLineage(payload) {
    const deck = Number(payload?.deck);
    const deckId = typeof payload?.deckId === "string" ? payload.deckId : null;
    const playSessionId = typeof payload?.playSessionId === "string" ? payload.playSessionId : null;
    if (
      !Number.isInteger(deck) ||
      deck < 1 ||
      deck > 4 ||
      deckId !== `rekordbox-deck-${deck}` ||
      !playSessionId ||
      playSessionId.trim() !== playSessionId
    ) {
      return null;
    }
    return { deck, deckId, playSessionId };
  }

  function normalizedTrackIdentity(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const exactString = (value) => (
      typeof value === "string" && value.length > 0 && value.trim() === value ? value : null
    );
    const hasContentId = Object.hasOwn(payload, "contentId");
    const hasTitle = Object.hasOwn(payload, "title");
    const hasArtist = Object.hasOwn(payload, "artist");
    if (hasContentId && !hasTitle && !hasArtist) {
      const contentId = exactString(payload.contentId);
      return contentId ? `content:${contentId}` : null;
    }
    if (!hasContentId && hasTitle && hasArtist) {
      const title = exactString(payload.title);
      const artist = exactString(payload.artist);
      return title && artist ? `text:${title.toLocaleLowerCase()}\u0000${artist.toLocaleLowerCase()}` : null;
    }
    return null;
  }

  function trackCandidate(payload) {
    const lineage = trackLineage(payload);
    const identity = normalizedTrackIdentity(payload);
    return lineage && identity ? { ...lineage, identity } : null;
  }

  function sameTrackLineage(left, right) {
    return Boolean(
      left &&
      right &&
      left.deck === right.deck &&
      left.deckId === right.deckId &&
      left.playSessionId === right.playSessionId,
    );
  }

  function sameTrackCandidate(left, right) {
    return sameTrackLineage(left, right) && left.identity === right.identity;
  }

  function admittedTrackTarget() {
    return admittedTrack
      ? {
          deck: admittedTrack.deck,
          deckId: admittedTrack.deckId,
          playSessionId: admittedTrack.playSessionId,
        }
      : null;
  }

  function admitTrack(event, delivery) {
    const candidate = trackCandidate(event?.payload);
    const accepted = delivery?.state === "acknowledged" &&
      ["accepted", "duplicate"].includes(delivery?.ack?.outcome);
    if (!candidate || !accepted || releasedPlaySessions.has(candidate.playSessionId)) {
      return false;
    }
    if (sameTrackCandidate(admittedTrack, candidate)) {
      return true;
    }
    if (admittedTrack && !releasedPlaySessions.has(admittedTrack.playSessionId)) {
      // A concurrent candidate may be observable and even mapped by the peer,
      // but it cannot steal Stage 1 ownership from the admitted live session.
      return false;
    }
    stage1LoopFallback.resetForSession();
    admittedTrack = candidate;
    activePlaySessionId = candidate.playSessionId;
    released = false;
    timelineSnapshotReady = false;
    timelinePlaySessionId = null;
    timelineReleaseEventId = null;
    pendingHandoffEventId = null;
    timelinePedalOwner = "dj";
    // A measured loop can be present in the same snapshot as the candidate
    // ACTIVE frame. It was intentionally held back until this terminal ACK
    // established ownership, so flush that exact measured state now rather
    // than waiting for Rekordbox to change its loop revision again.
    detector.requestMeasuredLoopForSession?.(admittedTrackTarget());
    return true;
  }

  function midiTarget(mapping, targetDeck) {
    const resolved = midi.resolveTarget?.(mapping, targetDeck) || {};
    return {
      targetDeck: resolved.targetDeck ?? targetDeck ?? null,
      targetChannel: resolved.targetChannel ?? null,
    };
  }

  function timelineTarget() {
    return {
      timelineId,
      state: timelineState,
      loopActive: timelineLoopActive,
      positionBars: timelinePositionBars,
      playSessionId: timelinePlaySessionId,
      pedalOwner: timelinePedalOwner,
      releaseEventId: timelineReleaseEventId,
    };
  }

  function emitState() {
    emitter.emit("state", getStateSync());
  }

  function setMode(nextMode, reason = null) {
    if (!TIMELINE_MODES.has(nextMode)) {
      return;
    }
    const changed = mode !== nextMode;
    mode = nextMode;
    if (changed) {
      emitter.emit("mode", { mode, reason, at: new Date(now()).toISOString() });
    }
    emitState();
  }

  function emitAction(result) {
    if (result && typeof result === "object" && result.action) {
      lastAction = result;
    }
    if (result?.mode === "timeline-control" || result?.action?.startsWith?.("timeline-")) {
      lastTimelineAction = result;
    }
    emitter.emit("action", result);
    emitState();
    return result;
  }

  function updateActiveReleaseAction(patch = {}) {
    if (activeReleaseAction) {
      activeReleaseAction = {
        ...activeReleaseAction,
        ...patch,
        sequence: releaseMacroSequence,
        phase: releaseMacroPhase,
      };
      lastAction = activeReleaseAction;
      emitter.emit("action", activeReleaseAction);
    }
    emitState();
  }

  function setReleaseMacroPhase(phase, reason = undefined) {
    releaseMacroPhase = String(phase || "idle");
    if (reason !== undefined) {
      releaseMacroReason = reason == null ? null : String(reason);
    } else if (releaseMacroPhase !== "failed") {
      releaseMacroReason = null;
    }
    updateActiveReleaseAction();
  }

  function blockedAction(action, reason, extra = {}) {
    return emitAction({
      action,
      mode,
      ...(action === "release"
        ? { sequence: releaseMacroSequence, phase: releaseMacroPhase }
        : {}),
      target: mode === "timeline-control" ? timelineTarget() : null,
      delivery: extra.delivery || null,
      ok: false,
      midiSent: false,
      ignored: false,
      reason,
      ...extra,
    });
  }

  function routeEvent(event) {
    const delivery = syndocalClient.sendEvent(event) || {
      sent: false,
      ok: false,
      state: "send-failed",
      ackState: "send-failed",
      reason: "client-send-returned-no-result",
    };
    // Detector events already carry an eventId. Manual actions do not; the
    // client is the canonical allocator for those IDs, so normalize both
    // sides before storing/emitting the routed event.
    const eventId = event.eventId || delivery.eventId || delivery.delivery?.eventId || null;
    const normalizedDelivery = delivery.eventId === eventId
      ? delivery
      : { ...delivery, eventId };
    const routedEvent = {
      ...event,
      eventId,
      source: event.source || "detector",
      delivery: normalizedDelivery,
    };
    lastRoutedEvent = routedEvent;
    if (eventId) {
      routedEvents.set(eventId, routedEvent);
    }
    if (routedEvents.size > 128) {
      routedEvents.delete(routedEvents.keys().next().value);
    }
    emitter.emit("event", routedEvent);
    return routedEvent;
  }

  function deliveryState(delivery) {
    return delivery?.state || delivery?.ackState || null;
  }

  // The loop latch may only stay armed while a delivery can still resolve
  // later: pending (awaiting ACK), acknowledged (awaiting the authoritative
  // broadcast), or retrying (queued for reconnect replay). Every other state
  // is terminal and will never emit another delivery update, so holding the
  // latch would wedge timeline loop actions forever. Fail closed to
  // retryability: clear the exact latch immediately.
  const LOOP_LATCH_AWAIT_STATES = new Set(["pending", "acknowledged", "retrying"]);

  function loopDeliveryIsFinalWithoutUpdate(delivery) {
    const state = deliveryState(delivery);
    return typeof state === "string" && state.length > 0 && !LOOP_LATCH_AWAIT_STATES.has(state);
  }

  function isDeliveryFailure(delivery) {
    const state = deliveryState(delivery);
    return ["send-failed", "rejected", "timed-out"].includes(state) ||
      (delivery && delivery.ok === false && state !== "pending");
  }

  function deliveryFailureReason(delivery) {
    return delivery?.reason || deliveryState(delivery) || "release-delivery-failed";
  }

  function syncLastReleaseAction() {
    if (!lastAction || lastAction.action !== "release") {
      return;
    }
    lastAction = {
      ...lastAction,
      mode,
      sequence: releaseMacroSequence,
      phase: releaseMacroPhase,
      ...(releaseMacroPhase === "failed" && releaseMacroReason
        ? { reason: releaseMacroReason }
        : {}),
    };
    emitState();
  }

  function applyReleaseDeliveryLifecycle(delivery, eventId = null) {
    if (eventId) {
      pendingHandoffEventId = eventId;
    }
    const state = deliveryState(delivery);
    if (!syndocalEnabled()) {
      pendingHandoffEventId = null;
      return;
    }
    if (isDeliveryFailure(delivery)) {
      pendingHandoffEventId = null;
      const reason = deliveryFailureReason(delivery);
      // A running snapshot wins a late ACK failure race. Once Stage 2 has
      // been authoritative, do not fall back to local Rekordbox control.
      if (mode !== "timeline-control") {
        setMode("dj-control", "release-delivery-failed");
        setReleaseMacroPhase("failed", reason);
      } else if (releaseMacroPhase === "handoff-pending") {
        setReleaseMacroPhase("complete", null);
      }
      syncLastReleaseAction();
      return;
    }
    if (state === "pending" || state === "acknowledged") {
      setReleaseMacroPhase("handoff-pending", null);
      setMode("handoff-pending", state === "pending"
        ? "release-awaiting-ack"
        : "release-acknowledged-awaiting-timeline");
    }
  }

  function onDetectorEvent(event) {
    if (!event || typeof event.type !== "string") return null;
    if (event.type === "DJ_TRACK_ACTIVE") {
      const candidate = trackCandidate(event.payload);
      if (!candidate || releasedPlaySessions.has(candidate.playSessionId)) return null;
      if (sameTrackLineage(admittedTrack, candidate) && !sameTrackCandidate(admittedTrack, candidate)) {
        return null;
      }
      return routeEvent(event);
    }
    if (event.type === "DJ_TRACK_SYNC") {
      const candidate = trackCandidate(event.payload);
      if (!candidate || !sameTrackCandidate(admittedTrack, candidate) || releasedPlaySessions.has(candidate.playSessionId)) return null;
      return routeEvent(event);
    }
    if (event.type === "DJ_LOOP_STATE") {
      const lineage = trackLineage(event.payload);
      if (!lineage || !sameTrackLineage(admittedTrack, lineage) || releasedPlaySessions.has(lineage.playSessionId)) return null;
      const outcome = stage1LoopFallback.observeMeasured(event);
      if (outcome.accepted && outcome.state === "contradictory") {
        emitWarning("Stage 1 loop measurement contradicted the pending prediction; fallback suppressed", "rekordbox-hook");
      }
      return routeEvent(event);
    }
    return null;
  }

  function emitWarning(message, source = "dj-agent") {
    lastTimelineWarning = String(message || "Unknown DJ Agent warning");
    emitter.emit("warning", { message: lastTimelineWarning, source });
    emitState();
  }

  function onTimelineWarning(warning) {
    emitWarning(warning?.message || String(warning || "Unknown timeline warning"), "syndocal");
  }

  function resetTimelineStateFenceForConnection(status) {
    const generation = status?.connectionGeneration;
    if (!Number.isSafeInteger(generation) || generation < 0) {
      return;
    }
    if (!timelineStateFence || timelineStateFence.connectionGeneration !== generation) {
      timelineStateFence = { connectionGeneration: generation, sessionId: null, sequence: 0 };
    }
  }

  // Returns true when the frame may mutate router state. A frame is rejected
  // without any mutation only when it provably replays the same session at a
  // stale or equal sequence. Frames lacking provable identity cannot be
  // fenced; no synthetic timestamps or defaults are invented for them. A new
  // sessionId is a session replacement with its own sequence space, so the
  // fence re-keys instead of comparing across sessions.
  function timelineStateFenceAccepts(state) {
    const sessionId = typeof state.sessionId === "string" && state.sessionId.length > 0
      ? state.sessionId
      : null;
    const sequence = Number.isSafeInteger(state.sequence) && state.sequence >= 1
      ? state.sequence
      : null;
    if (!sessionId || sequence == null) {
      return true;
    }
    if (timelineStateFence && timelineStateFence.sessionId === sessionId) {
      if (sequence <= timelineStateFence.sequence) {
        emitWarning("Stale duplicate DJ_TIMELINE_STATE ignored", "syndocal");
        return false;
      }
      timelineStateFence.sequence = sequence;
      return true;
    }
    timelineStateFence = {
      connectionGeneration: timelineStateFence?.connectionGeneration ?? null,
      sessionId,
      sequence,
    };
    return true;
  }

  function onTimelineState(state) {
    if (
      !state ||
      !TIMELINE_STATES.has(String(state.state || "").toLowerCase()) ||
      typeof state.loopActive !== "boolean"
    ) {
      onTimelineWarning("Invalid authoritative timeline state ignored");
      return;
    }
    if (!timelineStateFenceAccepts(state)) {
      return;
    }
    const wasHandoffPending = mode === "handoff-pending" ||
      releaseMacroPhase === "handoff-pending";
    timelineState = String(state.state).toLowerCase();
    timelineLoopActive = state.loopActive;
    timelineId = state.timelineId ?? null;
    timelinePositionBars = state.positionBars ?? null;
    timelinePlaySessionId = state.playSessionId ?? null;
    timelinePedalOwner = state.pedalOwner || "dj";
    timelineReleaseEventId = state.releaseEventId ?? null;
    timelineStateUpdatedAt = new Date(now()).toISOString();
    timelineSnapshotReady = true;
    pendingLoopDesired = null;
    if (reannounceCandidatesAfterTimelineState && syndocalEnabled() && syndocalState() === "connected") {
      reannounceCandidatesAfterTimelineState = false;
      detector.requestCurrentTrackCandidates?.();
    }
    const correlatedTimelineOwnership =
      timelineState === "running" &&
      timelinePedalOwner === "timeline" &&
      Boolean(activePlaySessionId) &&
      timelinePlaySessionId === activePlaySessionId &&
      releasedPlaySessions.has(activePlaySessionId) &&
      Boolean(pendingHandoffEventId) &&
      timelineReleaseEventId === pendingHandoffEventId;
    if (correlatedTimelineOwnership) {
      if (wasHandoffPending) {
        setReleaseMacroPhase("complete", null);
        if (
          lastAction?.action === "release" &&
          (lastAction.phase === "handoff-pending" || lastAction.mode === "handoff-pending")
        ) {
          lastAction = {
            ...lastAction,
            mode: "timeline-control",
            phase: "complete",
          };
        }
      }
      setMode("timeline-control", "authoritative-timeline-running");
    } else if (timelineState !== "running") {
      released = false;
      loopDivision = 0;
      setMode("dj-control", `authoritative-timeline-${timelineState}`);
    } else {
      setMode(
        releasedPlaySessions.has(activePlaySessionId) ? "handoff-pending" : "dj-control",
        "timeline-running-without-correlated-pedal-ownership",
      );
    }
  }

  function onSyndocalStatus(status = {}) {
    const nextState = status.state || "unknown";
    const changed = nextState !== lastSyndocalState;
    lastSyndocalState = nextState;
    resetTimelineStateFenceForConnection(status);
    if (syndocalEnabled() && changed && nextState === "connected") {
      // handleOpen sends an explicit state request. Do not permit timeline
      // actions until the authoritative snapshot answers that request.
      timelineSnapshotReady = false;
      reannounceCandidatesAfterTimelineState = true;
    } else if (syndocalEnabled() && changed && nextState !== "connected") {
      timelineSnapshotReady = false;
      // A timeline-control session never falls back to Rekordbox MIDI merely
      // because WS connectivity changed. This is deliberately fail-closed.
      if (mode === "timeline-control") {
        emitWarning("Timeline control suspended: Syndocal disconnected", "syndocal");
      }
    }
    emitState();
  }

  detector.on("event", onDetectorEvent);
  if (typeof syndocalClient.on === "function") {
    syndocalClient.on("delivery", (delivery) => {
      const routedEvent = routedEvents.get(delivery?.eventId);
      if (routedEvent) {
        const updated = { ...routedEvent, delivery };
        routedEvents.set(delivery.eventId, updated);
        if (lastRoutedEvent?.eventId === delivery.eventId) {
          lastRoutedEvent = updated;
        }
        if (lastAction?.delivery?.eventId === delivery.eventId) {
          const acknowledged = delivery.state === "acknowledged";
          const failure = isDeliveryFailure(delivery);
          lastAction = {
            ...lastAction,
            delivery,
            ...(updated.type === "DJ_RELEASE"
              ? {
                  mode,
                  sequence: releaseMacroSequence,
                  phase: releaseMacroPhase,
                }
              : {}),
            ok: acknowledged && lastAction.midiSent !== false && !lastAction.localFailure,
            reason: lastAction.localFailure || (acknowledged ? null : delivery.reason || delivery.state),
          };
          if (updated.type === "DJ_RELEASE" && failure && releaseMacroPhase === "failed") {
            lastAction.reason = releaseMacroReason || lastAction.reason;
          }
        }
        if (updated.type === "DJ_TRACK_ACTIVE") {
          admitTrack(updated, delivery);
        }
        emitter.emit("event", updated);
        if (
          updated.type === "DJ_RELEASE" &&
          updated.source === "action" &&
          updated.eventId === pendingHandoffEventId
        ) {
          applyReleaseDeliveryLifecycle(delivery, updated.eventId);
        }
      }
      if (delivery?.type === "DJ_TIMELINE_LOOP_SET") {
        if (loopDeliveryIsFinalWithoutUpdate(delivery)) {
          pendingLoopDesired = null;
        }
        emitState();
      }
      if (delivery?.type?.startsWith?.("DJ_TIMELINE_")) {
        if (lastTimelineAction?.delivery?.eventId === delivery.eventId) {
          const acknowledged = delivery.state === "acknowledged";
          const isTimelineAction = lastTimelineAction.mode === "timeline-control";
          lastTimelineAction = {
            ...lastTimelineAction,
            delivery,
            ok: acknowledged && (isTimelineAction || lastTimelineAction.midiSent !== false),
            reason: acknowledged ? null : delivery.reason || delivery.state,
          };
        }
        emitState();
      }
    });
    syndocalClient.on("timeline-state", onTimelineState);
    syndocalClient.on("warning", onTimelineWarning);
    syndocalClient.on("status", onSyndocalStatus);
  }

  function onSnapshot(snapshot) {
    currentSnapshot = snapshot && typeof snapshot === "object" ? snapshot : {};
    const result = detector.onSnapshot(currentSnapshot);
    emitState();
    return result;
  }

  function onTrackLoaded(event) {
    const result = detector.onTrackLoaded(event);
    emitState();
    return result;
  }

  function onMasterChange(event) {
    const result = detector.onMasterChange(event);
    emitState();
    return result;
  }

  function authoritativeTimelinePlaySessionId() {
    if (
      timelinePedalOwner === "timeline" &&
      typeof timelinePlaySessionId === "string" &&
      timelinePlaySessionId.length > 0 &&
      timelinePlaySessionId === activePlaySessionId
    ) {
      return timelinePlaySessionId;
    }
    return null;
  }

  function sendTimelineAction(action, type, payload, target = timelineTarget()) {
    const routedEvent = routeEvent({
      type,
      source: "action",
      payload: {
        ...payload,
        source: "pedal",
      },
    });
    const delivery = routedEvent.delivery;
    return emitAction({
      action,
      mode,
      target,
      midiSent: false,
      delivery,
      ok: delivery?.ok === true,
      reason: delivery?.ok === true ? null : delivery?.reason || delivery?.state || "timeline-delivery-failed",
    });
  }

  function triggerStage2Action(action) {
    if (mode === "handoff-pending") {
      return blockedAction(action, "handoff-pending");
    }
    if (syndocalState() !== "connected") {
      return blockedAction(action, "timeline-network-disconnected");
    }
    if (!timelineSnapshotReady) {
      return blockedAction(action, "timeline-state-pending");
    }
    const playSessionId = authoritativeTimelinePlaySessionId();
    if (!playSessionId) {
      return blockedAction(action, "timeline-play-session-unproven");
    }
    if (action === "beat-jump-minus-4") {
      return sendTimelineAction(action, "DJ_TIMELINE_BEAT_JUMP", { bars: -4, timelineId, playSessionId });
    }
    if (action === "beat-jump-plus-4") {
      return sendTimelineAction(action, "DJ_TIMELINE_BEAT_JUMP", { bars: 4, timelineId, playSessionId });
    }
    if (action === "timeline-loop-toggle") {
      if (timelineLoopActive == null) {
        return blockedAction(action, "timeline-loop-state-unknown");
      }
      if (pendingLoopDesired != null) {
        return blockedAction(action, "timeline-loop-action-pending");
      }
      const desired = !timelineLoopActive;
      pendingLoopDesired = desired;
      const result = sendTimelineAction(
        action,
        "DJ_TIMELINE_LOOP_SET",
        { active: desired, timelineId, playSessionId },
        { ...timelineTarget(), desiredLoopActive: desired },
      );
      if (!result.delivery || loopDeliveryIsFinalWithoutUpdate(result.delivery)) {
        pendingLoopDesired = null;
      }
      return result;
    }
    return blockedAction(action, "unknown-timeline-action");
  }

  function releaseTarget(targetDeck) {
    return {
      targetDeck,
      targetChannel: midiTarget("stop", targetDeck).targetChannel,
      stopChannel: midiTarget("stop", targetDeck).targetChannel,
      filterChannel: midiTarget("filter", targetDeck).targetChannel,
    };
  }

  function finalizeRelease({ target, stopSent, filterRamp, reset, localFailure = null, generation }) {
    if (generation !== releaseMacroGeneration) {
      return null;
    }
    released = stopSent === true;
    const releaseSessionId = activePlaySessionId;
    fenceReleasedSession(releaseSessionId);
    const routedEvent = routeEvent({
      type: "DJ_RELEASE",
      source: "action",
      payload: {
        state: "released",
        timelineId,
        playSessionId: releaseSessionId,
      },
    });
    const delivery = routedEvent.delivery;
    applyReleaseDeliveryLifecycle(delivery, routedEvent.eventId);
    if (isDeliveryFailure(delivery)) {
      setReleaseMacroPhase("failed", deliveryFailureReason(delivery));
    } else if (mode === "handoff-pending") {
      setReleaseMacroPhase("handoff-pending", localFailure);
    } else {
      setReleaseMacroPhase("complete", localFailure);
    }
    releaseMacroActive = false;
    activeReleaseAction = null;
    const result = {
      action: "release",
      mode,
      sequence: releaseMacroSequence,
      phase: releaseMacroPhase,
      target,
      targetDeck: target.targetDeck,
      targetChannel: target.targetChannel,
      filterRamp,
      reset,
      localFailure,
      midiSent: stopSent === true,
      delivery,
      ok: stopSent === true && !localFailure && delivery?.ok === true,
      reason: localFailure || (stopSent !== true
        ? "local-midi-stop-failed"
        : releaseMacroPhase === "failed"
          ? releaseMacroReason
          : delivery?.state || null),
    };
    return emitAction(result);
  }

  function startReleaseMacro(targetDeck) {
    const generation = ++releaseMacroGeneration;
    releaseMacroActive = true;
    const target = releaseTarget(targetDeck);
    const macroFilter = releaseMacro?.filter || {};
    const durationMs = Math.max(1, Number(macroFilter.durationMs) || 1);
    let filterRamp = null;
    let filterFailure = null;
    let filterOutcome = null;
    let completionTimer = null;
    let releaseRouted = false;
    let finalResult = null;

    const updatePending = (patch = {}) => {
      updateActiveReleaseAction({
        target,
        filterRamp,
        ...patch,
      });
    };

    const scheduleBestEffortReset = () => {
      if (releaseMacro.resetAfterStop !== true) return null;
      const delayMs = Math.max(0, Number(releaseMacro.resetDelayMs) || 0);
      lastReleaseReset = {
        state: "scheduled",
        mapping: "filter",
        targetDeck: target.targetDeck,
        value: macroFilter.resetValue,
        delayMs,
      };
      const resetTimer = releaseTimerApi.setTimeout(() => {
        resetTimers.delete(resetTimer);
        if (generation !== releaseMacroGeneration) return;
        let sent = false;
        try {
          sent = midi.sendMapping("filter", {
            targetDeck: target.targetDeck,
            value: macroFilter.resetValue,
          }) === true;
        } catch {
          sent = false;
        }
        lastReleaseReset = {
          ...lastReleaseReset,
          state: sent ? "completed" : "failed",
          ok: sent,
          reason: sent ? null : "release-filter-reset-failed",
        };
        if (!sent) {
          emitWarning("Release filter reset failed after DJ_RELEASE", "release-macro");
        }
        emitState();
      }, delayMs);
      resetTimers.add(resetTimer);
      return { ...lastReleaseReset };
    };

    const cancelRampAtPlannedCompletion = () => {
      // Status inspection is diagnostic only. A broken adapter status method
      // must not be able to prevent the independently required Stop/Release.
      let activeBeforeCancel = null;
      try {
        activeBeforeCancel = midi.getStatus?.().rampActive === true;
      } catch {
        activeBeforeCancel = null;
      }
      const cancellation = {
        state: "not-supported",
        attempted: false,
        activeBeforeCancel,
        ok: null,
      };
      if (typeof midi.cancelFilterRamp !== "function") {
        return { cancellation, failure: null };
      }
      cancellation.attempted = true;
      try {
        cancellation.ok = midi.cancelFilterRamp("planned-filter-completion") === true;
        cancellation.state = cancellation.ok
          ? "cancelled"
          : activeBeforeCancel === false
            ? "not-active"
            : "failed";
      } catch {
        cancellation.ok = false;
        cancellation.state = "failed";
      }
      const failure = cancellation.state === "failed"
        ? "release-filter-ramp-cancel-failed"
        : null;
      filterRamp = { ...(filterRamp || {}), cancellation };
      return { cancellation, failure };
    };

    const finishAtPlannedFilterCompletion = () => {
      if (releaseRouted || generation !== releaseMacroGeneration) return finalResult;
      releaseRouted = true;
      if (completionTimer) {
        resetTimers.delete(completionTimer);
        completionTimer = null;
      }
      // Cancel the production interval before Stop.  The MIDI implementation
      // additionally fences a callback that was queued at this same boundary.
      // A cancel failure is visible, but cannot suppress the one Stop/Release.
      const rampCancellation = cancelRampAtPlannedCompletion();
      setReleaseMacroPhase("stopping");
      let stopSent = false;
      try {
        stopSent = midi.sendMapping("stop", { targetDeck: target.targetDeck }) === true;
      } catch {
        stopSent = false;
      }
      const reset = scheduleBestEffortReset();
      finalResult = finalizeRelease({
        target,
        stopSent,
        filterRamp,
        reset,
        localFailure: filterFailure || rampCancellation.failure || (stopSent ? null : "local-midi-stop-failed"),
        generation,
      });
      return finalResult;
    };

    const recordFilterFailure = () => {
      if (releaseRouted || generation !== releaseMacroGeneration || filterFailure) return;
      filterFailure = "release-filter-ramp-failed";
      filterOutcome = { ...(filterOutcome || {}), state: "failed", reason: filterFailure };
      filterRamp = { ...(filterRamp || {}), ...filterOutcome };
      setReleaseMacroPhase("filter-failed-awaiting-completion", filterFailure);
      updatePending({ filterRamp });
      emitWarning("Release filter ramp failed; planned Stop and DJ_RELEASE remain scheduled", "release-macro");
    };

    const pending = {
      action: "release",
      mode,
      sequence: releaseMacroSequence,
      phase: "filter-ramp",
      target,
      targetDeck: target.targetDeck,
      targetChannel: target.targetChannel,
      filterRamp: null,
      midiSent: false,
      delivery: null,
      ok: false,
      pending: true,
      reason: "release-macro-in-progress",
    };
    setReleaseMacroPhase(pending.phase, null);
    activeReleaseAction = pending;

    // The Stop deadline belongs to the physical F13 intent, not to successful
    // MIDI ramp delivery.  It therefore remains armed through an unavailable
    // MIDI port, a first-CC failure, or a later ramp failure.
    completionTimer = releaseTimerApi.setTimeout(finishAtPlannedFilterCompletion, durationMs);
    resetTimers.add(completionTimer);
    try {
      filterRamp = midi.startFilterRamp?.({
        targetDeck: target.targetDeck,
        startValue: macroFilter.startValue,
        endValue: macroFilter.endValue,
        durationMs,
        updateIntervalMs: macroFilter.updateIntervalMs,
        onComplete: (result) => {
          if (releaseRouted || generation !== releaseMacroGeneration || filterFailure) return;
          filterOutcome = { ...(filterOutcome || {}), ...(result || {}), state: "completed" };
          filterRamp = { ...(filterRamp || {}), ...filterOutcome };
          updatePending({ filterRamp });
        },
        onError: recordFilterFailure,
      }) || { started: false, ok: false, reason: "filter-ramp-unavailable" };
    } catch {
      filterRamp = { started: false, ok: false, reason: "filter-ramp-unavailable" };
    }
    filterRamp = { ...(filterRamp || {}), ...(filterOutcome || {}) };
    if (filterRamp.started !== true) {
      recordFilterFailure();
    }
    updatePending({ filterRamp, plannedCompletionMs: durationMs });
    return emitAction(activeReleaseAction);
  }

  function triggerAction(action) {
    const normalized = String(action || "").trim().toLowerCase();
    if (releaseMacroActive) {
      return blockedAction(normalized, "release-macro-in-progress");
    }
    if (mode === "timeline-control") {
      if (normalized === "release") {
        return triggerStage2Action("beat-jump-minus-4");
      }
      if (normalized === "loop-half" || normalized === "loop_half" || normalized === "loophalf") {
        return triggerStage2Action("timeline-loop-toggle");
      }
      if (normalized === "filter-close" || normalized === "filter_close" || normalized === "filter") {
        return triggerStage2Action("beat-jump-plus-4");
      }
    }
    if (mode === "handoff-pending") {
      return blockedAction(normalized, "handoff-pending");
    }
    if (normalized === "loop-half" || normalized === "loop_half" || normalized === "loophalf") {
      const owner = admittedTrackTarget();
      if (!owner) {
        return blockedAction("loop-half", "no-admitted-track-candidate");
      }
      const target = midiTarget("loopHalf", owner.deck);
      // Arm before attempting MIDI. A device/module failure is not evidence
      // that the physical F14 intent did not happen, so it cannot suppress the
      // independent response window.
      const fallbackIntent = stage1LoopFallback.begin({
        ...owner,
      });
      let midiSent = false;
      let midiError = null;
      try {
        midiSent = midi.sendMapping("loopHalf", { targetDeck: target.targetDeck }) === true;
      } catch (error) {
        midiError = error?.message || String(error);
      }
      if (fallbackIntent) {
        loopDivision = fallbackIntent.targetLengthBeats;
      }
      return emitAction({
        action: "loop-half",
        mode,
        loopDivision,
        loopFallbackIntentId: fallbackIntent?.intentId || null,
        targetLengthBeats: fallbackIntent?.targetLengthBeats || null,
        responseWindowMs: fallbackIntent?.responseWindowMs || null,
        fallback: fallbackIntent
          ? { state: "awaiting-measured-loop" }
          : { state: "identity-unproven" },
        midiSent,
        targetDeck: target.targetDeck,
        targetChannel: target.targetChannel,
        delivery: null,
        ok: midiSent === true && Boolean(fallbackIntent),
        reason: !fallbackIntent
          ? "loop-fallback-identity-unproven"
          : midiSent !== true
            ? midiError || "local-midi-failed"
            : null,
      });
    }
    if (normalized === "filter-close" || normalized === "filter_close" || normalized === "filter") {
      return emitAction({
        action: "filter-close",
        mode,
        midiSent: false,
        delivery: null,
        ok: false,
        ignored: true,
        state: "inactive",
        reason: "stage1-filter-disabled",
      });
    }
    if (normalized === "release") {
      // Release is a distinct physical intent. It cancels only the pending
      // Stage 1 prediction and never reuses its timer or payload shape.
      stage1LoopFallback.clear("release");
      const owner = admittedTrackTarget();
      if (!owner) {
        return blockedAction("release", "no-admitted-track-candidate");
      }
      if (!releaseMacroConfigured) {
        setReleaseMacroPhase("blocked", "release-macro-unavailable");
        return blockedAction("release", "release-macro-unavailable");
      }
      return startReleaseMacro(owner.deck);
    }
    if (normalized === "track-active" || normalized === "track_active" || normalized === "test-track-active") {
      return emitAction({
        action: "track-active",
        mode,
        ok: false,
        ignored: true,
        reason: "candidate-active-is-automatic",
        delivery: null,
      });
    }
    return { action: normalized, mode, ok: false, reason: "unknown-action" };
  }

  function getStateSync() {
    const detectorState = detector.getState();
    const owner = admittedTrackTarget();
    const ownerState = owner ? detectorState.decks?.[owner.deck] : null;
    const track = ownerState?.track || null;
    return {
      loopDivision,
      released,
      mode,
      timelineState,
      timelineLoopActive,
      timelineId,
      timelinePositionBars,
      timelineSnapshotReady,
      timelineStateUpdatedAt,
      lastTimelineAction,
      lastTimelineWarning,
      stage1LoopFallback: stage1LoopFallback.getState(),
      releaseMacroSequence,
      releaseMacroPhase,
      releaseMacroReason,
      lastReleaseReset,
      lastAction,
      // `masterDeck` is deliberately not repurposed: under the generic v3
      // capability contract these explicit fields describe show-control
      // ownership, while Rekordbox MASTER remains diagnostic only.
      ownerDeck: owner?.deck || null,
      ownerDeckId: owner?.deckId || null,
      activePlaySessionId: owner ? activePlaySessionId : null,
      ownerWireIdentity: admittedTrack?.identity || null,
      ownerTrack: track
        ? {
            contentId: track.contentId || null,
            title: track.title || null,
            artist: track.artist || null,
            trackBpm: Number.isFinite(track.trackBpm) ? track.trackBpm : null,
            isPlaying: ownerState?.playback?.isPlaying === true,
          }
        : null,
      ownerSource: owner ? "acknowledged-track-candidate" : "none",
      admittedTrack: owner,
      updatedAt: new Date(now()).toISOString(),
    };
  }

  function getStatus() {
    return {
      mode,
      timelineState,
      timelineLoopActive,
      timelineId,
      timelinePositionBars,
      timelinePlaySessionId,
      timelinePedalOwner,
      timelineReleaseEventId,
      timelineSnapshotReady,
      lastTimelineAction,
      lastTimelineWarning,
      releaseMacroSequence,
      releaseMacroPhase,
      releaseMacroReason,
      releaseMacroActive,
      lastReleaseReset,
      lastAction,
      loopDivision,
      stage1LoopFallback: stage1LoopFallback.getState(),
      released,
      ownerDeck: admittedTrack?.deck || null,
      ownerDeckId: admittedTrack?.deckId || null,
      activePlaySessionId: admittedTrack ? activePlaySessionId : null,
      ownerWireIdentity: admittedTrack?.identity || null,
      ownerTrack: (() => {
        const owner = admittedTrackTarget();
        const state = owner ? detector.getState().decks?.[owner.deck] : null;
        return state?.track ? { ...state.track } : null;
      })(),
      snapshotUpdatedAt: currentSnapshot?.updatedAt || null,
      syndocal: syndocalClient.getStatus(),
      midi: midi.getStatus(),
      pedal: pedal.getStatus(),
    };
  }

  function start() {
    midi.start();
    pedal.start();
    syndocalClient.start();
  }

  function stop() {
    releaseMacroGeneration += 1;
    releaseMacroActive = false;
    stage1LoopFallback.clear("router-stopped");
    for (const timer of resetTimers) {
      releaseTimerApi.clearTimeout(timer);
    }
    resetTimers.clear();
    try {
      midi.cancelFilterRamp?.("router-stopped");
    } catch {
      // Shutdown is best-effort. A cancellation failure was already recorded
      // at planned completion when it affected an active F13 macro.
    }
    pedal.stop();
    midi.stop();
    syndocalClient.stop();
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    getStateSync,
    getStatus,
    onMasterChange,
    onSnapshot,
    onTrackLoaded,
    start,
    stop,
    triggerAction,
  };
}

module.exports = { createShowEventRouter };
