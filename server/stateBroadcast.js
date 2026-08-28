"use strict";

const DEFAULT_STATE_BROADCAST_INTERVAL_MS = 50;

/**
 * Coalesce high-frequency internal state changes into a bounded latest-wins
 * stream for browser/remote consumers. State mutation remains synchronous;
 * only the outward broadcast is delayed by at most one frame interval.
 */
function createLatestStateBroadcaster({
  emitSnapshot,
  intervalMs = DEFAULT_STATE_BROADCAST_INTERVAL_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (typeof emitSnapshot !== "function") {
    throw new TypeError("emitSnapshot must be a function");
  }
  const interval = Number.isFinite(intervalMs) && intervalMs >= 0 ? Math.trunc(intervalMs) : DEFAULT_STATE_BROADCAST_INTERVAL_MS;
  let timer = null;
  let pending = false;
  let stopped = false;
  let deferredDepth = 0;

  const schedule = () => {
    if (timer !== null) {
      return;
    }
    timer = setTimeoutFn(() => {
      timer = null;
      flush();
    }, interval);
  };

  const flush = () => {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    if (!pending || stopped) {
      return false;
    }
    pending = false;
    emitSnapshot();
    return true;
  };

  const request = ({ immediate = false } = {}) => {
    if (stopped) {
      return false;
    }
    pending = true;
    if (immediate && deferredDepth === 0) {
      return flush();
    }
    schedule();
    return true;
  };

  const runDeferred = (callback) => {
    if (typeof callback !== "function") {
      throw new TypeError("runDeferred callback must be a function");
    }
    deferredDepth += 1;
    try {
      return callback();
    } finally {
      deferredDepth -= 1;
      if (deferredDepth === 0 && pending) {
        schedule();
      }
    }
  };

  const stop = ({ flushPending = true } = {}) => {
    if (stopped) {
      return false;
    }
    if (flushPending) {
      flush();
    } else if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
      pending = false;
    }
    stopped = true;
    return true;
  };

  return Object.freeze({
    request,
    runDeferred,
    flush,
    stop,
    get pending() {
      return pending;
    },
  });
}

module.exports = {
  DEFAULT_STATE_BROADCAST_INTERVAL_MS,
  createLatestStateBroadcaster,
};
