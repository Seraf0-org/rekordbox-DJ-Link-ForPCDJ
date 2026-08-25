const statusLineEl = document.getElementById("statusLine");
const sourceLineEl = document.getElementById("sourceLine");
const warningsEl = document.getElementById("warnings");
const warningCountEl = document.getElementById("warningCount");
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

const mixerUpdatedEl = document.getElementById("mixerUpdated");
const crossfaderTrackEl = document.getElementById("crossfaderTrack");
const crossfaderThumbEl = document.getElementById("crossfaderThumb");
const crossfaderValueEl = document.getElementById("crossfaderValue");
const deck1FaderTrackEl = document.getElementById("deck1FaderTrack");
const deck1FaderFillEl = document.getElementById("deck1FaderFill");
const deck1FaderValueEl = document.getElementById("deck1FaderValue");
const deck1OutputStateEl = document.getElementById("deck1OutputState");
const deck2FaderTrackEl = document.getElementById("deck2FaderTrack");
const deck2FaderFillEl = document.getElementById("deck2FaderFill");
const deck2FaderValueEl = document.getElementById("deck2FaderValue");
const deck2OutputStateEl = document.getElementById("deck2OutputState");

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
const djAgentSetupRefreshEl = document.getElementById("djAgentSetupRefresh");
const djAgentSetupMessageEl = document.getElementById("djAgentSetupMessage");
const djAgentSetupReadinessEl = document.getElementById("djAgentSetupReadiness");
const djAgentMidiPortsEl = document.getElementById("djAgentMidiPorts");
const djAgentMappingArtifactEl = document.getElementById("djAgentMappingArtifact");
const djAgentConfigPreviewEl = document.getElementById("djAgentConfigPreview");
const djAgentConfigDownloadEl = document.getElementById("djAgentConfigDownload");
const djAgentConfigCopyEl = document.getElementById("djAgentConfigCopy");
const djAgentSyndocalHostEl = document.getElementById("djAgentSyndocalHost");
const djAgentSyndocalNicEl = document.getElementById("djAgentSyndocalNic");
const djAgentMidiOutputEl = document.getElementById("djAgentMidiOutput");
const djAgentAdapterEl = document.getElementById("djAgentAdapter");

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
const lastTrackBpmByDeck = { 1: null, 2: null };
let latestState = null;
let lastWarningsFingerprint = "";
let lastDebugLogsFingerprint = "";
let stateFetchInFlight = null;
let djAgentSetupFetchInFlight = null;

const DEFAULT_DJ_AGENT_CONFIG_TEMPLATE = {
  enabled: false,
  syndocal: {
    host: "",
    nic: "",
    adapter: "",
    path: "/dj-link",
  },
  midi: {
    device: "",
    port: null,
  },
  pedal: {
    bindings: {
      release: "F13",
      loopHalf: "F14",
      filterClose: "F15",
    },
  },
  releaseMacro: {
    enabled: false,
  },
};

const SETUP_ADAPTERS = ["generic-json", "syndocal-envelope-v1"];
const DEFAULT_MAPPING_ARTIFACT = {
  url: "/setup/CustomMIDI1-Syndocal-v1.1.2.csv",
  filename: "CustomMIDI1-Syndocal-v1.1.2.csv",
  valid: null,
};
const djAgentSetupDraft = {
  host: "",
  nic: "",
  midiPort: "",
  midiDevice: "",
  adapter: "",
};
const djAgentSetupDraftTouched = new Set();
let djAgentSetupTemplate = DEFAULT_DJ_AGENT_CONFIG_TEMPLATE;

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
      resetSortableFields();
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
  const lengthBeats = Number(loopState.lengthBeats);
  const startBeat = Number(loopState.startBeat);
  const endBeat = Number(loopState.endBeat);
  const startMs = Number(loopState.startMs);
  const endMs = Number(loopState.endMs);
  const hasBoundaries =
    (Number.isFinite(startBeat) && Number.isFinite(endBeat)) ||
    (Number.isFinite(startMs) && Number.isFinite(endMs));
  const status = active ? "ACTIVE" : loopState.active === false ? "OFF" : hasBoundaries ? "SET" : "UNKNOWN";
  if (Number.isFinite(lengthBeats) && lengthBeats > 0) {
    const lengthText = `${Number(lengthBeats.toFixed(2))} beats`;
    if (Number.isFinite(startBeat) && Number.isFinite(endBeat)) {
      return { text: `${status} · ${lengthText} · ${Number(startBeat.toFixed(2))}→${Number(endBeat.toFixed(2))}`, active };
    }
    return { text: `${status} · ${lengthText}`, active };
  }
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

function isLocalDjAgentHost() {
  const hostname = String(window.location.hostname || "").toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function clearSetupElement(element) {
  if (!element) {
    return;
  }
  element.replaceChildren();
}

function appendSetupMessage(element, text, className = "dj-agent-muted") {
  if (!element) {
    return;
  }
  const message = document.createElement("p");
  message.className = className;
  message.textContent = text;
  element.appendChild(message);
}

function setDjAgentSetupMessage(text, state = "") {
  if (!djAgentSetupMessageEl) {
    return;
  }
  djAgentSetupMessageEl.textContent = text;
  djAgentSetupMessageEl.classList.toggle("is-error", state === "error");
  djAgentSetupMessageEl.classList.toggle("is-ready", state === "ready");
}

function safeSetupCode(value, fallback = "unknown") {
  const text = String(value ?? "").trim();
  return /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(text) ? text : fallback;
}

function renderDjAgentSetupReadiness(readiness) {
  clearSetupElement(djAgentSetupReadinessEl);
  if (!readiness || typeof readiness !== "object" || Array.isArray(readiness)) {
    appendSetupMessage(djAgentSetupReadinessEl, "Readiness unavailable until the local setup endpoint responds.");
    return;
  }

  const summary = document.createElement("div");
  summary.className = "dj-agent-readiness-summary";
  const state = safeSetupCode(readiness.state, readiness.ready === true ? "ready" : "blocked");
  const ready = readiness.ready === true ? "READY" : "NOT READY";
  summary.textContent = `${state.toUpperCase()} · ${ready}`;
  summary.classList.toggle("is-ready", readiness.ready === true);
  djAgentSetupReadinessEl.appendChild(summary);

  const gates = readiness.gates && typeof readiness.gates === "object" && !Array.isArray(readiness.gates)
    ? readiness.gates
    : {};
  const gateNames = Object.keys(gates);
  if (!gateNames.length) {
    appendSetupMessage(djAgentSetupReadinessEl, "No gate details were returned.");
    return;
  }
  const list = document.createElement("ul");
  list.className = "dj-agent-gate-list";
  for (const name of gateNames) {
    const gate = gates[name] && typeof gates[name] === "object" ? gates[name] : {};
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.className = "dj-agent-gate-name";
    label.textContent = safeSetupCode(name, "gate");
    const value = document.createElement("span");
    value.className = "dj-agent-gate-state";
    const gateState = safeSetupCode(gate.state, gate.allowed === true ? "ready" : "blocked");
    value.textContent = `${gateState.toUpperCase()}${gate.reason ? ` · ${safeSetupCode(gate.reason, "details-unavailable")}` : ""}`;
    value.classList.toggle("is-ready", gateState === "ready" || gate.allowed === true);
    item.append(label, value);
    list.appendChild(item);
  }
  djAgentSetupReadinessEl.appendChild(list);
}

function renderDjAgentMidiPorts(midiPorts) {
  clearSetupElement(djAgentMidiPortsEl);
  const ports = Array.isArray(midiPorts?.ports) ? midiPorts.ports : [];
  if (midiPorts?.ok !== true && ports.length === 0) {
    appendSetupMessage(djAgentMidiPortsEl, "MIDI outputs unavailable or not enumerated yet.");
    return;
  }
  if (ports.length === 0) {
    appendSetupMessage(djAgentMidiPortsEl, "No MIDI output ports detected.");
    return;
  }
  const list = document.createElement("ul");
  list.className = "dj-agent-port-list";
  for (const port of ports) {
    const item = document.createElement("li");
    const index = normalizeSetupMidiPort(port?.port);
    const indexLabel = index === null ? "#?" : `#${index}`;
    item.textContent = `${indexLabel} ${String(port?.name || "Unnamed MIDI output")}`;
    list.appendChild(item);
  }
  djAgentMidiPortsEl.appendChild(list);
}

function safeArtifactUrl(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const parsed = new URL(value, window.location.origin);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== window.location.origin) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function safeArtifactFilename(value) {
  const filename = String(value || "CustomMIDI1-Syndocal.csv").replace(/[\\/:*?"<>|]/g, "_");
  return filename.slice(-160) || "CustomMIDI1-Syndocal.csv";
}

function renderDjAgentMappingArtifact(artifact) {
  clearSetupElement(djAgentMappingArtifactEl);
  const value = artifact && typeof artifact === "object" ? artifact : {};
  const status = document.createElement("div");
  status.className = "dj-agent-artifact-status";
  status.textContent = value.valid === true ? "VALID" : value.valid === false ? "INVALID / REVIEW" : "NOT CHECKED";
  status.classList.toggle("is-ready", value.valid === true);
  djAgentMappingArtifactEl.appendChild(status);

  const url = safeArtifactUrl(value.url);
  if (!url) {
    appendSetupMessage(djAgentMappingArtifactEl, "No safe versioned CSV link was returned.");
    return;
  }
  const link = document.createElement("a");
  link.href = url;
  link.download = safeArtifactFilename(value.filename);
  link.textContent = safeArtifactFilename(value.filename);
  link.className = "dj-agent-artifact-link";
  djAgentMappingArtifactEl.appendChild(link);
}

function removeSensitiveConfigFields(value, depth = 0) {
  if (depth > 8 || value == null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => removeSensitiveConfigFields(item, depth + 1));
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/(token|secret|password|credential|authorization|auth)/i.test(key)) {
      continue;
    }
    result[key] = removeSensitiveConfigFields(child, depth + 1);
  }
  return result;
}

function normalizeDjAgentConfigTemplate(template) {
  let value = template;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const safe = removeSensitiveConfigFields(value);
  if (!safe || typeof safe !== "object" || Array.isArray(safe)) {
    return removeSensitiveConfigFields(DEFAULT_DJ_AGENT_CONFIG_TEMPLATE);
  }
  safe.releaseMacro = {
    ...(safe.releaseMacro && typeof safe.releaseMacro === "object" && !Array.isArray(safe.releaseMacro)
      ? safe.releaseMacro
      : {}),
    enabled: false,
  };
  return safe;
}

function safeSetupField(value, max = 160) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
}

function normalizeSetupMidiPort(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function parseSetupMidiPortText(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return null;
  }
  return normalizeSetupMidiPort(Number(value));
}

function setupTemplateObject(template) {
  const safe = normalizeDjAgentConfigTemplate(template);
  const syndocal = safe.syndocal && typeof safe.syndocal === "object" && !Array.isArray(safe.syndocal)
    ? safe.syndocal
    : {};
  const midi = safe.midi && typeof safe.midi === "object" && !Array.isArray(safe.midi)
    ? safe.midi
    : {};
  return { safe, syndocal, midi };
}

function seedDjAgentSetupDraft(template) {
  const { syndocal, midi } = setupTemplateObject(template);
  if (!djAgentSetupDraftTouched.has("host")) {
    djAgentSetupDraft.host = safeSetupField(syndocal.host);
  }
  if (!djAgentSetupDraftTouched.has("nic")) {
    djAgentSetupDraft.nic = safeSetupField(syndocal.nic);
  }
  if (!djAgentSetupDraftTouched.has("adapter")) {
    // Adapter selection is an explicit operator choice on this page.  Never
    // infer a transport from the server template on first render.
    djAgentSetupDraft.adapter = "";
  }
  const midiPortTouched = djAgentSetupDraftTouched.has("midiPort");
  const midiDeviceTouched = djAgentSetupDraftTouched.has("midiDevice");
  if (!midiPortTouched && !midiDeviceTouched) {
    const device = typeof midi.device === "string" ? safeSetupField(midi.device) : "";
    const port = normalizeSetupMidiPort(midi.port);
    djAgentSetupDraft.midiDevice = device;
    djAgentSetupDraft.midiPort = port === null ? "" : String(port);
  } else if (midiPortTouched !== midiDeviceTouched) {
    // A MIDI selection is one name+port pair; a partial draft is invalid.
    djAgentSetupDraft.midiDevice = "";
    djAgentSetupDraft.midiPort = "";
  }
}

function renderDjAgentSetupControls(template, midiPorts, networkInterfaces) {
  seedDjAgentSetupDraft(template);
  if (djAgentSyndocalHostEl) {
    djAgentSyndocalHostEl.value = djAgentSetupDraft.host;
  }
  if (djAgentAdapterEl) {
    djAgentAdapterEl.value = SETUP_ADAPTERS.includes(djAgentSetupDraft.adapter)
      ? djAgentSetupDraft.adapter
      : "";
  }

  if (djAgentSyndocalNicEl) {
    djAgentSyndocalNicEl.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Required: select local NIC";
    djAgentSyndocalNicEl.appendChild(placeholder);
    for (const item of Array.isArray(networkInterfaces) ? networkInterfaces : []) {
      const name = safeSetupField(item?.name, 120);
      const address = safeSetupField(item?.address, 80);
      if (!address) {
        continue;
      }
      const option = document.createElement("option");
      // syndocalClient passes this value to ws as `localAddress`; the adapter
      // label is presentation only and must never enter the generated config.
      option.value = address;
      option.dataset.interfaceName = name;
      option.textContent = name ? `${name} (${address})` : address;
      djAgentSyndocalNicEl.appendChild(option);
    }
    const matchingNic = [...djAgentSyndocalNicEl.options].find(
      (option) => option.value === djAgentSetupDraft.nic,
    );
    if (matchingNic) {
      djAgentSetupDraft.nic = matchingNic.value;
    }
    djAgentSyndocalNicEl.value = djAgentSetupDraft.nic;
  }

  if (djAgentMidiOutputEl) {
    djAgentMidiOutputEl.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Required: select MIDI output";
    placeholder.selected = true;
    djAgentMidiOutputEl.appendChild(placeholder);
    for (const port of Array.isArray(midiPorts?.ports) ? midiPorts.ports : []) {
      const index = normalizeSetupMidiPort(port?.port);
      const name = safeSetupField(port?.name, 160);
      if (index === null || !name) {
        continue;
      }
      const option = document.createElement("option");
      option.value = String(index);
      option.dataset.port = String(index);
      option.dataset.deviceName = name;
      option.textContent = `#${index} ${name}`;
      djAgentMidiOutputEl.appendChild(option);
    }
    const selectedPort = parseSetupMidiPortText(djAgentSetupDraft.midiPort);
    const selectedDevice = safeSetupField(djAgentSetupDraft.midiDevice, 160);
    const matchingOption = selectedPort === null || !selectedDevice
      ? null
      : [...djAgentMidiOutputEl.options].find(
        (option) => option.dataset.deviceName === selectedDevice
          && parseSetupMidiPortText(option.dataset.port || option.value) === selectedPort,
      );
    if (matchingOption) {
      djAgentSetupDraft.midiPort = matchingOption.value;
      djAgentSetupDraft.midiDevice = matchingOption.dataset.deviceName;
      djAgentMidiOutputEl.value = matchingOption.value;
      matchingOption.selected = true;
    } else {
      // Keep the required placeholder selected whenever the exact pair is
      // absent; stale config and disappeared ports must never be previewed.
      djAgentSetupDraft.midiPort = "";
      djAgentSetupDraft.midiDevice = "";
      djAgentMidiOutputEl.value = "";
      placeholder.selected = true;
    }
  }
  updateDjAgentConfigPreviewFromDraft();
}

function updateDjAgentConfigPreviewFromDraft() {
  const { safe, syndocal, midi } = setupTemplateObject(djAgentSetupTemplate);
  safe.syndocal = { ...syndocal, host: djAgentSetupDraft.host, nic: djAgentSetupDraft.nic, adapter: djAgentSetupDraft.adapter };
  const midiPort = parseSetupMidiPortText(djAgentSetupDraft.midiPort);
  const midiDevice = midiPort === null ? "" : safeSetupField(djAgentSetupDraft.midiDevice, 160);
  safe.midi = {
    ...midi,
    device: midiDevice,
    port: midiPort,
  };
  safe.releaseMacro = { ...(safe.releaseMacro || {}), enabled: false };
  renderDjAgentConfigTemplate(safe);
}

function getDjAgentConfigPreview() {
  return djAgentConfigPreviewEl?.textContent || `${JSON.stringify(DEFAULT_DJ_AGENT_CONFIG_TEMPLATE, null, 2)}\n`;
}

function renderDjAgentConfigTemplate(template) {
  if (!djAgentConfigPreviewEl) {
    return;
  }
  const safeTemplate = normalizeDjAgentConfigTemplate(template);
  djAgentConfigPreviewEl.textContent = `${JSON.stringify(safeTemplate, null, 2)}\n`;
}

function renderDjAgentSetup(payload) {
  const data = payload && typeof payload === "object" ? payload : {};
  const template = Object.hasOwn(data, "configTemplate") ? data.configTemplate : DEFAULT_DJ_AGENT_CONFIG_TEMPLATE;
  djAgentSetupTemplate = normalizeDjAgentConfigTemplate(template);
  renderDjAgentSetupReadiness(data.readiness);
  renderDjAgentMidiPorts(data.midiPorts);
  renderDjAgentMappingArtifact(data.mappingArtifact || DEFAULT_MAPPING_ARTIFACT);
  renderDjAgentSetupControls(djAgentSetupTemplate, data.midiPorts, data.networkInterfaces);

  if (data.localOnly !== true) {
    setDjAgentSetupMessage("DJ PC上のlocalhostで開く（setup endpoint is local-only）", "error");
  } else if (data.ok !== true) {
    setDjAgentSetupMessage("Setup API is not available yet; follow the DJ PC guided steps.");
  } else if (data.enabled !== true) {
    setDjAgentSetupMessage("DJ Agent is disabled. Read-only setup checks remain available.");
  } else if (data.readiness?.ready === true) {
    setDjAgentSetupMessage("DJ Agent setup is ready.", "ready");
  } else {
    setDjAgentSetupMessage("DJ Agent setup is not ready; resolve the listed gates.");
  }
}

async function fetchDjAgentSetup() {
  if (djAgentSetupFetchInFlight) {
    return djAgentSetupFetchInFlight;
  }
  if (!isLocalDjAgentHost()) {
    if (djAgentSetupRefreshEl) {
      djAgentSetupRefreshEl.disabled = true;
    }
    renderDjAgentSetup({ localOnly: false, ok: false });
    return Promise.resolve();
  }
  if (djAgentSetupRefreshEl) {
    djAgentSetupRefreshEl.disabled = true;
  }
  djAgentSetupFetchInFlight = fetch("/api/dj-agent/setup", {
    method: "GET",
    cache: "no-store",
    headers: { Accept: "application/json" },
  })
    .then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (response.status === 403 || payload?.localOnly === false) {
        renderDjAgentSetup({ ...payload, ok: false, localOnly: false });
        return;
      }
      if (response.status === 404) {
        renderDjAgentSetup({ ok: false, localOnly: true });
        return;
      }
      if (!response.ok) {
        renderDjAgentSetup({ ...payload, ok: false, localOnly: true });
        return;
      }
      renderDjAgentSetup(payload);
    })
    .catch(() => {
      renderDjAgentSetup({ ok: false, localOnly: true });
      setDjAgentSetupMessage("Setup API could not be reached; follow the DJ PC guided steps.", "error");
    })
    .finally(() => {
      djAgentSetupFetchInFlight = null;
      if (djAgentSetupRefreshEl) {
        djAgentSetupRefreshEl.disabled = !isLocalDjAgentHost();
      }
    });
  return djAgentSetupFetchInFlight;
}

function bindDjAgentSetupActions() {
  if (djAgentSyndocalHostEl) {
    djAgentSyndocalHostEl.addEventListener("input", (event) => {
      djAgentSetupDraft.host = safeSetupField(event.target.value);
      djAgentSetupDraftTouched.add("host");
      updateDjAgentConfigPreviewFromDraft();
    });
  }
  if (djAgentSyndocalNicEl) {
    djAgentSyndocalNicEl.addEventListener("change", (event) => {
      djAgentSetupDraft.nic = safeSetupField(event.target.value);
      djAgentSetupDraftTouched.add("nic");
      updateDjAgentConfigPreviewFromDraft();
    });
  }
  if (djAgentMidiOutputEl) {
    djAgentMidiOutputEl.addEventListener("change", (event) => {
      const selected = event.target.selectedOptions[0];
      djAgentSetupDraft.midiPort = safeSetupField(event.target.value, 20);
      djAgentSetupDraft.midiDevice = safeSetupField(selected?.dataset.deviceName);
      djAgentSetupDraftTouched.add("midiPort");
      djAgentSetupDraftTouched.add("midiDevice");
      updateDjAgentConfigPreviewFromDraft();
    });
  }
  if (djAgentAdapterEl) {
    djAgentAdapterEl.addEventListener("change", (event) => {
      const adapter = safeSetupField(event.target.value, 80);
      djAgentSetupDraft.adapter = SETUP_ADAPTERS.includes(adapter) ? adapter : "";
      djAgentSetupDraftTouched.add("adapter");
      updateDjAgentConfigPreviewFromDraft();
    });
  }
  if (djAgentSetupRefreshEl) {
    djAgentSetupRefreshEl.addEventListener("click", () => fetchDjAgentSetup());
  }
  if (djAgentConfigDownloadEl) {
    djAgentConfigDownloadEl.addEventListener("click", () => {
      const blob = new Blob([getDjAgentConfigPreview()], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "dj-agent-config-preview.json";
      link.click();
      URL.revokeObjectURL(url);
      setDjAgentSetupMessage("Token-free config preview downloaded.");
    });
  }
  if (djAgentConfigCopyEl) {
    djAgentConfigCopyEl.addEventListener("click", async () => {
      const text = getDjAgentConfigPreview();
      try {
        if (!navigator.clipboard?.writeText) {
          throw new Error("clipboard unavailable");
        }
        await navigator.clipboard.writeText(text);
        setDjAgentSetupMessage("Token-free config preview copied.");
      } catch {
        setDjAgentSetupMessage("Copy is unavailable in this browser; use Download instead.", "error");
      }
    });
  }
}

function renderWarnings(items) {
  const warnings = Array.isArray(items) ? items : [];
  if (warningCountEl) {
    warningCountEl.textContent = String(warnings.length);
    warningCountEl.classList.toggle("has-warnings", warnings.length > 0);
  }
  const fingerprint = JSON.stringify(warnings);
  if (fingerprint === lastWarningsFingerprint) {
    return;
  }
  lastWarningsFingerprint = fingerprint;
  warningsEl.innerHTML = "";
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
  const logs = Array.isArray(items) ? items.slice(-14).reverse() : [];
  const fingerprint = JSON.stringify(logs);
  if (fingerprint === lastDebugLogsFingerprint) {
    return;
  }
  lastDebugLogsFingerprint = fingerprint;
  debugLogsEl.innerHTML = "";
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
  
  const targetWidth = canvasEl.clientWidth || 300;
  const targetHeight = canvasEl.clientHeight || 48;
  if (canvasEl.width !== targetWidth) canvasEl.width = targetWidth;
  if (canvasEl.height !== targetHeight) canvasEl.height = targetHeight;
  
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim() || '#47e1a8';
  const muted = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#6b7280';

  const drawFallbackSeekbar = () => {
    const centerY = Math.floor(canvasEl.height / 2);
    const x = Math.min(canvasEl.width, Math.max(0, (ratio / 100) * canvasEl.width));
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    ctx.fillStyle = muted;
    ctx.fillRect(0, centerY - 1, canvasEl.width, 2);
    ctx.fillStyle = accent;
    ctx.fillRect(0, centerY - 2, x, 4);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(Math.max(0, x - 1), 0, 2, canvasEl.height);
  };

  if (!base64Data) {
    canvasEl.dataset.waveraw = "";
    canvasEl._cachedHeights = null;
    drawFallbackSeekbar();
    return;
  }
  
  if (canvasEl.dataset.waveraw !== base64Data || !canvasEl._cachedHeights) {
    canvasEl.dataset.waveraw = base64Data;
    let bin = "";
    try {
      bin = atob(base64Data);
    } catch {
      canvasEl.dataset.waveraw = "";
      canvasEl._cachedHeights = null;
      drawFallbackSeekbar();
      return;
    }
    const heights = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      heights[i] = bin.charCodeAt(i);
    }
    canvasEl._cachedHeights = heights;
  }
  
  const heights = canvasEl._cachedHeights;
  if (!heights?.length) {
    drawFallbackSeekbar();
    return;
  }
  
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  
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
  const trackBpmRaw = track?.trackBpm == null ? NaN : Number(track.trackBpm);
  const trackIdentity = track?.contentId
    ? `id:${track.contentId}`
    : track?.title || track?.artist
      ? `text:${track?.title || ""}\u0000${track?.artist || ""}`
      : "";
  if (trackIdentity && Number.isFinite(trackBpmRaw) && trackBpmRaw > 0) {
    lastTrackBpmByDeck[deckNumber] = { identity: trackIdentity, value: trackBpmRaw };
  }
  const cachedTrackBpm = lastTrackBpmByDeck[deckNumber];
  const trackBpm = Number.isFinite(trackBpmRaw) && trackBpmRaw > 0
    ? trackBpmRaw
    : cachedTrackBpm?.identity === trackIdentity
      ? Number(cachedTrackBpm.value)
      : NaN;
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

function renderMixerState(mixerState, deckPlaybacks) {
  const clampUnit = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : NaN;
  };
  const crossfader = clampUnit(mixerState?.crossfader);
  const channelFaders = Array.isArray(mixerState?.channelFaders)
    ? mixerState.channelFaders.map(clampUnit)
    : [];
  const hasMixer = Number.isFinite(crossfader) &&
    channelFaders.length >= 2 &&
    Number.isFinite(channelFaders[0]) &&
    Number.isFinite(channelFaders[1]);

  if (!hasMixer) {
    if (mixerUpdatedEl) mixerUpdatedEl.textContent = "Waiting for fader data";
    if (crossfaderValueEl) crossfaderValueEl.textContent = "-";
    if (crossfaderThumbEl) crossfaderThumbEl.style.left = "50%";
    for (const view of [
      { fill: deck1FaderFillEl, value: deck1FaderValueEl, output: deck1OutputStateEl, card: deck1CardEl },
      { fill: deck2FaderFillEl, value: deck2FaderValueEl, output: deck2OutputStateEl, card: deck2CardEl },
    ]) {
      if (view.fill) view.fill.style.width = "0%";
      if (view.value) view.value.textContent = "-";
      if (view.output) {
        view.output.textContent = "-";
        view.output.classList.remove("live", "muted");
      }
      view.card?.classList.remove("is-audible");
    }
    return;
  }

  const crossPercent = Math.round(crossfader * 100);
  if (crossfaderThumbEl) crossfaderThumbEl.style.left = `${crossPercent}%`;
  if (crossfaderValueEl) crossfaderValueEl.textContent = `${crossPercent}%`;
  crossfaderTrackEl?.setAttribute("aria-valuenow", String(crossPercent));
  if (mixerUpdatedEl) mixerUpdatedEl.textContent = "LIVE · Rekordbox faders";

  const crossGain = [
    crossfader <= 0.5 ? 1 : (1 - crossfader) * 2,
    crossfader >= 0.5 ? 1 : crossfader * 2,
  ];
  const channelViews = [
    { deck: 1, value: channelFaders[0], track: deck1FaderTrackEl, fill: deck1FaderFillEl, text: deck1FaderValueEl, output: deck1OutputStateEl, card: deck1CardEl },
    { deck: 2, value: channelFaders[1], track: deck2FaderTrackEl, fill: deck2FaderFillEl, text: deck2FaderValueEl, output: deck2OutputStateEl, card: deck2CardEl },
  ];
  for (let index = 0; index < channelViews.length; index += 1) {
    const view = channelViews[index];
    const percent = Math.round(view.value * 100);
    const effectiveLevel = view.value * crossGain[index];
    const playback = deckPlaybacks.find((item) => Number(item?.deck) === view.deck);
    const isPlaying = playback?.isPlaying === true;
    const isMuted = effectiveLevel <= 0.01;
    const isLive = isPlaying && !isMuted;
    if (view.fill) view.fill.style.width = `${percent}%`;
    if (view.text) view.text.textContent = `${percent}%`;
    view.track?.setAttribute("aria-valuenow", String(percent));
    if (view.output) {
      view.output.textContent = isMuted ? "MUTED" : isLive ? "LIVE" : "OPEN";
      view.output.classList.toggle("live", isLive);
      view.output.classList.toggle("muted", isMuted);
    }
    view.card?.classList.toggle("is-audible", isLive);
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
  latestState = state;
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
  const mergeMasterFallback = (track, deck) => {
    const fallback = Number(playback?.deck) === deck ? state?.nowPlaying : null;
    if (!fallback) {
      return track;
    }
    const trackId = track?.contentId ? String(track.contentId) : null;
    const fallbackId = fallback?.contentId ? String(fallback.contentId) : null;
    if (trackId && fallbackId && trackId !== fallbackId) {
      return track;
    }
    return {
      ...(track || {}),
      contentId: trackId || fallbackId || null,
      title: track?.title || fallback.title || null,
      artist: track?.artist || fallback.artist || null,
      durationSec: Number(track?.durationSec) > 0 ? track.durationSec : fallback.durationSec ?? null,
      trackBpm: Number(track?.trackBpm) > 0 ? track.trackBpm : fallback.trackBpm ?? null,
      waveform: track?.waveform || fallback.waveform || null,
    };
  };
  deck1Track = mergeMasterFallback(deck1Track, 1);
  deck2Track = mergeMasterFallback(deck2Track, 2);
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

  renderMixerState(state?.mixerState, deckPlaybacks);

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

function estimatePosition(playback, loopState, nowMs) {
  let position = Number(playback?.positionSec);
  if (!Number.isFinite(position) || position < 0) {
    return NaN;
  }
  const observedAt = Date.parse(playback?.positionObservedAt || playback?.updatedAt || "");
  if (playback?.isPlaying === true && Number.isFinite(observedAt)) {
    const ageSec = Math.min(1.25, Math.max(0, (nowMs - observedAt) / 1000));
    position += ageSec;
  }
  const loopStart = Number(loopState?.startMs) / 1000;
  const loopEnd = Number(loopState?.endMs) / 1000;
  if (loopState?.active === true && Number.isFinite(loopStart) && Number.isFinite(loopEnd) && loopEnd > loopStart) {
    const length = loopEnd - loopStart;
    if (position >= loopEnd) {
      position = loopStart + ((position - loopStart) % length);
    }
  } else {
    const total = Number(playback?.totalSec);
    if (Number.isFinite(total) && total > 0) {
      position = Math.min(total, position);
    }
  }
  return position;
}

function renderLivePlaybackFrame() {
  const nowMs = Date.now();
  const state = latestState;
  if (state) {
    const deckPlaybacks = Array.isArray(state.deckPlaybacks) ? state.deckPlaybacks : [];
    const deckTracks = Array.isArray(state.deckNowPlaying) ? state.deckNowPlaying : [];
    const loopStates = Array.isArray(state.loopStates) ? state.loopStates : [];
    const views = [
      { deck: 1, positionEl: deck1PositionTextEl, waveformEl: deck1WaveformEl },
      { deck: 2, positionEl: deck2PositionTextEl, waveformEl: deck2WaveformEl },
    ];
    for (const view of views) {
      const playback = deckPlaybacks.find((item) => Number(item?.deck) === view.deck) ||
        (Number(state.playback?.deck) === view.deck ? state.playback : null);
      if (!playback) {
        continue;
      }
      const loopState = loopStates.find((item) => Number(item?.deck) === view.deck);
      const position = estimatePosition(playback, loopState, nowMs);
      const total = Number(playback.totalSec);
      const track = deckTracks.find((item) => Number(item?.deck) === view.deck);
      const masterFallback = Number(state.playback?.deck) === view.deck ? state.nowPlaying : null;
      const waveform = track?.waveform || masterFallback?.waveform || null;
      const ratio = Number.isFinite(position) && Number.isFinite(total) && total > 0
        ? Math.min(100, Math.max(0, (position / total) * 100))
        : 0;
      view.positionEl.textContent = formatDuration(position);
      drawWaveform(view.waveformEl, waveform, ratio);
    }
  }
  window.requestAnimationFrame(renderLivePlaybackFrame);
}

async function fetchInitialState() {
  if (stateFetchInFlight) {
    return stateFetchInFlight;
  }
  stateFetchInFlight = fetch("/api/now-playing", { cache: "no-store" })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.json();
    })
    .then((state) => render(state))
    .catch(() => {})
    .finally(() => {
      stateFetchInFlight = null;
    });
  return stateFetchInFlight;
}

function connectSocket() {
  if (typeof io !== "function") {
    return null;
  }
  const socket = io();
  window.__rbSocket = socket;
  socket.on("connect", () => fetchInitialState());
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
  socket.on("mixer_state", (mixerState) => {
    if (!window.__rbLastState || !mixerState) {
      return;
    }
    window.__rbLastState = { ...window.__rbLastState, mixerState };
    render(window.__rbLastState);
  });
  return socket;
}

loadThemeSettings();
bindThemeSettings();

const FIELD_ORDER_KEY = "rb-output-field-order";
const DEFAULT_FIELD_ORDER = ["title", "artist", "album", "genre", "key", "label", "realtimebpm", "trackbpm", "time"];
let sortableBoundList = null;

function isValidFieldOrder(value) {
  if (!Array.isArray(value) || value.length !== DEFAULT_FIELD_ORDER.length) {
    return false;
  }
  const seen = new Set();
  for (const fieldName of value) {
    if (typeof fieldName !== "string" || !DEFAULT_FIELD_ORDER.includes(fieldName) || seen.has(fieldName)) {
      return false;
    }
    seen.add(fieldName);
  }
  return seen.size === DEFAULT_FIELD_ORDER.length;
}

function findFieldElement(scopeEl, fieldName) {
  if (!scopeEl) return null;
  for (const el of scopeEl.querySelectorAll("[data-field]")) {
    if (el.getAttribute("data-field") === fieldName) return el;
  }
  return null;
}

function applyFieldOrder(orderArray) {
  const decks = [document.getElementById("deck1Card"), document.getElementById("deck2Card")];
  for (const deck of decks) {
    if (!deck) continue;
    const container = deck.querySelector(".deck-fields");
    if (!container) continue;
    orderArray.forEach((fieldName, index) => {
      const el = findFieldElement(container, fieldName);
      if (el) {
        el.style.order = index;
      }
    });
  }
}

function getFieldOrderFromList(listEl) {
  return Array.from(listEl.querySelectorAll("[data-field]")).map((el) => el.getAttribute("data-field"));
}

function restoreListDomOrder(listEl, orderArray) {
  if (!listEl) return;
  for (const fieldName of orderArray) {
    const el = findFieldElement(listEl, fieldName);
    if (el) {
      listEl.appendChild(el);
    }
  }
}

function applyControlDisabledState(control, disabled) {
  if (!control) return;
  control.disabled = disabled === true;
  control.setAttribute("aria-disabled", disabled === true ? "true" : "false");
}

function syncSortableControlStates(listEl) {
  if (!listEl) return;
  const items = Array.from(listEl.querySelectorAll(".sortable-item"));
  items.forEach((item, index) => {
    applyControlDisabledState(item.querySelector('.sortable-move[data-move="up"]'), index === 0);
    applyControlDisabledState(item.querySelector('.sortable-move[data-move="down"]'), index === items.length - 1);
  });
}

function getSortableStatusEl() {
  try {
    return document.getElementById("fieldSortableStatus");
  } catch (e) {
    return null;
  }
}

function sortableItemLabel(itemEl) {
  if (!itemEl) return "";
  const labelEl = itemEl.querySelector(".sortable-label");
  const text = String(labelEl && labelEl.textContent ? labelEl.textContent : "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  if (text) return text;
  const field = itemEl.getAttribute("data-field");
  return field ? String(field).slice(0, 60) : "";
}

function announceSortableResult(message) {
  const statusEl = getSortableStatusEl();
  if (!statusEl || !message) return;
  const safeMessage = String(message).replace(/\s+/g, " ").trim().slice(0, 120);
  if (!safeMessage) return;
  try {
    if (statusEl.textContent === safeMessage) {
      statusEl.textContent = "";
    }
    statusEl.textContent = safeMessage;
  } catch (e) {}
}

function sortableItemPosition(listEl, itemEl) {
  return Array.from(listEl.querySelectorAll(".sortable-item")).indexOf(itemEl) + 1;
}

function moveSortableItem(listEl, itemEl, offset) {
  if (!listEl || !itemEl) return false;
  if (offset !== -1 && offset !== 1) return false;
  const items = Array.from(listEl.querySelectorAll("[data-field]"));
  const fromIndex = items.indexOf(itemEl);
  const toIndex = fromIndex + offset;
  if (fromIndex < 0 || toIndex < 0 || toIndex >= items.length) return false;
  const referenceNode = offset > 0 ? items[toIndex].nextSibling : items[toIndex];
  listEl.insertBefore(itemEl, referenceNode);
  return true;
}

function getSortableAfterElement(listEl, y, excludeItem) {
  let closest = null;
  let closestOffset = Number.NEGATIVE_INFINITY;
  for (const item of Array.from(listEl.querySelectorAll(".sortable-item"))) {
    if (item === excludeItem) continue;
    const box = item.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = item;
    }
  }
  return closest;
}

function persistAndApplySortableOrder(listEl) {
  const newOrder = getFieldOrderFromList(listEl);
  try {
    localStorage.setItem(FIELD_ORDER_KEY, JSON.stringify(newOrder));
  } catch (e) {}
  applyFieldOrder(newOrder);
  syncSortableControlStates(listEl);
}

function resetSortableFields() {
  try {
    localStorage.removeItem(FIELD_ORDER_KEY);
  } catch (e) {}
  const listEl = document.getElementById("fieldSortableList");
  restoreListDomOrder(listEl, DEFAULT_FIELD_ORDER);
  applyFieldOrder(DEFAULT_FIELD_ORDER);
  syncSortableControlStates(listEl);
  announceSortableResult("Field order reset to defaults");
}

function bindSortableEvents(listEl) {
  let draggingItem = null;

  listEl.addEventListener("dragstart", (e) => {
    const origin = e.target;
    if (
      origin &&
      typeof origin.closest === "function" &&
      origin.closest("input, button, label, .sortable-controls")
    ) {
      if (typeof e.preventDefault === "function") {
        e.preventDefault();
      }
      return;
    }
    const item = origin && typeof origin.closest === "function" ? origin.closest(".sortable-item") : null;
    if (!item) return;
    draggingItem = item;
    item.classList.add("dragging");
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setData("text/plain", item.getAttribute("data-field") || "");
      } catch (err) {}
    }
  });

  listEl.addEventListener("dragover", (e) => {
    if (typeof e.preventDefault === "function") {
      e.preventDefault();
    }
    if (!draggingItem) return;
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "move";
    }
    const after = getSortableAfterElement(listEl, e.clientY, draggingItem);
    if (after == null) {
      listEl.appendChild(draggingItem);
    } else {
      listEl.insertBefore(draggingItem, after);
    }
  });

  listEl.addEventListener("drop", (e) => {
    if (typeof e.preventDefault === "function") {
      e.preventDefault();
    }
    if (!draggingItem) return;
  });

  listEl.addEventListener("dragend", () => {
    if (!draggingItem) return;
    const dragged = draggingItem;
    draggingItem.classList.remove("dragging");
    draggingItem = null;
    persistAndApplySortableOrder(listEl);
    announceSortableResult(`${sortableItemLabel(dragged)} moved to position ${sortableItemPosition(listEl, dragged)}`);
  });

  function moveViaControl(control, direction) {
    const item = control.closest(".sortable-item");
    if (!item) return false;
    const moved = moveSortableItem(listEl, item, direction);
    if (moved) {
      persistAndApplySortableOrder(listEl);
      announceSortableResult(
        `${sortableItemLabel(item)} moved ${direction === -1 ? "up" : "down"} to position ${sortableItemPosition(listEl, item)}`,
      );
    }
    return moved;
  }

  listEl.addEventListener("click", (e) => {
    const control = e.target.closest(".sortable-move[data-move]");
    if (!control || control.disabled) return;
    moveViaControl(control, control.getAttribute("data-move") === "up" ? -1 : 1);
  });

  listEl.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const control = e.target.closest(".sortable-move[data-move]");
    if (!control || control.disabled) return;
    e.preventDefault();
    moveViaControl(control, e.key === "ArrowUp" ? -1 : 1);
  });
}

function initSortableFields() {
  const listEl = document.getElementById("fieldSortableList");
  if (!listEl) return;

  let savedOrder = null;
  try {
    savedOrder = JSON.parse(localStorage.getItem(FIELD_ORDER_KEY));
  } catch (e) {}
  const activeOrder = isValidFieldOrder(savedOrder) ? savedOrder : DEFAULT_FIELD_ORDER.slice();

  restoreListDomOrder(listEl, activeOrder);
  applyFieldOrder(activeOrder);

  for (const item of Array.from(listEl.querySelectorAll(".sortable-item"))) {
    item.setAttribute("draggable", "true");
  }
  syncSortableControlStates(listEl);

  if (sortableBoundList === listEl) return;
  sortableBoundList = listEl;
  bindSortableEvents(listEl);
}

initSortableFields();
bindDjAgentSetupActions();

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

connectSocket();
fetchInitialState();
fetchDjAgentSetup();
window.setInterval(fetchInitialState, 1_000);
window.setInterval(fetchDjAgentSetup, 10_000);
window.requestAnimationFrame(renderLivePlaybackFrame);
