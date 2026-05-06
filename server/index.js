const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const isPackaged = typeof process.pkg !== "undefined";
const _exeDir = isPackaged ? path.dirname(process.execPath) : null;
const express = require("express");
const { Server } = require("socket.io");
const { createPythonBridge } = require("./providers/pythonBridge");
const { createAbletonLinkProvider } = require("./providers/abletonLinkProvider");
const { createHookUdpProvider } = require("./providers/hookUdpProvider");

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
const HOOK_INJECT_SCRIPT =
  process.env.REKORDBOX_INJECT_SCRIPT ||
  path.resolve(__dirname, "..", "scripts", "inject_hook.py");
const DEFAULT_REKORDBOX_EXE = "C:\\Program Files\\rekordbox\\rekordbox 7.2.13\\rekordbox.exe";
const REKORDBOX_EXE_PATH =
  process.env.REKORDBOX_EXE_PATH || (fs.existsSync(DEFAULT_REKORDBOX_EXE) ? DEFAULT_REKORDBOX_EXE : "");

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

let lastStateFingerprint = "";
const hookRuntime = {
  pid: null,
  lastSignalAt: 0,
  targetExited: false,
  recovering: false,
  lastRecoveryAt: 0,
};

function tryRecoverHook() {
  if (hookRuntime.recovering) {
    return;
  }
  const now = Date.now();
  if (now - hookRuntime.lastRecoveryAt < 15000) {
    return;
  }
  hookRuntime.recovering = true;
  hookRuntime.lastRecoveryAt = now;
  const args = ["--process-name", "rekordbox.exe", "--wait-seconds", "4", "--handoff-seconds", "20"];
  if (REKORDBOX_EXE_PATH) {
    args.push("--launch-path", REKORDBOX_EXE_PATH);
  }
  const [_injCmd, _injArgs] = buildSpawnCmd("inject_hook.exe", HOOK_INJECT_SCRIPT, args);
  const child = spawn(_injCmd, _injArgs, {
    cwd: isPackaged ? _exeDir : path.resolve(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.on("close", (code) => {
    hookRuntime.recovering = false;
    if (code === 0) {
      pushDebugLog("hook-recovery", "Hook auto-recovery attempt completed");
    } else {
      pushDebugLog("hook-recovery", `Hook auto-recovery failed (${code})`, {
        stderr: stderr.trim() || null,
      });
    }
    emitState();
  });
  child.on("error", (error) => {
    hookRuntime.recovering = false;
    pushDebugLog("hook-recovery", "Hook auto-recovery spawn error", {
      message: error?.message || String(error),
    });
    emitState();
  });
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearRealtimeState(reasonMessage) {
  state.nowPlaying = null;
  state.recentTracks = [];
  state.deckNowPlaying = [];
  state.deckPlaybacks = [];
  state.playback = {
    positionSec: null,
    remainingSec: null,
    isEstimated: true,
    isPlaying: null,
    updatedAt: new Date().toISOString(),
  };
  state.realtimeBpm = {
    value: null,
    source: null,
    peers: null,
    isPlaying: null,
    updatedAt: null,
  };
  state.capabilities = {
    ...state.capabilities,
    nowPlayingSource: "unknown",
    playheadSource: "unknown",
    realtimeBpmSource: "unknown",
  };
  state.status.hook = {
    ...state.status.hook,
    ok: false,
    message: reasonMessage,
    updatedAt: new Date().toISOString(),
  };
  state.sourceInfo = {
    nowPlayingMethod: "unknown",
    deckMethods: {
      1: "unknown",
      2: "unknown",
    },
  };
  pushDebugLog("hook-reset", reasonMessage);
}

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
  io.emit("state", buildSnapshot());
}

const contentMetadataCache = new Map();
const contentLookupInFlight = new Map();
const deckCandidateCounts = new Map();
const CANDIDATE_ACCEPT_COUNT = 2;
const failedContentCandidates = new Map();

const EXT_FIELDS = ["album", "genre", "key", "label", "origArtist", "remixer", "composer", "comment", "mixName", "lyricist", "waveform"];

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
    trackBpm: Number.isFinite(payload.trackBpm) ? payload.trackBpm : null,
    durationSec: Number.isFinite(payload.durationSec) ? payload.durationSec : null,
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
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (code !== 0) {
        pushDebugLog("db-lookup-error", `contentId ${key}: lookup process failed (${code})`, {
          contentId: key,
          stderr: stderr.trim() || null,
        });
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
        pushDebugLog("db-lookup-error", `contentId ${key}: invalid lookup payload`, {
          contentId: key,
          stdout: raw.slice(0, 240),
        });
        resolve(null);
      }
    });
    child.on("error", (error) => {
      pushDebugLog("db-lookup-error", `contentId ${key}: lookup spawn error`, {
        contentId: key,
        message: error?.message || String(error),
      });
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
    durationSec: Number.isFinite(metadata.durationSec) ? metadata.durationSec : entry.durationSec ?? null,
    trackBpm: Number.isFinite(entry.trackBpm) ? entry.trackBpm : metadata.trackBpm ?? null,
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
  const nextNowPlaying = {
    ...(state.nowPlaying || {}),
    contentId: target.contentId || state.nowPlaying?.contentId || null,
    title:
      target.title ||
      state.nowPlaying?.title ||
      (target.contentId ? `ID ${target.contentId}` : null),
    artist: target.artist || state.nowPlaying?.artist || null,
    durationSec: Number.isFinite(target.durationSec)
      ? target.durationSec
      : state.nowPlaying?.durationSec ?? null,
    trackNo: Number.isFinite(target.trackNo) ? target.trackNo : state.nowPlaying?.trackNo ?? null,
    trackBpm: Number.isFinite(target.trackBpm) ? target.trackBpm : state.nowPlaying?.trackBpm ?? null,
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
    .filter((entry) => entry && entry.contentId && !entry.title && !entry.artist)
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
      upsertDeckNowPlayingEntry(entry.deck, mergeDeckEntryMetadata(entry, resolvedMetadata));
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
    if (/target process exited/i.test(status.message)) {
      tryRecoverHook();
    }
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
  if (Number.isFinite(status?.pid)) {
    hookRuntime.pid = Number(status.pid);
  }
  if (status.ok && /connected|events detected/i.test(status.message || "")) {
    hookRuntime.lastSignalAt = Date.now();
    hookRuntime.targetExited = false;
  }
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
  }
  emitState();
});

hookUdpProvider.on("snapshot", (snapshot) => {
  hookRuntime.lastSignalAt = Date.now();
  hookRuntime.targetExited = false;
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
    state.deckNowPlaying = snapshot.deckNowPlaying.map((entry) =>
      mergeDeckEntryMetadata(
        sanitizeDeckEntryText({
          ...entry,
          sourceMethod: entry?.title || entry?.artist ? "hook-track-meta" : "hook-track-load",
          updatedAt: entry?.updatedAt || new Date().toISOString(),
        }),
        null
      )
    );
    for (const entry of state.deckNowPlaying) {
      setDeckMethod(Number(entry.deck), inferDeckMethod(entry));
    }
  }
  if (Array.isArray(snapshot.deckPlaybacks)) {
    state.deckPlaybacks = snapshot.deckPlaybacks;
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
  mergeWarning(`[hook] ${message}`);
  pushDebugLog("hook-log", message);
  emitState();
});

setInterval(() => {
  if (
    ((!state.status.hook?.ok && /target process exited/i.test(state.status.hook?.message || "")) ||
      (!hookRuntime.pid && /listener started/i.test(state.status.hook?.message || "")))
  ) {
    tryRecoverHook();
  }
  if (
    !hookRuntime.pid &&
    !hookRuntime.lastSignalAt &&
    /listener started/i.test(state.status.hook.message || "") &&
    (state.nowPlaying !== null || state.deckNowPlaying.length > 0 || state.deckPlaybacks.length > 0)
  ) {
    clearRealtimeState("Hook waiting for connection");
    emitState();
    return;
  }
  if (!hookRuntime.pid) {
    return;
  }
  if (isProcessAlive(hookRuntime.pid)) {
    return;
  }
  if (hookRuntime.targetExited) {
    return;
  }
  hookRuntime.targetExited = true;
  hookRuntime.lastSignalAt = 0;
  hookRuntime.pid = null;
  clearRealtimeState("Hook target process exited");
  emitState();
}, 1000);

app.use(express.json());
app.use(express.static(isPackaged ? path.join(_exeDir, "public") : path.resolve(__dirname, "public")));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/api/status", (_req, res) => {
  res.json({
    status: state.status,
    capabilities: state.capabilities,
    warnings: state.warnings,
    sourceInfo: state.sourceInfo,
    debugLogs: state.debugLogs,
    updatedAt: state.updatedAt,
  });
});

app.get("/api/now-playing", (_req, res) => {
  res.json(buildSnapshot());
});

io.on("connection", (socket) => {
  socket.emit("state", buildSnapshot());
});

function shutdown() {
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

server.listen(PORT, () => {
  console.log(`rb-output server listening on http://0.0.0.0:${PORT}`);
});
