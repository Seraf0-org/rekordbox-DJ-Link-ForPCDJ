const { EventEmitter } = require("node:events");

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

function resolveMidiModule(moduleName = "") {
  const candidates = moduleName
    ? [moduleName]
    : ["@julusian/midi", "midi"];
  for (const candidate of candidates) {
    try {
      // Keep the supported optional packages as literal requires so pkg can
      // discover and include their Windows native prebuilds.
      if (candidate === "@julusian/midi") {
        return require("@julusian/midi");
      }
      if (candidate === "midi") {
        return require("midi");
      }
      return require(candidate);
    } catch {
      // Optional adapters are best-effort; try the next built-in fallback.
    }
  }
  return null;
}

function createRekordboxMidi({
  enabled = false,
  moduleName = "@julusian/midi",
  device = "",
  port = null,
  mappings = {},
  filter = {},
  deckChannels = {},
  releaseFade = {},
  midiModule = null,
  outputFactory = null,
  now = () => Date.now(),
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
  let rampStartedAt = 0;
  let releaseFadeTimer = null;
  let releaseFadeStartedAt = 0;
  let status = {
    enabled: Boolean(enabled),
    ok: false,
    available: false,
    message: enabled ? "MIDI output not started" : "MIDI integration disabled by config",
    device: device || null,
    port: port,
    deckChannels: { ...normalizedDeckChannels },
    releaseFadeConfigured: false,
    releaseFadeActive: false,
    updatedAt: new Date(now()).toISOString(),
    rampActive: false,
  };

  function updateStatus(patch) {
    status = { ...status, ...patch, enabled: Boolean(enabled), updatedAt: new Date(now()).toISOString() };
    emitter.emit("status", { ...status });
  }

  function choosePort(outputObject) {
    const count = Number(outputObject?.getPortCount?.() || 0);
    if (count <= 0) {
      return null;
    }
    const requestedPort =
      port == null || String(port).trim() === ""
        ? null
        : Number.isFinite(Number(port))
          ? Math.trunc(Number(port))
          : null;
    if (requestedPort != null && requestedPort >= 0 && requestedPort < count) {
      return requestedPort;
    }
    if (device && typeof outputObject.getPortName === "function") {
      for (let index = 0; index < count; index += 1) {
        if (String(outputObject.getPortName(index) || "").toLowerCase().includes(device.toLowerCase())) {
          return index;
        }
      }
    }
    return device ? null : 0;
  }

  function start() {
    if (!enabled) {
      updateStatus({ ok: false, available: false, message: "MIDI integration disabled by config" });
      return;
    }
    if (opened) {
      return;
    }
    const moduleObject =
      midiModule || resolveMidiModule(moduleName === "@julusian/midi" ? "" : moduleName);
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
    try {
      output = factory();
      const selectedPort = choosePort(output);
      if (selectedPort == null || typeof output.openPort !== "function") {
        updateStatus({ ok: false, available: true, message: "No configured MIDI output device found" });
        output = null;
        return;
      }
      output.openPort(selectedPort);
      opened = true;
      updateStatus({
        ok: true,
        available: true,
        message: "MIDI output connected",
        port: selectedPort,
        device: typeof output.getPortName === "function" ? output.getPortName(selectedPort) : device || null,
      });
    } catch (error) {
      output = null;
      opened = false;
      updateStatus({ ok: false, available: true, message: `MIDI output error: ${error?.message || String(error)}` });
      emitter.emit("adapter-error", error);
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
    } catch (error) {
      emitter.emit("send-failed", { reason: "send-error", error, message, ...context });
      updateStatus({ ok: false, message: `MIDI send failed: ${error?.message || String(error)}` });
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
      targetChannel: configuredChannel || fallbackChannel || null,
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
    rampTimer = setInterval(() => {
      const elapsed = now() - startedAt;
      const progress = Math.min(1, elapsed / durationMs);
      const value = Math.round(startValue + (endValue - startValue) * progress);
      if (!sendAt(value)) {
        clearInterval(rampTimer);
        rampTimer = null;
        rampStartedAt = 0;
        updateStatus({ rampActive: false, ok: false, message: "MIDI filter ramp stopped after send failure" });
        emitter.emit("ramp-error", { reason: "midi-send-failed", value });
        options.onError?.({ reason: "midi-send-failed", value });
        return;
      }
      if (progress >= 1) {
        clearInterval(rampTimer);
        rampTimer = null;
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

  function releaseFadeMapping() {
    if (releaseFade?.enabled === false) {
      return null;
    }
    return normalizedMappings[releaseFade?.mappingName || "releaseFade"] || null;
  }

  function releaseFadeTarget(targetDeck, mapping) {
    const scope = String(releaseFade?.target || "deck").trim().toLowerCase();
    return resolveTarget(
      releaseFade?.mappingName || "releaseFade",
      scope === "global" ? null : targetDeck,
      mapping,
    );
  }

  function hasReleaseFade() {
    return Boolean(releaseFadeMapping());
  }

  function startReleaseFade(options = {}) {
    const mapping = releaseFadeMapping();
    const target = releaseFadeTarget(options.targetDeck, mapping);
    if (releaseFadeTimer) {
      return { started: false, ok: false, reason: "release-fade-in-progress", ...target };
    }
    if (!mapping) {
      return { started: false, ok: false, reason: "release-fade-mapping-missing", ...target };
    }
    if (!opened || !output) {
      return { started: false, ok: false, reason: "midi-not-connected", ...target };
    }
    const startValue = clampMidi(options.startValue ?? releaseFade.startValue, 127);
    const endValue = clampMidi(options.endValue ?? releaseFade.endValue, 0);
    const durationMs = Math.max(1, Number(options.durationMs ?? releaseFade.durationMs ?? 1_000));
    const updateIntervalMs = Math.max(1, Number(options.updateIntervalMs ?? releaseFade.updateIntervalMs ?? 50));
    const startedAt = now();
    releaseFadeStartedAt = startedAt;
    const sendAt = (value) => sendNormalizedMapping(releaseFade.mappingName || "releaseFade", {
      ...mapping,
      channel: target.targetChannel || mapping.channel,
      value,
    }, { ...target, phase: "release-fade" });
    if (!sendAt(startValue)) {
      releaseFadeStartedAt = 0;
      options.onError?.({ reason: "midi-send-failed", value: startValue });
      return { started: false, ok: false, reason: "midi-send-failed", ...target };
    }
    updateStatus({ releaseFadeActive: true });
    releaseFadeTimer = setInterval(() => {
      const elapsed = now() - startedAt;
      const progress = Math.min(1, elapsed / durationMs);
      const value = Math.round(startValue + (endValue - startValue) * progress);
      if (!sendAt(value)) {
        clearInterval(releaseFadeTimer);
        releaseFadeTimer = null;
        releaseFadeStartedAt = 0;
        updateStatus({ releaseFadeActive: false, ok: false, message: "MIDI release fade stopped after send failure" });
        emitter.emit("release-fade-error", { reason: "midi-send-failed", value, ...target });
        options.onError?.({ reason: "midi-send-failed", value, ...target });
        return;
      }
      if (progress >= 1) {
        clearInterval(releaseFadeTimer);
        releaseFadeTimer = null;
        releaseFadeStartedAt = 0;
        updateStatus({ releaseFadeActive: false });
        const result = { startValue, endValue, durationMs, updateIntervalMs, ...target };
        emitter.emit("release-fade-complete", result);
        options.onComplete?.(result);
      }
    }, updateIntervalMs);
    return {
      started: true,
      ok: true,
      startValue,
      endValue,
      durationMs,
      updateIntervalMs,
      resetAfterStop: releaseFade.resetAfterStop === true || releaseFade.resetPolicy === "restore-after-stop",
      resetValue: clampMidi(releaseFade.resetValue, startValue),
      resetDelayMs: Math.max(0, Number(releaseFade.resetDelayMs) || 0),
      ...target,
    };
  }

  function resetReleaseFade(options = {}) {
    const mapping = releaseFadeMapping();
    const target = releaseFadeTarget(options.targetDeck, mapping);
    if (!mapping) {
      return { ok: false, reason: "release-fade-mapping-missing", ...target };
    }
    const value = clampMidi(options.value ?? releaseFade.resetValue, 127);
    const sent = sendNormalizedMapping(releaseFade.mappingName || "releaseFade", {
      ...mapping,
      channel: target.targetChannel || mapping.channel,
      value,
    }, { ...target, phase: "release-fade-reset" });
    return { ok: sent, value, reason: sent ? null : "midi-send-failed", ...target };
  }

  function cancelFilterRamp(reason = "cancelled") {
    if (!rampTimer) {
      return false;
    }
    clearInterval(rampTimer);
    rampTimer = null;
    rampStartedAt = 0;
    updateStatus({ rampActive: false, message: `MIDI filter ramp ${reason}` });
    return true;
  }

  function cancelReleaseFade(reason = "cancelled") {
    if (!releaseFadeTimer) {
      return false;
    }
    clearInterval(releaseFadeTimer);
    releaseFadeTimer = null;
    releaseFadeStartedAt = 0;
    updateStatus({ releaseFadeActive: false, message: `MIDI release fade ${reason}` });
    return true;
  }

  function stop() {
    if (rampTimer) {
      clearInterval(rampTimer);
      rampTimer = null;
    }
    if (releaseFadeTimer) {
      clearInterval(releaseFadeTimer);
      releaseFadeTimer = null;
    }
    rampStartedAt = 0;
    releaseFadeStartedAt = 0;
    if (opened && output && typeof output.closePort === "function") {
      try {
        output.closePort();
      } catch {
        // Ignore close errors during shutdown.
      }
    }
    output = null;
    opened = false;
    updateStatus({ ok: false, rampActive: false, message: enabled ? "MIDI output stopped" : status.message });
  }

  function getStatus() {
    return {
      ...status,
      rampActive: Boolean(rampTimer),
      rampStartedAt,
      releaseFadeActive: Boolean(releaseFadeTimer),
      releaseFadeStartedAt,
      releaseFadeConfigured: hasReleaseFade(),
    };
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    getStatus,
    cancelFilterRamp,
    cancelReleaseFade,
    hasReleaseFade,
    resetReleaseFade,
    resolveTarget,
    sendMapping,
    sendMessage,
    start,
    startFilterRamp,
    startReleaseFade,
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
