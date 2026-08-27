const { EventEmitter } = require("node:events");
const { resolveMidiModule } = require("./midiModuleResolver");

function clampMidi(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(0, Math.min(127, Math.trunc(number)));
}

function normalizeChannel(value, fallback = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.max(1, Math.min(16, Math.trunc(number)));
}

function normalizeDeck(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? number : null;
}

function normalizeDeckChannels(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result = {};
  for (const [rawDeck, rawChannel] of Object.entries(value)) {
    const deck = normalizeDeck(rawDeck);
    const channel = Number(rawChannel);
    if (deck == null || !Number.isInteger(channel) || channel < 1 || channel > 16) {
      continue;
    }
    result[String(deck)] = channel;
  }
  return result;
}

function normalizeMessageType(value) {
  const text = String(value || "controlChange").trim().toLowerCase().replace(/[-_ ]/g, "");
  if (["noteon", "note"].includes(text)) return "noteOn";
  if (["noteoff"].includes(text)) return "noteOff";
  if (["cc", "controlchange", "controller"].includes(text)) return "controlChange";
  if (["programchange", "program"].includes(text)) return "programChange";
  return "controlChange";
}

function normalizeMapping(mapping = {}) {
  if (!mapping || typeof mapping !== "object") {
    return null;
  }
  const messageType = normalizeMessageType(mapping.messageType || mapping.type);
  const data1 = mapping.data1 ?? (messageType.startsWith("note")
    ? mapping.note
    : messageType === "controlChange"
      ? mapping.cc ?? mapping.controller
      : mapping.program);
  if (!Number.isFinite(Number(data1))) {
    return null;
  }
  return {
    device: mapping.device ? String(mapping.device) : null,
    channel: normalizeChannel(mapping.channel, 1),
    messageType,
    data1: clampMidi(data1),
    value: clampMidi(mapping.value ?? mapping.velocity ?? 127, 127),
  };
}

function statusByte(mapping) {
  const base = {
    noteOn: 0x90,
    noteOff: 0x80,
    controlChange: 0xb0,
    programChange: 0xc0,
  }[mapping.messageType] || 0xb0;
  return base + mapping.channel - 1;
}

function createRekordboxMidi({
  enabled = false,
  moduleName = "@julusian/midi",
  device = "",
  port = null,
  mappings = {},
  filter = {},
  deckChannels = {},
  midiModule = null,
  outputFactory = null,
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const emitter = new EventEmitter();
  const normalizedMappings = {};
  for (const [name, mapping] of Object.entries(mappings || {})) {
    const normalized = normalizeMapping(mapping);
    if (normalized) {
      normalizedMappings[name] = normalized;
    }
  }
  const normalizedDeckChannels = normalizeDeckChannels(deckChannels);
  let output = null;
  let opened = false;
  let rampTimer = null;
  let rampGeneration = 0;
  let rampStartedAt = 0;
  let status = {
    enabled: Boolean(enabled),
    ok: false,
    available: false,
    message: enabled ? "MIDI output not started" : "MIDI integration disabled by config",
    device: device || null,
    port: port,
    deckChannels: { ...normalizedDeckChannels },
    updatedAt: new Date(now()).toISOString(),
    rampActive: false,
  };

  function updateStatus(patch) {
    status = { ...status, ...patch, enabled: Boolean(enabled), updatedAt: new Date(now()).toISOString() };
    emitter.emit("status", { ...status });
  }

  function readExactPortName(outputObject, index) {
    try {
      const name = outputObject?.getPortName?.(index);
      return typeof name === "string" ? name.trim() : null;
    } catch {
      // A native name-read failure must fail closed, never guess a match.
      return null;
    }
  }

  function choosePort(outputObject) {
    const count = Number(outputObject?.getPortCount?.() || 0);
    if (!Number.isSafeInteger(count) || count <= 0) {
      return null;
    }
    const requestedPort = typeof port === "number" && Number.isSafeInteger(port) && port >= 0
      ? port
      : null;
    const requestedDevice = typeof device === "string" && device.trim() ? device.trim() : null;
    if (
      requestedPort == null
      || requestedPort >= count
      || requestedDevice == null
      || typeof outputObject.getPortName !== "function"
    ) {
      return null;
    }
    // One exact, case-sensitive, trimmed device-name rule shared with the
    // setup probe: the selected port must carry the literal configured name,
    // and that name must be unique across every enumerated port. Duplicate
    // identical port names are ambiguous and always fail closed.
    if (readExactPortName(outputObject, requestedPort) !== requestedDevice) {
      return null;
    }
    for (let index = 0; index < count; index += 1) {
      if (index !== requestedPort && readExactPortName(outputObject, index) === requestedDevice) {
        return null;
      }
    }
    return { port: requestedPort, device: requestedDevice };
  }

  function releaseOutput(outputObject, closeOpenedPort = false) {
    if (!outputObject) {
      return;
    }
    if (closeOpenedPort && typeof outputObject.closePort === "function") {
      try {
        outputObject.closePort();
      } catch {
        // Shutdown and failed-start cleanup remain best-effort.
      }
    }
    if (typeof outputObject.destroy === "function") {
      try {
        outputObject.destroy();
      } catch {
        // Native-handle release failure is reported through connection state.
      }
    }
  }

  function start() {
    if (!enabled) {
      updateStatus({ ok: false, available: false, message: "MIDI integration disabled by config" });
      return;
    }
    if (opened) {
      return;
    }
    const moduleObject = midiModule || resolveMidiModule(moduleName);
    const factory = outputFactory || (() => new moduleObject.Output());
    if (!moduleObject && !outputFactory) {
      updateStatus({
        ok: false,
        available: false,
        message: "MIDI unavailable; install optional midi dependency or configure another transport",
      });
      emitter.emit("unavailable", { reason: "missing-midi-dependency" });
      return;
    }
    let portOpened = false;
    try {
      output = factory();
      const selection = choosePort(output);
      if (!selection || typeof output.openPort !== "function") {
        const message = device && port == null
          ? "MIDI_DEVICE requires the matching MIDI_PORT"
          : "No configured MIDI output device found";
        updateStatus({ ok: false, available: true, message });
        releaseOutput(output);
        output = null;
        return;
      }
      try {
        if (output.openPort(selection.port) === false) {
          // An explicit refusal means no port was opened; skip the close attempt.
          updateStatus({ ok: false, available: true, message: "Configured MIDI output could not be opened" });
          releaseOutput(output);
          output = null;
          return;
        }
        portOpened = true;
      } catch {
        // A thrown open can leave the port partially opened natively, so the
        // open attempt gets exactly one best-effort close before destroy,
        // without masking the primary failure.
        releaseOutput(output, true);
        output = null;
        updateStatus({ ok: false, available: true, message: "MIDI output error" });
        emitter.emit("adapter-error", { code: "midi-open-failed", message: "MIDI output error" });
        return;
      }
      const observedAfterOpen = typeof output.getPortName === "function"
        ? String(output.getPortName(selection.port) || "").trim()
        : "";
      if (observedAfterOpen !== selection.device) {
        releaseOutput(output, true);
        output = null;
        updateStatus({ ok: false, available: true, message: "Configured MIDI output identity changed" });
        return;
      }
      opened = true;
      updateStatus({
        ok: true,
        available: true,
        message: "MIDI output connected",
        port: selection.port,
        device: selection.device,
      });
    } catch {
      releaseOutput(output, portOpened || opened);
      output = null;
      opened = false;
      updateStatus({ ok: false, available: true, message: "MIDI output error" });
      emitter.emit("adapter-error", { code: "midi-start-failed", message: "MIDI output error" });
    }
  }

  function sendMessage(message, context = {}) {
    if (!opened || !output || typeof output.sendMessage !== "function") {
      emitter.emit("send-failed", { reason: "not-connected", message, ...context });
      return false;
    }
    try {
      output.sendMessage(message);
      emitter.emit("sent", { message, ...context });
      return true;
    } catch {
      emitter.emit("send-failed", { reason: "send-error", code: "midi-send-failed", message, ...context });
      updateStatus({ ok: false, message: "MIDI send failed" });
      return false;
    }
  }

  function resolveTarget(
    name,
    targetDeck,
    baseMapping = normalizedMappings[name],
    channelOverride = null,
  ) {
    const deck = normalizeDeck(targetDeck);
    const configuredChannel = deck == null ? null : normalizedDeckChannels[String(deck)];
    const fallbackChannel = channelOverride != null
      ? normalizeChannel(channelOverride, baseMapping?.channel ?? 1)
      : baseMapping?.channel ?? (name === "filter" ? normalizeChannel(filter.channel, 1) : null);
    return {
      targetDeck: deck,
      targetChannel: deck == null ? fallbackChannel || null : configuredChannel || null,
    };
  }

  function sendNormalizedMapping(name, mapping, context = {}) {
    if (!mapping) {
      emitter.emit("mapping-missing", { name });
      return false;
    }
    const message = [statusByte(mapping), mapping.data1];
    if (mapping.messageType !== "programChange") {
      message.push(mapping.value);
    }
    return sendMessage(message, {
      mapping: name,
      targetDeck: context.targetDeck ?? null,
      targetChannel: context.targetChannel ?? mapping.channel,
    });
  }

  function sendMapping(name, override = {}) {
    const base = normalizedMappings[name];
    if (!base) {
      emitter.emit("mapping-missing", { name });
      return false;
    }
    const { targetDeck, ...mappingOverride } = override && typeof override === "object" ? override : {};
    const target = resolveTarget(name, targetDeck, base, mappingOverride.channel);
    if (target.targetDeck != null && target.targetChannel == null) {
      emitter.emit("mapping-target-unavailable", { name, targetDeck: target.targetDeck });
      return false;
    }
    const mapping = normalizeMapping({
      ...base,
      ...mappingOverride,
      ...(target.targetChannel == null ? {} : { channel: target.targetChannel }),
    });
    if (!mapping) {
      emitter.emit("mapping-invalid", { name });
      return false;
    }
    return sendNormalizedMapping(name, mapping, target);
  }

  function startFilterRamp(options = {}) {
    const target = resolveTarget("filter", options.targetDeck, normalizedMappings.filter || {
      channel: normalizeChannel(filter.channel, 1),
    });
    if (rampTimer) {
      return { started: false, ok: false, reason: "ramp-in-progress", ...target };
    }
    if (!opened || !output) {
      return { started: false, ok: false, reason: "midi-not-connected", ...target };
    }
    if (target.targetDeck != null && target.targetChannel == null) {
      return { started: false, ok: false, reason: "filter-target-channel-missing", ...target };
    }
    const mapping = normalizedMappings.filter || normalizeMapping({
      messageType: "controlChange",
      channel: filter.channel,
      cc: filter.cc,
      value: filter.startValue,
    });
    if (!mapping) {
      emitter.emit("mapping-missing", { name: "filter" });
      return { started: false, ok: false, reason: "filter-mapping-missing", ...target };
    }
    const startValue = clampMidi(options.startValue ?? filter.startValue, 127);
    const endValue = clampMidi(options.endValue ?? filter.endValue, 0);
    const durationMs = Math.max(1, Number(options.durationMs ?? filter.durationMs ?? 2_000));
    const updateIntervalMs = Math.max(1, Number(options.updateIntervalMs ?? filter.updateIntervalMs ?? 50));
    const startedAt = now();
    rampStartedAt = startedAt;
    const sendAt = (value) => sendNormalizedMapping("filter", {
      ...mapping,
      channel: target.targetChannel || mapping.channel,
      value,
    }, target);
    if (!sendAt(startValue)) {
      rampStartedAt = 0;
      options.onError?.({ reason: "midi-send-failed", value: startValue });
      return { started: false, ok: false, reason: "midi-send-failed", ...target };
    }
    updateStatus({ rampActive: true });
    const generation = ++rampGeneration;
    rampTimer = setIntervalImpl(() => {
      // clearInterval prevents future callbacks in production. The generation
      // fence also makes an already-queued callback a no-op, so an F13 Stop
      // cannot be followed by a stale ramp CC under a timer-boundary race.
      if (generation !== rampGeneration || !rampTimer) return;
      const elapsed = now() - startedAt;
      const progress = Math.min(1, elapsed / durationMs);
      const value = Math.round(startValue + (endValue - startValue) * progress);
      if (!sendAt(value)) {
        clearIntervalImpl(rampTimer);
        rampTimer = null;
        rampGeneration += 1;
        rampStartedAt = 0;
        updateStatus({ rampActive: false, ok: false, message: "MIDI filter ramp stopped after send failure" });
        emitter.emit("ramp-error", { reason: "midi-send-failed", value });
        options.onError?.({ reason: "midi-send-failed", value });
        return;
      }
      if (progress >= 1) {
        clearIntervalImpl(rampTimer);
        rampTimer = null;
        rampGeneration += 1;
        rampStartedAt = 0;
        updateStatus({ rampActive: false });
        emitter.emit("ramp-complete", { startValue, endValue, durationMs });
        options.onComplete?.({ startValue, endValue, durationMs, ...target });
      }
    }, updateIntervalMs);
    return {
      started: true,
      ok: true,
      startValue,
      endValue,
      durationMs,
      updateIntervalMs,
      ...target,
    };
  }

  function cancelFilterRamp(reason = "cancelled") {
    if (!rampTimer) {
      return false;
    }
    clearIntervalImpl(rampTimer);
    rampTimer = null;
    rampGeneration += 1;
    rampStartedAt = 0;
    updateStatus({ rampActive: false, message: `MIDI filter ramp ${reason}` });
    return true;
  }

  function stop() {
    if (rampTimer) {
      clearIntervalImpl(rampTimer);
      rampTimer = null;
    }
    rampGeneration += 1;
    rampStartedAt = 0;
    releaseOutput(output, opened);
    output = null;
    opened = false;
    updateStatus({ ok: false, rampActive: false, message: enabled ? "MIDI output stopped" : status.message });
  }

  function getStatus() {
    return {
      ...status,
      rampActive: Boolean(rampTimer),
      rampStartedAt,
    };
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    getStatus,
    cancelFilterRamp,
    resolveTarget,
    sendMapping,
    sendMessage,
    start,
    startFilterRamp,
    stop,
  };
}

module.exports = {
  clampMidi,
  createRekordboxMidi,
  normalizeDeckChannels,
  normalizeMapping,
  normalizeMessageType,
  resolveMidiModule,
};
