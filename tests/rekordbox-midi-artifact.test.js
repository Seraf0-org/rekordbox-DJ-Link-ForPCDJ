"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  CANONICAL_STRING,
  validateCustomMidiCsv,
} = require("../server/dj-agent/rekordboxMapping");

const ARTIFACT = path.join(
  __dirname,
  "..",
  "server",
  "public",
  "setup",
  "CustomMIDI1-Syndocal-v1.1.6.csv",
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
