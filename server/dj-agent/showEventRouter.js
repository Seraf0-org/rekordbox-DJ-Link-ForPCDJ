const { EventEmitter } = require("node:events");
const { normalizeReleaseMacroSequence } = require("./config");
const { createStage1LoopFallback } = require("./stage1LoopFallback");

const TIMELINE_MODES = new Set(["dj-control", "handoff-pending", "timeline-control"]);
const TIMELINE_STATES = new Set(["idle", "running", "stopped", "ended", "reset"]);

function createShowEventRouter({
  detector,
  syndocalClient,
  midi,
  pedal,
  releaseReset = { enabled: false, steps: [] },
  releaseMacro = { enabled: false },
  loopFallback = {},
  now = () => Date.now(),
} = {}) {
  if (!detector || !syndocalClient || !midi || !pedal) {
    throw new TypeError("showEventRouter requires detector, syndocalClient, midi, and pedal");
  }
  const emitter = new EventEmitter();
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
  const releaseMacroSequence = normalizeReleaseMacroSequence(
    releaseMacro.sequence ?? releaseMacro.mode
  );
  let releaseMacroPhase = "idle";
  let releaseMacroReason = null;
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
            ok: acknowledged && lastAction.midiSent !== false,
            reason: acknowledged ? null : delivery.reason || delivery.state,
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

  function sendResetStep(step, targetDeck) {
    if (!step || !step.mapping) {
      return false;
    }
    return midi.sendMapping(step.mapping, { targetDeck });
  }

  function scheduleReleaseReset(targetDeck) {
    if (!releaseReset?.enabled || !Array.isArray(releaseReset.steps)) {
      return;
    }
    for (const step of releaseReset.steps) {
      const timer = setTimeout(() => {
        resetTimers.delete(timer);
        sendResetStep(step, targetDeck);
      }, Math.max(0, Number(step.delayMs) || 0));
      resetTimers.add(timer);
    }
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

  function finalizeRelease({ target, stopSent, filterRamp, fadeRamp, reset, generation }) {
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
      setReleaseMacroPhase("handoff-pending", null);
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
      midiSent: stopSent === true,
      delivery,
      ok: stopSent === true && delivery?.ok === true,
      reason: stopSent !== true
        ? "local-midi-stop-failed"
        : releaseMacroPhase === "failed"
          ? releaseMacroReason
          : delivery?.state || null,
    };
    return emitAction(result);
  }

  function startReleaseMacro(targetDeck) {
    const generation = ++releaseMacroGeneration;
    releaseMacroActive = true;
    const target = releaseTarget(targetDeck);
    const macroFilter = releaseMacro?.filter || {};
    const sequence = releaseMacroSequence;
    let filterRamp = null;
    let fadeRamp = null;
    let filterDone = false;
    let fadeDone = false;
    let failed = false;
    let finalResult = null;

    const updatePending = (patch = {}) => {
      updateActiveReleaseAction({
        target,
        filterRamp,
        fadeRamp,
        ...patch,
      });
    };

    const resetFilterAfterFadeFailure = () => {
      try {
        const sent = midi.sendMapping("filter", {
          targetDeck: target.targetDeck,
          value: macroFilter.resetValue,
        });
        return { filter: sent === true, value: macroFilter.resetValue };
      } catch (error) {
        return {
          filter: false,
          value: macroFilter.resetValue,
          error: error?.message || String(error),
        };
      }
    };

    const fail = (reason, extra = {}) => {
      if (failed || generation !== releaseMacroGeneration) {
        return finalResult;
      }
      failed = true;
      midi.cancelFilterRamp?.("release-macro-failed");
      midi.cancelReleaseFade?.("release-macro-failed");
      releaseMacroActive = false;
      activeReleaseAction = null;
      setReleaseMacroPhase("failed", reason);
      emitWarning(`Release macro failed: ${reason}`, "release-macro");
      finalResult = emitAction({
        action: "release",
        mode,
        sequence,
        phase: "failed",
        target,
        targetDeck: target.targetDeck,
        targetChannel: target.targetChannel,
        filterRamp,
        fadeRamp,
        midiSent: false,
        delivery: null,
        ok: false,
        reason,
        ...extra,
      });
      return finalResult;
    };

    const finishRamps = () => {
      if (failed || !filterDone || !fadeDone || generation !== releaseMacroGeneration) {
        return;
      }
      setReleaseMacroPhase("stopping");
      let stopSent = false;
      try {
        stopSent = midi.sendMapping("stop", { targetDeck: target.targetDeck }) === true;
      } catch {
        stopSent = false;
      }
      if (stopSent !== true) {
        // The F13 physical intent remains reportable even when the macro's
        // final Stop mapping fails. Do not make Syndocal delivery disappear
        // behind that local failure; the action result carries both truths.
        fenceReleasedSession(activePlaySessionId);
        const routedEvent = routeEvent({
          type: "DJ_RELEASE",
          source: "action",
          payload: {
            state: "released",
            timelineId,
            playSessionId: activePlaySessionId,
          },
        });
        applyReleaseDeliveryLifecycle(routedEvent.delivery, routedEvent.eventId);
        fail("local-midi-stop-failed", {
          midiSent: false,
          delivery: routedEvent.delivery,
        });
        return;
      }
      if (releaseMacro.resetAfterStop !== true) {
        finalizeRelease({ target, stopSent, filterRamp, fadeRamp, reset: null, generation });
        return;
      }
      setReleaseMacroPhase("resetting");
      const resetDelayMs = Math.max(0, Number(releaseMacro.resetDelayMs) || 0);
      const resetTimer = setTimeout(() => {
        resetTimers.delete(resetTimer);
        if (failed || generation !== releaseMacroGeneration) {
          return;
        }
        const filterReset = midi.sendMapping("filter", {
          targetDeck: target.targetDeck,
          value: macroFilter.resetValue,
        });
        const fadeResetResult = midi.resetReleaseFade?.({
          targetDeck: target.targetDeck,
          value: fadeRamp?.resetValue,
        });
        const fadeReset = typeof fadeResetResult === "boolean"
          ? { ok: fadeResetResult, reason: fadeResetResult ? null : "release-fade-reset-failed" }
          : fadeResetResult || { ok: false, reason: "release-fade-reset-unavailable" };
        const reset = { filter: filterReset, fade: fadeReset };
        if (filterReset !== true || fadeReset.ok !== true) {
          fail("release-reset-failed", { midiSent: true, reset });
          return;
        }
        finalizeRelease({ target, stopSent, filterRamp, fadeRamp, reset, generation });
      }, resetDelayMs);
      resetTimers.add(resetTimer);
    };

    const startFade = () => {
      if (
        failed ||
        fadeRamp ||
        fadeDone ||
        generation !== releaseMacroGeneration ||
        (sequence === "filter-then-fade" && !filterDone)
      ) {
        return;
      }
      setReleaseMacroPhase("fade-ramp");
      fadeRamp = midi.startReleaseFade?.({
        targetDeck: target.targetDeck,
        onComplete: (result) => {
          fadeRamp = { ...(fadeRamp || {}), ...result };
          fadeDone = true;
          updatePending({ fadeRamp });
          finishRamps();
        },
        onError: (error) => {
          const reset = resetFilterAfterFadeFailure();
          fail("release-fade-ramp-failed", { error, reset });
        },
      }) || { started: false, ok: false, reason: "release-fade-unavailable" };
      // startReleaseFade may invoke onError synchronously while attempting its
      // first CC. That callback already performed the one safe Filter reset;
      // do not run the unavailable/started fallback path a second time.
      if (failed) {
        return finalResult;
      }
      if (fadeRamp.started !== true) {
        const reset = resetFilterAfterFadeFailure();
        fail(fadeRamp.reason || "release-fade-ramp-failed", { reset });
        return;
      }
      target.filterChannel = filterRamp?.targetChannel ?? target.filterChannel;
      target.fadeChannel = fadeRamp.targetChannel ?? target.fadeChannel;
      updatePending({ fadeRamp });
    };

    const pending = {
      action: "release",
      mode,
      sequence,
      phase: sequence === "filter-then-fade" ? "filter-ramp" : "parallel-ramp",
      target,
      targetDeck: target.targetDeck,
      targetChannel: target.targetChannel,
      filterRamp: null,
      fadeRamp: null,
      midiSent: false,
      delivery: null,
      ok: false,
      pending: true,
      reason: "release-macro-in-progress",
    };
    setReleaseMacroPhase(pending.phase, null);
    activeReleaseAction = pending;

    filterRamp = midi.startFilterRamp?.({
      targetDeck: target.targetDeck,
      startValue: macroFilter.startValue,
      endValue: macroFilter.endValue,
      durationMs: macroFilter.durationMs,
      updateIntervalMs: macroFilter.updateIntervalMs,
      onComplete: (result) => {
        filterRamp = { ...(filterRamp || {}), ...result };
        filterDone = true;
        updatePending({ filterRamp });
        if (sequence === "filter-then-fade") {
          startFade();
        } else {
          finishRamps();
        }
      },
      onError: (error) => fail("release-filter-ramp-failed", { error }),
    }) || { started: false, ok: false, reason: "filter-ramp-unavailable" };
    if (failed || filterRamp.started !== true) {
      return fail(filterRamp.reason || "release-filter-ramp-failed");
    }
    activeReleaseAction = { ...pending, filterRamp };
    if (sequence === "parallel" && !fadeRamp && !failed) {
      startFade();
    }
    if (!activeReleaseAction) {
      return finalResult;
    }
    return emitAction(activeReleaseAction);
  }

  function sendLegacyRelease(target) {
    let midiSent = false;
    let midiError = null;
    try {
      midiSent = midi.sendMapping("stop", { targetDeck: target.targetDeck }) === true;
    } catch (error) {
      midiError = error?.message || String(error);
    }
    released = midiSent === true;
    // F13 is a physical release intent independently of whether the local
    // Stop mapping reports success. Route that intent exactly once so MIDI and
    // Syndocal delivery retain separate, truthful outcomes.
    fenceReleasedSession(activePlaySessionId);
    const routedEvent = routeEvent({
      type: "DJ_RELEASE",
      source: "action",
      payload: {
        state: "released",
        timelineId,
        playSessionId: activePlaySessionId,
      },
    });
    const delivery = routedEvent.delivery;
    applyReleaseDeliveryLifecycle(delivery, routedEvent.eventId);
    scheduleReleaseReset(target.targetDeck);
    return emitAction({
      action: "release",
      mode,
      sequence: releaseMacroSequence,
      phase: releaseMacroPhase,
      target,
      targetDeck: target.targetDeck,
      targetChannel: target.targetChannel,
      midiSent,
      delivery,
      ok: midiSent === true && delivery?.ok === true,
      reason: midiSent !== true
        ? midiError || "local-midi-failed"
        : releaseMacroPhase === "failed"
          ? releaseMacroReason
          : delivery?.state || null,
    });
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
      const target = releaseTarget(owner.deck);
      if (releaseMacro?.enabled === true) {
        return startReleaseMacro(target.targetDeck);
      }
      return sendLegacyRelease(target);
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
      clearTimeout(timer);
    }
    resetTimers.clear();
    midi.cancelFilterRamp?.("router-stopped");
    midi.cancelReleaseFade?.("router-stopped");
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
