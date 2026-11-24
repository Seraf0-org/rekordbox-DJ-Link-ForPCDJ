"use strict";

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const REPARSE_POINT_EXIT_CODE = 10;
const ACE_FLAGS = new Set(["I", "OI", "CI", "IO", "NP", "ID", "SA", "FA"]);
const ACE_RIGHTS = new Set([
  "F", "M", "RX", "R", "W", "D", "DE", "N", "RC", "WDAC", "WO", "S", "AS", "MA",
  "GR", "GW", "GE", "GA", "RD", "WD", "AD", "REA", "WEA", "X", "DC", "RA", "WA", "NW", "NR", "NX",
]);
const WRITE_RIGHTS = new Set(["F", "M", "W", "D", "DE", "WDAC", "WO", "AS", "MA", "GW", "GA", "WD", "AD", "WEA", "WA"]);
const SYSTEM_PRINCIPALS = new Set(["system", "nt authority\\system", "s-1-5-18", "*s-1-5-18"]);
const ADMINISTRATORS_PRINCIPALS = new Set(["administrators", "builtin\\administrators", "s-1-5-32-544", "*s-1-5-32-544"]);

function windowsSystemBinary(name) {
  const systemRoot = typeof process.env.SystemRoot === "string" && process.env.SystemRoot.trim()
    ? process.env.SystemRoot.trim()
    : "C:\\Windows";
  return path.join(systemRoot, "System32", name);
}

function runWindowsCommandResult(executable, args) {
  return spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  });
}

function runWindowsCommand(executable, args) {
  const result = runWindowsCommandResult(executable, args);
  return result && result.error == null && result.status === 0 ? result : null;
}

function currentWindowsIdentity() {
  if (process.platform !== "win32") {
    return null;
  }
  const result = runWindowsCommand(windowsSystemBinary("whoami.exe"), []);
  const identity = String(result?.stdout || "").trim();
  // The identity is passed as an icacls principal; reject anything that could
  // alter the command instead of guessing.
  if (!identity || /[\r\n"']/u.test(identity) || identity.includes(":") || identity.includes("/") || identity.includes("\\\\")) {
    return null;
  }
  return identity;
}

function normalizedPrincipal(principal) {
  return typeof principal === "string" ? principal.trim().toLowerCase() : "";
}

function isTrustedPrincipal(principal, currentIdentity) {
  const normalized = normalizedPrincipal(principal);
  return normalized === normalizedPrincipal(currentIdentity) ||
    SYSTEM_PRINCIPALS.has(normalized) || ADMINISTRATORS_PRINCIPALS.has(normalized);
}

function isCurrentPrincipal(principal, currentIdentity) {
  return normalizedPrincipal(principal) === normalizedPrincipal(currentIdentity);
}

function parseAce(text) {
  const match = text.match(/^(.+?):((?:\([^()]+\))+)$/u);
  if (!match) {
    return null;
  }
  const principal = match[1].trim();
  const tokens = Array.from(match[2].matchAll(/\(([^()]+)\)/gu), (entry) => entry[1].trim().toUpperCase())
    .flatMap((token) => token.split(",").map((part) => part.trim()));
  if (!principal || tokens.length === 0 || tokens.some((token) => !token)) {
    return null;
  }
  const deny = tokens.includes("DENY");
  const flags = tokens.filter((token) => ACE_FLAGS.has(token));
  const rights = tokens.filter((token) => ACE_RIGHTS.has(token));
  if (deny || flags.length + rights.length !== tokens.length || rights.length === 0) {
    return null;
  }
  return { principal, flags, rights };
}

function parseIcaclsAclOutput(output, filePath) {
  const normalizedFilePath = path.normalize(filePath).toLowerCase();
  const lines = String(output || "").split(/\r?\n/u);
  const firstIndex = lines.findIndex((line) => {
    const text = line.trimStart();
    return text.toLowerCase().startsWith(`${normalizedFilePath} `);
  });
  if (firstIndex < 0) {
    return null;
  }

  const aclLines = [];
  for (let index = firstIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (index !== firstIndex && !/^\s+/u.test(line)) {
      break;
    }
    const text = index === firstIndex
      ? line.trimStart().slice(normalizedFilePath.length).trim()
      : line.trim();
    if (!text) {
      continue;
    }
    const ace = parseAce(text);
    // Do not ignore an ACE merely because it has an unfamiliar localized
    // principal or rights spelling: an unparsed allow ACE is unsafe.
    if (!ace) {
      return null;
    }
    aclLines.push(ace);
  }
  return aclLines.length > 0 ? aclLines : null;
}

function restrictiveAclFromIcaclsOutput(output, filePath, currentIdentity) {
  const entries = parseIcaclsAclOutput(output, filePath);
  if (!entries || !currentIdentity) {
    return false;
  }
  let currentFullControlCount = 0;
  for (const entry of entries) {
    // The initializer strips inheritance. Keeping that invariant prevents an
    // inherited broad ACE from becoming effective after a parent ACL change.
    if (entry.flags.includes("I")) {
      return false;
    }
    if (isCurrentPrincipal(entry.principal, currentIdentity)) {
      if (entry.rights.length !== 1 || entry.rights[0] !== "F") {
        return false;
      }
      currentFullControlCount += 1;
      continue;
    }
    if (!isTrustedPrincipal(entry.principal, currentIdentity) && entry.rights.some((right) => WRITE_RIGHTS.has(right))) {
      return false;
    }
  }
  return currentFullControlCount === 1;
}

function pathComponents(filePath, pathApi = path) {
  const absolute = pathApi.resolve(filePath);
  const parsed = pathApi.parse(absolute);
  const tail = absolute.slice(parsed.root.length);
  if (!parsed.root || !tail) {
    return [];
  }
  let current = parsed.root;
  return tail.split(/[\\/]+/u).filter(Boolean).map((part) => {
    current = pathApi.join(current, part);
    return current;
  });
}

function queryWindowsReparsePoint(componentPath) {
  const literalPath = `'${componentPath.replace(/'/gu, "''")}'`;
  const script = `$entry = Get-Item -LiteralPath ${literalPath} -Force -ErrorAction Stop; ` +
    "if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 10 }; exit 0";
  const result = runWindowsCommandResult(windowsSystemBinary("WindowsPowerShell\\v1.0\\powershell.exe"), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
  if (!result || result.error != null || result.signal != null) {
    return null;
  }
  if (result.status === REPARSE_POINT_EXIT_CODE) {
    return true;
  }
  return result.status === 0 ? false : null;
}

function fixedPathHasNoReparsePoints(filePath, {
  fsApi = fs,
  pathApi = path,
  queryReparsePoint = queryWindowsReparsePoint,
} = {}) {
  if (typeof filePath !== "string" || !pathApi.isAbsolute(filePath)) {
    return false;
  }
  const components = pathComponents(filePath, pathApi);
  if (components.length === 0) {
    return false;
  }
  for (const component of components) {
    let stat;
    try {
      stat = fsApi.lstatSync(component);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink?.() || stat.isReparsePoint?.()) {
      return false;
    }
    // lstat catches links/junctions, while the FileAttributes query covers
    // non-link Windows reparse tags. Failure to query is a verification failure.
    if (queryReparsePoint(component) !== false) {
      return false;
    }
  }
  return true;
}

function verifyRekordboxLocalTestAcl(filePath) {
  if (process.platform !== "win32") {
    return false;
  }
  const identity = currentWindowsIdentity();
  if (!identity || typeof filePath !== "string" || !path.isAbsolute(filePath) || !fixedPathHasNoReparsePoints(filePath)) {
    return false;
  }
  const result = runWindowsCommand(windowsSystemBinary("icacls.exe"), [filePath]);
  return Boolean(result && restrictiveAclFromIcaclsOutput(result.stdout, filePath, identity));
}

function installAndVerifyRekordboxLocalTestAcl(filePath) {
  if (process.platform !== "win32") {
    throw new Error("restrictive Rekordbox local test config ACL requires Windows");
  }
  const identity = currentWindowsIdentity();
  if (!identity || typeof filePath !== "string" || !path.isAbsolute(filePath) || !fixedPathHasNoReparsePoints(filePath)) {
    throw new Error("current Windows identity or fixed config path could not be established for the Rekordbox local test ACL");
  }
  const result = runWindowsCommand(windowsSystemBinary("icacls.exe"), [
    filePath,
    "/inheritance:r",
    "/grant:r",
    `${identity}:F`,
  ]);
  if (!result || !verifyRekordboxLocalTestAcl(filePath)) {
    throw new Error("Rekordbox local test config restrictive ACL could not be installed and verified");
  }
  return { identity };
}

module.exports = {
  currentWindowsIdentity,
  fixedPathHasNoReparsePoints,
  installAndVerifyRekordboxLocalTestAcl,
  parseIcaclsAclOutput,
  restrictiveAclFromIcaclsOutput,
  verifyRekordboxLocalTestAcl,
};
