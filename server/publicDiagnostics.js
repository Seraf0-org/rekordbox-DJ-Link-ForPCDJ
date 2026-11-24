const LOOKUP_FAILURE_REASONS = new Set([
  "lookup-process-failed",
  "invalid-lookup-payload",
  "lookup-spawn-failed",
]);

function normalizeContentId(value) {
  const text = String(value ?? "").trim();
  return /^\d{1,32}$/.test(text) ? text : null;
}

function normalizeExitCode(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= -1 && value <= 0x7fffffff
    ? value
    : null;
}

function normalizeErrorCode(error) {
  const code = String(error?.code ?? "").trim();
  return /^[A-Z][A-Z0-9_]{0,31}$/.test(code) ? code : null;
}

function buildPublicLookupDiagnostic({ contentId, reason, exitCode, error } = {}) {
  const diagnostic = {
    reason: LOOKUP_FAILURE_REASONS.has(reason) ? reason : "lookup-failed",
  };
  const safeContentId = normalizeContentId(contentId);
  const safeExitCode = normalizeExitCode(exitCode);
  const safeErrorCode = normalizeErrorCode(error);
  if (safeContentId !== null) {
    diagnostic.contentId = safeContentId;
  }
  if (safeExitCode !== null) {
    diagnostic.exitCode = safeExitCode;
  }
  if (safeErrorCode !== null) {
    diagnostic.errorCode = safeErrorCode;
  }
  return diagnostic;
}

module.exports = {
  buildPublicLookupDiagnostic,
  normalizeContentId,
  normalizeErrorCode,
  normalizeExitCode,
};
