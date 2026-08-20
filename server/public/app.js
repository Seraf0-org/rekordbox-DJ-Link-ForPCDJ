const statusLineEl = document.getElementById("statusLine");
const sourceLineEl = document.getElementById("sourceLine");
const warningsEl = document.getElementById("warnings");
const debugLogsEl = document.getElementById("debugLogs");

const deck1TitleEl = document.getElementById("deck1Title");
const deck1ArtistEl = document.getElementById("deck1Artist");
const deck1AlbumEl = document.getElementById("deck1Album");
const deck1GenreEl = document.getElementById("deck1Genre");
const deck1KeyEl = document.getElementById("deck1Key");
const deck1LabelEl = document.getElementById("deck1Label");
const deck1RealtimeBpmEl = document.getElementById("deck1RealtimeBpm");
const deck1TrackBpmEl = document.getElementById("deck1TrackBpm");
const deck1PositionTextEl = document.getElementById("deck1PositionText");
const deck1TotalTextEl = document.getElementById("deck1TotalText");
const deck1PlayStateEl = document.getElementById("deck1PlayState");
const deck1LoopStateEl = document.getElementById("deck1LoopState");
const deck1CardEl = document.getElementById("deck1Card");
const deck1WaveformEl = document.getElementById("deck1Waveform");

const deck2TitleEl = document.getElementById("deck2Title");
const deck2ArtistEl = document.getElementById("deck2Artist");
const deck2AlbumEl = document.getElementById("deck2Album");
const deck2GenreEl = document.getElementById("deck2Genre");
const deck2KeyEl = document.getElementById("deck2Key");
const deck2LabelEl = document.getElementById("deck2Label");
const deck2RealtimeBpmEl = document.getElementById("deck2RealtimeBpm");
const deck2TrackBpmEl = document.getElementById("deck2TrackBpm");
const deck2PositionTextEl = document.getElementById("deck2PositionText");
const deck2TotalTextEl = document.getElementById("deck2TotalText");
const deck2PlayStateEl = document.getElementById("deck2PlayState");
const deck2LoopStateEl = document.getElementById("deck2LoopState");
const deck2CardEl = document.getElementById("deck2Card");
const deck2WaveformEl = document.getElementById("deck2Waveform");

const themeSelectEl = document.getElementById("themeSelect");
const accentColorEl = document.getElementById("accentColor");
const resetThemeEl = document.getElementById("resetTheme");
const djAgentPanelEl = document.getElementById("djAgentPanel");
const djAgentSyndocalStatusEl = document.getElementById("djAgentSyndocalStatus");
const djAgentMidiStatusEl = document.getElementById("djAgentMidiStatus");
const djAgentModeEl = document.getElementById("djAgentMode");
const djAgentTimelineStateEl = document.getElementById("djAgentTimelineState");
const djAgentTimelineLoopEl = document.getElementById("djAgentTimelineLoop");
const djAgentReleaseMacroEl = document.getElementById("djAgentReleaseMacro");
const djAgentLastEventEl = document.getElementById("djAgentLastEvent");
const djAgentLastTimelineActionEl = document.getElementById("djAgentLastTimelineAction");
const djAgentLastAckEl = document.getElementById("djAgentLastAck");
const djAgentActionResultEl = document.getElementById("djAgentActionResult");

const toggleAlbumEl = document.getElementById("toggleAlbum");
const toggleGenreEl = document.getElementById("toggleGenre");
const toggleKeyEl = document.getElementById("toggleKey");
const toggleLabelEl = document.getElementById("toggleLabel");
const toggleTrackBpmEl = document.getElementById("toggleTrackBpm");
const toggleTimeEl = document.getElementById("toggleTime");

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

  // Load field toggles
  const extFields = [
    { el: toggleAlbumEl,   key: "rb-output-show-album",    cls: "hide-meta-album",    defaultVal: false },
    { el: toggleGenreEl,   key: "rb-output-show-genre",    cls: "hide-meta-genre",    defaultVal: false },
    { el: toggleKeyEl,     key: "rb-output-show-key",      cls: "hide-meta-key",      defaultVal: false },
    { el: toggleLabelEl,   key: "rb-output-show-label",    cls: "hide-meta-label",    defaultVal: false },
    { el: toggleTrackBpmEl,key: "rb-output-show-trackbpm", cls: "hide-meta-trackbpm", defaultVal: true },
    { el: toggleTimeEl,    key: "rb-output-show-time",     cls: "hide-meta-time",     defaultVal: true },
  ];
  for (const { el, key, cls, defaultVal } of extFields) {
    if (el) {
      const saved = localStorage.getItem(key);
      const isShowing = saved === null ? defaultVal : saved === "true";
      el.checked = isShowing;
      document.body.classList.toggle(cls, !isShowing);
    }
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
      // Reset toggles
      const extFields = [
        { el: toggleAlbumEl,   key: "rb-output-show-album",    cls: "hide-meta-album",    defaultVal: false },
        { el: toggleGenreEl,   key: "rb-output-show-genre",    cls: "hide-meta-genre",    defaultVal: false },
        { el: toggleKeyEl,     key: "rb-output-show-key",      cls: "hide-meta-key",      defaultVal: false },
        { el: toggleLabelEl,   key: "rb-output-show-label",    cls: "hide-meta-label",    defaultVal: false },
        { el: toggleTrackBpmEl,key: "rb-output-show-trackbpm", cls: "hide-meta-trackbpm", defaultVal: true },
        { el: toggleTimeEl,    key: "rb-output-show-time",     cls: "hide-meta-time",     defaultVal: true },
      ];
      for (const { el, key, cls, defaultVal } of extFields) {
        if (el) {
          el.checked = defaultVal;
          localStorage.removeItem(key);
          document.body.classList.toggle(cls, !defaultVal);
        }
      }
      
      // Reset Field Order
      localStorage.removeItem(FIELD_ORDER_KEY);
      applyFieldOrder(DEFAULT_FIELD_ORDER);
      const listEl = document.getElementById("fieldSortableList");
      if (listEl) {
        DEFAULT_FIELD_ORDER.forEach((fieldName) => {
          const el = listEl.querySelector(`[data-field="${fieldName}"]`);
          if (el) {
            listEl.appendChild(el);
          }
        });
      }
    });
  }

  // Bind field toggles
  const extFields = [
    { el: toggleAlbumEl,   key: "rb-output-show-album",    cls: "hide-meta-album" },
    { el: toggleGenreEl,   key: "rb-output-show-genre",    cls: "hide-meta-genre" },
    { el: toggleKeyEl,     key: "rb-output-show-key",      cls: "hide-meta-key" },
    { el: toggleLabelEl,   key: "rb-output-show-label",    cls: "hide-meta-label" },
    { el: toggleTrackBpmEl,key: "rb-output-show-trackbpm", cls: "hide-meta-trackbpm" },
    { el: toggleTimeEl,    key: "rb-output-show-time",     cls: "hide-meta-time" },
  ];
  for (const { el, key, cls } of extFields) {
    if (el) {
      el.addEventListener("change", (e) => {
        const isShowing = e.target.checked;
        localStorage.setItem(key, isShowing.toString());
        document.body.classList.toggle(cls, !isShowing);
      });
    }
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

function formatLoopState(loopState) {
  if (!loopState || typeof loopState !== "object") {
    return { text: "-", active: false };
  }
  const active = loopState.active === true;
  const status = active ? "ACTIVE" : loopState.active === false ? "OFF" : "UNKNOWN";
  const lengthBeats = Number(loopState.lengthBeats);
  const startBeat = Number(loopState.startBeat);
  const endBeat = Number(loopState.endBeat);
  if (Number.isFinite(lengthBeats) && lengthBeats > 0) {
    const lengthText = `${Number(lengthBeats.toFixed(2))} beats`;
    if (Number.isFinite(startBeat) && Number.isFinite(endBeat)) {
      return { text: `${status} · ${lengthText} · ${Number(startBeat.toFixed(2))}→${Number(endBeat.toFixed(2))}`, active };
    }
    return { text: `${status} · ${lengthText}`, active };
  }
  const startMs = Number(loopState.startMs);
  const endMs = Number(loopState.endMs);
  if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
    return { text: `${status} · ${(startMs / 1000).toFixed(2)}→${(endMs / 1000).toFixed(2)}s`, active };
  }
  return { text: status, active };
}

function renderLoopState(loopState, loopStateEl, cardEl) {
  if (!loopStateEl) {
    return;
  }
  const formatted = formatLoopState(loopState);
  loopStateEl.textContent = formatted.text;
  loopStateEl.classList.toggle("active", formatted.active);
  if (cardEl) {
    cardEl.classList.toggle("loop-active", formatted.active);
  }
}

function renderDjAgentStatus(status) {
  const agent = status?.djAgent || {};
  if (djAgentPanelEl) {
    djAgentPanelEl.hidden = agent.enabled !== true;
  }
  if (agent.enabled !== true) {
    return;
  }
  const syndocal = agent.syndocal || {};
  const midi = agent.midi || {};
  if (djAgentSyndocalStatusEl) {
    djAgentSyndocalStatusEl.textContent = String(syndocal.state || agent.state || "DISCONNECTED").toUpperCase();
    djAgentSyndocalStatusEl.classList.toggle("connected", syndocal.state === "connected");
  }
  if (djAgentMidiStatusEl) {
    djAgentMidiStatusEl.textContent = midi.ok ? "CONNECTED" : String(midi.message || "UNAVAILABLE");
  }
  if (djAgentModeEl) {
    djAgentModeEl.textContent = String(agent.mode || "dj-control").toUpperCase();
    djAgentModeEl.classList.toggle("connected", agent.mode === "timeline-control");
  }
  if (djAgentTimelineStateEl) {
    const state = agent.timelineState || "unknown";
    djAgentTimelineStateEl.textContent = String(state).toUpperCase();
    djAgentTimelineStateEl.classList.toggle("connected", state === "running");
  }
  if (djAgentTimelineLoopEl) {
    djAgentTimelineLoopEl.textContent = agent.timelineLoopActive == null
      ? "UNKNOWN"
      : agent.timelineLoopActive ? "ON" : "OFF";
  }
  if (djAgentReleaseMacroEl) {
    const sequence = agent.releaseMacroSequence || "parallel";
    const phase = agent.releaseMacroPhase || "idle";
    const reason = agent.releaseMacroReason || "";
    djAgentReleaseMacroEl.textContent = `${sequence} · ${phase}${reason ? ` · ${reason}` : ""}`;
  }
  if (djAgentLastEventEl) {
    djAgentLastEventEl.textContent = agent.lastEventType || "-";
  }
  if (djAgentLastTimelineActionEl) {
    const action = agent.lastTimelineAction;
    const delivery = action?.delivery || {};
    djAgentLastTimelineActionEl.textContent = action?.action
      ? `${action.action} · ${String(delivery.state || (action.ok ? "acknowledged" : "pending")).toUpperCase()}`
      : "-";
  }
  if (djAgentLastAckEl) {
    const ack = syndocal.lastAckResult;
    djAgentLastAckEl.textContent = ack
      ? `${String(ack.state || "ACK").toUpperCase()} · ${ack.type || "event"}${ack.message ? ` · ${ack.message}` : ""}`
      : syndocal.lastAckAt || "-";
  }
  if (djAgentActionResultEl) {
    const action = agent.lastAction;
    const deliveryState = action?.delivery?.state || action?.delivery?.ackState || null;
    const state = deliveryState || (action?.ok === true ? "acknowledged" : null);
    let text = "Ready";
    let failure = false;
    if (action?.action) {
      if (action.ignored === true || action.state === "inactive") {
        text = `Ignored · ${action.action}${action.reason ? ` · ${action.reason}` : ""}`;
      } else if (state === "pending") {
        text = `Pending · ${action.action}`;
      } else if (action.ok === true) {
        text = `Success · ${action.action}`;
      } else {
        text = `Failed · ${action.action}${action.reason ? ` · ${action.reason}` : ""}`;
        failure = true;
      }
    }
    djAgentActionResultEl.textContent = text;
    djAgentActionResultEl.classList.toggle("error", failure);
  }
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

function drawWaveform(canvasEl, base64Data, ratio) {
  if (!canvasEl) return;
  const ctx = canvasEl.getContext('2d');
  
  canvasEl.width = canvasEl.clientWidth || 300;
  canvasEl.height = canvasEl.clientHeight || 48;
  
  if (!base64Data) {
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    canvasEl.dataset.waveraw = "";
    canvasEl._cachedHeights = null;
    return;
  }
  
  if (canvasEl.dataset.waveraw !== base64Data || !canvasEl._cachedHeights) {
    canvasEl.dataset.waveraw = base64Data;
    const bin = atob(base64Data);
    const heights = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      heights[i] = bin.charCodeAt(i);
    }
    canvasEl._cachedHeights = heights;
  }
  
  const heights = canvasEl._cachedHeights;
  
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim() || '#47e1a8';
  const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#6b7280';
  
  const barWidth = canvasEl.width / heights.length;
  const maxH = 31;
  const splitIndex = Math.floor(heights.length * (ratio / 100));

  for (let i = 0; i < heights.length; i++) {
    const val = heights[i] & 0x1F;
    const ch = (val / maxH) * canvasEl.height;
    ctx.fillStyle = i <= splitIndex ? accent : muted;
    ctx.fillRect(i * barWidth, canvasEl.height - ch, Math.max(1, barWidth - 0.5), ch);
  }
  
  // Draw playhead line
  const x = (ratio / 100) * canvasEl.width;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x - 1, 0, 2, canvasEl.height);
}

function renderDeckCard(track, playback, view, fallbackRealtimeBpm = null, deckNumber = 0, loopState = null) {
  const titleText =
    track?.title ||
    (Number.isFinite(track?.trackNo) && track.trackNo > 0 ? `Track #${track.trackNo}` : "-");
  const artistText = track?.artist || "-";
  const realtimeRaw = playback?.bpm == null ? NaN : Number(playback.bpm);
  const realtimeBpm =
    Number.isFinite(realtimeRaw) && realtimeRaw > 0 ? realtimeRaw : (fallbackRealtimeBpm == null ? NaN : Number(fallbackRealtimeBpm));
  const trackBpm = track?.trackBpm == null ? NaN : Number(track.trackBpm);
  const pos = playback?.positionSec == null ? NaN : Number(playback.positionSec);
  const totalRaw = playback?.totalSec == null ? NaN : Number(playback.totalSec);
  const durationFallback = track?.durationSec == null ? NaN : Number(track.durationSec);
  const total =
    Number.isFinite(totalRaw) && totalRaw > 0
      ? totalRaw
      : Number.isFinite(durationFallback)
        ? durationFallback
        : NaN;
  const ratio =
    Number.isFinite(pos) && Number.isFinite(total) && total > 0
      ? Math.min(100, Math.max(0, (pos / total) * 100))
      : 0;

  view.titleEl.textContent = titleText;
  view.titleEl.title = titleText;
  view.artistEl.textContent = artistText;
  view.artistEl.title = artistText;

  if (view.albumEl) view.albumEl.textContent = track?.album || "-";
  if (view.genreEl) view.genreEl.textContent = track?.genre || "-";
  if (view.keyEl) view.keyEl.textContent = track?.key || "-";
  if (view.labelEl) view.labelEl.textContent = track?.label || "-";

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
  renderLoopState(loopState, view.loopStateEl, view.cardEl);
  if (view.waveformEl) {
    drawWaveform(view.waveformEl, track?.waveform, ratio);
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
  window.__rbLastState = state;
  const deckNowPlaying = Array.isArray(state?.deckNowPlaying) ? state.deckNowPlaying : [];
  const recentTracks = Array.isArray(state?.recentTracks) ? state.recentTracks : [];
  const deckPlaybacks = Array.isArray(state?.deckPlaybacks) ? state.deckPlaybacks : [];
  const loopStates = Array.isArray(state?.loopStates)
    ? state.loopStates
    : Array.isArray(state?.loops)
      ? state.loops
      : [];
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
  const deck1RealtimeFallback = Number(realtimeBpm?.deck) === 1 ? Number(realtimeBpm?.value) : null;
  const deck2RealtimeFallback = Number(realtimeBpm?.deck) === 2 ? Number(realtimeBpm?.value) : null;

  renderDeckCard(deck1Track, deck1Playback, {
    cardEl: deck1CardEl,
    playStateEl: deck1PlayStateEl,
    titleEl: deck1TitleEl,
    artistEl: deck1ArtistEl,
    albumEl: deck1AlbumEl,
    genreEl: deck1GenreEl,
    keyEl: deck1KeyEl,
    labelEl: deck1LabelEl,
    realtimeBpmEl: deck1RealtimeBpmEl,
    trackBpmEl: deck1TrackBpmEl,
    positionEl: deck1PositionTextEl,
    totalEl: deck1TotalTextEl,
    waveformEl: deck1WaveformEl,
    loopStateEl: deck1LoopStateEl,
  }, deck1RealtimeFallback, 1, loopStates.find((item) => Number(item?.deck) === 1));

  renderDeckCard(deck2Track, deck2Playback, {
    cardEl: deck2CardEl,
    playStateEl: deck2PlayStateEl,
    titleEl: deck2TitleEl,
    artistEl: deck2ArtistEl,
    albumEl: deck2AlbumEl,
    genreEl: deck2GenreEl,
    keyEl: deck2KeyEl,
    labelEl: deck2LabelEl,
    realtimeBpmEl: deck2RealtimeBpmEl,
    trackBpmEl: deck2TrackBpmEl,
    positionEl: deck2PositionTextEl,
    totalEl: deck2TotalTextEl,
    waveformEl: deck2WaveformEl,
    loopStateEl: deck2LoopStateEl,
  }, deck2RealtimeFallback, 2, loopStates.find((item) => Number(item?.deck) === 2));

  const rb = status.rekordbox || {};
  const hook = status.hook || {};
  const sourceInfo = state?.sourceInfo || {};
  const deckMethods = sourceInfo?.deckMethods || {};
  const rbStatus = rb.ok ? "Rekordbox: OK" : `Rekordbox: ${rb.message || "NG"}`;
  const hookStatus = hook.ok ? "Hook: OK" : `Hook: ${hook.message || "NG"}`;
  renderDjAgentStatus(status);
  if (statusLineEl) {
    statusLineEl.textContent = `${rbStatus} | ${hookStatus}`;
  }
  if (sourceLineEl) {
    sourceLineEl.textContent = `Source: nowPlaying=${sourceInfo.nowPlayingMethod || "-"} | deck1=${deckMethods[1] || "-"} | deck2=${deckMethods[2] || "-"}`;
  }

  const warnings = [...(state?.warnings || [])];
  const noTrackData =
    hook.ok &&
    deckPlaybacks.length > 0 &&
    (!state?.deckNowPlaying?.length ||
      state.deckNowPlaying.every((e) => !e?.title && !e?.artist));
  if (noTrackData) {
    warnings.unshift("Rekordboxで曲をデッキに読み込むと曲名が表示されます (Hook connected, waiting for track load)");
  }
  renderWarnings(warnings);
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
  socket.on("loop_state", (loopState) => {
    if (!window.__rbLastState || !loopState) {
      return;
    }
    const current = Array.isArray(window.__rbLastState.loopStates)
      ? window.__rbLastState.loopStates
      : [];
    const next = current.filter((item) => Number(item?.deck) !== Number(loopState?.deck));
    next.push(loopState);
    next.sort((a, b) => Number(a?.deck) - Number(b?.deck));
    window.__rbLastState = { ...window.__rbLastState, loopStates: next };
    render(window.__rbLastState);
  });
}

loadThemeSettings();
bindThemeSettings();

const FIELD_ORDER_KEY = "rb-output-field-order";
const DEFAULT_FIELD_ORDER = ["title", "artist", "album", "genre", "key", "label", "realtimebpm", "trackbpm", "time"];

function applyFieldOrder(orderArray) {
  const decks = [document.getElementById("deck1Card"), document.getElementById("deck2Card")];
  for (const deck of decks) {
    if (!deck) continue;
    const container = deck.querySelector(".deck-fields");
    if (!container) continue;
    orderArray.forEach((fieldName, index) => {
      const el = container.querySelector(`[data-field="${fieldName}"]`);
      if (el) {
        el.style.order = index;
      }
    });
  }
}

function initSortableFields() {
  const listEl = document.getElementById("fieldSortableList");
  if (!listEl || typeof Sortable === "undefined") return;

  let savedOrder;
  try {
    savedOrder = JSON.parse(localStorage.getItem(FIELD_ORDER_KEY));
  } catch (e) {}
  if (!Array.isArray(savedOrder) || savedOrder.length === 0) {
    savedOrder = DEFAULT_FIELD_ORDER;
  }

  // Reorder sortable list DOM nodes to match saved order
  savedOrder.forEach((fieldName) => {
    const el = listEl.querySelector(`[data-field="${fieldName}"]`);
    if (el) {
      listEl.appendChild(el);
    }
  });

  applyFieldOrder(savedOrder);

  Sortable.create(listEl, {
    animation: 150,
    onEnd: function () {
      const newOrder = Array.from(listEl.querySelectorAll("[data-field]")).map(el => el.getAttribute("data-field"));
      localStorage.setItem(FIELD_ORDER_KEY, JSON.stringify(newOrder));
      applyFieldOrder(newOrder);
    }
  });
}

initSortableFields();

for (const button of document.querySelectorAll("[data-dj-action]")) {
  button.addEventListener("click", async () => {
    const action = button.getAttribute("data-dj-action");
    if (!action) {
      return;
    }
    button.disabled = true;
    try {
      if (djAgentActionResultEl) {
        djAgentActionResultEl.textContent = `Pending · ${action}`;
        djAgentActionResultEl.classList.remove("error");
      }
      const response = await fetch(`/api/dj-agent/actions/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const result = await response.json().catch(() => ({}));
      const ignored = result?.ignored === true || result?.result?.ignored === true || result?.result?.state === "inactive";
      if (djAgentActionResultEl && ignored) {
        djAgentActionResultEl.textContent = `Ignored · ${action}${result?.result?.reason ? ` · ${result.result.reason}` : ""}`;
        djAgentActionResultEl.classList.remove("error");
      } else if (djAgentActionResultEl && result.pending !== true && (!response.ok || result.ok !== true)) {
        const reason = result?.result?.reason || result?.error || result?.ackState || `HTTP ${response.status}`;
        djAgentActionResultEl.textContent = `Failed · ${action} · ${reason}`;
        djAgentActionResultEl.classList.add("error");
      } else if (djAgentActionResultEl && result.pending === true) {
        djAgentActionResultEl.textContent = `Pending · ${action} · ACK`;
      } else if (djAgentActionResultEl) {
        djAgentActionResultEl.textContent = `Success · ${action}`;
      }
    } catch (error) {
      if (djAgentActionResultEl) {
        djAgentActionResultEl.textContent = `Failed · ${action} · network error`;
        djAgentActionResultEl.classList.add("error");
      }
    } finally {
      button.disabled = false;
    }
  });
}

fetchInitialState().finally(() => {
  connectSocket();
});
