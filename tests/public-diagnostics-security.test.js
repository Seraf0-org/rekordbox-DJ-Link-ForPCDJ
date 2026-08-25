const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildPublicLookupDiagnostic,
  normalizeContentId,
  normalizeErrorCode,
  normalizeExitCode,
} = require("../server/publicDiagnostics");

test("lookup diagnostics expose only fixed reason and bounded scalar codes", () => {
  const secretPath = "C:\\Users\\alice\\Documents\\secret.py";
  const secretToken = "0123456789abcdef0123456789abcdef";
  const error = new Error(`ENOENT ${secretPath} ${secretToken}`);
  error.code = "ENOENT";

  const diagnostic = buildPublicLookupDiagnostic({
    contentId: "33556432",
    reason: "lookup-spawn-failed",
    exitCode: 1,
    error,
  });

  assert.deepEqual(diagnostic, {
    reason: "lookup-spawn-failed",
    contentId: "33556432",
    exitCode: 1,
    errorCode: "ENOENT",
  });
  const serialized = JSON.stringify(diagnostic);
  assert.equal(serialized.includes(secretPath), false);
  assert.equal(serialized.includes(secretToken), false);
  assert.equal(serialized.includes(error.message), false);
});

test("untrusted diagnostic fields fail closed instead of reflecting input", () => {
  const error = new Error("private-message");
  error.code = "../../private-path";
  const diagnostic = buildPublicLookupDiagnostic({
    contentId: "id=C:\\private",
    reason: "token=private",
    exitCode: "NaN",
    error,
  });

  assert.deepEqual(diagnostic, { reason: "lookup-failed" });
  assert.equal(normalizeContentId(true), null);
  assert.equal(normalizeExitCode(true), null);
  assert.equal(normalizeErrorCode({ code: "E ACCESS" }), null);
});
