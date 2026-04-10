const dgram = require("node:dgram");
const { EventEmitter } = require("node:events");

function normalizePlaybackSeconds(rawValue) {
  if (!Number.isFinite(rawValue)) {
    return null;
  }
  return Number((rawValue / 1000).toFixed(2));
}

function bpmFromRaw(rawValue) {
  if (!Number.isFinite(rawValue)) {
    return null;
  }
  if (rawValue > 500) {
    return Number((rawValue / 100).toFixed(2));
  }
  return Number(rawValue.toFixed(2));
}

function isLikelyHookEventName(name) {
  if (typeof name !== "string") {
    return false;
  }
  const text = name.trim();
  if (!text || text.length < 2 || text.length > 80 || !text.startsWith("@")) {
    return false;
  }
  return /^@[A-Za-z0-9_.-]+$/.test(text);
}

function isPlayStateLikeEventName(name) {
  if (typeof name !== "string") {
    return false;
  }
  return /@(IsPlaying|PlayState|PlayerState|Play|Pause|Stop)$/i.test(name.trim());
}

function isExplicitPlaybackStateEventName(name) {
  if (typeof name !== "string") {
    return false;
  }
  return /@(IsPlaying|PlayState|PlayerState)$/i.test(name.trim());
}

function isLikelyTrackText(value) {
  if (typeof value !== "string") {
    return false;
  }
  const text = value.trim();
  if (!text || text.length > 256) {
    return false;
  }
  if (/^[A-Za-z]:\\/.test(text) || text.includes("\\AppData\\") || text.includes("/AppData/")) {
    return false;
  }
  if (/\.db$|\.sqlite$|rekordbox\.settings/i.test(text)) {
    return false;
  }
  if (
    /^@/i.test(text) ||
    /ActivePart/i.test(text) ||
    /FXPart/i.test(text) ||
    /TrackBrowserID/i.test(text)
  ) {
    return false;
  }
  return true;
}

const HOOK_OLVC_WHITELIST = new Set([
  "@BPM",
  "@SyncSlaveBPM",
  "@OriginalBPM",
  "@CurrentTime",
  "@TotalTime",
  "@MixPointLinkRemainingTime",
  "@TrackBrowserID",
  "@TrackNo",
]);

function createHookUdpProvider({ enabled = true, port = 22346 } = {}) {
  const emitter = new EventEmitter();
  let socket = null;
  let connected = false;
  const logicalDeckCount = 2;
  const deckState = new Map();
  const deckSignals = new Map();
  const unknownEventNames = new Set();

  function initDeckState() {
    return {
      bpm: null,
      currentTime: null,
      totalTime: null,
      remainingTime: null,
      lastPositionSec: null,
      lastPositionAt: 0,
      lastIsPlaying: null,
      explicitIsPlaying: null,
      trackNo: null,
      title: null,
      artist: null,
      lastSeenAt: null,
      metadata: {},
    };
  }

  function emitStatus(ok, message, extra = {}) {
    emitter.emit("status", {
      ok,
      message,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
  }

  function normalizeDeckIndex(deckRaw) {
    if (!Number.isFinite(deckRaw)) {
      return null;
    }
    const sourceDeckIndex = Math.trunc(deckRaw) - 1;
    if (sourceDeckIndex < 0) {
      return null;
    }
    return ((sourceDeckIndex % logicalDeckCount) + logicalDeckCount) % logicalDeckCount;
  }

  function initDeckSignals() {
    return {
      playbackAt: 0,
      trackLoadAt: 0,
      trackMetaAt: 0,
      trackIdAt: 0,
    };
  }

  function markDeckSignal(deck, kind) {
    const now = Date.now();
    const current = deckSignals.get(deck) || initDeckSignals();
    if (kind === "playback") {
      current.playbackAt = now;
    } else if (kind === "track-load") {
      current.trackLoadAt = now;
    } else if (kind === "track-meta") {
      current.trackMetaAt = now;
    } else if (kind === "track-id") {
      current.trackIdAt = now;
    }
    deckSignals.set(deck, current);
  }

  function updateDeckState(deck, mutator) {
    const current = deckState.get(deck) || initDeckState();
    mutator(current);
    current.lastSeenAt = Date.now();
    deckState.set(deck, current);
  }

  function computeMasterDeck() {
    let winnerDeck = null;
    let winnerScore = Number.NEGATIVE_INFINITY;
    for (const [deck, data] of deckState) {
      const hasPlaybackSignal =
        Number.isFinite(data.currentTime) ||
        Number.isFinite(data.remainingTime) ||
        Number.isFinite(data.totalTime);
      const score = Number(data.lastSeenAt || 0) + (hasPlaybackSignal ? 1_000_000_000_000 : 0);
      if (score > winnerScore) {
        winnerDeck = deck;
        winnerScore = score;
      }
    }
    return winnerDeck;
  }

  function buildDeckPlayback(deckIndex, data) {
    let positionSecRaw = normalizePlaybackSeconds(data.currentTime);
    let totalSec = normalizePlaybackSeconds(data.totalTime);
    let remainingFromEvent = normalizePlaybackSeconds(data.remainingTime);

    const sanitizePlaybackSeconds = (value, { totalHint = null, allowBeyondTotal = false } = {}) => {
      if (!Number.isFinite(value) || value < 0) {
        return null;
      }
      if (value > 7_200) {
        return null;
      }
      if (!allowBeyondTotal && Number.isFinite(totalHint) && totalHint > 0 && value > totalHint + 30) {
        return null;
      }
      return value;
    };

    totalSec = sanitizePlaybackSeconds(totalSec, { allowBeyondTotal: true });
    positionSecRaw = sanitizePlaybackSeconds(positionSecRaw, { totalHint: totalSec });
    remainingFromEvent = sanitizePlaybackSeconds(remainingFromEvent, {
      totalHint: totalSec,
      allowBeyondTotal: false,
    });

    let remainingSec =
      Number.isFinite(totalSec) && Number.isFinite(positionSecRaw)
        ? Number((totalSec - positionSecRaw).toFixed(2))
        : null;

    if (Number.isFinite(remainingFromEvent) && remainingFromEvent > 0) {
      remainingSec = remainingFromEvent;
    }

    if (Number.isFinite(remainingSec)) {
      remainingSec = Math.max(0, remainingSec);
    }

    const positionSec =
      Number.isFinite(positionSecRaw)
        ? positionSecRaw
        : Number.isFinite(totalSec) && Number.isFinite(remainingSec)
          ? Number((totalSec - remainingSec).toFixed(2))
          : null;

    const now = Date.now();
    let isPlaying =
      typeof data.explicitIsPlaying === "boolean" ? data.explicitIsPlaying : data.lastIsPlaying;
    if (Number.isFinite(positionSec)) {
      const prevPos = Number(data.lastPositionSec);
      const prevAt = Number(data.lastPositionAt || 0);
      if (Number.isFinite(prevPos) && prevAt > 0) {
        const elapsedSec = (now - prevAt) / 1000;
        const deltaSec = positionSec - prevPos;
        if (elapsedSec >= 0.4) {
          if (deltaSec > 0.03) {
            isPlaying = true;
          } else if (Math.abs(deltaSec) <= 0.02) {
            isPlaying = false;
          } else if (deltaSec < -1.0) {
            // Track jump/reload時は判定を維持
            isPlaying = data.lastIsPlaying;
          }
          data.lastPositionSec = positionSec;
          data.lastPositionAt = now;
        }
      } else {
        data.lastPositionSec = positionSec;
        data.lastPositionAt = now;
      }
      data.lastIsPlaying = isPlaying;
    }

    return {
      deck: deckIndex + 1,
      bpm: bpmFromRaw(data.bpm),
      positionSec: Number.isFinite(positionSec) ? positionSec : null,
      remainingSec: Number.isFinite(remainingSec) ? remainingSec : null,
      totalSec: Number.isFinite(totalSec) ? totalSec : null,
      isEstimated: false,
      isPlaying: typeof isPlaying === "boolean" ? isPlaying : null,
      updatedAt: new Date().toISOString(),
    };
  }

  function emitSnapshotFromDecks() {
    const masterDeck = computeMasterDeck();
    if (!Number.isInteger(masterDeck)) {
      return;
    }
    const data = deckState.get(masterDeck);
    if (!data) {
      return;
    }

    const masterPlayback = buildDeckPlayback(masterDeck, data);
    const deckPlaybacks = Array.from(deckState.entries())
      .map(([deck, deckData]) => buildDeckPlayback(deck, deckData))
      .filter(
        (deckPlayback) =>
          Number.isFinite(deckPlayback.positionSec) ||
          Number.isFinite(deckPlayback.remainingSec) ||
          Number.isFinite(deckPlayback.totalSec)
      )
      .sort((a, b) => a.deck - b.deck);
    const deckNowPlaying = Array.from(deckState.entries())
      .map(([deck, deckData]) => {
        const contentId =
          Number.isFinite(deckData.trackBrowserId) &&
          deckData.trackBrowserId > 0 &&
          deckData.trackBrowserId < Number.MAX_SAFE_INTEGER
            ? String(Math.trunc(deckData.trackBrowserId))
            : null;
        const title = typeof deckData.title === "string" && deckData.title ? deckData.title : null;
        const artist = typeof deckData.artist === "string" && deckData.artist ? deckData.artist : null;
        if (!contentId && !title && !artist) {
          return null;
        }
        const trackNo =
          Number.isFinite(deckData.trackNo) &&
          deckData.trackNo > 0 &&
          deckData.trackNo < 1_000_000 &&
          deckData.trackNo !== 0xffffffff
            ? Math.trunc(deckData.trackNo)
            : null;
        const trackBpm = bpmFromRaw(deckData.originalBpm);
        return {
          deck: deck + 1,
          contentId,
          title,
          artist,
          trackNo,
          trackBpm: Number.isFinite(trackBpm) ? trackBpm : null,
          updatedAt: new Date().toISOString(),
          source: "rekordbox-hook",
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.deck - b.deck);

    const nowPlayingPatch = {};
    const originalTrackBpm = bpmFromRaw(data.originalBpm);
    if (Number.isFinite(originalTrackBpm)) {
      nowPlayingPatch.trackBpm = originalTrackBpm;
    }
    if (
      Number.isFinite(data.trackBrowserId) &&
      data.trackBrowserId > 0 &&
      data.trackBrowserId < Number.MAX_SAFE_INTEGER
    ) {
      nowPlayingPatch.contentId = String(Math.trunc(data.trackBrowserId));
    }
    if (
      Number.isFinite(data.trackNo) &&
      data.trackNo > 0 &&
      data.trackNo < 1_000_000 &&
      data.trackNo !== 0xffffffff
    ) {
      nowPlayingPatch.trackNo = Math.trunc(data.trackNo);
    }
    if (Object.keys(nowPlayingPatch).length > 0) {
      nowPlayingPatch.source = "rekordbox-hook";
    }

    emitter.emit("snapshot", {
      playback: {
        ...masterPlayback,
      },
      deckPlaybacks,
      deckNowPlaying,
      realtimeBpm: {
        value: bpmFromRaw(data.bpm),
        source: "rekordbox-hook",
        peers: null,
        isPlaying: null,
        updatedAt: new Date().toISOString(),
        deck: masterDeck + 1,
      },
      capabilities: {
        playheadSource: "rekordbox-hook",
        realtimeBpmSource: "rekordbox-hook",
      },
      nowPlayingPatch: Object.keys(nowPlayingPatch).length > 0 ? nowPlayingPatch : undefined,
    });
  }

  function pickDeckForUnknownTrackLoad() {
    const now = Date.now();
    const candidates = [];
    for (let deck = 0; deck < logicalDeckCount; deck += 1) {
      const data = deckState.get(deck) || initDeckState();
      const signal = deckSignals.get(deck) || initDeckSignals();
      const lastSeenAt = Number(data.lastSeenAt || 0);
      const recencyMs = now - Math.max(lastSeenAt, signal.playbackAt || 0, signal.trackLoadAt || 0);
      if (recencyMs > 6000) {
        continue;
      }
      const score =
        Math.max(lastSeenAt, signal.playbackAt || 0) +
        Math.max(signal.trackLoadAt || 0, signal.trackMetaAt || 0) +
        (!Number.isFinite(data.trackBrowserId) ? 2500 : 0);
      candidates.push({ deck, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    if (candidates.length === 0) {
      return null;
    }
    if (candidates.length === 1) {
      return { deck: candidates[0].deck, method: "recent-signal-single" };
    }
    if (candidates[0].score - candidates[1].score >= 300) {
      return { deck: candidates[0].deck, method: "recent-signal-dominant" };
    }
    const fallbackDeck = computeMasterDeck();
    if (Number.isInteger(fallbackDeck)) {
      return { deck: fallbackDeck, method: "master-deck-fallback" };
    }
    return null;
  }

  function resolveDeckFromHints(packet, { preferUnknownContent = false } = {}) {
    const rawHints = [Number(packet.deck), Number(packet.arg3), Number(packet.arg4)]
      .map((raw) => ({ raw, normalized: normalizeDeckIndex(raw) }))
      .filter((item) => Number.isInteger(item.normalized));

    const uniqueDecks = Array.from(new Set(rawHints.map((item) => item.normalized)));
    if (uniqueDecks.length === 1) {
      return { deck: uniqueDecks[0], method: "explicit-hint" };
    }
    if (uniqueDecks.length > 1) {
      const scored = uniqueDecks
        .map((deck) => {
          const data = deckState.get(deck) || initDeckState();
          const signal = deckSignals.get(deck) || initDeckSignals();
          const score =
            Number(data.lastSeenAt || 0) +
            Number(signal.playbackAt || 0) +
            Number(signal.trackLoadAt || 0) +
            (preferUnknownContent && !Number.isFinite(data.trackBrowserId) ? 5000 : 0);
          return { deck, score };
        })
        .sort((a, b) => b.score - a.score);
      return { deck: scored[0].deck, method: "scored-hints" };
    }
    return pickDeckForUnknownTrackLoad();
  }

  function handlePacket(buffer) {
    let packet;
    try {
      packet = JSON.parse(buffer.toString("utf8"));
    } catch {
      emitter.emit("log", `[hook-udp/raw] ${buffer.toString("utf8")}`);
      return;
    }

    if (packet.type === "hello") {
      connected = true;
      emitStatus(true, "Hook DLL connected", {
        version: packet.version || "unknown",
        pid: packet.pid || null,
      });
      return;
    }

    if (packet.type === "error") {
      emitStatus(false, packet.message || "Hook error");
      return;
    }

    if (packet.type === "log") {
      const message = String(packet.message || "").trim();
      if (message) {
        emitter.emit("hook-log", message);
      }
      return;
    }

    if (packet.type === "cid_probe") {
      const deckRaw = Number(packet.deck);
      if (!Number.isFinite(deckRaw)) {
        return;
      }
      const sourceDeckIndex = Math.trunc(deckRaw) - 1;
      if (sourceDeckIndex < 0) {
        return;
      }
      const deck = ((sourceDeckIndex % logicalDeckCount) + logicalDeckCount) % logicalDeckCount;
      const candidates = Array.isArray(packet.candidates)
        ? packet.candidates
            .map((value) => Number(value))
            .filter(
              (value) =>
                Number.isFinite(value) && value > 0 && value < Number.MAX_SAFE_INTEGER
            )
            .map((value) => String(Math.trunc(value)))
        : [];
      if (candidates.length > 0) {
        emitter.emit("cid-probe", {
          deck: deck + 1,
          candidates,
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }

    if (packet.type === "track_meta") {
      emitter.emit("raw-track-meta", {
        deckHint: Number(packet.deck),
        contentIdHint: packet.contentId != null ? String(packet.contentId) : null,
        titleRaw: typeof packet.title === "string" ? packet.title : null,
        artistRaw: typeof packet.artist === "string" ? packet.artist : null,
        updatedAt: new Date().toISOString(),
      });
      const resolvedDeck = resolveDeckFromHints(packet, { preferUnknownContent: true });
      if (!resolvedDeck || !Number.isInteger(resolvedDeck.deck) || resolvedDeck.deck < 0) return;
      const deck = resolvedDeck.deck;
      const titleRaw = typeof packet.title === "string" ? packet.title.trim() : null;
      const artistRaw = typeof packet.artist === "string" ? packet.artist.trim() : null;
      const title = isLikelyTrackText(titleRaw) ? titleRaw : null;
      const artist = isLikelyTrackText(artistRaw) ? artistRaw : null;
      if (!title && !artist) return;
      updateDeckState(deck, (data) => {
        if (title) data.title = title;
        if (artist) data.artist = artist;
      });
      markDeckSignal(deck, "track-meta");
      emitter.emit("deck-resolution", {
        type: "track_meta",
        deck: deck + 1,
        method: resolvedDeck.method,
        updatedAt: new Date().toISOString(),
      });
      if (!connected) {
        connected = true;
        emitStatus(true, "Hook events detected");
      }
      emitSnapshotFromDecks();
      return;
    }

    if (packet.type === "track_load") {
      emitter.emit("raw-track-load", {
        deckHint: Number(packet.deck),
        contentIdRaw: packet.contentId != null ? String(packet.contentId) : null,
        arg3: packet.arg3 != null ? Number(packet.arg3) : null,
        arg4: packet.arg4 != null ? Number(packet.arg4) : null,
        updatedAt: new Date().toISOString(),
      });
      const contentId = Number(packet.contentId);
      if (!Number.isFinite(contentId) || contentId <= 0 || contentId >= Number.MAX_SAFE_INTEGER) {
        return;
      }
      const resolvedDeck = resolveDeckFromHints(packet, { preferUnknownContent: true });
      if (!resolvedDeck || !Number.isInteger(resolvedDeck.deck) || resolvedDeck.deck < 0) {
        return;
      }
      const deck = resolvedDeck.deck;
      updateDeckState(deck, (data) => {
        data.trackBrowserId = contentId;
      });
      markDeckSignal(deck, "track-load");
      emitter.emit("deck-resolution", {
        type: "track_load",
        deck: deck + 1,
        contentId: String(Math.trunc(contentId)),
        method: resolvedDeck.method,
        updatedAt: new Date().toISOString(),
      });
      if (!connected) {
        connected = true;
        emitStatus(true, "Hook events detected");
      }
      emitSnapshotFromDecks();
      return;
    }

    if (packet.type !== "olvc") {
      return;
    }

    const deckRaw = Number(packet.deck);
    if (!Number.isFinite(deckRaw)) {
      return;
    }
    const sourceDeckIndex = Math.trunc(deckRaw) - 1;
    if (sourceDeckIndex < 0) {
      return;
    }
    const deck = ((sourceDeckIndex % logicalDeckCount) + logicalDeckCount) % logicalDeckCount;
    const name = String(packet.name || "");
    if (!isLikelyHookEventName(name)) {
      return;
    }
    const isTrackIdLikeName =
      /TrackBrowserID/i.test(name) || /ContentID/i.test(name) || /Track.*ID/i.test(name);
    const isPlayStateName = isPlayStateLikeEventName(name);
    if (!HOOK_OLVC_WHITELIST.has(name) && !isTrackIdLikeName && !isPlayStateName) {
      return;
    }
    const value = Number(packet.value);

    updateDeckState(deck, (data) => {
      if (name === "@BPM") {
        if (Number.isFinite(value) && value > 0) {
          data.bpm = value;
        }
        markDeckSignal(deck, "playback");
      } else if (name === "@SyncSlaveBPM") {
        if (Number.isFinite(value) && value > 0 && (!Number.isFinite(data.bpm) || data.bpm === 0)) {
          data.bpm = value;
        }
        markDeckSignal(deck, "playback");
      } else if (name === "@OriginalBPM") {
        data.originalBpm = value;
      } else if (name === "@CurrentTime") {
        data.currentTime = value;
        markDeckSignal(deck, "playback");
      } else if (name === "@MixPointLinkRemainingTime") {
        data.remainingTime = value;
        markDeckSignal(deck, "playback");
      } else if (name === "@TotalTime") {
        data.totalTime = value;
        markDeckSignal(deck, "playback");
      } else if (name === "@TrackBrowserID") {
        data.trackBrowserId = value;
        markDeckSignal(deck, "track-id");
      } else if (
        /TrackBrowserID/i.test(name) ||
        /ContentID/i.test(name) ||
        /Track.*ID/i.test(name)
      ) {
        if (Number.isFinite(value) && value > 0 && value < Number.MAX_SAFE_INTEGER) {
          data.trackBrowserId = value;
          markDeckSignal(deck, "track-id");
        }
      } else if (isPlayStateName) {
        if (isExplicitPlaybackStateEventName(name) && Number.isFinite(value)) {
          if (/IsPlaying/i.test(name)) {
            data.explicitIsPlaying = value > 0;
          } else if (/PlayState|PlayerState/i.test(name)) {
            // Common enum patterns:
            // 0: stop, 1: play, 2: pause
            if (value === 0 || value === 2) {
              data.explicitIsPlaying = false;
            } else if (value === 1) {
              data.explicitIsPlaying = true;
            } else if (value > 2) {
              data.explicitIsPlaying = true;
            }
          }
          data.lastIsPlaying = data.explicitIsPlaying;
        }
        markDeckSignal(deck, "playback");
      } else if (name === "@TrackNo") {
        data.trackNo = value;
      } else if (/CurrentTime/i.test(name)) {
        data.currentTime = value;
      } else if (/TotalTime/i.test(name)) {
        data.totalTime = value;
      } else if (/RemainingTime/i.test(name)) {
        data.remainingTime = value;
      } else {
        data.metadata[name] = value;
        if (!unknownEventNames.has(name)) {
          unknownEventNames.add(name);
          emitter.emit("unknown-event", name);
        }
      }
    });

    if (!connected) {
      connected = true;
      emitStatus(true, "Hook events detected");
    }

    emitSnapshotFromDecks();
  }

  function start() {
    if (!enabled) {
      emitStatus(false, "Hook UDP provider disabled by config");
      return;
    }
    if (socket) {
      return;
    }

    socket = dgram.createSocket("udp4");
    socket.on("error", (error) => {
      emitStatus(false, `Hook UDP socket error: ${error.message}`);
    });
    socket.on("message", handlePacket);
    socket.bind(port, "127.0.0.1", () => {
      emitStatus(true, `Hook UDP listener started on 127.0.0.1:${port}`);
    });
  }

  function stop() {
    if (!socket) {
      return;
    }
    socket.close();
    socket = null;
    connected = false;
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    start,
    stop,
  };
}

module.exports = { createHookUdpProvider };
