"use strict";

// Token-free projection of the DJ Agent diagnostic payloads. This module only
// copies bounded, evidence-relevant fields into the public sample shape.

const {
  ACK_OUTCOMES,
  CONNECTION_STATES,
  DEFAULT_SETUP_URL,
  DEFAULT_STATUS_URL,
  DELIVERY_STATES,
  EVENT_TYPES,
  EvidenceCaptureError,
  LOOP_DIVISIONS,
  PEDAL_OWNERS,
  STATE_SYNC_STATES,
  STATUS_PATH,
  SETUP_PATH,
  TIMELINE_MODES,
  TIMELINE_STATES,
  assertTokenFree,
  isPlainRecord,
  normalizedEndpoint,
  safeBoolean,
  safeCode,
  safeEnum,
  safeId,
  safeInteger,
  safeNumber,
  safeReason,
  safeTimestamp,
} = require("./dj-agent-hw4-evidence-safety");

function firstRecord(...values) {
  return values.find((value) => isPlainRecord(value)) || null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}

function projectAck(source) {
  const ack = isPlainRecord(source) ? source : {};
  return {
    eventId: safeId(ack.eventId),
    type: safeEnum(ack.type, EVENT_TYPES),
    sequence: safeInteger(ack.sequence, { min: 1 }),
    outcome: safeEnum(ack.outcome, ACK_OUTCOMES),
    code: safeCode(ack.code),
    stateGeneration: safeInteger(ack.stateGeneration),
    state: safeEnum(ack.state, DELIVERY_STATES),
    ok: safeBoolean(ack.ok),
    receivedAt: safeTimestamp(ack.receivedAt),
  };
}

function projectDelivery(source) {
  const delivery = isPlainRecord(source) ? source : {};
  return {
    eventId: safeId(delivery.eventId),
    type: safeEnum(delivery.type, EVENT_TYPES),
    state: safeEnum(delivery.state, DELIVERY_STATES),
    ackState: safeEnum(delivery.ackState, DELIVERY_STATES),
    ok: safeBoolean(delivery.ok),
    sent: safeBoolean(delivery.sent),
    ackRequired: safeBoolean(delivery.ackRequired),
    awaitingAck: safeBoolean(delivery.awaitingAck),
    attempts: safeInteger(delivery.attempts, { min: 0 }),
    busyRetries: safeInteger(delivery.busyRetries, { min: 0 }),
    reason: safeReason(delivery.reason),
    createdAt: safeTimestamp(delivery.createdAt),
    updatedAt: safeTimestamp(delivery.updatedAt),
    ack: projectAck(delivery.ack),
  };
}

function projectConnection(status) {
  const syndocal = isPlainRecord(status) ? status : {};
  return {
    state: safeEnum(syndocal.state, CONNECTION_STATES),
    connected: safeBoolean(syndocal.connected),
    adapter: syndocal.adapter === "syndocal-envelope-v3" ? syndocal.adapter : null,
    connectionGeneration: safeInteger(syndocal.connectionGeneration),
    wireSequence: safeInteger(syndocal.wireSequence),
    stateSync: safeEnum(syndocal.stateSync, STATE_SYNC_STATES),
    pendingAcks: safeInteger(syndocal.pendingAcks, { min: 0 }),
    lastAckAt: safeTimestamp(syndocal.lastAckAt),
    updatedAt: safeTimestamp(syndocal.updatedAt),
  };
}

function projectTimeline(status, state) {
  const router = isPlainRecord(status) ? status : {};
  const stateSync = isPlainRecord(state) ? state : {};
  const playSessionId = firstValue(router.timelinePlaySessionId, stateSync.timelinePlaySessionId);
  return {
    mode: safeEnum(router.mode, TIMELINE_MODES),
    state: safeEnum(router.timelineState, TIMELINE_STATES),
    loopActive: safeBoolean(router.timelineLoopActive),
    transitionHoldActive: safeBoolean(router.timelineTransitionHoldActive),
    id: safeId(router.timelineId),
    positionBars: safeNumber(router.timelinePositionBars, { min: 0, max: 1_000_000_000 }),
    snapshotReady: safeBoolean(router.timelineSnapshotReady),
    pedalOwner: safeEnum(router.timelinePedalOwner, PEDAL_OWNERS),
    playSessionId: safeId(playSessionId),
    releaseEventId: safeId(router.timelineReleaseEventId),
    lastAction: projectDelivery(router.lastTimelineAction?.delivery),
  };
}

function projectOwner(status, state) {
  const router = isPlainRecord(status) ? status : {};
  const stateSync = isPlainRecord(state) ? state : {};
  const ownerPresent = [
    router.ownerDeck,
    router.ownerDeckId,
    router.activePlaySessionId,
    router.ownerWireIdentity,
    router.ownerTrack,
    stateSync.ownerDeck,
    stateSync.ownerDeckId,
    stateSync.activePlaySessionId,
    stateSync.ownerWireIdentity,
    stateSync.ownerTrack,
  ].some((value) => value !== null && value !== undefined);
  const rawDeck = firstValue(router.ownerDeck, stateSync.ownerDeck);
  const deckText = typeof rawDeck === "number" || typeof rawDeck === "string" ? String(rawDeck) : "";
  return {
    present: ownerPresent,
    deck: deckText === "1" || deckText === "2" ? Number(deckText) : null,
  };
}

function projectSetup(setup) {
  const source = isPlainRecord(setup) ? setup : {};
  const readiness = isPlainRecord(source.readiness) ? source.readiness : {};
  const actions = isPlainRecord(readiness.actions) ? readiness.actions : {};
  const mapping = isPlainRecord(source.mappingArtifact) ? source.mappingArtifact : {};
  return {
    ok: safeBoolean(source.ok),
    localOnly: safeBoolean(source.localOnly),
    enabled: safeBoolean(source.enabled),
    // This is a boolean readiness fact only; the credential itself is never
    // accepted by the projection or written to evidence.
    tokenConfigured: safeBoolean(source.tokenConfigured),
    mapping: {
      valid: safeBoolean(mapping.valid),
      operatorVerified: safeBoolean(mapping.operatorVerified),
    },
    readiness: {
      state: safeEnum(readiness.state, new Set(["disabled", "ready", "blocked", "not-ready"])),
      ready: safeBoolean(readiness.ready),
      mappingAction: safeBoolean(actions.mapping),
      releaseMacroAction: safeBoolean(actions.releaseMacro),
    },
  };
}

function buildEvidenceSample({
  status,
  setup,
  observedAt,
  statusHttpStatus = 200,
  setupHttpStatus = 200,
  statusEndpoint = DEFAULT_STATUS_URL,
  setupEndpoint = DEFAULT_SETUP_URL,
} = {}) {
  if (!isPlainRecord(status) || !isPlainRecord(setup)) {
    throw new EvidenceCaptureError("response-shape-invalid");
  }
  const normalizedStatusEndpoint = normalizedEndpoint(statusEndpoint, STATUS_PATH);
  const normalizedSetupEndpoint = normalizedEndpoint(setupEndpoint, SETUP_PATH);
  const publicStatus = isPlainRecord(status.status) ? status.status : {};
  const publicState = isPlainRecord(status.state) ? status.state : {};
  const syndocal = isPlainRecord(publicStatus.syndocal) ? publicStatus.syndocal : {};
  const statusLastDelivery = firstRecord(
    syndocal.lastDelivery,
    publicStatus.lastDelivery,
    publicState.lastDelivery,
    publicState.lastAction?.delivery,
  );
  const statusLastAck = firstRecord(
    syndocal.lastAckResult,
    publicStatus.lastAckResult,
    statusLastDelivery?.ack,
    publicState.lastAction?.delivery?.ack,
  );
  const sessionId = firstValue(
    syndocal.sessionId,
    publicStatus.sessionId,
    publicState.sessionId,
    publicState.timelineSessionId,
    statusLastDelivery?.sessionId,
  );

  const sample = {
    observedAt: safeTimestamp(observedAt) || new Date().toISOString(),
    provenance: {
      transport: "http-get",
      statusEndpoint: normalizedStatusEndpoint,
      setupEndpoint: normalizedSetupEndpoint,
    },
    responses: {
      statusHttpStatus: safeInteger(statusHttpStatus, { min: 100, max: 599 }),
      setupHttpStatus: safeInteger(setupHttpStatus, { min: 100, max: 599 }),
    },
    agent: {
      enabled: safeBoolean(status.enabled),
      allowRemoteActions: safeBoolean(status.allowRemoteActions),
      ok: safeBoolean(publicStatus.ok),
      state: safeEnum(publicStatus.state, CONNECTION_STATES),
      updatedAt: safeTimestamp(publicStatus.updatedAt),
    },
    session: {
      sessionId: safeId(sessionId),
      playSessionId: safeId(firstValue(publicStatus.activePlaySessionId, publicState.activePlaySessionId)),
      connectionGeneration: safeInteger(syndocal.connectionGeneration),
    },
    connection: projectConnection(syndocal),
    state: {
      mode: safeEnum(publicStatus.mode, TIMELINE_MODES),
      timelineState: safeEnum(publicStatus.timelineState, TIMELINE_STATES),
      timelineLoopActive: safeBoolean(publicStatus.timelineLoopActive),
      timelineTransitionHoldActive: safeBoolean(publicStatus.timelineTransitionHoldActive),
      timelineSnapshotReady: safeBoolean(publicStatus.timelineSnapshotReady),
      released: safeBoolean(publicState.released),
      loopDivision: safeEnum(String(publicState.loopDivision ?? ""), LOOP_DIVISIONS),
    },
    ack: projectAck(statusLastAck),
    delivery: projectDelivery(statusLastDelivery),
    timeline: projectTimeline(publicStatus, publicState),
    owner: projectOwner(publicStatus, publicState),
    setup: projectSetup(setup),
  };
  assertTokenFree(sample);
  return sample;
}

module.exports = {
  buildEvidenceSample,
  projectAck,
  projectDelivery,
};
