"use strict";

const MIN_TOKEN_UTF8_BYTES = 32;
const MAX_TOKEN_UTF8_BYTES = 256;

function hasUnicodeControl(value) {
  if (/\p{Cc}/u.test(value)) {
    return true;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validToken(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    /\s/u.test(value) ||
    hasUnicodeControl(value)
  ) {
    return false;
  }
  const byteLength = Buffer.byteLength(value, "utf8");
  return byteLength >= MIN_TOKEN_UTF8_BYTES && byteLength <= MAX_TOKEN_UTF8_BYTES;
}

module.exports = {
  hasUnicodeControl,
  validToken,
};
