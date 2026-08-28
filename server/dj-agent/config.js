const fs = require("node:fs");
const path = require("node:path");
const { validToken } = require("./tokenValidation");

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
    releaseFade: ["releaseFade"],
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

function normalizeReleaseMacroSequence(value) {
  return value === "filter-then-fade-then-stop" ? "filter-then-fade-then-stop" : null;
}

function isPlainRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasExactValues(value, expected) {
  return hasExactKeys(value, Object.keys(expected)) && Object.entries(expected).every(
    ([key, expectedValue]) => value[key] === expectedValue,
  );
}

// The controlled source launcher accepts exactly one show schema.  Keep this
// validator separate from the permissive default-off config loader: its input
// is the raw external show file and it never returns that file or its token.
function validateFilterThenFadeThenStopShowConfig(value, { allowTokenPlaceholder = false } = {}) {
  if (!hasExactKeys(value, ["version", "enabled", "syndocal", "pedal", "midi", "trackActivity"])) return false;
  if (value.version !== "1.1.11" || value.enabled !== true) return false;

  const syndocal = value.syndocal;
  if (!hasExactKeys(syndocal, ["enabled", "host", "port", "path", "nic", "token", "adapter", "heartbeatMs"])) return false;
  if (
    syndocal.enabled !== true ||
    syndocal.host !== "192.168.50.1" ||
    syndocal.port !== 9100 ||
    syndocal.path !== "/dj-link" ||
    syndocal.nic !== "192.168.50.2" ||
    syndocal.adapter !== "syndocal-envelope-v3" ||
    syndocal.heartbeatMs !== 5000 ||
    typeof syndocal.token !== "string"
  ) return false;
  if (syndocal.token === "<SYNDOCAL_ONE_TIME_TOKEN>") {
    if (!allowTokenPlaceholder) return false;
  } else if (!validToken(syndocal.token)) {
    return false;
  }

  const pedal = value.pedal;
  if (!hasExactKeys(pedal, ["enabled", "bindings"]) || pedal.enabled !== true) return false;
  if (!hasExactValues(pedal.bindings, { release: "F13", loopHalf: "F14", filterClose: "F15" })) return false;

  const trackActivity = value.trackActivity;
  if (!hasExactKeys(trackActivity, ["ownerSelection"])) return false;
  if (!hasExactValues(trackActivity.ownerSelection, PRODUCTION_OWNER_SELECTION_POLICY)) return false;

  const midi = value.midi;
  if (!hasExactKeys(midi, ["enabled", "device", "port", "mappings", "deckChannels", "filter", "releaseFade", "releaseMacro"])) return false;
  if (midi.enabled !== true || midi.device !== "CustomMIDI1" || !Number.isInteger(midi.port) || midi.port < 0 || midi.port > 4096) return false;
  if (!hasExactKeys(midi.mappings, ["loopHalf", "stop", "filter", "releaseFade"])) return false;
  if (!hasExactValues(midi.mappings.loopHalf, { channel: 1, messageType: "noteOn", note: 36, value: 127 })) return false;
  if (!hasExactValues(midi.mappings.stop, { channel: 1, messageType: "noteOn", note: 37, value: 127 })) return false;
  if (!hasExactValues(midi.mappings.filter, { channel: 1, messageType: "controlChange", cc: 16 })) return false;
  if (!hasExactValues(midi.mappings.releaseFade, { channel: 1, messageType: "controlChange", cc: 17 })) return false;
  if (!hasExactValues(midi.deckChannels, { 1: 1, 2: 2 })) return false;
  const filter = { startValue: 64, endValue: 127, durationMs: 1000, updateIntervalMs: 50 };
  if (!hasExactValues(midi.filter, filter)) return false;
  if (!hasExactKeys(midi.releaseFade, [
    "enabled", "mapping", "target", "startValue", "endValue", "durationMs",
    "updateIntervalMs", "resetAfterStop", "resetValue", "resetDelayMs",
  ])) return false;
  if (!hasExactValues(midi.releaseFade, {
    enabled: true,
    mapping: "releaseFade",
    target: "deck",
    startValue: 127,
    endValue: 0,
    durationMs: 1000,
    updateIntervalMs: 50,
    resetAfterStop: true,
    resetValue: 127,
    resetDelayMs: 0,
  })) return false;
  if (!hasExactKeys(midi.releaseMacro, ["enabled", "sequence", "filter", "resetAfterStop", "resetDelayMs"])) return false;
  if (midi.releaseMacro.enabled !== true || midi.releaseMacro.sequence !== "filter-then-fade-then-stop") return false;
  if (!hasExactValues(midi.releaseMacro.filter, { ...filter, resetValue: 64 })) return false;
  return midi.releaseMacro.resetAfterStop === true && midi.releaseMacro.resetDelayMs === 0;
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

const STRICT_SHOW_CONFIG_DISABLED_REASON =
  "DJ Agent disabled: exact external v1.1.11 filter-then-fade-then-stop configuration is required";
const PRODUCTION_OWNER_SELECTION_POLICY = Object.freeze({
  // titleContains is selection only. A matching track is sent as v3 text
  // identity only after both title and artist exist; artist-missing matches
  // remain fail-closed rather than changing the v3 payload contract.
  mode: "titleContains",
  titleNeedle: "人生オーバー",
  // Reserve the final 100 ms of the v3 1500-ms freshness bound for timer
  // dispatch. The configured wait is therefore intentionally 1400 ms, not a
  // misleading promise that a delayed JavaScript callback can send stale data.
  deck1MetadataWaitMs: 1400,
});
const RUNTIME_SHOW_OVERRIDE_KEYS = Object.freeze([
  "DJ_AGENT_CONFIG",
  "DJ_AGENT_ENABLED",
  "DJ_AGENT_ALLOW_REMOTE_ACTIONS",
  "SYNDOCAL_ENABLED",
  "SYNDOCAL_HOST",
  "SYNDOCAL_PORT",
  "SYNDOCAL_PATH",
  "SYNDOCAL_NIC",
  "SYNDOCAL_TOKEN",
  "SYNDOCAL_WS_ADAPTER",
  "SYNDOCAL_HEARTBEAT_MS",
  "PEDAL_ENABLED",
  "PEDAL_MODULE",
  "MIDI_ENABLED",
  "MIDI_MODULE",
  "MIDI_DEVICE",
  "MIDI_PORT",
  "MIDI_RELEASE_FADE",
  "MIDI_RELEASE_MACRO",
  "MIDI_DECK_CHANNELS",
]);

function hasRuntimeShowOverride(env) {
  return RUNTIME_SHOW_OVERRIDE_KEYS.some((key) => (
    Object.hasOwn(env, key) && env[key] != null && String(env[key]).trim() !== ""
  ));
}

function disabledDjAgentConfig() {
  return {
    enabled: false,
    allowRemoteActions: false,
    warning: STRICT_SHOW_CONFIG_DISABLED_REASON,
    allowRemoteDeprecationWarning: null,
    syndocal: {
      enabled: false,
      host: "",
      port: 9100,
      path: "/dj-link",
      nic: "",
      token: "",
      adapter: "syndocal-envelope-v3",
      reconnectMinMs: 500,
      reconnectMaxMs: 10_000,
      heartbeatMs: 5_000,
      ackTimeoutMs: 5_000,
    },
    pedal: {
      enabled: false,
      bindings: normalizeBindings({}),
      moduleName: "uiohook-napi",
    },
    trackActivity: {
      ownerSelection: { mode: "content-first" },
    },
    midi: {
      enabled: false,
      moduleName: "@julusian/midi",
      device: "",
      port: null,
      deckChannels: {},
      mappings: {},
      filter: {},
      releaseFade: {
        enabled: false,
        mappingName: "releaseFade",
        target: "deck",
      },
      releaseMacro: {
        enabled: false,
        sequence: null,
        filter: {},
        resetAfterStop: false,
        resetDelayMs: 0,
      },
    },
  };
}

function strictShowConfig(source) {
  return {
    enabled: true,
    allowRemoteActions: false,
    warning: null,
    allowRemoteDeprecationWarning: null,
    syndocal: {
      enabled: true,
      host: source.syndocal.host,
      port: source.syndocal.port,
      path: source.syndocal.path,
      nic: source.syndocal.nic,
      token: source.syndocal.token,
      adapter: source.syndocal.adapter,
      reconnectMinMs: 500,
      reconnectMaxMs: 10_000,
      heartbeatMs: source.syndocal.heartbeatMs,
      ackTimeoutMs: 5_000,
    },
    pedal: {
      enabled: true,
      bindings: { ...source.pedal.bindings },
      moduleName: "uiohook-napi",
    },
    trackActivity: {
      ownerSelection: { ...source.trackActivity.ownerSelection },
    },
    midi: {
      enabled: true,
      moduleName: "@julusian/midi",
      device: source.midi.device,
      port: source.midi.port,
      deckChannels: { ...source.midi.deckChannels },
      mappings: {
        loopHalf: { ...source.midi.mappings.loopHalf },
        stop: { ...source.midi.mappings.stop },
        filter: { ...source.midi.mappings.filter },
        releaseFade: { ...source.midi.mappings.releaseFade },
      },
      filter: { ...source.midi.filter },
      releaseFade: {
        enabled: true,
        mappingName: source.midi.releaseFade.mapping,
        target: source.midi.releaseFade.target,
        startValue: source.midi.releaseFade.startValue,
        endValue: source.midi.releaseFade.endValue,
        durationMs: source.midi.releaseFade.durationMs,
        updateIntervalMs: source.midi.releaseFade.updateIntervalMs,
        resetAfterStop: source.midi.releaseFade.resetAfterStop,
        resetValue: source.midi.releaseFade.resetValue,
        resetDelayMs: source.midi.releaseFade.resetDelayMs,
      },
      releaseMacro: {
        enabled: true,
        sequence: "filter-then-fade-then-stop",
        filter: { ...source.midi.releaseMacro.filter },
        resetAfterStop: true,
        resetDelayMs: 0,
      },
    },
  };
}

function realpath(fsApi, target) {
  const native = fsApi.realpathSync && fsApi.realpathSync.native;
  if (typeof native === "function") return native(target);
  if (typeof fsApi.realpathSync === "function") return fsApi.realpathSync(target);
  return path.resolve(target);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

const REPOSITORY_ROOT = path.resolve(__dirname, "..", "..");

// Direct server starts may use an arbitrary process.cwd(). The external-file
// boundary must therefore be the module's checkout root, not the caller's
// working directory. The injected filesystem seam intentionally falls back to
// its resolved path for pure parser tests that do not model filesystem metadata.
function resolveStrictExternalShowPath(requestedPath, fsApi, repositoryRoot = REPOSITORY_ROOT) {
  if (!path.isAbsolute(requestedPath)) return null;
  if (typeof fsApi.lstatSync !== "function") return path.resolve(requestedPath);

  try {
    const stat = fsApi.lstatSync(requestedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const resolvedPath = realpath(fsApi, requestedPath);
    const resolvedRepositoryRoot = realpath(fsApi, repositoryRoot);
    return isWithin(resolvedRepositoryRoot, resolvedPath) ? null : resolvedPath;
  } catch {
    return null;
  }
}

function loadDjAgentConfig({ env = process.env, fsApi = fs, repositoryRoot = REPOSITORY_ROOT } = {}) {
  const requestedPath = typeof env.DJ_AGENT_CONFIG_PATH === "string"
    ? env.DJ_AGENT_CONFIG_PATH.trim()
    : "";
  if (!requestedPath || hasRuntimeShowOverride(env)) {
    return disabledDjAgentConfig();
  }

  const externalPath = resolveStrictExternalShowPath(requestedPath, fsApi, repositoryRoot);
  if (!externalPath) return disabledDjAgentConfig();

  const fileResult = readConfigFile(externalPath, fsApi);
  if (fileResult.warning || !validateFilterThenFadeThenStopShowConfig(fileResult.config)) {
    return disabledDjAgentConfig();
  }
  return strictShowConfig(fileResult.config);
}

module.exports = {
  PRODUCTION_OWNER_SELECTION_POLICY,
  STRICT_SHOW_CONFIG_DISABLED_REASON,
  RUNTIME_SHOW_OVERRIDE_KEYS,
  REPOSITORY_ROOT,
  asBoolean,
  asNumber,
  disabledDjAgentConfig,
  hasRuntimeShowOverride,
  loadDjAgentConfig,
  normalizeReleaseMacroSequence,
  resolveStrictExternalShowPath,
  normalizeDeckChannels,
  normalizeBindings,
  normalizeMidiMappings,
  parseJson,
  readConfigFile,
  strictShowConfig,
  validateFilterThenFadeThenStopShowConfig,
};
