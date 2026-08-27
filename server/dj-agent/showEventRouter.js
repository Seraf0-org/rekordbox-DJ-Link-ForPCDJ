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
  releaseFade = { enabled: false },
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
  const releaseMacroSequence = releaseMacro.sequence === "filter-then-fade-then-stop"
    ? "filter-then-fade-then-stop"
    : null;
  const releaseMacroConfigured = releaseMacro.enabled === true &&
    releaseMacroSequence === "filter-then-fade-then-stop" &&
    releaseMacro.filter?.startValue === 64 &&
    releaseMacro.filter?.endValue === 127 &&
    releaseMacro.filter?.durationMs === 1_000 &&
    releaseMacro.filter?.updateIntervalMs === 50 &&
    releaseMacro.filter?.resetValue === 64 &&
    releaseMacro.resetAfterStop === true &&
    releaseMacro.resetDelayMs === 0 &&
    releaseFade.enabled === true &&
    releaseFade.mappingName === "releaseFade" &&
    releaseFade.target === "deck" &&
    releaseFade.startValue === 127 &&
    releaseFade.endValue === 0 &&
    releaseFade.durationMs === 1_000 &&
    releaseFade.updateIntervalMs === 50 &&
    releaseFade.resetAfterStop === true &&
    releaseFade.resetValue === 127 &&
    releaseFade.resetDelayMs === 0;
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
    // A physical event remains live while it is pending, acknowledged but
    // awaiting the correlated timeline state, or queued for reconnect replay.
    // In particular, `retrying` is not a terminal failure: clearing the
    // handoff event id here would make the next connection's ACK unable to
    // promote the same release.
    if (["pending", "acknowledged", "retrying", "disconnected"].includes(state)) {
      return false;
    }
    return ["send-failed", "rejected", "timed-out"].includes(state) ||
      (delivery && delivery.ok === false);
  }

  function deliveryFailureReason(delivery) {
    return delivery?.reason || deliveryState(delivery) || "release-delivery-failed";
  }

  function latestReleaseDelivery(eventId, fallback) {
    if (!eventId) {
      return fallback;
    }
    return routedEvents.get(eventId)?.delivery || fallback;
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
    if (["pending", "acknowledged", "retrying", "disconnected"].includes(state)) {
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
          // During the local F13 tail, phase transitions call
          // updateActiveReleaseAction(), which republishes the in-flight
          // action. Keep that source object current too; otherwise a
          // retrying/ACK delivery is immediately overwritten by its original
          // route-time snapshot before finalizeRelease re-reads the map.
          if (
            updated.type === "DJ_RELEASE" &&
            activeReleaseAction?.delivery?.eventId === delivery.eventId
          ) {
            activeReleaseAction = {
              ...activeReleaseAction,
              delivery,
              ok: acknowledged && activeReleaseAction.midiSent !== false && !activeReleaseAction.localFailure,
              reason: activeReleaseAction.localFailure || (acknowledged ? null : delivery.reason || delivery.state),
            };
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
      fadeChannel: midiTarget("releaseFade", targetDeck).targetChannel,
    };
  }

  function finalizeRelease({
    target,
    stopSent,
    filterRamp,
    fadeRamp,
    reset,
    releaseDelivery,
    releaseEventId,
    localFailure = null,
    generation,
  }) {
    if (generation !== releaseMacroGeneration) {
      return null;
    }
    // The delivery object captured at the F13 edge is only a snapshot. The
    // Syndocal client can publish an ACK, rejection, or reconnect `retrying`
    // transition during the local two-second tail; always re-read the
    // authoritative routed-event record before deciding the terminal phase.
    const delivery = latestReleaseDelivery(releaseEventId, releaseDelivery) || {
      sent: false,
      ok: false,
      state: "send-failed",
      ackState: "send-failed",
      reason: "release-event-not-routed",
      eventId: releaseEventId || null,
    };
    if (isDeliveryFailure(delivery)) {
      setReleaseMacroPhase("failed", deliveryFailureReason(delivery));
    } else if (mode === "handoff-pending") {
      setReleaseMacroPhase("handoff-pending", localFailure);
    } else if (localFailure) {
      setReleaseMacroPhase("failed", localFailure);
    } else {
      setReleaseMacroPhase("complete", null);
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
      fadeRamp,
      reset,
      localFailure,
      midiSent: stopSent === true,
      releaseEventId: releaseEventId || delivery.eventId || null,
      delivery,
      ok: stopSent === true && !localFailure && delivery.ok === true,
      reason: localFailure || (stopSent !== true
        ? "local-midi-stop-failed"
        : releaseMacroPhase === "failed"
          ? releaseMacroReason
          : delivery.state || null),
    };
    return emitAction(result);
  }

  function startReleaseMacro(targetDeck) {
    const generation = ++releaseMacroGeneration;
    releaseMacroActive = true;
    const target = releaseTarget(targetDeck);
    const macroFilter = releaseMacro?.filter || {};
    const filterDurationMs = Math.max(1, Number(macroFilter.durationMs) || 1);
    const fadeDurationMs = Math.max(1, Number(releaseFade.durationMs) || 1);
    let filterRamp = null;
    let fadeRamp = null;
    let filterFailure = null;
    let fadeFailure = null;
    let filterDone = false;
    let filterBoundaryReached = false;
    let fadeBoundaryReached = false;
    let filterBoundaryTimer = null;
    let fadeBoundaryTimer = null;
    let stopFinished = false;
    let releaseRouted = false;
    let releaseDelivery = null;
    let releaseEventId = null;
    let finalResult = null;

    const updatePending = (patch = {}) => {
      updateActiveReleaseAction({
        target,
        filterRamp,
        fadeRamp,
        ...patch,
      });
    };

    const clearTimer = (timer) => {
      if (timer == null) return;
      releaseTimerApi.clearTimeout(timer);
      resetTimers.delete(timer);
    };

    const scheduleTimer = (callback, delayMs) => {
      let timer = null;
      timer = releaseTimerApi.setTimeout(() => {
        resetTimers.delete(timer);
        if (generation !== releaseMacroGeneration) return;
        callback();
      }, delayMs);
      resetTimers.add(timer);
      return timer;
    };

    const routeReleaseAtStart = () => {
      if (releaseRouted || generation !== releaseMacroGeneration) {
        return releaseDelivery;
      }
      releaseRouted = true;
      // The physical release intent belongs to this admitted play session,
      // independently of whether either local MIDI ramp later succeeds.
      released = true;
      const releaseSessionId = activePlaySessionId;
      const releaseTimelineId = timelineId;
      fenceReleasedSession(releaseSessionId);
      let routedEvent;
      try {
        routedEvent = routeEvent({
          type: "DJ_RELEASE",
          source: "action",
          payload: {
            state: "released",
            timelineId: releaseTimelineId,
            playSessionId: releaseSessionId,
          },
        });
      } catch {
        routedEvent = null;
      }
      releaseDelivery = routedEvent?.delivery || {
        sent: false,
        ok: false,
        state: "send-failed",
        ackState: "send-failed",
        reason: "release-event-route-failed",
        eventId: null,
      };
      releaseEventId = routedEvent?.eventId || releaseDelivery.eventId || null;
      if (!routedEvent) {
        emitWarning("DJ_RELEASE route failed at release edge", "release-macro");
      }
      applyReleaseDeliveryLifecycle(releaseDelivery, releaseEventId);
      updatePending({ delivery: releaseDelivery, releaseEventId });
      return releaseDelivery;
    };

    const recordFilterFailure = (reason = "release-filter-ramp-failed") => {
      if (filterFailure || stopFinished || generation !== releaseMacroGeneration) return;
      filterFailure = reason;
      setReleaseMacroPhase("filter-failed-awaiting-boundary", reason);
      updatePending({ filterRamp: { ...(filterRamp || {}), state: "failed", reason } });
      emitWarning("Release filter ramp failed; fade and Stop remain scheduled", "release-macro");
    };

    const recordFadeFailure = (reason = "release-fade-ramp-failed") => {
      if (fadeFailure || stopFinished || generation !== releaseMacroGeneration) return;
      fadeFailure = reason;
      setReleaseMacroPhase("fade-failed-awaiting-boundary", reason);
      updatePending({ fadeRamp: { ...(fadeRamp || {}), state: "failed", reason } });
      emitWarning("Release fade ramp failed; Stop remains scheduled", "release-macro");
    };

    const scheduleResetAfterStop = (stopSent, stopFailure = null) => {
      if (releaseMacro.resetAfterStop !== true) {
        return finalizeRelease({
          target,
          stopSent,
          filterRamp,
          fadeRamp,
          reset: null,
          releaseDelivery,
          releaseEventId,
          localFailure: filterFailure || fadeFailure || stopFailure || (stopSent ? null : "local-midi-stop-failed"),
          generation,
        });
      }
      const delayMs = Math.max(
        0,
        Number(releaseMacro.resetDelayMs) || 0,
        Number(releaseFade.resetDelayMs) || 0,
      );
      lastReleaseReset = {
        state: "scheduled",
        mapping: "filter-and-releaseFade",
        targetDeck: target.targetDeck,
        filterValue: macroFilter.resetValue,
        fadeValue: fadeRamp?.resetValue ?? releaseFade.resetValue,
        delayMs,
      };
      scheduleTimer(() => {
        let filterSent = false;
        try {
          filterSent = midi.sendMapping("filter", {
            targetDeck: target.targetDeck,
            value: macroFilter.resetValue,
          }) === true;
        } catch {
          filterSent = false;
        }
        let fadeReset;
        try {
          fadeReset = midi.resetReleaseFade?.({
            targetDeck: target.targetDeck,
            value: fadeRamp?.resetValue ?? releaseFade.resetValue,
          }) || { ok: false, reason: "release-fade-reset-unavailable" };
        } catch (error) {
          fadeReset = { ok: false, reason: error?.message || "release-fade-reset-failed" };
        }
        const reset = { filter: filterSent, fade: fadeReset };
        const resetFailure = filterSent && fadeReset.ok === true
          ? null
          : "release-reset-failed";
        lastReleaseReset = {
          ...lastReleaseReset,
          state: resetFailure ? "failed" : "completed",
          ok: !resetFailure,
          reason: resetFailure,
        };
        if (resetFailure) {
          emitWarning("Release filter/fader reset failed after Stop", "release-macro");
        }
        finalResult = finalizeRelease({
          target,
          stopSent,
          filterRamp,
          fadeRamp,
          reset,
          releaseDelivery,
          releaseEventId,
          localFailure: filterFailure || fadeFailure || stopFailure || resetFailure || (stopSent ? null : "local-midi-stop-failed"),
          generation,
        });
        emitState();
      }, delayMs);
      return lastReleaseReset;
    };

    const finishStop = () => {
      if (stopFinished || generation !== releaseMacroGeneration) return finalResult;
      stopFinished = true;
      if (fadeBoundaryTimer != null) {
        clearTimer(fadeBoundaryTimer);
        fadeBoundaryTimer = null;
      }
      // Cancel any interval queued at this exact boundary before Stop. Read
      // status once so a false return after a normal completion is represented
      // as `not-active`, while a false/throw against an active ramp remains a
      // visible local failure. Keep the two attempts independent: a broken
      // filter cancellation must never suppress the fade cancellation.
      let statusBeforeCancel = {};
      try {
        statusBeforeCancel = midi.getStatus?.() || {};
      } catch {
        statusBeforeCancel = {};
      }
      const attemptCancellation = ({ method, reason, failureReason, activeBeforeCancel }) => {
        const cancellation = {
          state: "not-supported",
          attempted: false,
          activeBeforeCancel,
          ok: null,
        };
        if (typeof midi[method] !== "function") {
          if (activeBeforeCancel === true) {
            cancellation.state = "failed";
            cancellation.ok = false;
            cancellation.reason = failureReason;
            return { cancellation, failure: failureReason };
          }
          cancellation.state = activeBeforeCancel === false ? "not-active" : "not-supported";
          return { cancellation, failure: null };
        }
        cancellation.attempted = true;
        try {
          const result = midi[method](reason);
          cancellation.ok = result === true;
          cancellation.state = result === true
            ? "cancelled"
            : activeBeforeCancel === true
              ? "failed"
              : "not-active";
        } catch {
          cancellation.ok = false;
          cancellation.state = "failed";
          cancellation.reason = failureReason;
        }
        const failure = cancellation.state === "failed" ? failureReason : null;
        if (failure && !cancellation.reason) {
          cancellation.reason = failure;
        }
        return { cancellation, failure };
      };
      const filterCancellation = attemptCancellation({
        method: "cancelFilterRamp",
        reason: "planned-filter-boundary",
        failureReason: "release-filter-ramp-cancel-failed",
        activeBeforeCancel: typeof statusBeforeCancel.rampActive === "boolean"
          ? statusBeforeCancel.rampActive
          : null,
      });
      const fadeCancellation = attemptCancellation({
        method: "cancelReleaseFade",
        reason: "planned-stop",
        failureReason: "release-fade-cancel-failed",
        activeBeforeCancel: typeof statusBeforeCancel.releaseFadeActive === "boolean"
          ? statusBeforeCancel.releaseFadeActive
          : null,
      });
      filterRamp = { ...(filterRamp || {}), cancellation: filterCancellation.cancellation };
      fadeRamp = { ...(fadeRamp || {}), cancellation: fadeCancellation.cancellation };
      updatePending({ filterRamp, fadeRamp });
      const cancellationFailure = filterCancellation.failure || fadeCancellation.failure || null;
      setReleaseMacroPhase("stopping");
      let stopSent = false;
      try {
        stopSent = midi.sendMapping("stop", { targetDeck: target.targetDeck }) === true;
      } catch {
        stopSent = false;
      }
      scheduleResetAfterStop(stopSent, cancellationFailure);
    };

    const startFade = () => {
      if (
        stopFinished ||
        fadeBoundaryReached ||
        generation !== releaseMacroGeneration ||
        !releaseRouted ||
        (!filterDone && !filterFailure)
      ) {
        return finalResult;
      }
      fadeBoundaryReached = true;
      if (filterBoundaryTimer != null) {
        clearTimer(filterBoundaryTimer);
        filterBoundaryTimer = null;
      }
      setReleaseMacroPhase("fade-ramp");
      try {
        fadeRamp = midi.startReleaseFade?.({
          targetDeck: target.targetDeck,
          startValue: releaseFade.startValue,
          endValue: releaseFade.endValue,
          durationMs: fadeDurationMs,
          updateIntervalMs: releaseFade.updateIntervalMs,
          onComplete: (result) => {
            if (stopFinished || generation !== releaseMacroGeneration) return;
            fadeRamp = { ...(fadeRamp || {}), ...(result || {}), state: "completed" };
            updatePending({ fadeRamp });
            if (releaseRouted) finishStop();
          },
          onError: (error) => {
            recordFadeFailure(error?.reason || "release-fade-ramp-failed");
          },
        }) || { started: false, ok: false, reason: "release-fade-unavailable" };
      } catch {
        fadeRamp = { started: false, ok: false, reason: "release-fade-unavailable" };
      }
      if (fadeRamp.started !== true) {
        recordFadeFailure(fadeRamp.reason || "release-fade-ramp-failed");
      } else {
        target.fadeChannel = fadeRamp.targetChannel ?? target.fadeChannel;
      }
      updatePending({ fadeRamp });
      if (!stopFinished) {
        fadeBoundaryTimer = scheduleTimer(finishStop, fadeDurationMs);
      }
      return finalResult;
    };

    const onFilterBoundary = () => {
      if (filterBoundaryReached || generation !== releaseMacroGeneration) return;
      filterBoundaryReached = true;
      if (filterDone === false && !filterFailure) {
        recordFilterFailure("release-filter-ramp-incomplete");
      }
      if (releaseRouted) startFade();
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
      fadeRamp: null,
      delivery: null,
      releaseEventId: null,
      midiSent: false,
      ok: false,
      pending: true,
      reason: "release-macro-in-progress",
    };
    setReleaseMacroPhase(pending.phase, null);
    activeReleaseAction = pending;

    // The initial Filter CC and the correlated DJ_RELEASE are both part of
    // the same F13 edge. Callback implementations are fenced until the
    // release event is routed, so a synchronous test/adapter callback cannot
    // reorder Fade/Stop ahead of DJ_RELEASE.
    try {
      filterRamp = midi.startFilterRamp?.({
        targetDeck: target.targetDeck,
        startValue: macroFilter.startValue,
        endValue: macroFilter.endValue,
        durationMs: filterDurationMs,
        updateIntervalMs: macroFilter.updateIntervalMs,
        onComplete: (result) => {
          if (stopFinished || generation !== releaseMacroGeneration || filterDone) return;
          filterRamp = { ...(filterRamp || {}), ...(result || {}), state: "completed" };
          filterDone = true;
          updatePending({ filterRamp });
          if (releaseRouted) {
            startFade();
          }
        },
        onError: (error) => recordFilterFailure(error?.reason || "release-filter-ramp-failed"),
      }) || { started: false, ok: false, reason: "filter-ramp-unavailable" };
    } catch {
      filterRamp = { started: false, ok: false, reason: "filter-ramp-unavailable" };
    }
    if (filterRamp.started !== true) {
      recordFilterFailure(filterRamp.reason || "release-filter-ramp-failed");
    } else {
      target.filterChannel = filterRamp.targetChannel ?? target.filterChannel;
    }
    updatePending({ filterRamp, plannedFilterDurationMs: filterDurationMs });
    routeReleaseAtStart();
    if (filterDone) {
      startFade();
    } else {
      // A failed or unavailable HPF still owns its planned one-second
      // boundary. Preserve the HPF -> fade order and keep the local tail
      // deterministic even when no first CC could be sent.
      filterBoundaryTimer = scheduleTimer(onFilterBoundary, filterDurationMs);
    }
    if (!activeReleaseAction) return finalResult;
    return emitAction({
      ...activeReleaseAction,
      delivery: releaseDelivery,
      releaseEventId,
    });
  }

  function triggerAction(action) {
    const normalized = String(action || "").trim().toLowerCase();
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
    // Stage 2 timeline control is an independent network mode. Once the
    // authoritative correlated snapshot has promoted the handoff, a local
    // Stage 1 fade/stop tail must not block those timeline actions. Keep the
    // guard for Stage 1 retries and the other local-only actions.
    if (releaseMacroActive) {
      return blockedAction(normalized, "release-macro-in-progress");
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
    const hadActiveRelease = releaseMacroActive || activeReleaseAction !== null;
    releaseMacroGeneration += 1;
    releaseMacroActive = false;
    // Drop the public in-flight action before invoking adapter cancellation.
    // A synchronous or already-queued callback from the old generation must
    // not be able to mutate lastAction after shutdown.
    activeReleaseAction = null;
    if (hadActiveRelease) {
      releaseMacroPhase = "idle";
      releaseMacroReason = null;
    }
    stage1LoopFallback.clear("router-stopped");
    for (const timer of resetTimers) {
      releaseTimerApi.clearTimeout(timer);
    }
    resetTimers.clear();
    try {
      midi.cancelFilterRamp?.("router-stopped");
    } catch {
      // Shutdown is best-effort, but keep the independent fade cancellation
      // reachable even when the filter adapter throws.
    }
    try {
      midi.cancelReleaseFade?.("router-stopped");
    } catch {
      // Shutdown is best-effort.
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
