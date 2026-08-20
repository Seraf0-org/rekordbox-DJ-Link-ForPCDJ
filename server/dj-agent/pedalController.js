const { EventEmitter } = require("node:events");

function normalizeKey(value) {
  return String(value || "").trim().toUpperCase();
}

function resolveKeyboardAdapter(moduleName = "") {
  const candidates = !moduleName || moduleName === "uiohook-napi"
    ? ["uiohook-napi", "node-global-key-listener"]
    : [moduleName];
  for (const candidate of candidates) {
    try {
      // Literal optional requires allow pkg to include the native uiohook
      // prebuild while still keeping the dependency lazy and crash-safe.
      const loaded = candidate === "uiohook-napi"
        ? require("uiohook-napi")
        : candidate === "node-global-key-listener"
          ? require("node-global-key-listener")
          : require(candidate);
      if (candidate === "uiohook-napi" || loaded?.uIOhook) {
        return { kind: "uiohook", module: loaded?.uIOhook || loaded };
      }
      const Constructor = loaded?.GlobalKeyboardListener || loaded?.default || loaded;
      if (typeof Constructor === "function") {
        return { kind: "global-key-listener", module: Constructor };
      }
    } catch {
      // Optional adapters are intentionally best-effort.
    }
  }
  return null;
}

function keyFromUiohookEvent(event = {}) {
  if (typeof event.key === "string") {
    return normalizeKey(event.key);
  }
  if (
    typeof event.keycode === "number" &&
    Number.isInteger(event.keycode) &&
    event.keycode >= 91 &&
    event.keycode <= 102
  ) {
    return `F${event.keycode - 78}`;
  }
  return "";
}

function createPedalController({
  enabled = false,
  bindings = { release: "F13", loopHalf: "F14", filterClose: "F15" },
  actionSink = () => {},
  moduleName = "",
  keyboardAdapter = null,
  platform = process.platform,
  debounceMs = 1000,
  now = () => Date.now(),
} = {}) {
  const emitter = new EventEmitter();
  const normalizedBindings = {
    release: normalizeKey(bindings.release || "F13"),
    loopHalf: normalizeKey(bindings.loopHalf || "F14"),
    filterClose: normalizeKey(bindings.filterClose || "F15"),
  };
  const actionByKey = new Map([
    [normalizedBindings.release, "release"],
    [normalizedBindings.loopHalf, "loop-half"],
    [normalizedBindings.filterClose, "filter-close"],
  ]);
  let adapter = null;
  let keydownListener = null;
  let keyupListener = null;
  const heldKeys = new Set();
  let lastActionAt = null;
  let status = {
    enabled: Boolean(enabled),
    ok: false,
    available: false,
    state: enabled ? "stopped" : "disabled",
    message: enabled ? "Pedal global hotkey not started" : "Pedal integration disabled by config",
    bindings: { ...normalizedBindings },
    updatedAt: new Date().toISOString(),
  };

  function updateStatus(patch) {
    status = { ...status, ...patch, enabled: Boolean(enabled), updatedAt: new Date().toISOString() };
    emitter.emit("status", { ...status });
  }

  function trigger(bindingOrAction) {
    const raw = normalizeKey(bindingOrAction);
    const action = actionByKey.get(raw) || String(bindingOrAction || "").trim().toLowerCase();
    if (!["release", "loop-half", "filter-close"].includes(action)) {
      return { triggered: false, reason: "unknown-binding" };
    }
    try {
      const result = actionSink(action);
      emitter.emit("action", { action, result });
      return { triggered: true, action, result };
    } catch (error) {
      emitter.emit("action-error", { action, error });
      return { triggered: false, action, reason: "action-error", error };
    }
  }

  function onGlobalKey(event, down) {
    const key = keyFromUiohookEvent(event);
    if (!key) {
      return;
    }

    if (down === false) {
      heldKeys.delete(key);
      return;
    }

    // Both adapters can report auto-repeat keydown events. A physical press
    // must enter the action path once, even when the key remains held longer
    // than the cooldown window.
    if (!actionByKey.has(key) || heldKeys.has(key)) {
      return;
    }
    heldKeys.add(key);

    const timestamp = now();
    const cooldownMs = Math.max(0, Number(debounceMs) || 0);
    if (lastActionAt != null && timestamp - lastActionAt < cooldownMs) {
      return;
    }
    lastActionAt = timestamp;
    trigger(key);
  }

  function detachAdapter() {
    if (!adapter) {
      keydownListener = null;
      keyupListener = null;
      return;
    }
    try {
      if (adapter.kind === "uiohook") {
        if (keydownListener) {
          adapter.module.off?.("keydown", keydownListener);
          adapter.module.removeListener?.("keydown", keydownListener);
        }
        if (keyupListener) {
          adapter.module.off?.("keyup", keyupListener);
          adapter.module.removeListener?.("keyup", keyupListener);
        }
        adapter.module.stop?.();
      } else if (adapter.keyboard) {
        adapter.keyboard.removeListener?.(keydownListener);
      }
    } catch {
      // Ignore optional adapter shutdown failures.
    }
    adapter = null;
    keydownListener = null;
    keyupListener = null;
  }

  function start() {
    if (!enabled) {
      updateStatus({ ok: false, available: false, state: "disabled", message: "Pedal integration disabled by config" });
      return;
    }
    if (adapter && (keydownListener || keyupListener)) {
      return;
    }
    if (platform !== "win32" && !keyboardAdapter) {
      updateStatus({
        ok: false,
        available: false,
        state: "unavailable",
        message: "Global pedal hotkeys are supported on Windows only",
      });
      return;
    }
    adapter = keyboardAdapter || resolveKeyboardAdapter(moduleName);
    if (!adapter) {
      updateStatus({
        ok: false,
        available: false,
        state: "unavailable",
        message: "Global hotkey adapter unavailable; install optional pedal dependency",
      });
      emitter.emit("unavailable", { reason: "missing-global-hotkey-dependency" });
      return;
    }
    try {
      if (adapter.kind === "uiohook") {
        keydownListener = (event) => onGlobalKey(event, true);
        keyupListener = (event) => onGlobalKey(event, false);
        adapter.module.on?.("keydown", keydownListener);
        adapter.module.on?.("keyup", keyupListener);
        adapter.module.start?.();
      } else {
        const keyboard = typeof adapter.module === "function" ? new adapter.module() : adapter.module;
        keydownListener = (event, down) => onGlobalKey({ key: event?.name || event?.key }, down);
        keyboard.addListener?.(keydownListener);
        adapter.keyboard = keyboard;
      }
      updateStatus({ ok: true, available: true, state: "listening", message: "Global pedal hotkeys listening" });
    } catch (error) {
      detachAdapter();
      heldKeys.clear();
      lastActionAt = null;
      updateStatus({ ok: false, available: true, state: "error", message: `Pedal hotkey error: ${error?.message || String(error)}` });
      emitter.emit("adapter-error", error);
    }
  }

  function stop() {
    if (!adapter) {
      heldKeys.clear();
      lastActionAt = null;
      if (enabled) {
        updateStatus({ ok: false, state: "stopped", message: "Pedal global hotkey stopped" });
      }
      return;
    }
    detachAdapter();
    heldKeys.clear();
    lastActionAt = null;
    if (enabled) {
      updateStatus({ ok: false, state: "stopped", message: "Pedal global hotkey stopped" });
    }
  }

  function getStatus() {
    return { ...status };
  }

  return {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    getStatus,
    start,
    stop,
    trigger,
  };
}

module.exports = {
  createPedalController,
  keyFromUiohookEvent,
  normalizeKey,
  resolveKeyboardAdapter,
};
