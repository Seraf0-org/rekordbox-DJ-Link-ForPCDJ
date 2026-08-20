const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");

function makeId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const TIMELINE_STATES = new Set(["idle", "running", "stopped", "ended", "reset"]);

function normalizeTimelineState(message = {}) {
  if (!message || typeof message !== "object") {
    return null;
  }
  const payload = message.payload && typeof message.payload === "object" ? message.payload : {};
  const source = { ...message, ...payload };
  if (String(source.type || "").trim().toUpperCase() !== "DJ_TIMELINE_STATE") {
    return null;
  }
  const state = String(source.state || "").trim().toLowerCase();
  if (!TIMELINE_STATES.has(state) || typeof source.loopActive !== "boolean") {
    return null;
  }
  let positionBars = null;
  if (source.positionBars != null) {
    const number = Number(source.positionBars);
    if (!Number.isFinite(number)) {
      return null;
    }
    positionBars = number;
  }
  return {
    type: "DJ_TIMELINE_STATE",
    state,
    loopActive: source.loopActive,
    timelineId: source.timelineId == null || String(source.timelineId).trim() === ""
      ? null
      : String(source.timelineId),
    positionBars,
    eventId: source.eventId == null ? null : String(source.eventId),
    sequence: Number.isFinite(Number(source.sequence)) ? Number(source.sequence) : null,
  };
}

function createGenericJsonAdapter({ token = "" } = {}) {
  return {
    name: "generic-json",
    encodeHello({ eventId, sequence }) {
      return {
        type: "DJ_AGENT_HELLO",
        eventId,
        sequence,
        protocol: "generic-json",
        token: token || undefined,
        capabilities: [
          "DJ_MASTER_CHANGED",
          "DJ_MASTER_TRACK_ACTIVE",
          "DJ_LOOP_STATE",
          "DJ_RELEASE",
          "DJ_TIMELINE_BEAT_JUMP",
          "DJ_TIMELINE_LOOP_SET",
          "DJ_TIMELINE_STATE",
          "DJ_TIMELINE_STATE_REQUEST",
          "DJ_STATE_SYNC",
        ],
      };
    },
    encodeEvent(event) {
      return {
        type: event.type,
        eventId: event.eventId,
        sequence: event.sequence,
        ...(event.payload && typeof event.payload === "object" ? event.payload : {}),
      };
    },
    encodeStateSync({ eventId, sequence, state }) {
      return {
        type: "DJ_STATE_SYNC",
        eventId,
        sequence,
        ...(state && typeof state === "object" ? state : {}),
      };
    },
    encodeHeartbeat({ eventId, sequence }) {
      return {
        type: "DJ_AGENT_HEARTBEAT",
        eventId,
        sequence,
        at: new Date().toISOString(),
      };
    },
    decode(data) {
      if (data && typeof data === "object" && "data" in data) {
        return this.decode(data.data);
      }
      if (data && typeof data === "object") {
        return data;
      }
      try {
        return JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
      } catch {
        return null;
      }
    },
    isAck(message) {
      return Boolean(message && (message.type === "ACK" || message.type === "ack") && message.eventId);
    },
    isStateSyncRequest(message) {
      return Boolean(
        message &&
          (message.type === "DJ_STATE_SYNC_REQUEST" || message.type === "STATE_SYNC_REQUEST")
      );
    },
    isTimelineState(message) {
      return Boolean(message && String(message.type || "").trim().toUpperCase() === "DJ_TIMELINE_STATE");
    },
    decodeTimelineState(message) {
      return normalizeTimelineState(message);
    },
    encodeTimelineStateRequest({ eventId, sequence }) {
      return {
        type: "DJ_TIMELINE_STATE_REQUEST",
        eventId,
        sequence,
      };
    },
  };
}

function resolveWebSocketImplementation(moduleName = "ws") {
  if (typeof globalThis.WebSocket === "function") {
    return globalThis.WebSocket;
  }
  if (!moduleName) {
    return null;
  }
  try {
    const loaded = require(moduleName);
    return loaded?.WebSocket || loaded?.default || loaded;
  } catch {
    return null;
  }
}

function addSocketListener(socket, name, handler) {
  if (!socket) {
    return () => {};
  }
  if (typeof socket.on === "function") {
    socket.on(name, handler);
    return () => {
      if (typeof socket.off === "function") {
        socket.off(name, handler);
      } else if (typeof socket.removeListener === "function") {
        socket.removeListener(name, handler);
      }
    };
  }
  const property = `on${name}`;
  socket[property] = handler;
  return () => {
    if (socket[property] === handler) {
      socket[property] = null;
    }
  };
}

function socketIsOpen(socket) {
  if (!socket) {
    return false;
  }
  if (typeof socket.readyState !== "number") {
    return true;
  }
  return socket.readyState === 1;
}

function resolveAdapter({ adapter, adapterFactory, token }) {
  if (adapter && typeof adapter === "object") {
    return { adapterObject: adapter, error: null };
  }
  if (typeof adapterFactory === "function") {
    try {
      const adapterObject = adapterFactory({ token, name: adapter });
      if (!adapterObject || typeof adapterObject !== "object") {
        return { adapterObject: null, error: "Syndocal adapter factory returned no adapter" };
      }
      return { adapterObject, error: null };
    } catch (error) {
      return { adapterObject: null, error: error?.message || String(error) };
    }
  }
  const name = String(adapter || "").trim().toLocaleLowerCase();
  if (name === "generic-json") {
    return { adapterObject: createGenericJsonAdapter({ token }), error: null };
  }
  if (!name) {
    return {
      adapterObject: null,
      error: "Syndocal adapter is not configured; select generic-json explicitly or provide an adapterFactory",
    };
  }
  return {
    adapterObject: null,
    error: `Syndocal adapter '${String(adapter)}' is unavailable; no silent generic fallback is allowed`,
  };
}

function createSyndocalClient({
  enabled = false,
  host = "127.0.0.1",
  port = 9100,
  path = "/ws",
  nic = "",
  token = "",
  adapter = "",
  adapterFactory = null,
  WebSocketImpl = null,
  wsModule = "ws",
  reconnectMinMs = 500,
  reconnectMaxMs = 10_000,
  heartbeatMs = 10_000,
  ackTimeoutMs = 5_000,
  requiresAckTypes = [
    "DJ_RELEASE",
    "DJ_LOOP_STATE",
    "DJ_TIMELINE_BEAT_JUMP",
    "DJ_TIMELINE_LOOP_SET",
  ],
  stateSyncProvider = () => ({}),
  now = () => Date.now(),
} = {}) {
  const emitter = new EventEmitter();
  const { adapterObject, error: adapterError } = resolveAdapter({ adapter, adapterFactory, token });
  const url = `ws://${host}:${port}${String(path || "/ws").startsWith("/") ? path : `/${path}`}`;
  const ackTypes = new Set(requiresAckTypes);
  let socket = null;
  let running = false;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let reconnectDelay = Math.max(50, reconnectMinMs);
  let sequence = 0;
  let lastDelivery = null;
  let lastAckResult = null;
  let status = {
    enabled: Boolean(enabled),
    state: enabled ? (adapterError ? "unavailable" : "disconnected") : "disabled",
    message: enabled
      ? adapterError || "Not connected"
      : "Syndocal integration disabled by config",
    url,
    nic: nic || null,
    adapter: adapterObject?.name || (String(adapter || "").trim() || null),
    updatedAt: new Date(now()).toISOString(),
    lastError: adapterError || null,
    lastAckAt: null,
    lastAckResult: null,
    lastDelivery: null,
  };
  const pendingAcks = new Map();
  const deliveryHistory = new Map();
  const socketCleanups = [];

  function updateStatus(patch) {
    status = {
      ...status,
      ...patch,
      enabled: Boolean(enabled),
      url,
      nic: nic || null,
      adapter: adapterObject?.name || (String(adapter || "").trim() || null),
      lastAckResult: lastAckResult ? { ...lastAckResult } : null,
      lastDelivery: lastDelivery ? { ...lastDelivery } : null,
      updatedAt: new Date(now()).toISOString(),
    };
    emitter.emit("status", { ...status });
  }

  function nextEnvelopeId() {
    sequence += 1;
    return { eventId: makeId(), sequence };
  }

  function clearSocketListeners() {
    while (socketCleanups.length > 0) {
      socketCleanups.pop()();
    }
  }

  function clearHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function publishDelivery(delivery, { ackResult = null } = {}) {
    const snapshot = { ...delivery };
    deliveryHistory.set(snapshot.eventId, snapshot);
    lastDelivery = snapshot;
    if (ackResult) {
      lastAckResult = { ...ackResult };
    }
    updateStatus({ lastDelivery, lastAckResult });
    emitter.emit("delivery", snapshot);
    return snapshot;
  }

  function finalizeDelivery(eventId, state, extra = {}) {
    const pending = pendingAcks.get(eventId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingAcks.delete(eventId);
    }
    const delivery = pending?.delivery || deliveryHistory.get(eventId);
    if (!delivery) {
      return null;
    }
    Object.assign(delivery, {
      state,
      ackState: state,
      ok: state === "acknowledged",
      updatedAt: new Date(now()).toISOString(),
      ...extra,
    });
    const ackResult =
      (delivery.ackRequired || ["rejected", "timed-out", "send-failed"].includes(state)) &&
      state !== "pending"
        ? {
            eventId: delivery.eventId,
            type: delivery.type,
            ok: state === "acknowledged",
            state,
            message: delivery.message || null,
            receivedAt: delivery.updatedAt,
          }
        : null;
    const snapshot = publishDelivery(delivery, { ackResult });
    if (state === "timed-out") {
      emitter.emit("ack-timeout", { eventId: delivery.eventId, type: delivery.type, delivery: snapshot });
    }
    return snapshot;
  }

  function scheduleReconnect() {
    if (!running || reconnectTimer || !enabled || adapterError) {
      return;
    }
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectMaxMs, Math.max(delay * 2, reconnectMinMs));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    updateStatus({ state: "disconnected", message: `Syndocal reconnect scheduled in ${delay}ms` });
  }

  function handleMessage(raw) {
    if (!adapterObject) {
      return;
    }
    const message = adapterObject.decode?.(raw);
    if (!message || typeof message !== "object") {
      emitter.emit("message", raw);
      return;
    }
    emitter.emit("message", message);
    if (adapterObject.isAck?.(message)) {
      const eventId = String(message.eventId);
      const ok = message.ok !== false;
      const delivery = finalizeDelivery(eventId, ok ? "acknowledged" : "rejected", {
        message: message.message || message.error || null,
        ack: message,
      });
      status.lastAckAt = new Date(now()).toISOString();
      updateStatus({ lastAckAt: status.lastAckAt });
      emitter.emit("ack", {
        eventId,
        ok,
        message,
        delivery,
      });
      return;
    }
    if (adapterObject.isStateSyncRequest?.(message)) {
      sendStateSync();
      return;
    }
    if (adapterObject.isTimelineState?.(message) || String(message.type || "").trim() === "DJ_TIMELINE_STATE") {
      const timelineState = adapterObject.decodeTimelineState?.(message);
      if (!timelineState) {
        const warning = "Invalid DJ_TIMELINE_STATE ignored; expected state and boolean loopActive";
        updateStatus({ lastError: warning });
        emitter.emit("warning", { message: warning, type: "DJ_TIMELINE_STATE", raw: message });
        return;
      }
      emitter.emit("timeline-state", timelineState);
      return;
    }
    if (String(message.type || "").trim().startsWith("DJ_TIMELINE_")) {
      const warning = `Unknown Syndocal timeline message ignored: ${String(message.type)}`;
      updateStatus({ lastError: warning });
      emitter.emit("warning", { message: warning, type: String(message.type), raw: message });
    }
  }

  function sendRaw(message, { kind = "message" } = {}) {
    if (!socketIsOpen(socket)) {
      emitter.emit("send-failed", { kind, reason: "disconnected", message });
      return false;
    }
    try {
      socket.send(JSON.stringify(message));
      emitter.emit("sent", { kind, message });
      return true;
    } catch (error) {
      updateStatus({ lastError: error?.message || String(error), message: "Syndocal send failed" });
      emitter.emit("send-failed", { kind, reason: "send-error", error, message });
      return false;
    }
  }

  function sendHeartbeat() {
    const envelope = nextEnvelopeId();
    const message = adapterObject?.encodeHeartbeat
      ? adapterObject.encodeHeartbeat(envelope)
      : { type: "DJ_AGENT_HEARTBEAT", ...envelope };
    sendRaw(message, { kind: "heartbeat" });
  }

  function startHeartbeat() {
    clearHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, heartbeatMs);
  }

  function sendHello() {
    const envelope = nextEnvelopeId();
    const message = adapterObject?.encodeHello
      ? adapterObject.encodeHello(envelope)
      : { type: "DJ_AGENT_HELLO", ...envelope };
    return sendRaw(message, { kind: "hello" });
  }

  function sendStateSync() {
    const envelope = nextEnvelopeId();
    let state;
    try {
      state = stateSyncProvider() || {};
    } catch (error) {
      emitter.emit("state-sync-error", error);
      state = {};
    }
    const message = adapterObject?.encodeStateSync
      ? adapterObject.encodeStateSync({ ...envelope, state })
      : { type: "DJ_STATE_SYNC", ...envelope, ...state };
    return sendRaw(message, { kind: "state-sync" });
  }

  function sendTimelineStateRequest() {
    if (typeof adapterObject?.encodeTimelineStateRequest !== "function") {
      return false;
    }
    const envelope = nextEnvelopeId();
    const message = adapterObject.encodeTimelineStateRequest(envelope);
    return sendRaw(message, { kind: "timeline-state-request" });
  }

  function sendEvent(input) {
    const source = typeof input === "string" ? { type: input } : input || {};
    const type = String(source.type || "").trim();
    if (!type) {
      return { sent: false, ok: false, state: "send-failed", ackState: "send-failed", reason: "missing-type" };
    }
    if (!adapterObject) {
      return {
        eventId: source.eventId || null,
        type,
        sent: false,
        ok: false,
        state: "send-failed",
        ackState: "send-failed",
        reason: "adapter-unavailable",
      };
    }
    const requiresAck = ackTypes.has(type);
    const envelope = {
      eventId: source.eventId != null ? String(source.eventId) : makeId(),
      sequence: Number.isFinite(Number(source.sequence)) ? Number(source.sequence) : ++sequence,
    };
    sequence = Math.max(sequence, envelope.sequence);
    const payload = source.payload && typeof source.payload === "object" ? source.payload : {};
    const event = { ...source, ...envelope, type, payload };
    const message = adapterObject.encodeEvent
      ? adapterObject.encodeEvent(event)
      : { type, ...envelope, ...payload };
    const delivery = {
      eventId: envelope.eventId,
      type,
      state: "pending",
      ackState: "pending",
      ok: false,
      sent: false,
      ackRequired: requiresAck,
      createdAt: new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
    };
    if (requiresAck) {
      const timer = setTimeout(() => {
        if (pendingAcks.has(envelope.eventId)) {
          finalizeDelivery(envelope.eventId, "timed-out", { reason: "ack-timeout" });
        }
      }, Math.max(1, Number(ackTimeoutMs) || 1));
      pendingAcks.set(envelope.eventId, { type, timer, delivery });
      publishDelivery(delivery);
    }
    const sent = sendRaw(message, { kind: "event", type, eventId: envelope.eventId });
    delivery.sent = sent;
    if (!sent) {
      if (requiresAck) {
        finalizeDelivery(envelope.eventId, "send-failed", { reason: "not-sent" });
      } else {
        delivery.state = "send-failed";
        delivery.ackState = "send-failed";
        delivery.reason = "not-sent";
        publishDelivery(delivery);
      }
    } else if (!requiresAck) {
      delivery.state = "acknowledged";
      delivery.ackState = "acknowledged";
      delivery.ok = true;
      publishDelivery(delivery);
    } else {
      // The ACK may be delivered synchronously by an in-process peer. Do not
      // overwrite a final ACK state with pending in that case.
      delivery.ackState = delivery.state;
      publishDelivery(delivery);
    }
    return {
      ...envelope,
      type,
      sent,
      ok: delivery.ok,
      state: delivery.state,
      ackState: delivery.state,
      awaitingAck: delivery.state === "pending",
      delivery: { ...delivery },
    };
  }

  function handleOpen() {
    reconnectDelay = Math.max(50, reconnectMinMs);
    updateStatus({ state: "connected", message: "Syndocal connected", lastError: null });
    startHeartbeat();
    sendHello();
    sendStateSync();
    sendTimelineStateRequest();
    emitter.emit("connected", { url });
  }

  function handleClose(code, reason) {
    clearHeartbeat();
    clearSocketListeners();
    socket = null;
    updateStatus({
      state: "disconnected",
      message: `Syndocal disconnected${code != null ? ` (${code})` : ""}`,
      closeCode: code ?? null,
      closeReason: reason ? String(reason) : null,
    });
    emitter.emit("disconnected", { code, reason });
    scheduleReconnect();
  }

  function handleError(error) {
    const message = error?.message || String(error);
    updateStatus({
      state: "disconnected",
      message: `Syndocal connection error: ${message}`,
      lastError: message,
    });
    emitter.emit("adapter-error", error);
    // Some WebSocket implementations emit error without close. Tear down the
    // current socket here so reconnect is guaranteed and close cannot schedule
    // a second timer.
    if (socket) {
      const failedSocket = socket;
      clearHeartbeat();
      clearSocketListeners();
      socket = null;
      try {
        failedSocket.close?.();
      } catch {
        // Ignore close errors after an adapter error.
      }
    }
    scheduleReconnect();
  }

  function connect() {
    if (!running || !enabled || socket) {
      return;
    }
    if (adapterError || !adapterObject) {
      running = false;
      updateStatus({ state: "unavailable", message: adapterError || "Syndocal adapter unavailable" });
      emitter.emit("unavailable", { reason: "adapter-unavailable", message: adapterError });
      return;
    }
    const Implementation = WebSocketImpl || resolveWebSocketImplementation(wsModule);
    if (typeof Implementation !== "function") {
      running = false;
      updateStatus({
        state: "unavailable",
        message: "Syndocal WebSocket unavailable; install optional ws dependency",
        lastError: "WebSocket implementation not found",
      });
      emitter.emit("unavailable", { reason: "missing-websocket-dependency" });
      return;
    }
    updateStatus({ state: "connecting", message: `Connecting to Syndocal ${url}` });
    try {
      const options = {};
      if (token) {
        options.headers = { Authorization: `Bearer ${token}` };
      }
      if (nic) {
        options.localAddress = nic;
      }
      socket = new Implementation(url, Object.keys(options).length > 0 ? options : undefined);
    } catch (error) {
      socket = null;
      handleError(error);
      return;
    }
    socketCleanups.push(addSocketListener(socket, "open", handleOpen));
    socketCleanups.push(addSocketListener(socket, "message", handleMessage));
    socketCleanups.push(addSocketListener(socket, "error", handleError));
    socketCleanups.push(addSocketListener(socket, "close", handleClose));
  }

  function start() {
    if (!enabled) {
      updateStatus({ state: "disabled", message: "Syndocal integration disabled by config" });
      return;
    }
    if (adapterError) {
      updateStatus({ state: "unavailable", message: adapterError, lastError: adapterError });
      emitter.emit("unavailable", { reason: "adapter-unavailable", message: adapterError });
      return;
    }
    if (running) {
      return;
    }
    running = true;
    connect();
  }

  function stop() {
    running = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    clearHeartbeat();
    for (const eventId of [...pendingAcks.keys()]) {
      finalizeDelivery(eventId, "send-failed", { reason: "stopped" });
    }
    const closingSocket = socket;
    clearSocketListeners();
    socket = null;
    if (closingSocket && typeof closingSocket.close === "function") {
      try {
        closingSocket.close();
      } catch {
        // Ignore close errors during process shutdown.
      }
    }
    if (enabled) {
      updateStatus({ state: adapterError ? "unavailable" : "disconnected", message: "Syndocal client stopped" });
    }
  }

  function getStatus() {
    return {
      ...status,
      pendingAcks: pendingAcks.size,
      lastDelivery: lastDelivery ? { ...lastDelivery } : null,
      lastAckResult: lastAckResult ? { ...lastAckResult } : null,
    };
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    getStatus,
    sendEvent,
    sendStateSync,
    sendTimelineStateRequest,
    start,
    stop,
  };
}

module.exports = {
  createGenericJsonAdapter,
  createSyndocalClient,
  normalizeTimelineState,
  resolveAdapter,
  resolveWebSocketImplementation,
};
