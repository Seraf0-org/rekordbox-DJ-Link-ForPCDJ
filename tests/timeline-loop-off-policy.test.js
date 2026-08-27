const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveCurrentTimelineLoopOff,
} = require("../server/dj-agent/timelineLoopOffPolicy");

test("current timeline loop-off policy permits both an authored loop and a transition hold", () => {
  for (const transitionHoldActive of [false, true]) {
    assert.deepEqual(resolveCurrentTimelineLoopOff({
      transitionHoldActive,
      loopActive: true,
      pendingLoopDesired: null,
    }), {
      allowed: true,
      desiredLoopActive: false,
    });
  }
});

test("current timeline loop-off policy rejects inactive or unknown loop state and shared pending loop actions", () => {
  for (const [input, reason] of [
    [{ loopActive: null, pendingLoopDesired: null }, "timeline-loop-state-unknown"],
    [{ loopActive: false, pendingLoopDesired: null }, "timeline-loop-inactive"],
    [{ loopActive: true, pendingLoopDesired: false }, "timeline-loop-action-pending"],
    [{ loopActive: true, pendingLoopDesired: true }, "timeline-loop-action-pending"],
  ]) {
    assert.deepEqual(resolveCurrentTimelineLoopOff(input), { allowed: false, reason });
  }
});
