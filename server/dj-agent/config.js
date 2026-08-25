const fs = require("node:fs");
const path = require("node:path");

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value == null || String(value).trim() === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function asNumber(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  if (value == null || String(value).trim() === "") {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    return fallback;
  }
  return number;
}

function parseJson(value, fallback) {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readConfigFile(filePath, fsApi = fs) {
  if (!filePath) {
    return { config: {}, warning: null };
  }

  // These warnings are copied into the public /api/status snapshot. Keep the
  // reason useful to an operator without reflecting the requested path,
  // username, token, or filesystem/parser exception text to LAN clients.
  const warning = (code) => `DJ Agent config warning: ${code}`;

  let raw;
  try {
    raw = fsApi.readFileSync(filePath, "utf8");
  } catch {
    return { config: {}, warning: warning("config-read-failed") };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: {}, warning: warning("config-invalid-json") };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { config: {}, warning: warning("config-invalid-object") };
  }
  return { config: parsed, warning: null };
}

function pickObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeBindings(bindings) {
  const input = pickObject(bindings);
  return {
    release: String(input.release || input.pedal1 || "F13").trim().toUpperCase(),
    loopHalf: String(input.loopHalf || input.loop_half || input.pedal2 || "F14").trim().toUpperCase(),
    filterClose: String(input.filterClose || input.filter_close || input.pedal3 || "F15").trim().toUpperCase(),
  };
}

function normalizeMidiMappings(mappings) {
  const input = pickObject(mappings);
  const aliases = {
    loopHalf: ["loopHalf", "loop_half"],
    stop: ["stop", "release"],
    filter: ["filter", "filterClose", "filter_close"],
    releaseFade: ["releaseFade", "release_fade", "fade", "channelFader", "channel_fader"],
    masterLevel: ["masterLevel", "master_level"],
    loopOff: ["loopOff", "loop_off"],
    filterReset: ["filterReset", "filter_reset"],
  };
  const result = {};
  for (const [name, keys] of Object.entries(aliases)) {
    const value = keys.map((key) => input[key]).find((item) => item && typeof item === "object");
    if (value) {
      result[name] = { ...value };
    }
  }
  return result;
}

function normalizeReleaseFadeTarget(value) {
  const normalized = String(value || "deck").trim().toLowerCase().replace(/[_ ]/g, "-");
  return normalized === "global" || normalized === "master" ? "global" : "deck";
}

function normalizeReleaseMacroSequence(value) {
  const normalized = String(value || "parallel")
    .trim()
    .toLowerCase()
    .replace(/[_ ]/g, "-");
  return normalized === "filter-then-fade" ? "filter-then-fade" : "parallel";
}

function normalizeDeckChannels(value) {
  const input = pickObject(value);
  const result = {};
  for (const [rawDeck, rawChannel] of Object.entries(input)) {
    const deck = Number(rawDeck);
    const channel = asNumber(rawChannel, null, { min: 1, max: 16 });
    if (!Number.isInteger(deck) || deck < 1 || channel == null) {
      continue;
    }
    result[String(deck)] = Math.trunc(channel);
  }
  return result;
}

function loadDjAgentConfig({ env = process.env, fsApi = fs, cwd = process.cwd() } = {}) {
  const requestedPath = String(env.DJ_AGENT_CONFIG_PATH || "").trim();
  const inlineConfig = String(env.DJ_AGENT_CONFIG || "").trim();
  const inlineLooksLikeJson = inlineConfig.startsWith("{") || inlineConfig.startsWith("[");
  const filePath = requestedPath
    ? path.resolve(cwd, requestedPath)
    : inlineConfig && !inlineLooksLikeJson && !/^(true|false|0|1)$/i.test(inlineConfig)
      ? path.resolve(cwd, inlineConfig)
      : "";
  const fileResult = readConfigFile(filePath, fsApi);
  const fileConfig = pickObject(fileResult.config);
  const inlineObject = inlineLooksLikeJson ? parseJson(inlineConfig, {}) : {};
  const merged = {
    ...fileConfig,
    ...inlineObject,
  };

  const envEnabled = env.DJ_AGENT_ENABLED;
  const explicitEnabled = envEnabled != null && String(envEnabled).trim() !== "";
  const enabled = explicitEnabled
    ? asBoolean(envEnabled, false)
    : asBoolean(merged.enabled, false);

  const syndocalFile = pickObject(merged.syndocal);
  const syndocalToken = Object.hasOwn(env, "SYNDOCAL_TOKEN")
    ? env.SYNDOCAL_TOKEN
    : syndocalFile.token;
  const pedalFile = pickObject(merged.pedal);
  const midiFile = pickObject(merged.midi);
  const releaseFadeValue =
    env.MIDI_RELEASE_FADE != null && String(env.MIDI_RELEASE_FADE).trim() !== ""
      ? parseJson(String(env.MIDI_RELEASE_FADE), {})
      : midiFile.releaseFade || midiFile.release_fade;
  const releaseFadeFile = pickObject(releaseFadeValue);
  const rawMidiMappings = pickObject(midiFile.mappings);
  const hasReleaseFadeMapping = [
    "releaseFade",
    "release_fade",
    "fade",
    "channelFader",
    "channel_fader",
  ].some((name) => rawMidiMappings[name] && typeof rawMidiMappings[name] === "object");
  const hasFilterMapping = ["filter", "filterClose", "filter_close"].some(
    (name) => rawMidiMappings[name] && typeof rawMidiMappings[name] === "object"
  ) || midiFile.filter?.cc != null;
  const releaseMacroValue =
    env.MIDI_RELEASE_MACRO != null && String(env.MIDI_RELEASE_MACRO).trim() !== ""
      ? parseJson(String(env.MIDI_RELEASE_MACRO), {})
      : midiFile.releaseMacro || midiFile.release_macro;
  const releaseMacroFile = pickObject(releaseMacroValue);
  const releaseFadeMappingName = String(
    releaseFadeFile.mappingName || releaseFadeFile.mapping || (hasReleaseFadeMapping ? "releaseFade" : "")
  ).trim();
  const deckChannelsValue =
    env.MIDI_DECK_CHANNELS != null && String(env.MIDI_DECK_CHANNELS).trim() !== ""
      ? parseJson(String(env.MIDI_DECK_CHANNELS), {})
      : midiFile.deckChannels;
  const midiPortValue =
    env.MIDI_PORT != null && String(env.MIDI_PORT).trim() !== ""
      ? env.MIDI_PORT
      : midiFile.port;
  const resetFile = pickObject(merged.releaseReset || merged.release_reset);
  // HTTP diagnostic action endpoints are permanently loopback-only on the DJ
  // PC; FOH control uses the authenticated /dj-link WebSocket. Any env or
  // config-file attempt to enable remote actions grants no authority and
  // yields exactly one fixed, secret-free notice (caller values are never
  // echoed back).
  const allowRemoteEnablementAttempted =
    asBoolean(env.DJ_AGENT_ALLOW_REMOTE_ACTIONS, false)
    || asBoolean(merged.allowRemoteActions, false);
  const allowRemoteDeprecationWarning = allowRemoteEnablementAttempted
    ? "DJ Agent security notice: DJ_AGENT_ALLOW_REMOTE_ACTIONS/allowRemoteActions is deprecated and ignored; HTTP action endpoints are permanently loopback-only"
    : null;
  const config = {
    enabled,
    allowRemoteActions: false,
    warning: fileResult.warning,
    allowRemoteDeprecationWarning,
    syndocal: {
      enabled: asBoolean(env.SYNDOCAL_ENABLED, asBoolean(syndocalFile.enabled, enabled)),
      host: String(env.SYNDOCAL_HOST || syndocalFile.host || "127.0.0.1").trim(),
      port: asNumber(env.SYNDOCAL_PORT || syndocalFile.port, 9100, { min: 1, max: 65535 }),
      path: String(env.SYNDOCAL_PATH || syndocalFile.path || "/dj-link").trim() || "/dj-link",
      nic: String(env.SYNDOCAL_NIC || syndocalFile.nic || syndocalFile.networkInterface || "").trim(),
      // Preserve the token exactly for the client preflight; do not trim,
      // persist, or log credentials here.
      token: typeof syndocalToken === "string" ? syndocalToken : "",
      adapter: String(env.SYNDOCAL_WS_ADAPTER || syndocalFile.adapter || "syndocal-envelope-v2").trim(),
      reconnectMinMs: asNumber(syndocalFile.reconnectMinMs, 500, { min: 50, max: 60_000 }),
      reconnectMaxMs: asNumber(syndocalFile.reconnectMaxMs, 10_000, { min: 250, max: 300_000 }),
      heartbeatMs: asNumber(
        env.SYNDOCAL_HEARTBEAT_MS ?? syndocalFile.heartbeatMs,
        5_000,
        { min: 1_000, max: 300_000 },
      ),
      ackTimeoutMs: asNumber(syndocalFile.ackTimeoutMs, 5_000, { min: 100, max: 120_000 }),
    },
    pedal: {
      enabled: asBoolean(env.PEDAL_ENABLED, asBoolean(pedalFile.enabled, enabled)),
      bindings: normalizeBindings(pedalFile.bindings),
      moduleName: String(env.PEDAL_MODULE || pedalFile.moduleName || "uiohook-napi").trim(),
    },
    midi: {
      enabled: asBoolean(env.MIDI_ENABLED, asBoolean(midiFile.enabled, enabled)),
      moduleName: String(env.MIDI_MODULE || midiFile.moduleName || "@julusian/midi").trim(),
      device: String(env.MIDI_DEVICE || midiFile.device || "").trim(),
      port: asNumber(midiPortValue, null, { min: 0, max: 4096 }),
      deckChannels: normalizeDeckChannels(deckChannelsValue),
      mappings: normalizeMidiMappings(midiFile.mappings),
      releaseFade: {
        enabled: asBoolean(releaseFadeFile.enabled, Boolean(releaseFadeMappingName)),
        mappingName: releaseFadeMappingName || "releaseFade",
        target: normalizeReleaseFadeTarget(releaseFadeFile.target || releaseFadeFile.scope),
        startValue: asNumber(releaseFadeFile.startValue ?? releaseFadeFile.start, 127, { min: 0, max: 127 }),
        endValue: asNumber(releaseFadeFile.endValue ?? releaseFadeFile.end, 0, { min: 0, max: 127 }),
        durationMs: asNumber(releaseFadeFile.durationMs ?? releaseFadeFile.duration, 1_000, { min: 1, max: 120_000 }),
        updateIntervalMs: asNumber(
          releaseFadeFile.updateIntervalMs ?? releaseFadeFile.updateInterval,
          50,
          { min: 1, max: 10_000 }
        ),
        resetPolicy: ["restore-after-stop", "restore", "reset"].includes(
          String(releaseFadeFile.resetPolicy || "").trim().toLowerCase()
        ) || asBoolean(releaseFadeFile.resetAfterStop, false)
          ? "restore-after-stop"
          : "none",
        resetAfterStop: asBoolean(
          releaseFadeFile.resetAfterStop,
          ["restore-after-stop", "restore", "reset"].includes(
            String(releaseFadeFile.resetPolicy || "").trim().toLowerCase()
          )
        ),
        resetValue: asNumber(releaseFadeFile.resetValue ?? releaseFadeFile.reset, 127, { min: 0, max: 127 }),
        resetDelayMs: asNumber(releaseFadeFile.resetDelayMs ?? releaseFadeFile.resetDelay, 0, { min: 0, max: 120_000 }),
      },
      releaseMacro: {
        enabled: asBoolean(
          releaseMacroFile.enabled,
          false
        ),
        sequence: normalizeReleaseMacroSequence(
          releaseMacroFile.sequence ?? releaseMacroFile.mode
        ),
        filter: {
          startValue: asNumber(
            releaseMacroFile.filter?.startValue ?? releaseMacroFile.filterStartValue,
            64,
            { min: 0, max: 127 }
          ),
          endValue: asNumber(
            releaseMacroFile.filter?.endValue ?? releaseMacroFile.filterEndValue,
            127,
            { min: 0, max: 127 }
          ),
          durationMs: asNumber(
            releaseMacroFile.filter?.durationMs ?? releaseMacroFile.filterDurationMs,
            1_000,
            { min: 1, max: 120_000 }
          ),
          updateIntervalMs: asNumber(
            releaseMacroFile.filter?.updateIntervalMs ?? releaseMacroFile.filterUpdateIntervalMs,
            50,
            { min: 1, max: 10_000 }
          ),
          resetValue: asNumber(
            releaseMacroFile.filter?.resetValue ?? releaseMacroFile.filterResetValue,
            64,
            { min: 0, max: 127 }
          ),
        },
        resetAfterStop: asBoolean(
          releaseMacroFile.resetAfterStop,
          asBoolean(releaseMacroFile.enabled, false)
            ? true
            : releaseFadeFile.resetAfterStop === true || releaseFadeFile.resetPolicy === "restore-after-stop"
        ),
        resetDelayMs: asNumber(
          releaseMacroFile.resetDelayMs ?? releaseMacroFile.resetDelay,
          releaseFadeFile.resetDelayMs ?? releaseFadeFile.resetDelay ?? 0,
          { min: 0, max: 120_000 }
        ),
      },
      filter: {
        channel: asNumber(midiFile.filter?.channel, 1, { min: 1, max: 16 }),
        cc: asNumber(midiFile.filter?.cc, null, { min: 0, max: 127 }),
        startValue: asNumber(midiFile.filter?.startValue, 127, { min: 0, max: 127 }),
        endValue: asNumber(midiFile.filter?.endValue, 0, { min: 0, max: 127 }),
        durationMs: asNumber(midiFile.filter?.durationMs ?? midiFile.filter?.duration, 2_000, { min: 1, max: 120_000 }),
        updateIntervalMs: asNumber(
          midiFile.filter?.updateIntervalMs ?? midiFile.filter?.updateInterval,
          50,
          { min: 1, max: 10_000 }
        ),
      },
    },
    releaseReset: {
      enabled: asBoolean(resetFile.enabled, false),
      steps: Array.isArray(resetFile.steps)
        ? resetFile.steps
            .filter((step) => step && typeof step === "object")
            .map((step) => ({
              delayMs: asNumber(step.delayMs ?? step.delay_ms, 0, { min: 0, max: 120_000 }),
              mapping: String(step.mapping || "").trim(),
            }))
            .filter((step) => step.mapping)
        : [],
    },
  };
  return config;
}

module.exports = {
  asBoolean,
  asNumber,
  loadDjAgentConfig,
  normalizeReleaseFadeTarget,
  normalizeReleaseMacroSequence,
  normalizeDeckChannels,
  normalizeBindings,
  normalizeMidiMappings,
  parseJson,
  readConfigFile,
};
