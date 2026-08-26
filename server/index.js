const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const isPackaged = typeof process.pkg !== "undefined";
const _exeDir = isPackaged ? path.dirname(process.execPath) : null;

// Installed-release verification mode: `server.exe --verify-install` checks
// the installed tree (install-manifest, sidecar identity, exe binding and, in
// packaged builds, the embedded commitment against the running executable)
// and exits 0/1 WITHOUT starting the server. start-rb.bat runs it before
// normal startup so a tampered or foreign installation never launches.
if (process.argv.includes("--verify-install")) {
  const { verifyInstalledInstall } = require("./installVerification");
  function argValue(flag) {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
  }
  const targetDir = argValue("--install-dir") || _exeDir || process.cwd();
  const outcome = verifyInstalledInstall({ exeDir: path.resolve(targetDir) });
  for (const warning of outcome.warnings) console.warn(`warning: ${warning}`);
  if (!outcome.ok) {
    for (const failure of outcome.failures) console.error(`- ${failure}`);
    console.error(`installation verification FAILED for ${targetDir}`);
    process.exit(1);
  }
  console.log(`installation verification OK for ${targetDir}`);
  console.log(`identityHash: ${outcome.identityHash}`);
  // Truthful scope label: only a packaged run proves the compiled-in
  // commitment; system-Node runs are manifest-level checks (layers A-C).
  console.log(isPackaged ? "provenance: verified-packaged" : "provenance: manifest-only (system Node; no embedded-commitment proof)");
  process.exit(0);
}

const express = require("express");
const { Server } = require("socket.io");
const { createPythonBridge } = require("./providers/pythonBridge");
const { createAbletonLinkProvider } = require("./providers/abletonLinkProvider");
const { createHookUdpProvider } = require("./providers/hookUdpProvider");
const { upsertLoopState } = require("./loopState");
const { loadDjAgentConfig } = require("./dj-agent/config");
const { createSyndocalClient } = require("./dj-agent/syndocalClient");
const { createTrackActivityDetector } = require("./dj-agent/trackActivityDetector");
const { createRekordboxMidi } = require("./dj-agent/rekordboxMidi");
const { createPedalController } = require("./dj-agent/pedalController");
const { createShowEventRouter } = require("./dj-agent/showEventRouter");
const {
  getActionRequestOrigin,
  isActionPreflightAllowed,
  isActionRequestAllowed,
  isLocalSetupRequest,
} = require("./dj-agent/httpSecurity");
const { buildPublicLookupDiagnostic } = require("./publicDiagnostics");
const { enumerateMidiOutputs } = require("./dj-agent/midiPorts");
const { validateCustomMidiCsv } = require("./dj-agent/rekordboxMapping");
const { SYNDOCAL_ADAPTERS, buildSetupChecklist } = require("./dj-agent/setupChecklist");
const { exactMidiPort, verifyRuntimeMidiSelection } = require("./dj-agent/setupSelection");
const { resolveBuildIdentity } = require("./buildIdentity");

const PUBLIC_ROOT = isPackaged ? path.join(_exeDir, "public") : path.resolve(__dirname, "public");
const SETUP_MAPPING_FILENAME = "CustomMIDI1-Syndocal-v1.1.5.csv";
const SETUP_MAPPING_URL = `/setup/${SETUP_MAPPING_FILENAME}`;
// Readiness-validation seam for operators and tests: point the semantic CSV
// validator at an alternate artifact without touching the bundled file that
// /setup serves. An unreadable or invalid override simply fails readiness
// closed in inspectSetupMappingArtifact().
const SETUP_MAPPING_PATH = String(process.env.RB_OUTPUT_SETUP_MAPPING_PATH || "").trim()
  ? path.resolve(String(process.env.RB_OUTPUT_SETUP_MAPPING_PATH).trim())
  : path.join(PUBLIC_ROOT, "setup", SETUP_MAPPING_FILENAME);

const HTTP_DEFAULT_HOST = "0.0.0.0";

// Preserve the product's IPv4 LAN-viewer default explicitly, while allowing
// an operator to select a literal interface IP. Only an unset or blank value
// selects the default: a typo must never broaden a local-only bind to every
// IPv4 interface. Brackets are accepted only as IPv6 URL-style notation and
// are removed before passing the address to net.Server.listen().
function resolveHttpBindHost(rawHost = process.env.RB_OUTPUT_HOST) {
  if (rawHost == null) {
    return HTTP_DEFAULT_HOST;
  }
  if (typeof rawHost !== "string") {
    throw new TypeError("RB_OUTPUT_HOST must be an IPv4 or IPv6 address literal");
  }
  const candidate = rawHost.trim();
  if (!candidate) {
    return HTTP_DEFAULT_HOST;
  }
  const bracketedIpv6 = candidate.match(/^\[([^\[\]]+)\]$/);
  const normalized = bracketedIpv6 ? bracketedIpv6[1] : candidate;
  const family = net.isIP(normalized);
  if (family === 0 || (bracketedIpv6 && family !== 6)) {
    throw new TypeError(
      "RB_OUTPUT_HOST must be an IPv4 or IPv6 address literal; hostnames and malformed values are not allowed"
    );
  }
  return normalized;
}

const HTTP_BIND_HOST = resolveHttpBindHost();
const PORT = Number(process.env.PORT || 8787);
const POLL_MS = Number(process.env.REKORDBOX_POLL_MS || 500);
// DB補完を無効化し、Hook由来のみでメタデータを扱う
const PYTHON_BRIDGE_ENABLED = false;
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const BRIDGE_SCRIPT =
  process.env.REKORDBOX_BRIDGE_SCRIPT ||
  path.resolve(__dirname, "..", "python", "bridge_stream.py");
const CONTENT_LOOKUP_SCRIPT =
  process.env.REKORDBOX_CONTENT_LOOKUP_SCRIPT ||
  path.resolve(__dirname, "..", "python", "content_lookup.py");
function buildSpawnCmd(exeName, scriptPath, extraArgs) {
  if (isPackaged) return [path.join(_exeDir, exeName), extraArgs];
  return [PYTHON_BIN, [scriptPath, ...extraArgs]];
}

const ABLETON_LINK_ENABLED = process.env.ABLETON_LINK_ENABLED === "true";
const ABLETON_LINK_MODULE = process.env.ABLETON_LINK_MODULE || "@ktamas77/abletonlink";
const ABLETON_LINK_INITIAL_TEMPO = Number(process.env.ABLETON_LINK_INITIAL_TEMPO || 120);
const HOOK_UDP_ENABLED = process.env.HOOK_UDP_ENABLED !== "false";
const HOOK_UDP_PORT = Number(process.env.HOOK_UDP_PORT || 22346);
const HISTORY_OFFSET_SECONDS = Number(process.env.HISTORY_OFFSET_SECONDS || 60);
const DJ_AGENT_CONFIG = loadDjAgentConfig();

// Packaged mode fails closed here: a missing or malformed build-identity.json
// next to the executable throws before the HTTP server starts. Runtime env
// vars can never forge packaged provenance.
const BUILD_IDENTITY = resolveBuildIdentity();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

const state = {
  nowPlaying: null,
  recentTracks: [],
  deckNowPlaying: [],
  deckPlaybacks: [],
  loopStates: [],
  mixerState: {
    crossfader: null,
    channelFaders: [null, null],
    source: null,
    updatedAt: null,
  },
  playback: {
    positionSec: null,
    remainingSec: null,
    isEstimated: true,
    updatedAt: null,
  },
  realtimeBpm: {
    value: null,
    source: null,
    peers: null,
    isPlaying: null,
    updatedAt: null,
  },
  capabilities: {
    nowPlayingSource: "unknown",
    playheadSource: "unknown",
    realtimeBpmSource: "unknown",
  },
  status: {
    rekordbox: { ok: false, message: "Not initialized", updatedAt: null },
    abletonLink: { ok: false, message: "Not initialized", updatedAt: null, peers: 0 },
    hook: { ok: false, message: "Not initialized", updatedAt: null },
    djAgent: {
      enabled: DJ_AGENT_CONFIG.enabled,
      allowRemoteActions: DJ_AGENT_CONFIG.allowRemoteActions,
      ok: false,
      state: DJ_AGENT_CONFIG.enabled ? "not-started" : "disabled",
      message: DJ_AGENT_CONFIG.enabled
        ? "DJ Agent not started"
        : "DJ Agent extension disabled by config",
      updatedAt: null,
      syndocal: null,
      midi: null,
      pedal: null,
      mode: "dj-control",
      timelineState: "unknown",
      timelineLoopActive: null,
      timelineId: null,
      timelinePositionBars: null,
      timelineSnapshotReady: false,
      lastTimelineAction: null,
      lastTimelineWarning: null,
      releaseMacroSequence: "parallel",
      releaseMacroPhase: "idle",
      releaseMacroReason: null,
      releaseMacroActive: false,
      lastAction: null,
      lastActionAt: null,
    },
  },
  warnings: [],
  debugLogs: [],
  sourceInfo: {
    nowPlayingMethod: "unknown",
    deckMethods: {
      1: "unknown",
      2: "unknown",
    },
  },
  updatedAt: null,
};

// Server-Sent Events clients are intentionally kept independent of Socket.IO.
// This makes the live feed consumable by simple scripts, DAWs, and browser
// integrations without requiring a Socket.IO client implementation.
const sseClients = new Set();

function writeSseEvent(response, eventName, payload) {
  if (!response || response.writableEnded) {
    return;
  }
  const data = JSON.stringify(payload ?? null);
  response.write(`event: ${eventName}\ndata: ${data}\n\n`);
}

function broadcastSse(eventName, payload) {
  for (const client of sseClients) {
    try {
      writeSseEvent(client, eventName, payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

let lastStateFingerprint = "";

function mergeWarning(message) {
  if (!message) {
    return;
  }
  if (!state.warnings.includes(message)) {
    state.warnings.push(message);
  }
}

function pushDebugLog(method, message, extra = {}) {
  if (!method || !message) {
    return;
  }
  const entry = {
    at: new Date().toISOString(),
    method: String(method),
    message: String(message),
    ...extra,
  };
  const last = state.debugLogs[state.debugLogs.length - 1];
  const sameAsLast =
    last &&
    last.method === entry.method &&
    last.message === entry.message &&
    String(last.deck || "") === String(entry.deck || "") &&
    String(last.contentId || "") === String(entry.contentId || "");
  if (sameAsLast) {
    return;
  }
  state.debugLogs.push(entry);
  if (state.debugLogs.length > 80) {
    state.debugLogs = state.debugLogs.slice(-80);
  }
}

function limitDebugText(text, max = 96) {
  const value = String(text ?? "").trim();
  if (!value) {
    return "";
  }
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max)}...`;
}

function setDeckMethod(deck, method, detail = "") {
  const deckNumber = Number(deck);
  if (!Number.isFinite(deckNumber) || deckNumber < 1 || deckNumber > 2) {
    return;
  }
  const nextMethod = method || "unknown";
  const currentMethod = state.sourceInfo.deckMethods[deckNumber];
  if (currentMethod === nextMethod) {
    return;
  }
  state.sourceInfo.deckMethods[deckNumber] = nextMethod;
  pushDebugLog(
    "deck-source",
    `Deck ${deckNumber}: ${nextMethod}${detail ? ` (${detail})` : ""}`,
    { deck: deckNumber }
  );
}

function setNowPlayingMethod(method, detail = "") {
  const nextMethod = method || "unknown";
  if (state.sourceInfo.nowPlayingMethod === nextMethod) {
    return;
  }
  state.sourceInfo.nowPlayingMethod = nextMethod;
  pushDebugLog("now-playing-source", `Now Playing: ${nextMethod}${detail ? ` (${detail})` : ""}`);
}

function buildSnapshot() {
  return {
    nowPlaying: state.nowPlaying,
    recentTracks: state.recentTracks,
    deckNowPlaying: state.deckNowPlaying,
    deckPlaybacks: state.deckPlaybacks,
    loopStates: state.loopStates,
    mixerState: state.mixerState,
    playback: state.playback,
    realtimeBpm: state.realtimeBpm,
    capabilities: state.capabilities,
    status: state.status,
    warnings: state.warnings,
    debugLogs: state.debugLogs,
    sourceInfo: state.sourceInfo,
    updatedAt: state.updatedAt,
  };
}

function emitState() {
  const fingerprintSource = {
    nowPlaying: state.nowPlaying,
    recentTracks: state.recentTracks,
    deckNowPlaying: state.deckNowPlaying,
    deckPlaybacks: state.deckPlaybacks,
    loopStates: state.loopStates,
    mixerState: state.mixerState,
    playback: state.playback,
    realtimeBpm: state.realtimeBpm,
    capabilities: state.capabilities,
    status: state.status,
    warnings: state.warnings,
    debugLogs: state.debugLogs,
    sourceInfo: state.sourceInfo,
  };
  const fingerprint = JSON.stringify(fingerprintSource);
  if (fingerprint === lastStateFingerprint) {
    return;
  }

  state.updatedAt = new Date().toISOString();
  lastStateFingerprint = fingerprint;
  const snapshot = buildSnapshot();
  io.emit("state", snapshot);
  broadcastSse("state", snapshot);
}

function applyLoopState(loopState, { emitEvent = true } = {}) {
  const previous = JSON.stringify(state.loopStates);
  state.loopStates = upsertLoopState(state.loopStates, loopState);
  const changed = previous !== JSON.stringify(state.loopStates);
  if (changed && emitEvent) {
    const current = state.loopStates.find((item) => Number(item?.deck) === Number(loopState?.deck));
    if (current) {
      io.emit("loop_state", current);
      broadcastSse("loop_state", current);
    }
  }
  return changed;
}

const contentMetadataCache = new Map();
const contentLookupInFlight = new Map();
const deckCandidateCounts = new Map();
const CANDIDATE_ACCEPT_COUNT = 2;
const failedContentCandidates = new Map();

const EXT_FIELDS = ["album", "genre", "key", "label", "origArtist", "remixer", "composer", "comment", "mixName", "lyricist", "waveform"];

function isPositiveFinite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function normalizeResolvedMetadata(payload, contentId) {
  if (!payload || payload.ok === false) {
    return null;
  }
  const extended = {};
  for (const f of EXT_FIELDS) {
    if (payload[f] != null) extended[f] = payload[f] || null;
  }
  return {
    contentId: String(payload.contentId || contentId),
    title: payload.title || null,
    artist: payload.artist || null,
    trackBpm: isPositiveFinite(payload.trackBpm) ? Number(payload.trackBpm) : null,
    durationSec: isPositiveFinite(payload.durationSec) ? Number(payload.durationSec) : null,
    trackNo: Number.isFinite(payload.trackNo) ? payload.trackNo : null,
    ...extended,
    source: "rekordbox-hook-live",
  };
}

function isLikelyGarbledText(value) {
  if (typeof value !== "string") {
    return false;
  }
  const text = value.trim();
  if (!text) {
    return false;
  }
  if (text.length > 180) {
    return true;
  }
  if (/[\u0000-\u001F\u007F]/u.test(text)) {
    return true;
  }
  if (/[\u4DC0-\u4DFF]/u.test(text)) {
    return true;
  }
  if (/[\uE000-\uF8FF]/u.test(text)) {
    return true;
  }
  if (/[\u3100-\u312F\u31A0-\u31BF\u31C0-\u31EF\u3200-\u33FF]/u.test(text)) {
    return true;
  }
  if (/[\uFFF0-\uFFFF]/u.test(text)) {
    return true;
  }
  const wordishCount = (text.match(/[\p{L}\p{N}]/gu) || []).length;
  if (wordishCount === 0) {
    return true;
  }
  const rareGlyphCount = (text.match(/[\u3400-\u4DBF\uF900-\uFAFF]/gu) || []).length;
  if (rareGlyphCount >= 3 && rareGlyphCount >= Math.ceil(text.length * 0.25)) {
    return true;
  }
  const suspiciousCount = (text.match(/[^\p{L}\p{N}\p{M}\p{Zs}\-_'".,&()!?:/+]/gu) || []).length;
  if (suspiciousCount >= 3 && suspiciousCount >= Math.ceil(text.length * 0.35)) {
    return true;
  }
  return false;
}

function sanitizeDeckEntryText(entry) {
  if (!entry || typeof entry !== "object") {
    return entry;
  }
  const title = typeof entry.title === "string" ? entry.title.trim() : null;
  const artist = typeof entry.artist === "string" ? entry.artist.trim() : null;
  const isNoiseToken = (text) =>
    typeof text === "string" &&
    (/ActivePart/i.test(text) ||
      /FXPart/i.test(text) ||
      /TrackBrowserID/i.test(text) ||
      /^[A-Za-z]:\\/.test(text) ||
      text.includes("\\AppData\\") ||
      text.includes("/AppData/"));
  const titleRejected = title && (isLikelyGarbledText(title) || isNoiseToken(title));
  const artistRejected = artist && (isLikelyGarbledText(artist) || isNoiseToken(artist));
  if (!titleRejected && !artistRejected) {
    return {
      ...entry,
      title: title || null,
      artist: artist || null,
    };
  }
  const deck = Number(entry.deck);
  const contentId = entry.contentId ? String(entry.contentId) : null;
  pushDebugLog(
    "hook-text-filter",
    `Deck ${Number.isFinite(deck) ? deck : "-"}: suspicious hook text rejected`,
    { deck: Number.isFinite(deck) ? deck : null, contentId, titleRejected, artistRejected }
  );
  return {
    ...entry,
    title: titleRejected ? null : title || null,
    artist: artistRejected ? null : artist || null,
    sourceMethod: "hook-track-meta-filtered",
  };
}

function getRecentTrackMetadata(contentId) {
  const track = state.recentTracks.find((item) => String(item?.contentId) === String(contentId));
  if (!track) {
    return null;
  }
  return {
    contentId: String(track.contentId),
    title: track.title || null,
    artist: track.artist || null,
    trackBpm: Number.isFinite(track.trackBpm) ? track.trackBpm : null,
    durationSec: Number.isFinite(track.durationSec) ? track.durationSec : null,
    trackNo: Number.isFinite(track.trackNo) ? track.trackNo : null,
    source: "rekordbox-hook-live",
  };
}

function resolveContentMetadata(contentId) {
  const key = contentId != null ? String(contentId) : "";
  if (!key) {
    return Promise.resolve(null);
  }
  if (contentMetadataCache.has(key)) {
    return Promise.resolve(contentMetadataCache.get(key));
  }
  if (contentLookupInFlight.has(key)) {
    return contentLookupInFlight.get(key);
  }

  const _cidFlags = buildContentLookupArgs(["--content-id", key]);
  const [_cidCmd, _cidArgs] = buildSpawnCmd("content_lookup.exe", CONTENT_LOOKUP_SCRIPT, _cidFlags);

  const lookup = new Promise((resolve) => {
    const child = spawn(_cidCmd, _cidArgs, {
      cwd: isPackaged ? _exeDir : path.resolve(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    // Drain diagnostics so a noisy helper cannot block, but never retain or
    // publish child stderr: Python tracebacks can contain private paths.
    child.stderr.resume();
    child.on("close", (code) => {
      if (code !== 0) {
        pushDebugLog(
          "db-lookup-error",
          `contentId ${key}: lookup process failed`,
          buildPublicLookupDiagnostic({
            contentId: key,
            reason: "lookup-process-failed",
            exitCode: code,
          })
        );
        resolve(null);
        return;
      }
      const raw = stdout.trim();
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        const payload = JSON.parse(raw);
        const metadata = normalizeResolvedMetadata(payload, key);
        if (metadata) {
          contentMetadataCache.set(key, metadata);
          pushDebugLog("db-lookup-hit", `contentId ${key}: metadata resolved`, { contentId: key });
          resolve(metadata);
          return;
        }
        pushDebugLog("db-lookup-miss", `contentId ${key}: metadata not found`, { contentId: key });
        resolve(null);
      } catch {
        pushDebugLog(
          "db-lookup-error",
          `contentId ${key}: invalid lookup payload`,
          buildPublicLookupDiagnostic({ contentId: key, reason: "invalid-lookup-payload" })
        );
        resolve(null);
      }
    });
    child.on("error", (error) => {
      pushDebugLog(
        "db-lookup-error",
        `contentId ${key}: lookup spawn error`,
        buildPublicLookupDiagnostic({
          contentId: key,
          reason: "lookup-spawn-failed",
          error,
        })
      );
      resolve(null);
    });
  }).finally(() => {
    contentLookupInFlight.delete(key);
  });

  contentLookupInFlight.set(key, lookup);
  return lookup;
}

function buildContentLookupArgs(extraArgs = []) {
  const args = [...extraArgs];
  if (process.env.REKORDBOX_DB_PATH) {
    args.push("--db-path", process.env.REKORDBOX_DB_PATH);
  }
  if (process.env.REKORDBOX_DB_DIR) {
    args.push("--db-dir", process.env.REKORDBOX_DB_DIR);
  }
  if (process.env.REKORDBOX_DB_KEY) {
    args.push("--db-key", process.env.REKORDBOX_DB_KEY);
  }
  return args;
}

function resolveDeckMetadataBySignature(deck) {
  const deckNumber = Number(deck);
  if (!Number.isFinite(deckNumber) || deckNumber <= 0) {
    return Promise.resolve(null);
  }
  const playback = state.deckPlaybacks.find((item) => Number(item?.deck) === deckNumber);
  const bpm = Number(playback?.bpm);
  const totalSec = Number(playback?.totalSec);
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(totalSec) || totalSec <= 10) {
    return Promise.resolve(null);
  }

  const sigKey = `sig:${deckNumber}:${bpm.toFixed(2)}:${Math.round(totalSec)}`;
  if (contentMetadataCache.has(sigKey)) {
    return Promise.resolve(contentMetadataCache.get(sigKey));
  }
  if (contentLookupInFlight.has(sigKey)) {
    return contentLookupInFlight.get(sigKey);
  }

  const _sigFlags = buildContentLookupArgs(["--track-bpm", String(bpm), "--duration-sec", String(totalSec)]);
  const [_sigCmd, _sigArgs] = buildSpawnCmd("content_lookup.exe", CONTENT_LOOKUP_SCRIPT, _sigFlags);
  const lookup = new Promise((resolve) => {
    const child = spawn(_sigCmd, _sigArgs, {
      cwd: isPackaged ? _exeDir : path.resolve(__dirname, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("close", () => {
      const raw = stdout.trim();
      if (!raw) {
        resolve(null);
        return;
      }
      try {
        const payload = JSON.parse(raw);
        const metadata = normalizeResolvedMetadata(payload, payload?.contentId || null);
        if (metadata) {
          contentMetadataCache.set(sigKey, metadata);
          pushDebugLog("db-lookup-signature-hit", `Deck ${deckNumber}: signature metadata resolved`, {
            deck: deckNumber,
            contentId: metadata.contentId,
          });
          resolve(metadata);
          return;
        }
      } catch {
        // ignore parse failures and treat as miss
      }
      resolve(null);
    });
    child.on("error", () => resolve(null));
  }).finally(() => {
    contentLookupInFlight.delete(sigKey);
  });

  contentLookupInFlight.set(sigKey, lookup);
  return lookup;
}

function mergeDeckEntryMetadata(entry, metadata) {
  if (!metadata) {
    return entry;
  }
  const extended = {};
  for (const f of EXT_FIELDS) {
    const val = entry[f] || metadata[f] || null;
    if (val != null) extended[f] = val;
  }
  return {
    ...entry,
    title: metadata.title || entry.title || null,
    artist: metadata.artist || entry.artist || null,
    durationSec: isPositiveFinite(metadata.durationSec)
      ? Number(metadata.durationSec)
      : isPositiveFinite(entry.durationSec)
        ? Number(entry.durationSec)
        : null,
    trackBpm: isPositiveFinite(entry.trackBpm)
      ? Number(entry.trackBpm)
      : isPositiveFinite(metadata.trackBpm)
        ? Number(metadata.trackBpm)
        : null,
    trackNo: Number.isFinite(entry.trackNo) ? entry.trackNo : metadata.trackNo ?? null,
    ...extended,
    source: "rekordbox-hook-live",
  };
}

function inferDeckMethod(entry) {
  if (!entry) {
    return "unknown";
  }
  if (entry.sourceMethod) {
    return String(entry.sourceMethod);
  }
  if (entry.title || entry.artist) {
    return "hook-track-meta";
  }
  if (entry.contentId) {
    return "hook-track-load";
  }
  return "unknown";
}

function upsertDeckNowPlayingEntry(deck, partial) {
  const normalizedDeck = Number(deck);
  if (!Number.isFinite(normalizedDeck) || normalizedDeck <= 0) {
    return;
  }
  const index = state.deckNowPlaying.findIndex((entry) => Number(entry?.deck) === normalizedDeck);
  const previous = index >= 0 ? state.deckNowPlaying[index] : { deck: normalizedDeck };
  const next = {
    ...previous,
    ...partial,
    deck: normalizedDeck,
    updatedAt: partial?.updatedAt || new Date().toISOString(),
  };
  if (index >= 0) {
    state.deckNowPlaying[index] = next;
  } else {
    state.deckNowPlaying.push(next);
    state.deckNowPlaying.sort((a, b) => Number(a.deck) - Number(b.deck));
  }
  setDeckMethod(normalizedDeck, inferDeckMethod(next));
}

function observeDeckContentCandidate(deck, contentId) {
  const normalizedDeck = Number(deck);
  const key = String(contentId || "");
  if (!Number.isFinite(normalizedDeck) || !key) {
    return 0;
  }
  let counts = deckCandidateCounts.get(normalizedDeck);
  if (!counts) {
    counts = new Map();
    deckCandidateCounts.set(normalizedDeck, counts);
  }
  const nextCount = Number(counts.get(key) || 0) + 1;
  counts.set(key, nextCount);
  if (counts.size > 20) {
    const items = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12);
    deckCandidateCounts.set(normalizedDeck, new Map(items));
  }
  return nextCount;
}

function shouldSkipFailedCandidate(contentId) {
  const key = String(contentId || "");
  if (!key) {
    return true;
  }
  const failedAt = Number(failedContentCandidates.get(key) || 0);
  if (!failedAt) {
    return false;
  }
  if (Date.now() - failedAt > 30_000) {
    failedContentCandidates.delete(key);
    return false;
  }
  return true;
}

function markFailedCandidate(contentId) {
  const key = String(contentId || "");
  if (!key) {
    return;
  }
  failedContentCandidates.set(key, Date.now());
}

function isMetadataConsistentWithDeck(deck, metadata) {
  if (!metadata) {
    return false;
  }
  const deckPlayback = state.deckPlaybacks.find((item) => Number(item?.deck) === Number(deck));
  const deckTotal = Number(deckPlayback?.totalSec);
  const deckBpm = Number(deckPlayback?.bpm);
  const trackDuration = Number(metadata.durationSec);
  const trackBpm = Number(metadata.trackBpm);
  if (
    Number.isFinite(deckTotal) &&
    Number.isFinite(trackDuration) &&
    deckTotal > 30 &&
    deckTotal < 1200
  ) {
    const delta = Math.abs(deckTotal - trackDuration);
    if (delta > 8) {
      return false;
    }
  }
  if (Number.isFinite(deckBpm) && Number.isFinite(trackBpm) && deckBpm > 60 && trackBpm > 60) {
    const bpmDelta = Math.abs(deckBpm - trackBpm);
    if (bpmDelta > 20.0) {
      return false;
    }
  }
  return true;
}

function applyMasterNowPlayingFromDecks() {
  const activeDeck = Number(state.playback?.deck);
  const active = Number.isFinite(activeDeck)
    ? state.deckNowPlaying.find((deck) => Number(deck?.deck) === activeDeck)
    : null;
  const fallback = [...state.deckNowPlaying]
    .filter((entry) => entry && (entry.title || entry.artist || entry.contentId))
    .sort((a, b) => {
      const ta = Date.parse(a.updatedAt || 0) || 0;
      const tb = Date.parse(b.updatedAt || 0) || 0;
      return tb - ta;
    })[0];
  const target = active || fallback;
  if (!target) {
    return false;
  }
  const targetContentId = target.contentId ? String(target.contentId) : null;
  const previousContentId = state.nowPlaying?.contentId ? String(state.nowPlaying.contentId) : null;
  const previous = targetContentId && previousContentId === targetContentId ? state.nowPlaying : {};
  const extended = {};
  for (const field of EXT_FIELDS) {
    extended[field] = target[field] ?? previous?.[field] ?? null;
  }
  const nextNowPlaying = {
    ...previous,
    contentId: targetContentId || previousContentId || null,
    title:
      target.title ||
      previous?.title ||
      (target.contentId ? `ID ${target.contentId}` : null),
    artist: target.artist || previous?.artist || null,
    durationSec: isPositiveFinite(target.durationSec)
      ? Number(target.durationSec)
      : isPositiveFinite(previous?.durationSec)
        ? Number(previous.durationSec)
        : null,
    trackNo: Number.isFinite(target.trackNo) ? target.trackNo : previous?.trackNo ?? null,
    trackBpm: isPositiveFinite(target.trackBpm)
      ? Number(target.trackBpm)
      : isPositiveFinite(previous?.trackBpm)
        ? Number(previous.trackBpm)
        : null,
    ...extended,
    source: "rekordbox-hook-live",
  };
  const changed = JSON.stringify(state.nowPlaying) !== JSON.stringify(nextNowPlaying);
  if (changed) {
    state.nowPlaying = nextNowPlaying;
  }
  state.capabilities.nowPlayingSource = "rekordbox-hook-live";
  const sourceDeck = Number(target.deck);
  const sourceMethod = inferDeckMethod(target);
  setNowPlayingMethod(sourceMethod, Number.isFinite(sourceDeck) ? `deck ${sourceDeck}` : "");
  return changed;
}

function hydrateDeckNowPlayingMetadata() {
  for (const entry of state.deckNowPlaying) {
    if (!entry) {
      continue;
    }
    const hasMetadata =
      Boolean(entry.title) || Boolean(entry.artist) || Number.isFinite(Number(entry.durationSec));
    if (!hasMetadata) {
      continue;
    }
    if (isMetadataConsistentWithDeck(entry.deck, entry)) {
      continue;
    }
    pushDebugLog(
      "metadata-refresh",
      `Deck ${entry.deck}: stale metadata cleared (duration mismatch)`,
      { deck: Number(entry.deck), contentId: entry.contentId ? String(entry.contentId) : null }
    );
    upsertDeckNowPlayingEntry(entry.deck, {
      ...entry,
      contentId: null,
      title: null,
      artist: null,
      durationSec: null,
      trackNo: null,
      sourceMethod: "db-signature-refresh",
      updatedAt: new Date().toISOString(),
    });
  }

  const pending = state.deckNowPlaying
    .filter((entry) => {
      if (!entry?.contentId) {
        return false;
      }
      const key = String(entry.contentId);
      if (contentMetadataCache.has(key)) {
        return false;
      }
      return (
        !entry.title ||
        !entry.artist ||
        !isPositiveFinite(entry.trackBpm) ||
        !isPositiveFinite(entry.durationSec) ||
        !entry.waveform
      );
    })
    .map(async (entry) => {
      const key = String(entry.contentId);
      if (shouldSkipFailedCandidate(key)) {
        return;
      }
      const metadata = getRecentTrackMetadata(key) || (await resolveContentMetadata(key));
      const resolvedMetadata = metadata || (await resolveDeckMetadataBySignature(entry.deck));
      if (!resolvedMetadata) {
        markFailedCandidate(key);
        return;
      }
      const current = state.deckNowPlaying.find((item) => Number(item?.deck) === Number(entry.deck));
      if (!current || String(current.contentId || "") !== key) {
        return;
      }
      upsertDeckNowPlayingEntry(entry.deck, mergeDeckEntryMetadata(current, resolvedMetadata));
    });
  if (pending.length === 0 && Array.isArray(state.deckPlaybacks) && state.deckPlaybacks.length > 0) {
    const missingDecks = state.deckPlaybacks
      .map((item) => Number(item?.deck))
      .filter((deck) => Number.isFinite(deck) && deck > 0)
      .filter((deck) => {
        const existing = state.deckNowPlaying.find((entry) => Number(entry?.deck) === deck);
        return !existing || (!existing.title && !existing.artist);
      });
    for (const deck of missingDecks) {
      pending.push(
        resolveDeckMetadataBySignature(deck).then((metadata) => {
          if (!metadata) {
            return;
          }
          upsertDeckNowPlayingEntry(
            deck,
            mergeDeckEntryMetadata(
              sanitizeDeckEntryText({
                deck,
                contentId: metadata.contentId || null,
                title: null,
                artist: null,
                source: "rekordbox-hook-live",
                sourceMethod: "db-signature-fallback",
                updatedAt: new Date().toISOString(),
              }),
              metadata
            )
          );
        })
      );
    }
  }
  if (pending.length === 0) {
    return;
  }
  Promise.allSettled(pending).then(() => {
    if (applyMasterNowPlayingFromDecks()) {
      emitState();
      return;
    }
    emitState();
  });
}

const bridgeArgs = ["--poll-ms", String(POLL_MS), "--history-offset-seconds", String(HISTORY_OFFSET_SECONDS)];
if (process.env.REKORDBOX_DB_PATH) {
  bridgeArgs.push("--db-path", process.env.REKORDBOX_DB_PATH);
}
if (process.env.REKORDBOX_DB_DIR) {
  bridgeArgs.push("--db-dir", process.env.REKORDBOX_DB_DIR);
}
if (process.env.REKORDBOX_DB_KEY) {
  bridgeArgs.push("--db-key", process.env.REKORDBOX_DB_KEY);
}

const pythonBridge = PYTHON_BRIDGE_ENABLED
  ? createPythonBridge({
      pythonBin: PYTHON_BIN,
      scriptPath: BRIDGE_SCRIPT,
      args: bridgeArgs,
    })
  : null;

if (pythonBridge) {
  pythonBridge.on("status", (status) => {
    state.status.rekordbox = {
      ...state.status.rekordbox,
      ...status,
    };
    emitState();
  });

  pythonBridge.on("snapshot", (payload) => {
    if (payload) {
      pushDebugLog("hook-only", "Python bridge snapshot ignored (DB補完 disabled)");
    }
  });

  pythonBridge.on("warning", (message) => {
    mergeWarning(message);
    emitState();
  });

  pythonBridge.on("log", (line) => {
    console.log(line);
  });
} else {
  state.status.rekordbox = {
    ok: false,
    message: "Python bridge disabled by config",
    updatedAt: new Date().toISOString(),
  };
}

const abletonLinkProvider = createAbletonLinkProvider({
  enabled: ABLETON_LINK_ENABLED,
  moduleName: ABLETON_LINK_MODULE,
  initialTempo: ABLETON_LINK_INITIAL_TEMPO,
});

const hookUdpProvider = createHookUdpProvider({
  enabled: HOOK_UDP_ENABLED,
  port: HOOK_UDP_PORT,
});

const djAgentDetector = createTrackActivityDetector();
const djAgentSyndocalClient = createSyndocalClient({
  enabled: DJ_AGENT_CONFIG.enabled && DJ_AGENT_CONFIG.syndocal.enabled,
  host: DJ_AGENT_CONFIG.syndocal.host,
  port: DJ_AGENT_CONFIG.syndocal.port,
  path: DJ_AGENT_CONFIG.syndocal.path,
  nic: DJ_AGENT_CONFIG.syndocal.nic,
  token: DJ_AGENT_CONFIG.syndocal.token,
  adapter: DJ_AGENT_CONFIG.syndocal.adapter,
  reconnectMinMs: DJ_AGENT_CONFIG.syndocal.reconnectMinMs,
  reconnectMaxMs: DJ_AGENT_CONFIG.syndocal.reconnectMaxMs,
  heartbeatMs: DJ_AGENT_CONFIG.syndocal.heartbeatMs,
  ackTimeoutMs: DJ_AGENT_CONFIG.syndocal.ackTimeoutMs,
  stateSyncProvider: () => (djAgentRouter ? djAgentRouter.getStateSync() : {}),
});
const djAgentMidi = createRekordboxMidi({
  enabled: DJ_AGENT_CONFIG.enabled && DJ_AGENT_CONFIG.midi.enabled,
  moduleName: DJ_AGENT_CONFIG.midi.moduleName,
  device: DJ_AGENT_CONFIG.midi.device,
  port: DJ_AGENT_CONFIG.midi.port,
  deckChannels: DJ_AGENT_CONFIG.midi.deckChannels,
  mappings: DJ_AGENT_CONFIG.midi.mappings,
  releaseFade: DJ_AGENT_CONFIG.midi.releaseFade,
  filter: DJ_AGENT_CONFIG.midi.filter,
});
let djAgentRouter = null;
const djAgentPedal = createPedalController({
  enabled: DJ_AGENT_CONFIG.enabled && DJ_AGENT_CONFIG.pedal.enabled,
  bindings: DJ_AGENT_CONFIG.pedal.bindings,
  moduleName: DJ_AGENT_CONFIG.pedal.moduleName,
  actionSink: (action) => djAgentRouter?.triggerAction(action),
});
djAgentRouter = createShowEventRouter({
  detector: djAgentDetector,
  syndocalClient: djAgentSyndocalClient,
  midi: djAgentMidi,
  pedal: djAgentPedal,
  releaseReset: DJ_AGENT_CONFIG.releaseReset,
  releaseMacro: DJ_AGENT_CONFIG.midi.releaseMacro,
});

function updateDjAgentStatus() {
  const routerStatus = djAgentRouter.getStatus();
  const syndocal = routerStatus.syndocal || {};
  const enabled = DJ_AGENT_CONFIG.enabled;
  state.status.djAgent = {
    ...state.status.djAgent,
    enabled,
    ok: enabled && (syndocal.state === "connected" || syndocal.state === "disabled"),
    state: enabled ? syndocal.state || "not-started" : "disabled",
    message: enabled
      ? syndocal.message || "DJ Agent running"
      : "DJ Agent extension disabled by config",
    syndocal,
    midi: routerStatus.midi,
    pedal: routerStatus.pedal,
    mode: routerStatus.mode,
    timelineState: routerStatus.timelineState,
    timelineLoopActive: routerStatus.timelineLoopActive,
    timelineId: routerStatus.timelineId,
    timelinePositionBars: routerStatus.timelinePositionBars,
    timelineSnapshotReady: routerStatus.timelineSnapshotReady,
    lastTimelineAction: routerStatus.lastTimelineAction,
    lastTimelineWarning: routerStatus.lastTimelineWarning,
    releaseMacroSequence: routerStatus.releaseMacroSequence,
    releaseMacroPhase: routerStatus.releaseMacroPhase,
    releaseMacroReason: routerStatus.releaseMacroReason,
    releaseMacroActive: routerStatus.releaseMacroActive,
    lastAction: routerStatus.lastAction || state.status.djAgent.lastAction || null,
    loopDivision: routerStatus.loopDivision,
    released: routerStatus.released,
    updatedAt: new Date().toISOString(),
  };
  emitState();
}

if (DJ_AGENT_CONFIG.warning) {
  mergeWarning(DJ_AGENT_CONFIG.warning);
}
if (DJ_AGENT_CONFIG.allowRemoteDeprecationWarning) {
  mergeWarning(DJ_AGENT_CONFIG.allowRemoteDeprecationWarning);
}

djAgentSyndocalClient.on("status", updateDjAgentStatus);
djAgentSyndocalClient.on("ack", updateDjAgentStatus);
djAgentSyndocalClient.on("delivery", updateDjAgentStatus);
djAgentMidi.on("status", updateDjAgentStatus);
djAgentPedal.on("status", updateDjAgentStatus);
djAgentRouter.on("state", updateDjAgentStatus);
djAgentRouter.on("warning", (warning) => {
  if (warning?.message) {
    mergeWarning(`DJ Agent timeline: ${warning.message}`);
  }
  updateDjAgentStatus();
});
djAgentRouter.on("action", (actionResult) => {
  state.status.djAgent = {
    ...state.status.djAgent,
    lastAction: actionResult || null,
    lastActionAt: new Date().toISOString(),
  };
  const deliveryState = actionResult?.delivery?.state;
  if (actionResult?.ok === false && deliveryState && deliveryState !== "pending") {
    mergeWarning(`DJ Agent action failed: ${actionResult.action} (${actionResult.reason || deliveryState})`);
  }
  updateDjAgentStatus();
});
djAgentRouter.on("event", (event) => {
  state.status.djAgent = {
    ...state.status.djAgent,
    lastEventType: event?.type || null,
    lastEventId: event?.eventId || null,
    lastDelivery: event?.delivery || null,
  };
  if (
    event?.source === "action" &&
    state.status.djAgent.lastAction?.delivery?.eventId === event.eventId
  ) {
    const deliveryState = event.delivery?.state || event.delivery?.ackState;
    const routerStatus = djAgentRouter.getStatus();
    const authoritativeRunning = routerStatus.mode === "timeline-control" &&
      routerStatus.timelineState === "running";
    state.status.djAgent.lastAction = {
      ...state.status.djAgent.lastAction,
      delivery: event.delivery,
      ok: deliveryState === "acknowledged" && (
        state.status.djAgent.lastAction.mode === "timeline-control" ||
        state.status.djAgent.lastAction.midiSent !== false
      ),
      phase: event.type === "DJ_RELEASE" &&
        authoritativeRunning
        ? routerStatus.releaseMacroPhase
        : event.type === "DJ_RELEASE" &&
            ["send-failed", "rejected", "timed-out"].includes(deliveryState)
          ? "failed"
        : state.status.djAgent.lastAction.phase,
      reason: deliveryState === "acknowledged" ? null : event.delivery?.reason || deliveryState,
    };
  }
  if (
    event?.delivery &&
    ["send-failed", "rejected", "timed-out"].includes(event.delivery.state)
  ) {
    mergeWarning(
      `DJ Agent event not delivered: ${event.type} (${event.delivery.reason || event.delivery.state})`
    );
  }
  updateDjAgentStatus();
});

// The extension subscribes to the existing provider events. It does not open
// another UDP socket and it never injects another DLL.
hookUdpProvider.on("snapshot", (snapshot) => {
  if (DJ_AGENT_CONFIG.enabled) {
    djAgentRouter.onSnapshot(snapshot);
  }
});
hookUdpProvider.on("track-loaded", (event) => {
  if (DJ_AGENT_CONFIG.enabled) {
    djAgentRouter.onTrackLoaded(event);
  }
});
hookUdpProvider.on("master-change", (event) => {
  if (DJ_AGENT_CONFIG.enabled) {
    djAgentRouter.onMasterChange(event);
  }
});

abletonLinkProvider.on("status", (status) => {
  state.status.abletonLink = {
    ...state.status.abletonLink,
    ...status,
  };
  if (status.ok) {
    state.capabilities.realtimeBpmSource = "ableton-link";
  }
  if (!status.ok && status.message && !status.message.includes("disabled by config")) {
    mergeWarning(status.message);
  }
  emitState();
});

abletonLinkProvider.on("bpm", (bpm) => {
  const nextRealtimeBpm = {
    value: Number.isFinite(bpm.value) ? Number(bpm.value.toFixed(2)) : null,
    source: bpm.source || "ableton-link",
    peers: Number.isFinite(bpm.peers) ? bpm.peers : null,
    isPlaying: typeof bpm.isPlaying === "boolean" ? bpm.isPlaying : null,
    updatedAt: bpm.updatedAt || new Date().toISOString(),
  };

  const oldComparable = {
    value: state.realtimeBpm.value,
    source: state.realtimeBpm.source,
    peers: state.realtimeBpm.peers,
    isPlaying: state.realtimeBpm.isPlaying,
  };
  const nextComparable = {
    value: nextRealtimeBpm.value,
    source: nextRealtimeBpm.source,
    peers: nextRealtimeBpm.peers,
    isPlaying: nextRealtimeBpm.isPlaying,
  };
  if (JSON.stringify(oldComparable) === JSON.stringify(nextComparable)) {
    return;
  }

  state.realtimeBpm = nextRealtimeBpm;

  if (typeof bpm.isPlaying === "boolean") {
    state.playback = {
      ...state.playback,
      isPlaying: bpm.isPlaying,
      updatedAt: state.playback.updatedAt || new Date().toISOString(),
    };
  }
  emitState();
});

hookUdpProvider.on("status", (status) => {
  state.status.hook = {
    ...state.status.hook,
    ...status,
  };

  if (status.ok && /connected|events detected/i.test(status.message || "")) {
    state.capabilities.realtimeBpmSource = "rekordbox-hook";
    state.capabilities.playheadSource = "rekordbox-hook";
  }
  if (!status.ok && status.message && !status.message.includes("disabled by config")) {
    mergeWarning(status.message);
    if (/target process exited|waiting for connection/i.test(status.message || "")) {
      djAgentDetector.reset();
    }
  }
  emitState();
});

hookUdpProvider.on("snapshot", (snapshot) => {
  if (snapshot.playback) {
    state.playback = {
      ...state.playback,
      ...snapshot.playback,
    };
  }
  if (snapshot.nowPlayingPatch) {
    state.nowPlaying = {
      ...(state.nowPlaying || {}),
      ...snapshot.nowPlayingPatch,
    };
    if (snapshot.nowPlayingPatch.contentId) {
      setNowPlayingMethod("hook-track-load", "nowPlayingPatch");
    }
  }
  if (Array.isArray(snapshot.deckNowPlaying) && snapshot.deckNowPlaying.length > 0) {
    const previousByDeck = new Map(
      state.deckNowPlaying.map((entry) => [Number(entry?.deck), entry])
    );
    state.deckNowPlaying = snapshot.deckNowPlaying.map((entry) => {
      const sanitized = sanitizeDeckEntryText({
        ...entry,
        sourceMethod: entry?.title || entry?.artist ? "hook-track-meta" : "hook-track-load",
        updatedAt: entry?.updatedAt || new Date().toISOString(),
      });
      const previous = previousByDeck.get(Number(entry?.deck));
      const sameTrack =
        previous?.contentId &&
        sanitized?.contentId &&
        String(previous.contentId) === String(sanitized.contentId);
      return mergeDeckEntryMetadata(sanitized, sameTrack ? previous : null);
    });
    for (const entry of state.deckNowPlaying) {
      setDeckMethod(Number(entry.deck), inferDeckMethod(entry));
    }
  }
  if (Array.isArray(snapshot.deckPlaybacks)) {
    state.deckPlaybacks = snapshot.deckPlaybacks;
  }
  if (Array.isArray(snapshot.loopStates)) {
    for (const loopState of snapshot.loopStates) {
      applyLoopState(loopState, { emitEvent: false });
    }
  }
  if (snapshot.realtimeBpm) {
    state.realtimeBpm = {
      ...state.realtimeBpm,
      ...snapshot.realtimeBpm,
    };
  }
  if (snapshot.capabilities) {
    state.capabilities = {
      ...state.capabilities,
      ...snapshot.capabilities,
    };
  }
  if (state.deckNowPlaying.length > 0) {
    state.capabilities.nowPlayingSource = "rekordbox-hook-live";
  }
  applyMasterNowPlayingFromDecks();
  hydrateDeckNowPlayingMetadata();
  emitState();
});

hookUdpProvider.on("loop-state", (loopState) => {
  if (applyLoopState(loopState)) {
    emitState();
  }
});

hookUdpProvider.on("cid-probe", (probe) => {
  const deck = Number(probe?.deck);
  if (!Number.isFinite(deck) || deck <= 0) {
    return;
  }
  const candidates = Array.isArray(probe?.candidates)
    ? probe.candidates.slice(0, 3).map((item) => String(item || "")).filter(Boolean)
    : [];
  if (candidates.length > 0) {
    pushDebugLog("hook-cid-probe", `Deck ${deck}: observed candidates ${candidates.join(",")}`, {
      deck,
    });
    for (const candidate of candidates) {
      const observed = observeDeckContentCandidate(deck, candidate);
      if (observed < CANDIDATE_ACCEPT_COUNT) {
        continue;
      }
      if (shouldSkipFailedCandidate(candidate)) {
        continue;
      }
      resolveContentMetadata(candidate).then((metadata) => {
        if (!metadata) {
          markFailedCandidate(candidate);
          return;
        }
        upsertDeckNowPlayingEntry(
          deck,
          mergeDeckEntryMetadata(
            sanitizeDeckEntryText({
              deck,
              contentId: String(candidate),
              title: null,
              artist: null,
              source: "rekordbox-hook-live",
              sourceMethod: "hook-cid-probe",
              updatedAt: new Date().toISOString(),
            }),
            metadata
          )
        );
        applyMasterNowPlayingFromDecks();
        emitState();
      });
      break;
    }
  }
});

hookUdpProvider.on("raw-track-meta", (event) => {
  const title = limitDebugText(event?.titleRaw || "");
  const artist = limitDebugText(event?.artistRaw || "");
  if (!title && !artist) {
    return;
  }
  const deckHint = Number(event?.deckHint);
  const deckLabel = Number.isFinite(deckHint) && deckHint > 0 ? ` deckHint=${Math.trunc(deckHint)}` : "";
  const contentHint = event?.contentIdHint ? ` contentIdHint=${event.contentIdHint}` : "";
  pushDebugLog("hook-raw-track-meta", `raw track_meta:${deckLabel}${contentHint} title="${title}" artist="${artist}"`);
});

hookUdpProvider.on("raw-track-load", (event) => {
  const deckHint = Number(event?.deckHint);
  const deckLabel = Number.isFinite(deckHint) && deckHint > 0 ? ` deckHint=${Math.trunc(deckHint)}` : "";
  const contentRaw = event?.contentIdRaw ? String(event.contentIdRaw) : "";
  if (!contentRaw) {
    return;
  }
  pushDebugLog("hook-raw-track-load", `raw track_load:${deckLabel} contentIdRaw=${contentRaw}`);
});

hookUdpProvider.on("deck-resolution", (event) => {
  const deck = Number(event?.deck);
  const type = String(event?.type || "unknown");
  const method = String(event?.method || "unknown");
  const contentId = event?.contentId ? String(event.contentId) : null;
  if (Number.isFinite(deck) && deck > 0) {
    const detail = contentId ? `contentId=${contentId}` : "no-content-id";
    pushDebugLog(
      "hook-resolution",
      `Deck ${deck}: ${type} resolved via ${method} (${detail})`,
      { deck, type, method, contentId }
    );
    if (type === "track_meta") {
      setDeckMethod(deck, "hook-track-meta", method);
    } else if (type === "track_load") {
      setDeckMethod(deck, "hook-track-load", method);
    }
  }
  emitState();
});

hookUdpProvider.on("master-change", (event) => {
  const deck = Number(event?.deck);
  if (Number.isFinite(deck) && deck >= 1 && deck <= 4) {
    pushDebugLog("hook-master-change", `Master deck changed to Deck ${deck}`);
    setDeckMethod(deck, "hook-master-change", "notifyMasterChange");
  }
  emitState();
});

hookUdpProvider.on("unknown-event", (name) => {
  mergeWarning(`Unmapped hook event detected: ${name}`);
  emitState();
});

hookUdpProvider.on("hook-log", (message) => {
  if (/\b(?:failed|error)\b/i.test(message)) {
    mergeWarning(`[hook] ${message}`);
  }
  pushDebugLog("hook-log", message);
  emitState();
});

hookUdpProvider.on("mixer-probe", (probe) => {
  pushDebugLog(
    "mixer-probe",
    `${probe.name} raw=${probe.raw ?? "-"} u32@raw=${probe.u32AtRaw ?? "-"} ptr@raw=${probe.pointerAtRaw ?? "-"} u32@ptr=${probe.u32AtPointer ?? "-"}`,
    { deck: probe.deck }
  );
  emitState();
});

hookUdpProvider.on("mixer-state-probe", (probe) => {
  pushDebugLog(
    "mixer-state-probe",
    `unit=${probe.unit ?? "-"} values=${JSON.stringify(probe.values)}`,
    { unit: probe.unit }
  );
  emitState();
});

hookUdpProvider.on("crossfader-probe", (probe) => {
  pushDebugLog(
    "crossfader-probe",
    `value=${probe.value.toFixed(6)} address=${probe.address ?? "-"}`,
  );
  emitState();
});

hookUdpProvider.on("mixer-state", (mixerState) => {
  state.mixerState = {
    crossfader: mixerState.crossfader,
    channelFaders: [...mixerState.channelFaders],
    source: mixerState.source,
    updatedAt: mixerState.updatedAt,
  };
  io.emit("mixer_state", state.mixerState);
  broadcastSse("mixer_state", state.mixerState);
  emitState();
});

const DJ_AGENT_ACTION_PATH_PREFIX = "/api/dj-agent/actions/";

// Express 5 matches these routes case-insensitively and tolerates a single
// trailing slash, while percent-encoded or malformed path variants never
// reach the action handlers (verified against express@5.2.1). A single decode
// is not enough to recognize every action-shaped request: nested encodings
// such as %2561ctions hide the "actions" segment behind two rounds of
// percent-decoding. The fence therefore walks a small bounded number of
// decode rounds and fails closed: a request is protected action surface when
// any round resolves to the action shape, or when the walk hits its depth
// bound or a malformed sequence while the request still sits inside the
// /api/dj-agent/ namespace with unresolved percent-encoding. Literal prefix
// characters survive every decode round unchanged, so "inside the namespace"
// here implies the raw request had the same prefix. This classification only
// strips wildcard CORS from unroutable lookalikes; Express routing itself is
// untouched, no new action becomes routable, and read-only surfaces outside
// the namespace keep the LAN viewer policy.
const ACTION_PATH_DECODE_LIMIT = 4;

function isDjAgentActionRequestPath(rawPath) {
  if (typeof rawPath !== "string") {
    return false;
  }
  const matchesActionShape = (text) => {
    const normalized = text.toLowerCase().replace(/\/+$/, "");
    return (
      normalized === "/api/dj-agent/actions"
      || normalized.startsWith(DJ_AGENT_ACTION_PATH_PREFIX)
    );
  };
  const sitsInActionNamespaceWithUnresolvedEncoding = (text) => {
    const normalized = text.toLowerCase();
    return normalized.startsWith("/api/dj-agent/") && normalized.includes("%");
  };

  if (!rawPath.includes("%")) {
    // Literal path: no decode round could ever reveal a hidden action shape.
    return matchesActionShape(rawPath);
  }
  let current = rawPath;
  for (let round = 0; round < ACTION_PATH_DECODE_LIMIT; round += 1) {
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      // Malformed percent-encoding fails closed exactly as documented: only
      // while the walk still sits inside the /api/dj-agent/ namespace with
      // unresolved encoding. Malformed targets elsewhere are unrelated 404
      // surface and keep the LAN viewer policy; none of them can route.
      return sitsInActionNamespaceWithUnresolvedEncoding(current);
    }
    if (decoded === current) {
      // Fully decoded: no percent-encoding remains anywhere in the path.
      break;
    }
    current = decoded;
    if (matchesActionShape(current)) {
      return true;
    }
  }
  return sitsInActionNamespaceWithUnresolvedEncoding(current);
}

app.use(express.json());
app.use((_req, res, next) => {
  const isDjAgentActionPath = isDjAgentActionRequestPath(_req.path);
  if (isDjAgentActionPath) {
    // Action endpoints never inherit the LAN viewer's wildcard CORS policy.
    // A browser preflight must pass the same action fence as the POST itself.
    res.removeHeader("Access-Control-Allow-Origin");
    if (_req.method === "OPTIONS") {
      if (!isActionPreflightAllowed(_req)) {
        res.status(403).end();
        return;
      }
      const origin = getActionRequestOrigin(_req);
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
      res.status(204).end();
      return;
    }
    next();
    return;
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Last-Event-ID");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (_req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
app.use(express.static(PUBLIC_ROOT));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    build: { ...BUILD_IDENTITY },
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    status: state.status,
    capabilities: state.capabilities,
    loopStates: state.loopStates,
    mixerState: state.mixerState,
    warnings: state.warnings,
    sourceInfo: state.sourceInfo,
    debugLogs: state.debugLogs,
    updatedAt: state.updatedAt,
    build: { ...BUILD_IDENTITY },
  });
});

app.get("/api/now-playing", (_req, res) => {
  res.json(buildSnapshot());
});

function sendLoopStates(res) {
  // `loops` is kept as a friendly alias while `loopStates` is the canonical
  // field used by the full snapshot and Socket.IO event contract.
  res.json({
    loopStates: state.loopStates,
    loops: state.loopStates,
    updatedAt: state.updatedAt,
  });
}

app.get("/api/loops", (_req, res) => {
  sendLoopStates(res);
});

app.get("/api/loop-state", (_req, res) => {
  sendLoopStates(res);
});

app.get("/api/state", (_req, res) => {
  res.json(buildSnapshot());
});

function listSetupNetworkInterfaces() {
  const interfaces = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (!entry || entry.internal === true || entry.family !== "IPv4" || net.isIP(entry.address) !== 4) {
        continue;
      }
      interfaces.push({ name, address: entry.address });
    }
  }
  return interfaces.sort((left, right) =>
    left.name.localeCompare(right.name) || left.address.localeCompare(right.address)
  );
}

function inspectSetupMappingArtifact() {
  let result;
  try {
    result = validateCustomMidiCsv(fs.readFileSync(SETUP_MAPPING_PATH, "utf8"));
  } catch {
    result = { ok: false, code: "artifact-unavailable", summary: null, canonicalString: null };
  }
  return {
    filename: SETUP_MAPPING_FILENAME,
    url: SETUP_MAPPING_URL,
    valid: result.ok === true,
    code: result.ok === true ? "ok" : result.code || "artifact-invalid",
    semanticFingerprint: result.ok === true
      ? crypto.createHash("sha256").update(result.canonicalString, "utf8").digest("hex")
      : null,
    summary: result.ok === true ? result.summary : null,
    operatorVerified: false,
  };
}

function sanitizeMidiEnumeration(result) {
  return {
    ok: result?.ok === true,
    available: result?.available === true,
    reason: typeof result?.reason === "string" ? result.reason : null,
    ports: Array.isArray(result?.ports)
      ? result.ports.map((port) => ({
          port: Number.isInteger(port?.port) ? port.port : null,
          name: typeof port?.name === "string" ? port.name : null,
        }))
      : [],
  };
}

function buildDjAgentSetupSnapshot() {
  const mappingArtifact = inspectSetupMappingArtifact();
  const networkInterfaces = listSetupNetworkInterfaces();
  const midiPorts = sanitizeMidiEnumeration(enumerateMidiOutputs({
    moduleName: DJ_AGENT_CONFIG.midi.moduleName,
  }));
  const runtime = state.status.djAgent || {};
  const runtimeMidi = runtime.midi || {};
  const runtimePedal = runtime.pedal || {};
  const runtimeSyndocal = runtime.syndocal || {};
  const midiSelection = verifyRuntimeMidiSelection({
    config: DJ_AGENT_CONFIG.midi,
    runtime: runtimeMidi,
    ports: midiPorts.ports,
  });
  const readiness = buildSetupChecklist({
    enabled: DJ_AGENT_CONFIG.enabled,
    mapping: {
      enabled: true,
      valid: mappingArtifact.valid,
      // The bundled, exact-validated CSV is software artifact readiness.
      // operatorVerified remains false in the artifact response; physical
      // Rekordbox Learn/hardware acceptance is a separate gate.
      ready: mappingArtifact.valid,
    },
    pedal: DJ_AGENT_CONFIG.pedal.enabled
      ? {
          enabled: true,
          available: runtimePedal.available === true,
          state: runtimePedal.state === "listening" ? "verification-required" : runtimePedal.state,
          ready: false,
        }
      : { enabled: false },
    midi: DJ_AGENT_CONFIG.midi.enabled
      ? {
          enabled: true,
          available: runtimeMidi.available === true,
          ok: runtimeMidi.ok === true,
          selected: midiSelection.ready,
          selectionValid: midiSelection.ready,
          nameVerified: midiSelection.nameVerified,
        }
      : { enabled: false },
    syndocal: DJ_AGENT_CONFIG.syndocal.enabled
      ? {
          enabled: true,
          available: runtimeSyndocal.state !== "unavailable",
          state: runtimeSyndocal.state || "not-started",
          connected: runtimeSyndocal.state === "connected",
          adapter: DJ_AGENT_CONFIG.syndocal.adapter,
        }
      : { enabled: false },
    macro: DJ_AGENT_CONFIG.midi.releaseMacro.enabled
      ? {
          enabled: true,
          ready: false,
          sequence: DJ_AGENT_CONFIG.midi.releaseMacro.sequence,
        }
      : { enabled: false },
  });
  const configuredHost = DJ_AGENT_CONFIG.syndocal.host === "127.0.0.1"
    ? ""
    : DJ_AGENT_CONFIG.syndocal.host;
  const configuredDevice = DJ_AGENT_CONFIG.midi.device || "";
  const matchingPort = exactMidiPort(
    midiPorts.ports,
    DJ_AGENT_CONFIG.midi.port,
    configuredDevice
  );

  return {
    ok: true,
    localOnly: true,
    enabled: DJ_AGENT_CONFIG.enabled,
    tokenConfigured: typeof DJ_AGENT_CONFIG.syndocal.token === "string"
      && DJ_AGENT_CONFIG.syndocal.token.length > 0,
    readiness,
    networkInterfaces,
    midiPorts,
    mappingArtifact,
    configTemplate: {
      schemaVersion: 1,
      enabled: true,
      allowRemoteActions: false,
      syndocal: {
        enabled: true,
        host: configuredHost,
        port: DJ_AGENT_CONFIG.syndocal.port || 9100,
        path: DJ_AGENT_CONFIG.syndocal.path || "/dj-link",
        nic: DJ_AGENT_CONFIG.syndocal.nic || "",
        // Fail-closed template adapter: only an exact recognized adapter may
        // be echoed. An unknown/invalid configured adapter renders as the
        // blank/unselected value instead of being silently rewritten to
        // syndocal-envelope-v3; any other adapter is retired and the Syndocal
        // readiness gate reports `syndocal-adapter-invalid` and the caller's
        // input is never reflected back here.
        adapter: SYNDOCAL_ADAPTERS.includes(DJ_AGENT_CONFIG.syndocal.adapter)
          ? DJ_AGENT_CONFIG.syndocal.adapter
          : "",
        heartbeatMs: DJ_AGENT_CONFIG.syndocal.heartbeatMs || 5_000,
      },
      pedal: {
        enabled: true,
        bindings: { release: "F13", loopHalf: "F14", filterClose: "F15" },
      },
      midi: {
        enabled: true,
        moduleName: "@julusian/midi",
        device: matchingPort?.name || "",
        port: matchingPort?.port ?? null,
        deckChannels: { "1": 1, "2": 2 },
        mappings: {
          loopHalf: { channel: 1, messageType: "noteOn", note: 36, value: 127 },
          stop: { channel: 1, messageType: "noteOn", note: 37, value: 127 },
          filter: { channel: 1, messageType: "controlChange", cc: 16 },
          releaseFade: { channel: 1, messageType: "controlChange", cc: 17 },
        },
        releaseFade: {
          enabled: true,
          mapping: "releaseFade",
          target: "deck",
          startValue: 127,
          endValue: 0,
          durationMs: 1_000,
          updateIntervalMs: 50,
          resetAfterStop: true,
          resetValue: 127,
        },
        releaseMacro: {
          enabled: false,
          sequence: "filter-then-fade",
          filter: {
            startValue: 64,
            endValue: 127,
            durationMs: 1_000,
            updateIntervalMs: 50,
            resetValue: 64,
          },
          resetAfterStop: true,
        },
      },
    },
  };
}

app.get("/api/dj-agent/setup", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  // This diagnostic/config-template response is deliberately same-machine.
  // Remove the server-wide LAN-viewer CORS header and reject DNS rebinding or
  // cross-origin reads even when the TCP peer itself is loopback.
  res.removeHeader("Access-Control-Allow-Origin");
  if (!isLocalSetupRequest(req)) {
    res.status(403).json({
      ok: false,
      localOnly: true,
      error: "DJ Agent setup is available only on the DJ PC through localhost",
    });
    return;
  }
  res.status(200).json(buildDjAgentSetupSnapshot());
});

function handleDjAgentAction(action, _req, res) {
  res.removeHeader("Access-Control-Allow-Origin");
  // Permanently loopback-only: the socket peer must be the DJ PC itself.
  // Env/config opt-outs were removed; proxy headers cannot forge the peer.
  if (!isActionRequestAllowed(_req)) {
    res.status(403).json({
      ok: false,
      error: "DJ Agent actions are available only on the DJ PC through localhost",
    });
    return;
  }
  if (!DJ_AGENT_CONFIG.enabled) {
    res.status(404).json({
      ok: false,
      error: "DJ Agent extension is disabled; set DJ_AGENT_ENABLED=true or use DJ_AGENT_CONFIG_PATH",
    });
    return;
  }
  const result = djAgentRouter.triggerAction(action);
  const ackState = result?.delivery?.state || result?.delivery?.ackState || null;
  const ok = result?.ok === true;
  const pending = ackState === "pending";
  const ignored = result?.ignored === true || result?.state === "inactive";
  res.status(pending ? 202 : ok || ignored ? 200 : 503).json({
    ok,
    ackState,
    pending,
    ignored,
    action,
    result,
    status: state.status.djAgent,
  });
}

// These diagnostics use the same action path as the physical pedal. They are
// deliberately unavailable while the extension feature gate is off.
app.post("/api/dj-agent/actions/loop-half", (req, res) => handleDjAgentAction("loop-half", req, res));
app.post("/api/dj-agent/actions/filter-close", (req, res) => handleDjAgentAction("filter-close", req, res));
app.post("/api/dj-agent/actions/release", (req, res) => handleDjAgentAction("release", req, res));
app.post("/api/dj-agent/actions/track-active", (req, res) => handleDjAgentAction("track-active", req, res));
app.get("/api/dj-agent/status", (_req, res) => {
  // Status is read-only and remains remotely readable. Disabled is a normal
  // HTTP 200 response with enabled:false.
  res.status(200).json({
    enabled: DJ_AGENT_CONFIG.enabled,
    allowRemoteActions: DJ_AGENT_CONFIG.allowRemoteActions,
    status: state.status.djAgent,
    state: djAgentRouter.getStateSync(),
  });
});

function handleEventStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  sseClients.add(res);
  writeSseEvent(res, "state", buildSnapshot());
  for (const loopState of state.loopStates) {
    writeSseEvent(res, "loop_state", loopState);
  }

  const keepAlive = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(keepAlive);
      sseClients.delete(res);
      return;
    }
    res.write(": keep-alive\n\n");
  }, 25_000);

  const cleanup = () => {
    clearInterval(keepAlive);
    sseClients.delete(res);
  };
  req.on("close", cleanup);
  res.on("error", cleanup);
}

app.get("/api/stream", handleEventStream);
app.get("/api/events", handleEventStream);

io.on("connection", (socket) => {
  socket.emit("state", buildSnapshot());
  for (const loopState of state.loopStates) {
    socket.emit("loop_state", loopState);
  }
});

function shutdown() {
  djAgentRouter.stop();
  hookUdpProvider.stop();
  abletonLinkProvider.stop();
  if (pythonBridge) {
    pythonBridge.stop();
  }
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (pythonBridge) {
  pythonBridge.start();
}
abletonLinkProvider.start();
hookUdpProvider.start();
if (DJ_AGENT_CONFIG.enabled) {
  djAgentRouter.start();
  updateDjAgentStatus();
}

server.listen(PORT, HTTP_BIND_HOST, () => {
  const address = server.address();
  const boundPort = address && typeof address === "object" ? address.port : PORT;
  const printableHost = HTTP_BIND_HOST.includes(":") ? `[${HTTP_BIND_HOST}]` : HTTP_BIND_HOST;
  console.log(`rb-output server listening on http://${printableHost}:${boundPort}`);
});
