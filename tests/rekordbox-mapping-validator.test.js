"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CANONICAL_STRING,
  canonicalizeCustomMidiCsv,
  decodeMidiCode,
  parseCustomMidiCsv,
  validateCustomMidiCsv,
} = require("../server/dj-agent/rekordboxMapping");

const VALID_CSV = [
  "@file,1,CustomMIDI1",
  "CFXParameterCH1,,KnobSlider,B010,,,,,,,,,,Fast;,",
  "CFXParameterCH2,,KnobSlider,B110,,,,,,,,,,Fast;,",
  "Cue,,Button,,9025,9125,,,,9025,9125,,,Fast;Blink=500;Priority=50;,",
  "LoopHalf,,Button,,9024,9124,,,,9024,9124,,,Fast;,",
].join("\r\n") + "\r\n";

test("validates the reviewed 15-field CustomMIDI1 contract and returns semantic summary", () => {
  const result = validateCustomMidiCsv("\ufeff" + VALID_CSV);

  assert.equal(result.ok, true);
  assert.equal(result.code, "ok");
  assert.deepEqual(result.errors, []);
  assert.equal(result.canonicalString, CANONICAL_STRING);
  assert.equal(result.summary.version, 1);
  assert.equal(result.summary.device, "CustomMIDI1");
  assert.deepEqual(result.summary.mappings.CFXParameterCH1, {
    kind: "cc",
    channel: 1,
    controller: 16,
    code: "B010",
  });
  assert.deepEqual(result.summary.mappings.CFXParameterCH2, {
    kind: "cc",
    channel: 2,
    controller: 16,
    code: "B110",
  });
  assert.equal(result.summary.mappings.Cue.channel1.note, 37);
  assert.equal(result.summary.mappings.Cue.channel2.note, 37);
  assert.equal(result.summary.mappings.LoopHalf.channel1.note, 36);
  assert.equal(result.summary.mappings.LoopHalf.channel2.note, 36);
});

test("accepts BOM/CRLF and keeps canonical output independent of nonsemantic options", () => {
  const alternate = VALID_CSV
    .replaceAll("Fast;", "Fast;Blink=1;")
    .replaceAll("\r\n", "\n");
  const result = parseCustomMidiCsv("\ufeff" + alternate);

  assert.equal(result.ok, true);
  assert.equal(canonicalizeCustomMidiCsv(alternate), CANONICAL_STRING);
});

test("rejects invalid header and all malformed record shapes", () => {
  const invalidHeader = VALID_CSV.replace("@file,1,CustomMIDI1", "@file,2,CustomMIDI1");
  assert.equal(validateCustomMidiCsv(invalidHeader).code, "invalid-header");

  const wrongFieldCount = VALID_CSV.replace(
    "CFXParameterCH1,,KnobSlider,B010,,,,,,,,,,Fast;,",
    "CFXParameterCH1,,KnobSlider,B010,",
  );
  assert.equal(validateCustomMidiCsv(wrongFieldCount).code, "malformed-row");

  const unterminatedQuote = VALID_CSV.replace(
    "LoopHalf,,Button,,9024,9124,,,,9024,9124,,,Fast;,",
    "LoopHalf,,Button,,9024,9124,,,,9024,9124,,,\"Fast;,",
  );
  assert.equal(validateCustomMidiCsv(unterminatedQuote).code, "malformed-row");
});

test("rejects duplicate, missing, unknown, and variant required rows", () => {
  const duplicate = VALID_CSV
    + "CFXParameterCH1,,KnobSlider,B010,,,,,,,,,,Fast;,\r\n";
  assert.equal(validateCustomMidiCsv(duplicate).code, "duplicate-row");

  const missing = VALID_CSV.replace(
    "LoopHalf,,Button,,9024,9124,,,,9024,9124,,,Fast;,\r\n",
    "",
  );
  assert.equal(validateCustomMidiCsv(missing).code, "missing-required-row");

  const unknown = VALID_CSV.replace(
    "LoopHalf,,Button,,9024,9124,,,,9024,9124,,,Fast;,",
    "OtherControl,,Button,,,,,,,,,,,Fast;,",
  );
  assert.equal(validateCustomMidiCsv(unknown).code, "unknown-row");

  const variant = VALID_CSV.replace("B110", "B112");
  assert.equal(validateCustomMidiCsv(variant).code, "required-mapping-mismatch");
});

test("failure output never reflects source token, path, or arbitrary field text", () => {
  const secretPath = "C:\\Users\\alice\\private\\CustomMIDI1.csv";
  const secretToken = "token-should-never-appear";
  const source = VALID_CSV.replace("CustomMIDI1", secretPath).replace("B010", secretToken);
  const result = validateCustomMidiCsv(source);
  const serialized = JSON.stringify(result);

  assert.equal(result.ok, false);
  assert.equal(serialized.includes(secretPath), false);
  assert.equal(serialized.includes("alice"), false);
  assert.equal(serialized.includes(secretToken), false);
  assert.equal(serialized.includes("B010"), false);
  assert.equal(result.summary, null);
  assert.equal(result.canonicalString, null);

  const validWithPrivateOption = VALID_CSV.replace(
    "Fast;",
    "Fast;path=" + secretPath + ";token=" + secretToken + ";",
  );
  const validResult = validateCustomMidiCsv(validWithPrivateOption);
  assert.equal(validResult.ok, true);
  const validSerialized = JSON.stringify(validResult);
  assert.equal(validSerialized.includes(secretPath), false);
  assert.equal(validSerialized.includes("alice"), false);
  assert.equal(validSerialized.includes(secretToken), false);
});

test("MIDI semantic decoding rejects non-four-digit and out-of-range codes", () => {
  assert.deepEqual(decodeMidiCode("B010"), {
    kind: "cc",
    channel: 1,
    controller: 16,
    code: "B010",
  });
  for (const value of ["B01", "B0100", "B0G0", "B080", "8024", null, 9024]) {
    assert.equal(decodeMidiCode(value), null, `unexpectedly accepted ${String(value)}`);
  }
});
