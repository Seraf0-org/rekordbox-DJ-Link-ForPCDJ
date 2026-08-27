"use strict";

const FIELD_COUNT = 15;
const REQUIRED_ROWS = Object.freeze([
  "CFXParameterCH1",
  "CFXParameterCH2",
  "Cue",
  "LoopHalf",
]);

const EXPECTED_HEADER = Object.freeze(["@file", "1", "CustomMIDI1"]);
const EXPECTED_FIELDS = Object.freeze({
  CFXParameterCH1: Object.freeze({ 3: "B010" }),
  CFXParameterCH2: Object.freeze({ 3: "B110" }),
  Cue: Object.freeze({ 4: "9025", 5: "9125", 9: "9025", 10: "9125" }),
  LoopHalf: Object.freeze({ 4: "9024", 5: "9124", 9: "9024", 10: "9124" }),
});

const CANONICAL_STRING = [
  "@file|1|CustomMIDI1",
  "CFXParameterCH1|B010",
  "CFXParameterCH2|B110",
  "Cue|9025|9125|9025|9125",
  "LoopHalf|9024|9124|9024|9124",
].join("\n");

function failure(...codes) {
  const errors = [...new Set(codes.filter(Boolean))];
  const code = errors[0] || "invalid-custom-midi";
  return {
    ok: false,
    code,
    errors,
    summary: null,
    canonicalString: null,
  };
}

// Parse one physical record without interpreting arbitrary input as an error
// message. Quoted fields are accepted only when they are valid CSV fields;
// records are split before this function, so a quoted newline is rejected.
function parseCsvRecord(line) {
  const fields = [];
  let field = "";
  let inQuotes = false;
  let quoteClosed = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (inQuotes) {
      if (character !== '"') {
        field += character;
        continue;
      }
      if (line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = false;
        quoteClosed = true;
      }
      continue;
    }

    if (character === '"') {
      if (field !== "" || quoteClosed) {
        return null;
      }
      inQuotes = true;
      continue;
    }
    if (character === ",") {
      fields.push(field);
      field = "";
      quoteClosed = false;
      continue;
    }
    if (quoteClosed) {
      return null;
    }
    field += character;
  }

  if (inQuotes) {
    return null;
  }
  fields.push(field);
  return fields;
}

function decodeMidiCode(code) {
  if (typeof code !== "string" || !/^[0-9a-fA-F]{4}$/.test(code)) {
    return null;
  }
  const normalized = code.toUpperCase();
  const status = Number.parseInt(normalized.slice(0, 2), 16);
  const data1 = Number.parseInt(normalized.slice(2), 16);
  if (!Number.isInteger(status) || !Number.isInteger(data1) || data1 > 0x7f) {
    return null;
  }
  const statusType = status & 0xf0;
  const channel = (status & 0x0f) + 1;
  if (statusType === 0xb0) {
    return { kind: "cc", channel, controller: data1, code: normalized };
  }
  if (statusType === 0x90) {
    return { kind: "note", channel, note: data1, code: normalized };
  }
  return null;
}

function buildSemanticSummary() {
  const cfxCh1 = decodeMidiCode("B010");
  const cfxCh2 = decodeMidiCode("B110");
  const cueCh1 = decodeMidiCode("9025");
  const cueCh2 = decodeMidiCode("9125");
  const loopCh1 = decodeMidiCode("9024");
  const loopCh2 = decodeMidiCode("9124");
  return {
    version: 1,
    device: "CustomMIDI1",
    mappings: {
      CFXParameterCH1: cfxCh1,
      CFXParameterCH2: cfxCh2,
      Cue: { channel1: cueCh1, channel2: cueCh2 },
      LoopHalf: { channel1: loopCh1, channel2: loopCh2 },
    },
  };
}

function validateCustomMidiCsv(source) {
  if (typeof source !== "string") {
    return failure("input-not-string");
  }

  const normalized = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const lines = normalized.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  while (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
    return failure("empty-input");
  }

  const header = parseCsvRecord(lines[0]);
  if (!header || header.length !== EXPECTED_HEADER.length ||
      header.some((value, index) => value !== EXPECTED_HEADER[index])) {
    return failure("invalid-header");
  }

  const rows = new Map();
  const errors = [];
  for (const line of lines.slice(1)) {
    if (line === "") {
      errors.push("malformed-row");
      continue;
    }
    const fields = parseCsvRecord(line);
    if (!fields || fields.length !== FIELD_COUNT) {
      errors.push("malformed-row");
      continue;
    }
    const name = fields[0];
    if (!Object.hasOwn(EXPECTED_FIELDS, name)) {
      errors.push("unknown-row");
      continue;
    }
    if (rows.has(name)) {
      errors.push("duplicate-row");
      continue;
    }
    rows.set(name, fields);
  }

  for (const requiredRow of REQUIRED_ROWS) {
    const fields = rows.get(requiredRow);
    if (!fields) {
      errors.push("missing-required-row");
      continue;
    }
    const expectedFields = EXPECTED_FIELDS[requiredRow];
    if (Object.entries(expectedFields).some(([index, expected]) => fields[Number(index)] !== expected)) {
      errors.push("required-mapping-mismatch");
    }
  }

  if (errors.length > 0) {
    return failure(...errors);
  }

  return {
    ok: true,
    code: "ok",
    errors: [],
    summary: buildSemanticSummary(),
    // Deliberately constructed from the reviewed fixed semantics rather than
    // copied from arbitrary CSV fields, so callers can hash it safely.
    canonicalString: CANONICAL_STRING,
  };
}

function canonicalizeCustomMidiCsv(source) {
  const result = validateCustomMidiCsv(source);
  return result.ok ? result.canonicalString : null;
}

module.exports = {
  CANONICAL_STRING,
  EXPECTED_FIELDS,
  EXPECTED_HEADER,
  FIELD_COUNT,
  REQUIRED_ROWS,
  canonicalizeCustomMidiCsv,
  decodeMidiCode,
  parseCustomMidiCsv: validateCustomMidiCsv,
  validateCustomMidiCsv,
};
