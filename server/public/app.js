const statusLineEl = document.getElementById("statusLine");
const sourceLineEl = document.getElementById("sourceLine");
const warningsEl = document.getElementById("warnings");
const debugLogsEl = document.getElementById("debugLogs");

const deck1TitleEl = document.getElementById("deck1Title");
const deck1ArtistEl = document.getElementById("deck1Artist");
const deck1RealtimeBpmEl = document.getElementById("deck1RealtimeBpm");
const deck1TrackBpmEl = document.getElementById("deck1TrackBpm");
const deck1PositionTextEl = document.getElementById("deck1PositionText");
const deck1TotalTextEl = document.getElementById("deck1TotalText");
const deck1ProgressBarEl = document.getElementById("deck1ProgressBar");
const deck1PlayStateEl = document.getElementById("deck1PlayState");
const deck1CardEl = document.getElementById("deck1Card");

const deck2TitleEl = document.getElementById("deck2Title");
const deck2ArtistEl = document.getElementById("deck2Artist");
const deck2RealtimeBpmEl = document.getElementById("deck2RealtimeBpm");
const deck2TrackBpmEl = document.getElementById("deck2TrackBpm");
const deck2PositionTextEl = document.getElementById("deck2PositionText");
const deck2TotalTextEl = document.getElementById("deck2TotalText");
const deck2ProgressBarEl = document.getElementById("deck2ProgressBar");
const deck2PlayStateEl = document.getElementById("deck2PlayState");
const deck2CardEl = document.getElementById("deck2Card");

const themeSelectEl = document.getElementById("themeSelect");
const accentColorEl = document.getElementById("accentColor");
const resetThemeEl = document.getElementById("resetTheme");

const THEME_STORAGE_KEY = "rb-output-theme";
const ACCENT_STORAGE_KEY = "rb-output-accent";
const DEFAULT_THEME = "dark";
const DEFAULT_ACCENT = "#47e1a8";
const lastRealtimeBpmByDeck = { 1: null, 2: null };

function normalizeTheme(value) {
  return value === "light" ? "light" : "dark";
}

function normalizeAccent(value) {
  if (typeof value !== "string") {
    return DEFAULT_ACCENT;
  }
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : DEFAULT_ACCENT;
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", normalizeTheme(theme));
}

function applyAccent(color) {
  document.documentElement.style.setProperty("--accent-color", normalizeAccent(color));
}

function loadThemeSettings() {
  const savedTheme = normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY) || DEFAULT_THEME);
  const savedAccent = normalizeAccent(localStorage.getItem(ACCENT_STORAGE_KEY) || DEFAULT_ACCENT);
  applyTheme(savedTheme);
  applyAccent(savedAccent);
  if (themeSelectEl) {
    themeSelectEl.value = savedTheme;
  }
  if (accentColorEl) {
    accentColorEl.value = savedAccent;
  }
}

function bindThemeSettings() {
  if (themeSelectEl) {
    themeSelectEl.addEventListener("change", (event) => {
      const nextTheme = normalizeTheme(event.target.value);
      applyTheme(nextTheme);
      localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    });
  }

  if (accentColorEl) {
    accentColorEl.addEventListener("input", (event) => {
      const nextAccent = normalizeAccent(event.target.value);
      applyAccent(nextAccent);
      localStorage.setItem(ACCENT_STORAGE_KEY, nextAccent);
    });
  }

  if (resetThemeEl) {
    resetThemeEl.addEventListener("click", () => {
      applyTheme(DEFAULT_THEME);
      applyAccent(DEFAULT_ACCENT);
      localStorage.setItem(THEME_STORAGE_KEY, DEFAULT_THEME);
      localStorage.setItem(ACCENT_STORAGE_KEY, DEFAULT_ACCENT);
      if (themeSelectEl) {
        themeSelectEl.value = DEFAULT_THEME;
      }
      if (accentColorEl) {
        accentColorEl.value = DEFAULT_ACCENT;
      }
    });
  }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "-";
  }
  const normalized = Math.max(0, Number(seconds));
  const mm = Math.floor(normalized / 60);
  const ss = (normalized - mm * 60).toFixed(1).padStart(4, "0");
  return `${mm}:${ss}`;
}

function formatBpm(value) {
  return Number.isFinite(value) && value > 0 ? value.toFixed(2) : "-";
}

function renderWarnings(items) {
  warningsEl.innerHTML = "";
  const warnings = Array.isArray(items) ? items : [];
  if (!warnings.length) {
    const li = document.createElement("li");
    li.textContent = "No warnings";
    warningsEl.appendChild(li);
    return;
  }
  for (const warning of warnings) {
    const li = document.createElement("li");
    li.textContent = warning;
    warningsEl.appendChild(li);
  }
}

function renderDebugLogs(items) {
  if (!debugLogsEl) {
    return;
  }
  debugLogsEl.innerHTML = "";
  const logs = Array.isArray(items) ? items.slice(-14).reverse() : [];
  if (!logs.length) {
    const li = document.createElement("li");
    li.textContent = "No debug logs";
    debugLogsEl.appendChild(li);
    return;
  }
  for (const entry of logs) {
    const li = document.createElement("li");
    const at = typeof entry?.at === "string" ? entry.at.replace("T", " ").replace("Z", "") : "-";
    const method = entry?.method || "unknown";
    const message = entry?.message || "";
    li.textContent = `[${at}] ${method}: ${message}`;
    debugLogsEl.appendChild(li);
  }
}

function renderDeckCard(track, playback, view, fallbackRealtimeBpm = null, deckNumber = 0) {
  const titleText =
    track?.title ||
    (Number.isFinite(track?.trackNo) && track.trackNo > 0 ? `Track #${track.trackNo}` : "-");
  const artistText = track?.artist || "-";
  const realtimeRaw = Number(playback?.bpm);
  const realtimeBpm =
    Number.isFinite(realtimeRaw) && realtimeRaw > 0 ? realtimeRaw : Number(fallbackRealtimeBpm);
  const trackBpm = Number(track?.trackBpm);
  const pos = Number(playback?.positionSec);
  const totalRaw = Number(playback?.totalSec);
  const durationFallback = Number(track?.durationSec);
  const total =
    Number.isFinite(totalRaw) && totalRaw > 0
      ? totalRaw
      : Number.isFinite(durationFallback)
        ? durationFallback
        : null;
  const ratio =
    Number.isFinite(pos) && Number.isFinite(total) && total > 0
      ? Math.min(100, Math.max(0, (pos / total) * 100))
      : 0;

  view.titleEl.textContent = titleText;
  view.titleEl.title = titleText;
  view.artistEl.textContent = artistText;
  view.artistEl.title = artistText;
  const realtimeDisplayValue =
    Number.isFinite(realtimeBpm) && realtimeBpm > 0
      ? realtimeBpm
      : Number(lastRealtimeBpmByDeck[deckNumber]);
  if (Number.isFinite(realtimeBpm) && realtimeBpm > 0) {
    lastRealtimeBpmByDeck[deckNumber] = realtimeBpm;
  }
  view.realtimeBpmEl.textContent = formatBpm(realtimeDisplayValue);
  view.trackBpmEl.textContent = formatBpm(trackBpm);
  view.positionEl.textContent = formatDuration(pos);
  view.totalEl.textContent = formatDuration(total);
  view.progressEl.style.width = `${ratio}%`;

  const explicitIsPlaying = playback?.isPlaying;
  const isPlaying = typeof explicitIsPlaying === "boolean" ? explicitIsPlaying : null;
  if (view.playStateEl) {
    view.playStateEl.textContent = isPlaying === null ? "-" : isPlaying ? "PLAY" : "PAUSE";
    view.playStateEl.classList.toggle("playing", isPlaying === true);
    view.playStateEl.classList.toggle("paused", isPlaying === false);
  }
  if (view.cardEl) {
    view.cardEl.classList.toggle("is-playing", isPlaying === true);
    view.cardEl.classList.toggle("is-paused", isPlaying === false);
  }
}

function pickRecentTrackByBpm(recentTracks, targetBpm, excludedIds = new Set()) {
  if (!Array.isArray(recentTracks) || !Number.isFinite(targetBpm) || targetBpm <= 0) {
    return null;
  }
  let best = null;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const track of recentTracks) {
    const trackId = String(track?.contentId || "");
    if (!trackId || excludedIds.has(trackId)) {
      continue;
    }
    const trackBpm = Number(track?.trackBpm);
    if (!Number.isFinite(trackBpm) || trackBpm <= 0) {
      continue;
    }
    const diff = Math.abs(trackBpm - targetBpm);
    if (diff < bestDiff) {
      best = track;
      bestDiff = diff;
    }
  }
  if (bestDiff > 3.0) {
    return null;
  }
  return best;
}

function render(state) {
  const deckNowPlaying = Array.isArray(state?.deckNowPlaying) ? state.deckNowPlaying : [];
  const recentTracks = Array.isArray(state?.recentTracks) ? state.recentTracks : [];
  const deckPlaybacks = Array.isArray(state?.deckPlaybacks) ? state.deckPlaybacks : [];
  const playback = state?.playback || {};
  const realtimeBpm = state?.realtimeBpm || {};
  const status = state?.status || {};

  const deck1Playback =
    deckPlaybacks.find((item) => Number(item?.deck) === 1) ||
    (Number(playback?.deck) === 1 ? playback : null);
  const deck2Playback =
    deckPlaybacks.find((item) => Number(item?.deck) === 2) ||
    (Number(playback?.deck) === 2 ? playback : null);
  const deck1KnownTrack = deckNowPlaying.find((item) => Number(item?.deck) === 1) || null;
  const deck2KnownTrack = deckNowPlaying.find((item) => Number(item?.deck) === 2) || null;
  const usedRecentIds = new Set(
    [deck1KnownTrack, deck2KnownTrack]
      .map((item) => String(item?.contentId || ""))
      .filter(Boolean)
  );
  const deck1FallbackTrack = pickRecentTrackByBpm(
    recentTracks,
    Number(deck1Playback?.bpm),
    usedRecentIds
  );
  if (deck1FallbackTrack?.contentId) {
    usedRecentIds.add(String(deck1FallbackTrack.contentId));
  }
  const deck2FallbackTrack = pickRecentTrackByBpm(
    recentTracks,
    Number(deck2Playback?.bpm),
    usedRecentIds
  );
  let deck1Track = deck1KnownTrack || deck1FallbackTrack || null;
  let deck2Track = deck2KnownTrack || deck2FallbackTrack || null;
  const nowPlayingTrack =
    state?.nowPlaying && (state.nowPlaying.title || state.nowPlaying.artist || state.nowPlaying.contentId)
      ? state.nowPlaying
      : null;
  const activeDeck = Number(playback?.deck);
  if (nowPlayingTrack) {
    if (activeDeck === 1 && !deck1Track) {
      deck1Track = nowPlayingTrack;
    } else if (activeDeck === 2 && !deck2Track) {
      deck2Track = nowPlayingTrack;
    } else if (!deck1Track && !deck2Track) {
      deck1Track = nowPlayingTrack;
    }
  }
  const deck1RealtimeFallback = Number(realtimeBpm?.deck) === 1 ? Number(realtimeBpm?.value) : null;
  const deck2RealtimeFallback = Number(realtimeBpm?.deck) === 2 ? Number(realtimeBpm?.value) : null;

  renderDeckCard(deck1Track, deck1Playback, {
    cardEl: deck1CardEl,
    playStateEl: deck1PlayStateEl,
    titleEl: deck1TitleEl,
    artistEl: deck1ArtistEl,
    realtimeBpmEl: deck1RealtimeBpmEl,
    trackBpmEl: deck1TrackBpmEl,
    positionEl: deck1PositionTextEl,
    totalEl: deck1TotalTextEl,
    progressEl: deck1ProgressBarEl,
  }, deck1RealtimeFallback, 1);

  renderDeckCard(deck2Track, deck2Playback, {
    cardEl: deck2CardEl,
    playStateEl: deck2PlayStateEl,
    titleEl: deck2TitleEl,
    artistEl: deck2ArtistEl,
    realtimeBpmEl: deck2RealtimeBpmEl,
    trackBpmEl: deck2TrackBpmEl,
    positionEl: deck2PositionTextEl,
    totalEl: deck2TotalTextEl,
    progressEl: deck2ProgressBarEl,
  }, deck2RealtimeFallback, 2);

  const rb = status.rekordbox || {};
  const hook = status.hook || {};
  const sourceInfo = state?.sourceInfo || {};
  const deckMethods = sourceInfo?.deckMethods || {};
  const rbStatus = rb.ok ? "Rekordbox: OK" : `Rekordbox: ${rb.message || "NG"}`;
  const hookStatus = hook.ok ? "Hook: OK" : `Hook: ${hook.message || "NG"}`;
  if (statusLineEl) {
    statusLineEl.textContent = `${rbStatus} | ${hookStatus}`;
  }
  if (sourceLineEl) {
    sourceLineEl.textContent = `Source: nowPlaying=${sourceInfo.nowPlayingMethod || "-"} | deck1=${deckMethods[1] || "-"} | deck2=${deckMethods[2] || "-"}`;
  }

  renderWarnings(state?.warnings || []);
  renderDebugLogs(state?.debugLogs || []);
}

async function fetchInitialState() {
  const response = await fetch("/api/now-playing");
  const state = await response.json();
  render(state);
}

function connectSocket() {
  const socket = io();
  socket.on("state", (state) => render(state));
}

loadThemeSettings();
bindThemeSettings();

fetchInitialState().finally(() => {
  connectSocket();
});
