#!/usr/bin/env node
"use strict";

// One-way tooling boundary for the v1.1.10 -> v1.1.11 show-config upgrade.
// This module deliberately does not participate in runtime config loading:
// v1.1.10 is accepted here only long enough to copy its validated token into
// the current token-free template.

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const { validToken } = require("../server/dj-agent/tokenValidation");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PREDECESSOR_VERSION = "1.1.10";
const CURRENT_VERSION = "1.1.11";
const TEMPLATE_PATH = path.join(PROJECT_ROOT, "config", `dj-agent-v${CURRENT_VERSION}.example.json`);
const TARGET_PATH = String.raw`C:\SyndocalShow\dj-agent-v${CURRENT_VERSION}.json`;
const TOKEN_PLACEHOLDER = "<SYNDOCAL_ONE_TIME_TOKEN>";
const WINDOWS_POWERSHELL_PATH = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const WINDOWS_TARGET_ACL_BOUNDARY = Object.freeze({
  parent: String.raw`C:\SyndocalShow`,
  authority: "NTFS ACL inherited from the operator-managed target parent",
  handleBoundary: "FileShare.None",
  unixModeClaim: false,
});

const FORBIDDEN_ENV_KEYS = Object.freeze([
  "DJ_AGENT_CONFIG",
  "DJ_AGENT_ENABLED",
  "DJ_AGENT_ALLOW_REMOTE_ACTIONS",
  "SYNDOCAL_ENABLED",
  "SYNDOCAL_HOST",
  "SYNDOCAL_PORT",
  "SYNDOCAL_PATH",
  "SYNDOCAL_NIC",
  "SYNDOCAL_TOKEN",
  "SYNDOCAL_WS_ADAPTER",
  "SYNDOCAL_HEARTBEAT_MS",
  "PEDAL_ENABLED",
  "PEDAL_MODULE",
  "MIDI_ENABLED",
  "MIDI_MODULE",
  "MIDI_DEVICE",
  "MIDI_PORT",
  "MIDI_RELEASE_FADE",
  "MIDI_RELEASE_MACRO",
  "MIDI_DECK_CHANNELS",
  "PORT",
  "RB_OUTPUT_HOST",
  "RB_OUTPUT_SETUP_MAPPING_PATH",
]);

// The Node fs Windows backend cannot request FILE_SHARE_NONE, so a target
// opened with fs.openSync("wx") can still be renamed while the descriptor is
// live. The pinned Windows PowerShell helper creates the file with
// FileMode.CreateNew and FileShare.None, keeps that handle live through the
// write/Flush(true), and only then releases it. The payload enters as a
// base64 frame so no token or config bytes appear in the process command line.
const WINDOWS_SECURE_WRITER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$nativeSource = @'
using System;
using System.Runtime.InteropServices;
public static class RbOutputSecureWriterNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct ByHandleFileInformation {
    public uint FileAttributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
    public uint VolumeSerialNumber;
    public uint FileSizeHigh;
    public uint FileSizeLow;
    public uint NumberOfLinks;
    public uint FileIndexHigh;
    public uint FileIndexLow;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct FileDispositionInfo {
    [MarshalAs(UnmanagedType.Bool)]
    public bool DeleteFile;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetFileInformationByHandle(IntPtr handle, out ByHandleFileInformation information);
  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool SetFileInformationByHandle(IntPtr handle, int informationClass, IntPtr information, uint bufferSize);
}
'@
Add-Type -TypeDefinition $nativeSource
$stream = $null
$parentHandle = [IntPtr]::Zero
$targetIdentity = $null
$created = $false
$exitCode = 1
$stage = 'bootstrap'
$failureCode = 'SECURE_WRITER_FAILED'
$target = $null
try {
  $stage = 'frame'
  $frameBytes = [Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim())
  if ($frameBytes.Length -eq 0) { throw 'invalid secure-writer frame' }
  $frame = ([Text.Encoding]::UTF8.GetString($frameBytes)) | ConvertFrom-Json
  $target = [string]$frame.targetPath
  $parent = [string]$frame.parentPath
  $expectedParent = [string]$frame.parentResolvedPath
  $expectedParentIdentity = [string]$frame.parentIdentity
  $expectedParentResolvedIdentity = [string]$frame.parentResolvedIdentity
  $stage = 'parent-path'
  if ([String]::IsNullOrWhiteSpace($target) -or [String]::IsNullOrWhiteSpace($parent) -or [String]::IsNullOrWhiteSpace($expectedParent)) { throw 'invalid secure-writer paths' }
  if ([String]::IsNullOrWhiteSpace($expectedParentIdentity) -or [String]::IsNullOrWhiteSpace($expectedParentResolvedIdentity)) { throw 'invalid secure-writer identity' }
  if (-not [String]::Equals([IO.Path]::GetFullPath([IO.Path]::GetDirectoryName($target)), [IO.Path]::GetFullPath($parent), [StringComparison]::OrdinalIgnoreCase)) { throw 'target parent path mismatch' }
  if (-not [String]::Equals([IO.Path]::GetFullPath($parent), [IO.Path]::GetFullPath($expectedParent), [StringComparison]::OrdinalIgnoreCase)) { throw 'target parent realpath mismatch' }
  $stage = 'parent-inspect'
  $payload = [Text.Encoding]::UTF8.GetBytes([string]$frame.payload)
  $parentItem = Get-Item -LiteralPath $parent -Force
  if (($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'target parent is a reparse point' }
  # Keep the exact parent directory open with FILE_READ_ATTRIBUTES access. Read and
  # write sharing lets the child FileStream open on Windows, while omitting
  # FILE_SHARE_DELETE still prevents the parent/target path from being
  # renamed or deleted until the target stream is flushed. OPEN_REPARSE_POINT
  # makes this fail closed rather than traversing a reparse point if the parent
  # changes before the handle.
  $stage = 'parent-open'
  $parentHandle = [RbOutputSecureWriterNative]::CreateFile(
    $parent,
    0x00000080,
    0x00000003,
    [IntPtr]::Zero,
    3,
    0x02000000 -bor 0x00200000,
    [IntPtr]::Zero
  )
  if ($parentHandle.ToInt64() -eq -1) { throw 'target parent could not be bound' }
  $stage = 'parent-info'
  $parentInfo = New-Object 'RbOutputSecureWriterNative+ByHandleFileInformation'
  if (-not [RbOutputSecureWriterNative]::GetFileInformationByHandle($parentHandle, [ref]$parentInfo)) { throw 'target parent identity could not be captured' }
  if (($parentInfo.FileAttributes -band 0x00000400) -ne 0) { throw 'target parent handle is a reparse point' }
  $stage = 'parent-identity'
  $parentHandleIdentity = "$($parentInfo.VolumeSerialNumber):$([uint64]$parentInfo.FileIndexHigh * 4294967296 + [uint64]$parentInfo.FileIndexLow)"
  $stage = 'parent-identity-match'
  if ($parentHandleIdentity -ne $expectedParentIdentity -or $parentHandleIdentity -ne $expectedParentResolvedIdentity) { throw 'target parent identity changed' }
  # FileMode.CreateNew inherits the parent ACL. Refuse a parent that grants
  # write/delete rights to the broad built-in principals; this is the ACL
  # boundary for the exact C:\SyndocalShow target. ACL ownership and repair
  # remain operator-managed; this helper never mutates the parent descriptor.
  if ([String]::Equals($parent, 'C:\SyndocalShow', [StringComparison]::OrdinalIgnoreCase)) {
    $stage = 'parent-acl'
    $parentAcl = [IO.Directory]::GetAccessControl($parent)
    $broadWriteSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')
    $writeMask = [int64][System.Security.AccessControl.FileSystemRights]::WriteData -bor
      [int64][System.Security.AccessControl.FileSystemRights]::AppendData -bor
      [int64][System.Security.AccessControl.FileSystemRights]::WriteAttributes -bor
      [int64][System.Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
      [int64][System.Security.AccessControl.FileSystemRights]::Delete -bor
      [int64][System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
    foreach ($accessRule in @($parentAcl.Access)) {
      if ($accessRule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
      try { $identitySid = $accessRule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { throw 'target parent ACL identity could not be resolved' }
      if ($broadWriteSids -contains $identitySid -and (([int64]$accessRule.FileSystemRights -band $writeMask) -ne 0)) {
        throw 'target parent ACL grants broad write access'
      }
    }
  }
  $stage = 'target-create'
  $stream = [IO.FileStream]::new(
    $target,
    [IO.FileMode]::CreateNew,
    [IO.FileAccess]::ReadWrite,
    [IO.FileShare]::None,
    4096,
    [IO.FileOptions]::WriteThrough
  )
  $created = $true
  Write-Output 'READY'
  $stage = 'target-inspect'
  $targetInfo = New-Object 'RbOutputSecureWriterNative+ByHandleFileInformation'
  if (-not [RbOutputSecureWriterNative]::GetFileInformationByHandle($stream.SafeFileHandle.DangerousGetHandle(), [ref]$targetInfo)) { throw 'target identity could not be captured' }
  $targetIdentity = "$($targetInfo.VolumeSerialNumber):$([uint64]$targetInfo.FileIndexHigh * 4294967296 + [uint64]$targetInfo.FileIndexLow)"
  $stage = 'target-write'
  $stream.Write($payload, 0, $payload.Length)
  $stage = 'target-flush'
  $stream.Flush($true)
  $exitCode = 0
} catch {
  $exitCode = 1
  $failureCode = switch ($stage) {
    'frame' { 'FRAME_INVALID' }
    'parent-path' { 'PARENT_PATH_INVALID' }
    'parent-inspect' { 'PARENT_INSPECTION_FAILED' }
    'parent-acl' { 'PARENT_ACL_UNSAFE' }
    'parent-open' { 'PARENT_OPEN_FAILED' }
    'parent-info' { 'PARENT_INFO_FAILED' }
    'parent-identity' { 'PARENT_IDENTITY_FAILED' }
    'parent-identity-match' { 'PARENT_IDENTITY_MISMATCH' }
    'target-create' { 'TARGET_CREATE_FAILED' }
    'target-inspect' { 'TARGET_IDENTITY_FAILED' }
    'target-write' { 'TARGET_WRITE_FAILED' }
    'target-flush' { 'TARGET_FLUSH_FAILED' }
    default { 'SECURE_WRITER_FAILED' }
  }
} finally {
  if ($created -and $exitCode -ne 0 -and $null -ne $stream) {
    try {
      $stream.SetLength(0)
      $stream.Flush($true)
    } catch { }
  }
  if ($null -ne $stream) { $stream.Dispose() }
  if ($parentHandle -ne [IntPtr]::Zero) { [RbOutputSecureWriterNative]::CloseHandle($parentHandle) | Out-Null }
}
if ($created -and $exitCode -ne 0) {
  # Re-open the path with DELETE access only after the original stream is
  # closed, then bind cleanup to that handle's exact File ID. If an attacker
  # replaced the path in the gap, the identity differs and no path deletion
  # is attempted. Deletion is issued on the bound handle, not by path.
  $cleanupHandle = [IntPtr]::Zero
  try {
    $cleanupHandle = [RbOutputSecureWriterNative]::CreateFile($target, 0x00010000, 0, [IntPtr]::Zero, 3, 0x00200000, [IntPtr]::Zero)
    if ($cleanupHandle.ToInt64() -ne -1) {
      $cleanupInfo = New-Object 'RbOutputSecureWriterNative+ByHandleFileInformation'
      if ([RbOutputSecureWriterNative]::GetFileInformationByHandle($cleanupHandle, [ref]$cleanupInfo)) {
        $cleanupIdentity = "$($cleanupInfo.VolumeSerialNumber):$([uint64]$cleanupInfo.FileIndexHigh * 4294967296 + [uint64]$cleanupInfo.FileIndexLow)"
        if ($cleanupIdentity -eq $targetIdentity) {
          $disposition = New-Object 'RbOutputSecureWriterNative+FileDispositionInfo'
          $disposition.DeleteFile = $true
          $bufferSize = [Runtime.InteropServices.Marshal]::SizeOf($disposition)
          $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($bufferSize)
          try {
            [Runtime.InteropServices.Marshal]::StructureToPtr($disposition, $buffer, $false)
            [RbOutputSecureWriterNative]::SetFileInformationByHandle($cleanupHandle, 4, $buffer, [uint32]$bufferSize) | Out-Null
          } finally {
            [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
          }
        }
      }
    }
  } catch { }
  finally {
    if ($cleanupHandle -ne [IntPtr]::Zero -and $cleanupHandle.ToInt64() -ne -1) { [RbOutputSecureWriterNative]::CloseHandle($cleanupHandle) | Out-Null }
  }
}
if ($exitCode -eq 0) { $failureCode = 'OK' }
Write-Output ("RB_OUTPUT_SECURE_WRITER_RESULT=" + $failureCode)
exit $exitCode
`;

const PREDECESSOR_REMOVAL_MILESTONE =
  "Remove the v1.1.10 migration path after every controlled DJ PC has adopted v1.1.11.";

class ShowConfigUpgradeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ShowConfigUpgradeError";
    this.code = code;
  }
}

function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNoForbiddenEnvironment(env) {
  if (!env || typeof env !== "object") return;
  const forbidden = new Set(FORBIDDEN_ENV_KEYS);
  const key = Object.keys(env).find((candidate) => forbidden.has(candidate.toUpperCase()));
  if (key) {
    throw new ShowConfigUpgradeError("FORBIDDEN_ENV", "forbidden environment override is present");
  }
}

function hasExactKeys(value, keys) {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasExactValues(value, expected) {
  return hasExactKeys(value, Object.keys(expected)) && Object.entries(expected).every(
    ([key, expectedValue]) => value[key] === expectedValue,
  );
}

const OWNER_SELECTION_POLICY = Object.freeze({
  mode: "titleContains",
  titleNeedle: "人生オーバー",
  deck1MetadataWaitMs: 1400,
});

const FILTER = Object.freeze({
  startValue: 64,
  endValue: 127,
  durationMs: 1000,
  updateIntervalMs: 50,
});

// Keep the predecessor schema exact and local to this one-way migration. In
// particular, do not call the runtime loader or accept any legacy aliases.
function validateStrictShowConfig(value, expectedVersion) {
  if (!hasExactKeys(value, ["version", "enabled", "syndocal", "pedal", "midi", "trackActivity"])) return false;
  if (value.version !== expectedVersion || value.enabled !== true) return false;

  const syndocal = value.syndocal;
  if (!hasExactKeys(syndocal, ["enabled", "host", "port", "path", "nic", "token", "adapter", "heartbeatMs"])) return false;
  if (
    syndocal.enabled !== true ||
    syndocal.host !== "192.168.50.1" ||
    syndocal.port !== 9100 ||
    syndocal.path !== "/dj-link" ||
    syndocal.nic !== "192.168.50.2" ||
    syndocal.adapter !== "syndocal-envelope-v3" ||
    syndocal.heartbeatMs !== 5000 ||
    typeof syndocal.token !== "string" ||
    !validToken(syndocal.token) ||
    syndocal.token === TOKEN_PLACEHOLDER
  ) return false;

  const pedal = value.pedal;
  if (!hasExactKeys(pedal, ["enabled", "bindings"]) || pedal.enabled !== true) return false;
  if (!hasExactValues(pedal.bindings, { release: "F13", loopHalf: "F14", filterClose: "F15" })) return false;

  const trackActivity = value.trackActivity;
  if (!hasExactKeys(trackActivity, ["ownerSelection"])) return false;
  if (!hasExactValues(trackActivity.ownerSelection, OWNER_SELECTION_POLICY)) return false;

  const midi = value.midi;
  if (!hasExactKeys(midi, ["enabled", "device", "port", "mappings", "deckChannels", "filter", "releaseFade", "releaseMacro"])) return false;
  if (midi.enabled !== true || midi.device !== "CustomMIDI1" || !Number.isInteger(midi.port) || midi.port < 0 || midi.port > 4096) return false;
  if (!hasExactKeys(midi.mappings, ["loopHalf", "stop", "filter", "releaseFade"])) return false;
  if (!hasExactValues(midi.mappings.loopHalf, { channel: 1, messageType: "noteOn", note: 36, value: 127 })) return false;
  if (!hasExactValues(midi.mappings.stop, { channel: 1, messageType: "noteOn", note: 37, value: 127 })) return false;
  if (!hasExactValues(midi.mappings.filter, { channel: 1, messageType: "controlChange", cc: 16 })) return false;
  if (!hasExactValues(midi.mappings.releaseFade, { channel: 1, messageType: "controlChange", cc: 17 })) return false;
  if (!hasExactValues(midi.deckChannels, { 1: 1, 2: 2 })) return false;
  if (!hasExactValues(midi.filter, FILTER)) return false;
  if (!hasExactKeys(midi.releaseFade, [
    "enabled", "mapping", "target", "startValue", "endValue", "durationMs",
    "updateIntervalMs", "resetAfterStop", "resetValue", "resetDelayMs",
  ])) return false;
  if (!hasExactValues(midi.releaseFade, {
    enabled: true,
    mapping: "releaseFade",
    target: "deck",
    startValue: 127,
    endValue: 0,
    durationMs: 1000,
    updateIntervalMs: 50,
    resetAfterStop: true,
    resetValue: 127,
    resetDelayMs: 0,
  })) return false;
  if (!hasExactKeys(midi.releaseMacro, ["enabled", "sequence", "filter", "resetAfterStop", "resetDelayMs"])) return false;
  if (midi.releaseMacro.enabled !== true || midi.releaseMacro.sequence !== "filter-then-fade-then-stop") return false;
  if (!hasExactValues(midi.releaseMacro.filter, { ...FILTER, resetValue: 64 })) return false;
  return midi.releaseMacro.resetAfterStop === true && midi.releaseMacro.resetDelayMs === 0;
}

function parseJson(raw, code) {
  try {
    const value = JSON.parse(raw);
    if (!isPlainRecord(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new ShowConfigUpgradeError(code, "show config JSON is malformed");
  }
}

function realpath(fsApi, target) {
  const native = fsApi.realpathSync && fsApi.realpathSync.native;
  if (typeof native === "function") return native.call(fsApi.realpathSync, target);
  if (typeof fsApi.realpathSync === "function") return fsApi.realpathSync(target);
  throw new Error("realpath is unavailable");
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function lstat(fsApi, target, code, message) {
  try {
    return fsApi.lstatSync(target, { bigint: true });
  } catch (error) {
    throw new ShowConfigUpgradeError(code, message || "show config path is unavailable");
  }
}

function stat(fsApi, target, code, message) {
  try {
    if (typeof fsApi.statSync !== "function") throw new Error("stat is unavailable");
    return fsApi.statSync(target, { bigint: true });
  } catch (error) {
    throw new ShowConfigUpgradeError(code, message || "show config path is unavailable");
  }
}

function fileIdentity(statValue, code, message) {
  const dev = statValue && statValue.dev;
  const ino = statValue && statValue.ino;
  const usable = (value) => {
    if (typeof value === "bigint") return value > 0n;
    return typeof value === "number" && Number.isFinite(value) && value > 0;
  };
  if (!usable(dev) || !usable(ino)) {
    throw new ShowConfigUpgradeError(code, message);
  }
  return `${String(dev)}:${String(ino)}`;
}

function assertSameIdentity(first, second, code, message) {
  if (fileIdentity(first, code, message) !== fileIdentity(second, code, message)) {
    throw new ShowConfigUpgradeError(code, message);
  }
}

function assertRegularFileStat(statValue, code, message) {
  assertNoLink(statValue, code, message);
  if (!statValue || typeof statValue.isFile !== "function" || !statValue.isFile()) {
    throw new ShowConfigUpgradeError(code, message);
  }
}

function assertRegularDirectoryStat(statValue, code, message) {
  assertNoLink(statValue, code, message);
  if (!statValue || typeof statValue.isDirectory !== "function" || !statValue.isDirectory()) {
    throw new ShowConfigUpgradeError(code, message);
  }
}

function samePath(first, second) {
  const left = path.normalize(path.resolve(first));
  const right = path.normalize(path.resolve(second));
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function assertNoLink(stat, code, message) {
  if (stat && typeof stat.isSymbolicLink === "function" && stat.isSymbolicLink()) {
    throw new ShowConfigUpgradeError(code, message);
  }
}

function assertNoLinkAncestors(fsApi, requestedPath, code, message) {
  const resolved = path.resolve(requestedPath);
  const root = path.parse(resolved).root;
  const relative = path.relative(root, resolved);
  let cursor = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = fsApi.lstatSync(cursor, { bigint: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw new ShowConfigUpgradeError(code, message);
    }
    assertNoLink(stat, code, message);
  }
}

function capturePathEvidence(fsApi, requestedPath, {
  missingCode,
  linkCode,
  message,
  requireFile = false,
  requireDirectory = false,
  rejectRedirect = false,
}) {
  const pathStat = lstat(fsApi, requestedPath, missingCode, message);
  if (requireFile) assertRegularFileStat(pathStat, linkCode, message);
  else if (requireDirectory) assertRegularDirectoryStat(pathStat, linkCode, message);
  else assertNoLink(pathStat, linkCode, message);

  let resolvedPath;
  try {
    resolvedPath = realpath(fsApi, requestedPath);
  } catch {
    throw new ShowConfigUpgradeError(missingCode, message);
  }
  if (rejectRedirect && !samePath(requestedPath, resolvedPath)) {
    throw new ShowConfigUpgradeError(linkCode, message);
  }
  const resolvedStat = stat(fsApi, resolvedPath, missingCode, message);
  if (requireFile) assertRegularFileStat(resolvedStat, linkCode, message);
  else if (requireDirectory) assertRegularDirectoryStat(resolvedStat, linkCode, message);
  assertSameIdentity(pathStat, resolvedStat, linkCode, message);
  return {
    path: path.resolve(requestedPath),
    pathStat,
    resolvedPath,
    resolvedStat,
    identity: fileIdentity(pathStat, linkCode, message),
  };
}

function existingAncestor(fsApi, requestedPath) {
  let candidate = path.resolve(requestedPath);
  while (true) {
    try {
      return { path: candidate, stat: fsApi.lstatSync(candidate, { bigint: true }) };
    } catch (error) {
      if (error?.code !== "ENOENT") return null;
      const parent = path.dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
}

function assertOutsideCheckout(fsApi, requestedPath, { repositoryRoot, code, linkCode = code, message }) {
  let resolvedRepositoryRoot;
  try {
    resolvedRepositoryRoot = realpath(fsApi, repositoryRoot);
  } catch {
    throw new ShowConfigUpgradeError(code, message);
  }
  const lexicalPath = path.resolve(requestedPath);
  if (isWithin(resolvedRepositoryRoot, lexicalPath)) {
    throw new ShowConfigUpgradeError(code, message);
  }

  const ancestor = existingAncestor(fsApi, lexicalPath);
  if (!ancestor) {
    throw new ShowConfigUpgradeError(code, message);
  }
  assertNoLink(ancestor.stat, linkCode, message);
  let resolvedAncestor;
  try {
    resolvedAncestor = realpath(fsApi, ancestor.path);
  } catch {
    throw new ShowConfigUpgradeError(code, message);
  }
  if (isWithin(resolvedRepositoryRoot, resolvedAncestor)) {
    throw new ShowConfigUpgradeError(code, message);
  }
}

function assertExternalSource(sourcePath, { fsApi, repositoryRoot }) {
  if (typeof sourcePath !== "string" || sourcePath.length === 0 || sourcePath.trim() !== sourcePath || !path.isAbsolute(sourcePath)) {
    throw new ShowConfigUpgradeError("SOURCE_PATH_INVALID", "DJ_AGENT_CONFIG_PATH must be an absolute external path");
  }
  const message = "DJ_AGENT_CONFIG_PATH must be a regular non-link file";
  assertNoLinkAncestors(
    fsApi,
    sourcePath,
    "SOURCE_NOT_REGULAR",
    "DJ_AGENT_CONFIG_PATH must not pass through a link or reparse point",
  );
  assertOutsideCheckout(fsApi, sourcePath, {
    repositoryRoot,
    code: "SOURCE_CHECKOUT_LOCAL",
    message: "DJ_AGENT_CONFIG_PATH must be outside the checkout",
  });
  const evidence = capturePathEvidence(fsApi, sourcePath, {
    missingCode: "SOURCE_UNAVAILABLE",
    linkCode: "SOURCE_NOT_REGULAR",
    message,
    requireFile: true,
    rejectRedirect: true,
  });
  try {
    const resolvedRepositoryRoot = realpath(fsApi, repositoryRoot);
    if (isWithin(resolvedRepositoryRoot, evidence.resolvedPath)) {
      throw new ShowConfigUpgradeError("SOURCE_CHECKOUT_LOCAL", "DJ_AGENT_CONFIG_PATH must be outside the checkout");
    }
  } catch (error) {
    if (error instanceof ShowConfigUpgradeError) throw error;
    throw new ShowConfigUpgradeError("SOURCE_UNAVAILABLE", "DJ_AGENT_CONFIG_PATH could not be resolved");
  }
  return evidence;
}

function assertExternalTarget(targetPath, { fsApi, repositoryRoot, allowExisting = false }) {
  if (typeof targetPath !== "string" || targetPath.length === 0 || targetPath.trim() !== targetPath || !path.isAbsolute(targetPath)) {
    throw new ShowConfigUpgradeError("TARGET_PATH_INVALID", "upgrade target must be an absolute external path");
  }
  assertOutsideCheckout(fsApi, targetPath, {
    repositoryRoot,
    code: "TARGET_CHECKOUT_LOCAL",
    linkCode: "TARGET_REPARSE_PATH",
    message: "upgrade target must be outside the checkout",
  });

  if (!allowExisting) {
    try {
      const stat = fsApi.lstatSync(targetPath, { bigint: true });
      // A present target is never replaced, even when it is malformed or a
      // link. This also prevents a broken link from being followed by write.
      if (stat) throw new ShowConfigUpgradeError("TARGET_EXISTS", "refusing to overwrite the existing upgrade target");
    } catch (error) {
      if (error instanceof ShowConfigUpgradeError) throw error;
      if (error?.code !== "ENOENT") {
        throw new ShowConfigUpgradeError("TARGET_UNAVAILABLE", "upgrade target could not be inspected");
      }
    }
  }

  const parent = path.dirname(path.resolve(targetPath));
  assertOutsideCheckout(fsApi, parent, {
    repositoryRoot,
    code: "TARGET_REPARSE_PATH",
    message: "upgrade target parent must not contain a link or reparse point",
  });
  assertNoLinkAncestors(
    fsApi,
    parent,
    "TARGET_REPARSE_PATH",
    "upgrade target parent must not contain a link or reparse point",
  );
  let parentEvidence = null;
  try {
    fsApi.lstatSync(parent, { bigint: true });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new ShowConfigUpgradeError(
        "TARGET_REPARSE_PATH",
        "upgrade target parent must not contain a link or reparse point",
      );
    }
  }
  try {
    parentEvidence = capturePathEvidence(fsApi, parent, {
      missingCode: "TARGET_REPARSE_PATH",
      linkCode: "TARGET_REPARSE_PATH",
      message: "upgrade target parent must not contain a link or reparse point",
      requireDirectory: true,
      rejectRedirect: true,
    });
  } catch (error) {
    if (!(error instanceof ShowConfigUpgradeError) || error.code !== "TARGET_REPARSE_PATH") throw error;
    try {
      fsApi.lstatSync(parent, { bigint: true });
      throw error;
    } catch (recheckError) {
      if (recheckError?.code !== "ENOENT") throw error;
    }
  }
  return { path: path.resolve(targetPath), parent, parentEvidence };
}

function sourceOpenFlags(fsApi) {
  const constants = fsApi.constants || fs.constants;
  const readOnly = typeof constants.O_RDONLY === "number" ? constants.O_RDONLY : 0;
  // O_NOFOLLOW is available on POSIX. Node does not expose a corresponding
  // flag on Windows, so Windows relies on the post-open lstat/realpath and
  // identity checks below rather than claiming a guarantee Node cannot make.
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  return readOnly | noFollow;
}

function openSourceDescriptor(fsApi, sourcePath) {
  try {
    return fsApi.openSync(sourcePath, sourceOpenFlags(fsApi));
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENXIO") {
      throw new ShowConfigUpgradeError("SOURCE_NOT_REGULAR", "DJ_AGENT_CONFIG_PATH must be a regular non-link file");
    }
    throw new ShowConfigUpgradeError("SOURCE_UNAVAILABLE", "DJ_AGENT_CONFIG_PATH is unavailable");
  }
}

function readValidatedSource({ fsApi, sourcePath, repositoryRoot }) {
  if (typeof sourcePath !== "string" || sourcePath.length === 0 || sourcePath.trim() !== sourcePath || !path.isAbsolute(sourcePath)) {
    throw new ShowConfigUpgradeError("SOURCE_PATH_INVALID", "DJ_AGENT_CONFIG_PATH must be an absolute external path");
  }

  // Open first, then bind all path-side evidence to this descriptor. The
  // config bytes are read from this descriptor only; the path is never read
  // again after validation.
  const descriptor = openSourceDescriptor(fsApi, sourcePath);
  let failure = null;
  let closeFailure = null;
  let raw;
  try {
    let descriptorStat;
    try {
      descriptorStat = fsApi.fstatSync(descriptor, { bigint: true });
    } catch {
      throw new ShowConfigUpgradeError("SOURCE_NOT_REGULAR", "DJ_AGENT_CONFIG_PATH descriptor could not be inspected");
    }
    assertRegularFileStat(
      descriptorStat,
      "SOURCE_NOT_REGULAR",
      "DJ_AGENT_CONFIG_PATH must be a regular non-link file",
    );
    const pathEvidence = assertExternalSource(sourcePath, { fsApi, repositoryRoot });
    assertSameIdentity(
      descriptorStat,
      pathEvidence.pathStat,
      "SOURCE_CHANGED",
      "DJ_AGENT_CONFIG_PATH changed while it was being opened",
    );
    assertSameIdentity(
      descriptorStat,
      pathEvidence.resolvedStat,
      "SOURCE_CHANGED",
      "DJ_AGENT_CONFIG_PATH realpath does not identify the opened file",
    );
    try {
      raw = fsApi.readFileSync(descriptor, "utf8");
    } catch {
      throw new ShowConfigUpgradeError("SOURCE_READ_FAILED", "DJ_AGENT_CONFIG_PATH could not be read");
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      fsApi.closeSync(descriptor);
    } catch (error) {
      closeFailure = error;
    }
  }
  if (failure) throw failure;
  if (closeFailure) throw new ShowConfigUpgradeError("SOURCE_READ_FAILED", "DJ_AGENT_CONFIG_PATH could not be closed");
  return raw;
}

function readFile(fsApi, filePath, code, message) {
  try {
    return fsApi.readFileSync(filePath, "utf8");
  } catch {
    throw new ShowConfigUpgradeError(code, message);
  }
}

function assertRegularTemplate(fsApi, templatePath) {
  const stat = lstat(fsApi, templatePath, "TEMPLATE_UNAVAILABLE", "bundled v1.1.11 show config template is unavailable");
  assertNoLink(stat, "TEMPLATE_NOT_REGULAR", "bundled show config template must be a regular non-link file");
  if (!stat || typeof stat.isFile !== "function" || !stat.isFile()) {
    throw new ShowConfigUpgradeError("TEMPLATE_NOT_REGULAR", "bundled show config template must be a regular non-link file");
  }
  assertNoLinkAncestors(
    fsApi,
    templatePath,
    "TEMPLATE_NOT_REGULAR",
    "bundled show config template must not pass through a link or reparse point",
  );
}

function validateTokenFreeTemplate(raw) {
  const template = parseJson(raw, "TEMPLATE_INVALID_JSON");
  if (
    template.syndocal?.token !== TOKEN_PLACEHOLDER ||
    !validateStrictShowConfig({ ...template, syndocal: { ...template.syndocal, token: "0123456789abcdef0123456789abcdef" } }, CURRENT_VERSION)
  ) {
    throw new ShowConfigUpgradeError(
      "TEMPLATE_CONTRACT_MISMATCH",
      "bundled v1.1.11 show config template is not the exact token-free contract",
    );
  }
  return { raw, template };
}

function buildCurrentConfig(templateRaw, token) {
  const placeholderLiteral = JSON.stringify(TOKEN_PLACEHOLDER);
  const tokenLiteral = JSON.stringify(token);
  const occurrences = templateRaw.split(placeholderLiteral).length - 1;
  if (occurrences !== 1) {
    throw new ShowConfigUpgradeError("TEMPLATE_CONTRACT_MISMATCH", "bundled show config template has an invalid token field");
  }
  const output = templateRaw.split(placeholderLiteral).join(tokenLiteral);
  const config = parseJson(output, "TARGET_CONTRACT_MISMATCH");
  if (!validateStrictShowConfig(config, CURRENT_VERSION)) {
    throw new ShowConfigUpgradeError("TARGET_CONTRACT_MISMATCH", "generated v1.1.11 show config failed strict validation");
  }
  return output;
}

function targetEvidence(fsApi, targetPath) {
  const message = "created upgrade target must be a regular non-link file";
  const pathStat = lstat(fsApi, targetPath, "TARGET_WRITE_FAILED", message);
  assertRegularFileStat(pathStat, "TARGET_WRITE_FAILED", message);
  let resolvedPath;
  try {
    resolvedPath = realpath(fsApi, targetPath);
  } catch {
    throw new ShowConfigUpgradeError("TARGET_WRITE_FAILED", "created upgrade target could not be resolved");
  }
  if (!samePath(targetPath, resolvedPath)) {
    throw new ShowConfigUpgradeError("TARGET_WRITE_FAILED", "created upgrade target path was redirected");
  }
  const resolvedStat = stat(fsApi, resolvedPath, "TARGET_WRITE_FAILED", message);
  assertRegularFileStat(resolvedStat, "TARGET_WRITE_FAILED", message);
  assertSameIdentity(pathStat, resolvedStat, "TARGET_WRITE_FAILED", message);
  return {
    pathStat,
    resolvedPath,
    resolvedStat,
    identity: fileIdentity(pathStat, "TARGET_WRITE_FAILED", message),
  };
}

function verifyCreatedTarget(fsApi, targetPath, targetPlan, repositoryRoot, descriptor) {
  const message = "created upgrade target must be a regular non-link file";
  let descriptorStat;
  try {
    descriptorStat = fsApi.fstatSync(descriptor, { bigint: true });
  } catch {
    throw new ShowConfigUpgradeError("TARGET_WRITE_FAILED", "created upgrade target descriptor could not be inspected");
  }
  assertRegularFileStat(descriptorStat, "TARGET_WRITE_FAILED", message);
  const evidence = targetEvidence(fsApi, targetPath);
  assertSameIdentity(descriptorStat, evidence.pathStat, "TARGET_WRITE_FAILED", message);
  assertSameIdentity(descriptorStat, evidence.resolvedStat, "TARGET_WRITE_FAILED", message);

  // Re-run all target/ancestor checks after wx creation. This catches a
  // parent redirect or target replacement before any token-bearing bytes are
  // sent to the descriptor. The parent identity is also bound to the plan
  // captured immediately before openSync.
  const currentPlan = assertExternalTarget(targetPath, { fsApi, repositoryRoot, allowExisting: true });
  if (!targetPlan?.parentEvidence || !currentPlan.parentEvidence) {
    throw new ShowConfigUpgradeError("TARGET_REPARSE_PATH", "upgrade target parent could not be rebound safely");
  }
  if (!samePath(targetPlan.parentEvidence.resolvedPath, currentPlan.parentEvidence.resolvedPath)) {
    throw new ShowConfigUpgradeError("TARGET_REPARSE_PATH", "upgrade target parent changed while it was being opened");
  }
  assertSameIdentity(
    targetPlan.parentEvidence.pathStat,
    currentPlan.parentEvidence.pathStat,
    "TARGET_REPARSE_PATH",
    "upgrade target parent changed while it was being opened",
  );
  assertSameIdentity(
    targetPlan.parentEvidence.resolvedStat,
    currentPlan.parentEvidence.resolvedStat,
    "TARGET_REPARSE_PATH",
    "upgrade target parent realpath changed while it was being opened",
  );
  return fileIdentity(descriptorStat, "TARGET_WRITE_FAILED", message);
}

function scrubDescriptor(fsApi, descriptor) {
  try {
    if (typeof fsApi.ftruncateSync !== "function") return false;
    fsApi.ftruncateSync(descriptor, 0);
    if (typeof fsApi.fsyncSync === "function") fsApi.fsyncSync(descriptor);
    return true;
  } catch {
    return false;
  }
}

function removeCreatedTarget(fsApi, targetPath, expectedIdentity) {
  if (!expectedIdentity || typeof fsApi.unlinkSync !== "function") return false;
  try {
    const evidence = targetEvidence(fsApi, targetPath);
    if (evidence.identity !== expectedIdentity) return false;
    fsApi.unlinkSync(targetPath);
    return true;
  } catch {
    // Refuse to unlink an unverified path. Verification failures happen
    // before token write, so leaving an empty artifact is safer than deleting
    // an attacker-controlled replacement.
    return false;
  }
}

function secureWriterFrame(targetPath, output, targetPlan) {
  const evidence = targetPlan?.parentEvidence;
  if (!evidence || typeof evidence.path !== "string" || typeof evidence.resolvedPath !== "string") {
    throw new ShowConfigUpgradeError("TARGET_REPARSE_PATH", "upgrade target parent could not be rebound safely");
  }
  const parentIdentity = fileIdentity(
    evidence.pathStat,
    "TARGET_REPARSE_PATH",
    "upgrade target parent identity could not be established",
  );
  const parentResolvedIdentity = fileIdentity(
    evidence.resolvedStat,
    "TARGET_REPARSE_PATH",
    "upgrade target parent identity could not be established",
  );
  if (
    evidence.identity !== parentIdentity ||
    evidence.identity !== parentResolvedIdentity ||
    !samePath(evidence.path, evidence.resolvedPath) ||
    !samePath(path.dirname(path.resolve(targetPath)), evidence.path)
  ) {
    throw new ShowConfigUpgradeError("TARGET_REPARSE_PATH", "upgrade target parent evidence is inconsistent");
  }
  return {
    targetPath: path.resolve(targetPath),
    parentPath: path.resolve(evidence.path),
    parentResolvedPath: path.resolve(evidence.resolvedPath),
    parentIdentity,
    parentResolvedIdentity,
    payload: output,
  };
}

function encodeSecureWriterFrame(targetPath, output, targetPlan) {
  const frame = Buffer.from(JSON.stringify(secureWriterFrame(targetPath, output, targetPlan)), "utf8");
  return frame.toString("base64");
}

const SECURE_WRITER_RESULT_PREFIX = "RB_OUTPUT_SECURE_WRITER_RESULT=";
const SECURE_WRITER_RESULT_CODES = Object.freeze(new Set([
  "OK",
  "FRAME_INVALID",
  "PARENT_PATH_INVALID",
  "PARENT_INSPECTION_FAILED",
  "PARENT_ACL_UNSAFE",
  "PARENT_OPEN_FAILED",
  "PARENT_INFO_FAILED",
  "PARENT_IDENTITY_FAILED",
  "PARENT_IDENTITY_MISMATCH",
  "TARGET_CREATE_FAILED",
  "TARGET_IDENTITY_FAILED",
  "TARGET_WRITE_FAILED",
  "TARGET_FLUSH_FAILED",
  "SECURE_WRITER_FAILED",
  "PROCESS_SPAWN_FAILED",
  "NO_RESULT",
]));

function secureWriterResultCode(result) {
  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  const match = stdout.match(
    new RegExp(`(?:^|\\r?\\n)${SECURE_WRITER_RESULT_PREFIX}([A-Z0-9_]+)(?:\\r?$|\\r?\\n)`),
  );
  if (match && SECURE_WRITER_RESULT_CODES.has(match[1])) return match[1];
  return result?.error ? "PROCESS_SPAWN_FAILED" : "NO_RESULT";
}

function writeSecureWindowsTarget(targetPath, output, targetPlan) {
  if (typeof childProcess.spawnSync !== "function") {
    throw new ShowConfigUpgradeError("TARGET_WRITE_FAILED", "secure Windows target writer is unavailable");
  }
  let result;
  try {
    result = childProcess.spawnSync(
      WINDOWS_POWERSHELL_PATH,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_SECURE_WRITER_SCRIPT],
      {
        input: encodeSecureWriterFrame(targetPath, output, targetPlan),
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch {
    throw new ShowConfigUpgradeError("TARGET_WRITE_FAILED", "upgrade target could not be created (writer reason: PROCESS_SPAWN_FAILED)");
  }
  // The helper never receives a token on its command line. It emits only a
  // fixed result code on stdout; stderr remains deliberately discarded so
  // failure diagnostics cannot log config or token-bearing exception text.
  const reason = secureWriterResultCode(result);
  if (result?.error || result?.status !== 0 || reason !== "OK") {
    throw new ShowConfigUpgradeError("TARGET_WRITE_FAILED", `upgrade target could not be created (writer reason: ${reason})`);
  }
}

function writeExclusive(fsApi, targetPath, output, { targetPlan, repositoryRoot, secureWriter = writeSecureWindowsTarget } = {}) {
  // Node's Windows fs.openSync cannot request FILE_SHARE_NONE. Keep the
  // descriptor-bound injectable path for race tests, but use the pinned
  // .NET writer for the real Windows fs so rename/delete cannot happen in the
  // verify-to-write window.
  if (process.platform === "win32" && fsApi === fs) {
    secureWriter(targetPath, output, targetPlan);
    return;
  }

  let descriptor;
  let created = false;
  let targetIdentity = null;
  let failure = null;
  let closeFailure = null;
  let writeStarted = false;

  try {
    descriptor = fsApi.openSync(targetPath, "wx", 0o600);
    created = true;
    try {
      let createdStat;
      try {
        createdStat = fsApi.fstatSync(descriptor, { bigint: true });
      } catch {
        throw new ShowConfigUpgradeError("TARGET_WRITE_FAILED", "created upgrade target descriptor could not be inspected");
      }
      assertRegularFileStat(
        createdStat,
        "TARGET_WRITE_FAILED",
        "created upgrade target must be a regular non-link file",
      );
      targetIdentity = fileIdentity(
        createdStat,
        "TARGET_WRITE_FAILED",
        "created upgrade target identity could not be established",
      );
      targetIdentity = verifyCreatedTarget(fsApi, targetPath, targetPlan, repositoryRoot, descriptor);
    } catch (error) {
      failure = error;
    }
    if (!failure) {
      if (typeof fsApi.fsyncSync !== "function") {
        failure = new ShowConfigUpgradeError("TARGET_SYNC_UNAVAILABLE", "upgrade target cannot be durably synchronized");
      } else {
        // Do not write the token until descriptor/path/ancestor identity has
        // been checked. writeStarted lets failure handling scrub partial data
        // through the same descriptor before attempting path cleanup.
        writeStarted = true;
        try {
          fsApi.writeFileSync(descriptor, output, "utf8");
          fsApi.fsyncSync(descriptor);
        } catch (error) {
          failure = error;
        }
      }
    }
  } catch (error) {
    failure = error;
  }

  if (failure && writeStarted && descriptor !== undefined) scrubDescriptor(fsApi, descriptor);
  if (descriptor !== undefined) {
    try {
      fsApi.closeSync(descriptor);
    } catch (error) {
      closeFailure = error;
    }
  }
  if (closeFailure) {
    if (!failure) failure = closeFailure;
    if (writeStarted && descriptor !== undefined) {
      scrubDescriptor(fsApi, descriptor);
      try {
        fsApi.closeSync(descriptor);
      } catch {
        // Cleanup below remains best-effort and identity-bound.
      }
    }
  }

  if (failure) {
    if (created) removeCreatedTarget(fsApi, targetPath, targetIdentity);
    if (failure instanceof ShowConfigUpgradeError) throw failure;
    if (failure?.code === "EEXIST") {
      throw new ShowConfigUpgradeError("TARGET_EXISTS", "refusing to overwrite the existing upgrade target");
    }
    throw new ShowConfigUpgradeError("TARGET_WRITE_FAILED", "upgrade target could not be created");
  }
  if (!created) throw new ShowConfigUpgradeError("TARGET_WRITE_FAILED", "upgrade target could not be created");
}

function upgradeShowConfig({
  env = process.env,
  sourcePath = env && Object.hasOwn(env, "DJ_AGENT_CONFIG_PATH") ? env.DJ_AGENT_CONFIG_PATH : undefined,
  targetPath = TARGET_PATH,
  templatePath = TEMPLATE_PATH,
  repositoryRoot = PROJECT_ROOT,
  fsApi = fs,
  secureWriter = writeSecureWindowsTarget,
} = {}) {
  assertNoForbiddenEnvironment(env);
  const sourceRaw = readValidatedSource({ fsApi, sourcePath, repositoryRoot });
  const predecessor = parseJson(sourceRaw, "SOURCE_INVALID_JSON");
  if (!validateStrictShowConfig(predecessor, PREDECESSOR_VERSION)) {
    throw new ShowConfigUpgradeError(
      "SOURCE_NOT_KNOWN_PREDECESSOR",
      "DJ_AGENT_CONFIG_PATH must be the exact known v1.1.10 predecessor",
    );
  }
  assertRegularTemplate(fsApi, templatePath);
  const templateRaw = readFile(fsApi, templatePath, "TEMPLATE_UNAVAILABLE", "bundled v1.1.11 show config template is unavailable");
  validateTokenFreeTemplate(templateRaw);
  const output = buildCurrentConfig(templateRaw, predecessor.syndocal.token);
  const initialTargetPlan = assertExternalTarget(targetPath, { fsApi, repositoryRoot });
  const target = initialTargetPlan.path;
  const targetParent = path.dirname(target);
  try {
    fsApi.mkdirSync(targetParent, { recursive: true });
  } catch {
    throw new ShowConfigUpgradeError("TARGET_DIRECTORY_UNAVAILABLE", "upgrade target parent is unavailable");
  }
  // Recheck after recursive creation: a race or a reparse-point parent must
  // never turn an external-looking path into a write through another tree.
  const targetPlan = assertExternalTarget(target, { fsApi, repositoryRoot, allowExisting: true });
  writeExclusive(fsApi, target, output, { targetPlan, repositoryRoot, secureWriter });
  return { targetPath: target };
}

function main() {
  if (process.argv.length !== 2) {
    console.error("[ERROR] upgrade-show-config accepts no arguments.");
    process.exitCode = 64;
    return;
  }
  if (process.platform !== "win32") {
    console.error("[ERROR] upgrade-show-config is supported only on the controlled Windows DJ PC.");
    process.exitCode = 1;
    return;
  }
  try {
    const { targetPath } = upgradeShowConfig();
    console.log(`[rb-output] created current v${CURRENT_VERSION} show config: ${targetPath}`);
    console.log("[rb-output] The predecessor file was left unchanged; no token or config content was printed.");
  } catch (error) {
    if (error instanceof ShowConfigUpgradeError) {
      console.error(`[ERROR] ${error.message}`);
      process.exitCode = error.code === "TARGET_EXISTS" ? 17 : 1;
      return;
    }
    console.error("[ERROR] show config upgrade failed closed.");
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  CURRENT_VERSION,
  FORBIDDEN_ENV_KEYS,
  PREDECESSOR_REMOVAL_MILESTONE,
  PREDECESSOR_VERSION,
  PROJECT_ROOT,
  TARGET_PATH,
  TEMPLATE_PATH,
  TOKEN_PLACEHOLDER,
  WINDOWS_POWERSHELL_PATH,
  WINDOWS_SECURE_WRITER_SCRIPT,
  SECURE_WRITER_RESULT_PREFIX,
  WINDOWS_TARGET_ACL_BOUNDARY,
  ShowConfigUpgradeError,
  buildCurrentConfig,
  isWithin,
  assertNoForbiddenEnvironment,
  encodeSecureWriterFrame,
  secureWriterResultCode,
  parseJson,
  upgradeShowConfig,
  validateStrictShowConfig,
  validateTokenFreeTemplate,
  writeSecureWindowsTarget,
};
