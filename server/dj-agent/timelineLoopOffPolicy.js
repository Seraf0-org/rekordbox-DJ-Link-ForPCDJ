"use strict";

// Stage 2 F13 releases the exact current authoritative Timeline loop. The
// required transitionHoldActive snapshot field remains diagnostic; an authored
// loop and a post-Follow hold are intentionally the same physical F13 action.
// Router-level connection, ownership, identity, and delivery fences remain
// outside this pure policy.
function resolveCurrentTimelineLoopOff({
  loopActive,
  pendingLoopDesired,
} = {}) {
  if (loopActive !== true) {
    return {
      allowed: false,
      reason: loopActive === false
        ? "timeline-loop-inactive"
        : "timeline-loop-state-unknown",
    };
  }
  if (pendingLoopDesired != null) {
    return { allowed: false, reason: "timeline-loop-action-pending" };
  }
  return { allowed: true, desiredLoopActive: false };
}

module.exports = { resolveCurrentTimelineLoopOff };
