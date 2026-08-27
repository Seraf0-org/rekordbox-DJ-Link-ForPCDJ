"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  CANONICAL_STRING,
  validateCustomMidiCsv,
} = require("../server/dj-agent/rekordboxMapping");
const { createRekordboxMidi } = require("../server/dj-agent/rekordboxMidi");

const ARTIFACT = path.join(
  __dirname,
  "..",
  "server",
  "public",
  "setup",
  "CustomMIDI1-Syndocal-v1.1.8.csv",
);

test("bundled CustomMIDI1 mapping matches the reviewed rekordbox setup contract", () => {
  const raw = fs.readFileSync(ARTIFACT, "utf8");
  assert.equal(raw.charCodeAt(0) === 0xfeff, false, "artifact must not contain a BOM");

  const validation = validateCustomMidiCsv(raw);
  assert.equal(validation.ok, true);
  assert.equal(validation.canonicalString, CANONICAL_STRING);
  assert.equal(validation.summary.device, "CustomMIDI1");

  const lines = raw.trimEnd().split(/\r?\n/);
  assert.equal(lines[0], "@file,1,CustomMIDI1");

  const mappings = new Map(
    lines.slice(1).map((line) => {
      const fields = line.split(",");
      assert.equal(fields.length, 15, `${fields[0]} must use rekordbox's 15-field format`);
      return [fields[0], fields];
    }),
  );

  assert.deepEqual([...mappings.keys()], [
    "CFXParameterCH1",
    "CFXParameterCH2",
    "ChannelFader",
    "Cue",
    "LoopHalf",
  ]);
  assert.equal(mappings.get("CFXParameterCH1")[3], "B010");
  assert.equal(mappings.get("CFXParameterCH2")[3], "B110");
  assert.deepEqual(mappings.get("ChannelFader").slice(4, 6), ["B011", "B111"]);
  assert.deepEqual(mappings.get("Cue").slice(4, 6), ["9025", "9125"]);
  assert.deepEqual(mappings.get("LoopHalf").slice(4, 6), ["9024", "9124"]);
});

test("release fade sends the reviewed CC17 127-to-0 ramp and restores CC17 127", () => {
  let nowMs = 0;
  const messages = [];
  const intervals = [];
  const output = {
    getPortCount: () => 1,
    getPortName: () => "CustomMIDI1",
    openPort: () => true,
    closePort: () => {},
    destroy: () => {},
    sendMessage: (message) => messages.push([...message]),
  };
  const midi = createRekordboxMidi({
    enabled: true,
    device: "CustomMIDI1",
    port: 0,
    mappings: {
      filter: { channel: 1, messageType: "controlChange", cc: 16 },
      releaseFade: { channel: 1, messageType: "controlChange", cc: 17 },
    },
    deckChannels: { "1": 1 },
    releaseFade: {
      enabled: true,
      mappingName: "releaseFade",
      target: "deck",
      startValue: 127,
      endValue: 0,
      durationMs: 1_000,
      updateIntervalMs: 50,
      resetAfterStop: true,
      resetValue: 127,
      resetDelayMs: 0,
    },
    outputFactory: () => output,
    now: () => nowMs,
    setIntervalImpl: (callback, delayMs) => {
      const handle = { callback, delayMs, cleared: false };
      intervals.push(handle);
      return handle;
    },
    clearIntervalImpl: (handle) => { handle.cleared = true; },
  });

  midi.start();
  assert.equal(midi.getStatus().ok, true);
  const completed = [];
  const ramp = midi.startReleaseFade({
    targetDeck: 1,
    onComplete: (result) => completed.push(result),
  });
  assert.equal(ramp.started, true);
  assert.deepEqual(messages.at(-1), [0xb0, 17, 127]);
  assert.equal(intervals.at(-1).delayMs, 50);

  nowMs = 1_000;
  intervals.at(-1).callback();
  assert.deepEqual(messages.at(-1), [0xb0, 17, 0]);
  assert.equal(completed.length, 1);
  assert.equal(midi.getStatus().releaseFadeActive, false);

  const reset = midi.resetReleaseFade({ targetDeck: 1 });
  assert.equal(reset.ok, true);
  assert.deepEqual(messages.at(-1), [0xb0, 17, 127]);
  midi.stop();
});
