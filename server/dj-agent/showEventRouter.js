const { EventEmitter } = require("node:events");
const { normalizeReleaseMacroSequence } = require("./config");

const TIMELINE_MODES = new Set(["dj-control", "handoff-pending", "timeline-control"]);
const TIMELINE_STATES = new Set(["idle", "running", "stopped", "ended", "reset"]);

function createShowEventRouter({
  detector,
  syndocalClient,
  midi,
  pedal,
  releaseReset = { enabled: false, steps: [] },
  releaseMacro = { enabled: false },
  loopDivisionMax = null,
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
  const releasedPlaySessions = new Set();

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

  function currentMasterDeck() {
    const detectorState = detector.getState?.() || {};
    const deck = Number(detectorState.currentMasterDeck);
    return Number.isInteger(deck) && deck >= 1 ? deck : null;
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
    if (event.type === "DJ_MASTER_TRACK_ACTIVE") {
      const nextSession = event.payload?.playSessionId || null;
      if (!nextSession) return null;
      if (nextSession !== activePlaySessionId) {
        timelineSnapshotReady = false;
        timelinePlaySessionId = null;
        timelineReleaseEventId = null;
        pendingHandoffEventId = null;
      }
      activePlaySessionId = nextSession;
      if (!releasedPlaySessions.has(nextSession)) {
        timelinePedalOwner = "dj";
        return routeEvent(event);
      }
      return null;
    }
    if (event.type === "DJ_MASTER_TRACK_SYNC" || event.type === "DJ_LOOP_STATE") {
      const session = event.payload?.playSessionId || null;
      if (!session || session !== activePlaySessionId || releasedPlaySessions.has(session)) return null;
      return routeEvent(event);
    }
    if (event.type === "DJ_MASTER_CHANGED") return routeEvent(event);
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

  function onTimelineState(state) {
    if (
      !state ||
      !TIMELINE_STATES.has(String(state.state || "").toLowerCase()) ||
      typeof state.loopActive !== "boolean"
    ) {
      onTimelineWarning("Invalid authoritative timeline state ignored");
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
    if (syndocalEnabled() && changed && nextState === "connected") {
      // handleOpen sends an explicit state request. Do not permit timeline
      // actions until the authoritative snapshot answers that request.
      timelineSnapshotReady = false;
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
        if (["rejected", "timed-out", "send-failed"].includes(delivery.state)) {
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
    if (currentSnapshot.playback?.isPlaying === true) {
      released = false;
    }
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

  function timelineReady() {
    return mode === "timeline-control" && timelineSnapshotReady && syndocalState() === "connected";
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
    if (action === "beat-jump-minus-4") {
      return sendTimelineAction(action, "DJ_TIMELINE_BEAT_JUMP", { bars: -4, timelineId });
    }
    if (action === "beat-jump-plus-4") {
      return sendTimelineAction(action, "DJ_TIMELINE_BEAT_JUMP", { bars: 4, timelineId });
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
        { active: desired, timelineId },
        { ...timelineTarget(), desiredLoopActive: desired },
      );
      if (["send-failed", "rejected", "timed-out"].includes(result.delivery?.state)) {
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
      const stopSent = midi.sendMapping("stop", { targetDeck: target.targetDeck });
      if (stopSent !== true) {
        fail("local-midi-stop-failed", { midiSent: false });
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
    const midiSent = midi.sendMapping("stop", { targetDeck: target.targetDeck });
    released = midiSent === true;
    if (midiSent !== true) {
      return emitAction({
        action: "release",
        mode,
        sequence: releaseMacroSequence,
        phase: releaseMacroPhase,
        target,
        targetDeck: target.targetDeck,
        targetChannel: target.targetChannel,
        midiSent: false,
        delivery: null,
        ok: false,
        reason: "local-midi-failed",
      });
    }
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
        ? "local-midi-failed"
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
      loopDivision =
        loopDivisionMax != null &&
        Number.isFinite(Number(loopDivisionMax)) &&
        loopDivision >= Number(loopDivisionMax)
          ? 0
          : loopDivision + 1;
      const target = midiTarget("loopHalf", currentMasterDeck());
      const midiSent = midi.sendMapping("loopHalf", { targetDeck: target.targetDeck });
      return emitAction({
        action: "loop-half",
        mode,
        loopDivision,
        midiSent,
        targetDeck: target.targetDeck,
        targetChannel: target.targetChannel,
        delivery: null,
        ok: midiSent === true,
        reason: midiSent !== true ? "local-midi-failed" : null,
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
      const target = releaseTarget(currentMasterDeck());
      if (releaseMacro?.enabled === true) {
        return startReleaseMacro(target.targetDeck);
      }
      return sendLegacyRelease(target);
    }
    if (normalized === "track-active" || normalized === "track_active" || normalized === "test-track-active") {
      const detectorEvent = detector.requestCurrentMasterActive();
      const routedEvent = detectorEvent && lastRoutedEvent?.eventId === detectorEvent.eventId
        ? lastRoutedEvent
        : null;
      const delivery = routedEvent?.delivery || null;
      return emitAction({
        action: "track-active",
        mode,
        ok: Boolean(detectorEvent && delivery?.ok !== false),
        reason: detectorEvent ? (delivery?.reason || null) : "no-active-master-track",
        detectorEvent,
        delivery,
      });
    }
    return { action: normalized, mode, ok: false, reason: "unknown-action" };
  }

  function getStateSync() {
    const detectorState = detector.getState();
    const masterDeck = detectorState.currentMasterDeck;
    const master = masterDeck ? detectorState.decks?.[masterDeck] : null;
    const track = master?.track || null;
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
      releaseMacroSequence,
      releaseMacroPhase,
      releaseMacroReason,
      lastAction,
      masterDeck: masterDeck || null,
      activePlaySessionId,
      masterTrack: track
        ? {
            contentId: track.contentId || null,
            title: track.title || null,
            artist: track.artist || null,
            trackBpm: Number.isFinite(track.trackBpm) ? track.trackBpm : null,
            isPlaying: master?.playback?.isPlaying === true,
          }
        : null,
      masterDeckSource: detectorState.masterDeckSource,
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
      released,
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
