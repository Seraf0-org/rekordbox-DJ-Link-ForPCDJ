"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO_ROOT = path.join(__dirname, "..");
const BUILDER_PATH = path.join(REPO_ROOT, "scripts", "build-ableton-link.ps1");
const MANIFEST_PATH = path.join(
  REPO_ROOT,
  "patches",
  "ableton-link-source",
  "source-manifest.json",
);
const PATCHED_REFERENCE_PATH = path.join(
  REPO_ROOT,
  "patches",
  "ableton-link-source",
  "binding.gyp.patched",
);
const HEADERS_MANIFEST_PATH = path.join(
  REPO_ROOT,
  "patches",
  "ableton-link-source",
  "node-headers-manifest.json",
);
const INSTALLED_PACKAGE_DIR = path.join(
  REPO_ROOT,
  "node_modules",
  "@ktamas77",
  "abletonlink",
);
const OFFICIAL_NODE_LIB_SHA =
  "0d8d8bcc11daea60f5dd4da414e72ccb785718345ec8fbec52cfc7d1a2326293";
const OFFICIAL_HEADERS_GZ_SHA =
  "0f76c31ce76a623a6a3a4038cb62eae281b2e33ad189dcf2d514ec32ae74d9b2";
const OFFICIAL_HEADERS_XZ_SHA =
  "3f435f2ac1ab363f8220f4beb60c7493a3f680918a7426ff83b7d4c6e1d314fa";
const REAL_HEADERS_CACHE_ROOT = path.join(
  process.env.LOCALAPPDATA || "",
  "node-gyp",
  "Cache",
  "22.22.1",
);

const FIXTURE_BASE = "C:\\TEMP\\opencode\\oxalpha-al-fixture";
const LICENSE_ARGS = ["-LinkLicenseMode", "GPL-2.0-or-later"];

let RUN_UNIQUE = `${Date.now()}-${process.pid}`;
let CREATED_PATHS = [];

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function freshDir(label) {
  const dir = path.join(FIXTURE_BASE, `${label}-${RUN_UNIQUE}`);
  fs.mkdirSync(dir, { recursive: true });
  CREATED_PATHS.push(dir);
  return dir;
}

function runBuilder(args, options = {}) {
  const spawnArgs = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    BUILDER_PATH,
    ...args,
  ];
  const spawnOptions = {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
    timeout: options.timeout || 300000,
    maxBuffer: 64 * 1024 * 1024,
  };
  if (options.env) {
    spawnOptions.env = { ...process.env, ...options.env };
  }
  return spawnSync("powershell.exe", spawnArgs, spawnOptions);
}

function outputOf(result) {
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function assertFailedWith(result, pattern, label) {
  const output = outputOf(result);
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded:\n${output}`);
  assert.match(output, pattern, `${label} failure output missing expectation:\n${output}`);
}

// ---------------------------------------------------------------------------
// Synthetic PE fixtures
// ---------------------------------------------------------------------------
function alignUp(value, alignment) {
  return Math.ceil(value / alignment) * alignment;
}

function buildSyntheticPe({ machine = 0x8664, isDll = true, imports = [], delays = [] } = {}) {
  const sectionVa = 0x1000;
  const sectionRaw = 0x400;

  const blobs = [];
  let cursor = 0;
  function place(bytes) {
    const rva = sectionVa + cursor;
    const offset = sectionRaw + cursor;
    blobs.push({ offset, bytes });
    cursor += bytes.length;
    return rva;
  }

  // Import directory table (one 20-byte descriptor per import + terminator).
  const nameBlobs = [];
  for (const name of imports) {
    nameBlobs.push(Buffer.from(`${name}\0`, "ascii"));
  }
  const hintNameBlobs = [];
  for (const name of imports) {
    hintNameBlobs.push(Buffer.concat([Buffer.from([0, 0]), Buffer.from(`${name}\0`, "ascii")]));
  }

  const idtSize = (imports.length + 1) * 20;
  const idtCursor = cursor;
  cursor += idtSize;

  const nameOffsets = [];
  for (const blob of nameBlobs) {
    nameOffsets.push(place(blob));
  }
  const hintNameOffsets = [];
  for (const blob of hintNameBlobs) {
    hintNameOffsets.push(place(blob));
  }
  // Thunk arrays (8-byte thunks; only the Hint/Name RVA matters to readers).
  const thunkArrays = [];
  for (let i = 0; i < imports.length; i++) {
    const thunk = Buffer.alloc(16);
    thunk.writeUInt32LE(hintNameOffsets[i], 0);
    thunkArrays.push(place(thunk));
  }

  const idt = Buffer.alloc(idtSize);
  for (let i = 0; i < imports.length; i++) {
    const base = i * 20;
    idt.writeUInt32LE(thunkArrays[i], base); // OriginalFirstThunk
    idt.writeUInt32LE(nameOffsets[i], base + 12); // Name RVA
    idt.writeUInt32LE(thunkArrays[i], base + 16); // FirstThunk
  }
  blobs.push({ offset: sectionRaw + idtCursor, bytes: idt });

  // Delay-load descriptors (32 bytes each + terminator), RVA form.
  const delayNameOffsets = [];
  for (const name of delays) {
    delayNameOffsets.push(place(Buffer.from(`${name}\0`, "ascii")));
  }
  const ddtSize = (delays.length + 1) * 32;
  const ddtCursor = cursor;
  const ddt = Buffer.alloc(ddtSize);
  for (let i = 0; i < delays.length; i++) {
    const base = i * 32;
    ddt.writeUInt32LE(1, base); // grAttrs: dlattrRva
    ddt.writeUInt32LE(delayNameOffsets[i], base + 4); // szName
  }
  blobs.push({ offset: sectionRaw + ddtCursor, bytes: ddt });

  const rawSize = alignUp(Math.max(cursor, 1), 0x200);
  const buffer = Buffer.alloc(sectionRaw + rawSize + 0x400);

  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(0x80, 0x3c);
  const pe = 0x80;
  buffer.write("PE\0\0", pe, "ascii");
  buffer.writeUInt16LE(machine, pe + 4);
  buffer.writeUInt16LE(1, pe + 6); // NumberOfSections
  buffer.writeUInt16LE(0xf0, pe + 20); // SizeOfOptionalHeader
  buffer.writeUInt16LE(isDll ? 0x2100 : 0x0100, pe + 22); // Characteristics

  const opt = pe + 24;
  buffer.writeUInt16LE(0x20b, opt); // PE32+
  buffer.writeUInt32LE(rawSize + sectionRaw, opt + 56); // SizeOfImage-ish
  buffer.writeUInt32LE(sectionRaw, opt + 60); // SizeOfHeaders
  buffer.writeUInt16LE(3, opt + 68); // Subsystem console
  buffer.writeUInt16LE(0x160, opt + 70); // DllCharacteristics
  buffer.writeUInt32LE(16, opt + 108); // NumberOfRvaAndSizes
  const dirs = opt + 112;
  if (imports.length > 0) {
    buffer.writeUInt32LE(sectionVa + idtCursor, dirs + 8); // dir[1].VirtualAddress
    buffer.writeUInt32LE(idtSize, dirs + 12); // dir[1].Size
  }
  if (delays.length > 0) {
    buffer.writeUInt32LE(sectionVa + ddtCursor, dirs + 13 * 8); // dir[13]
    buffer.writeUInt32LE(ddtSize, dirs + 13 * 8 + 4);
  }

  const sectionTable = opt + 0xf0;
  buffer.write(".idata", sectionTable, "ascii");
  buffer.writeUInt32LE(rawSize, sectionTable + 8); // VirtualSize
  buffer.writeUInt32LE(sectionVa, sectionTable + 12); // VirtualAddress
  buffer.writeUInt32LE(rawSize, sectionTable + 16); // SizeOfRawData
  buffer.writeUInt32LE(sectionRaw, sectionTable + 20); // PointerToRawData
  buffer.writeUInt32LE(0xc0000040, sectionTable + 36); // Characteristics

  for (const blob of blobs) {
    blob.bytes.copy(buffer, blob.offset);
  }
  return buffer;
}

function writePeFixture(filePath, options) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buildSyntheticPe(options));
  return filePath;
}

// ---------------------------------------------------------------------------
// Minimal source-package fixture mirroring the reviewed compile surface
// ---------------------------------------------------------------------------
function makeMiniPackage(packageDir) {
  const dirs = [
    "src",
    "link/include/ableton",
    "link/modules/asio-standalone/asio/include",
    "node_modules/node-addon-api",
  ];
  for (const rel of dirs) {
    fs.mkdirSync(path.join(packageDir, rel), { recursive: true });
  }
  fs.writeFileSync(
    path.join(packageDir, "binding.gyp"),
    fs.readFileSync(path.join(INSTALLED_PACKAGE_DIR, "binding.gyp")),
  );
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "@ktamas77/abletonlink",
      version: "1.2.3",
      license: "MIT",
    }),
  );
  fs.writeFileSync(path.join(packageDir, "src", "abletonlink.cc"), "// stub\n");
  fs.writeFileSync(path.join(packageDir, "src", "abletonlink.h"), "#pragma once\n");
  fs.writeFileSync(
    path.join(packageDir, "link", "include", "ableton", "Stub.hpp"),
    "#pragma once\n",
  );
  fs.writeFileSync(
    path.join(packageDir, "link", "modules", "asio-standalone", "asio", "include", "stub.hpp"),
    "#pragma once\n",
  );
  fs.writeFileSync(
    path.join(packageDir, "node_modules", "node-addon-api", "index.js"),
    "module.exports = { include: 'stub-include', gyp: 'node_addon_api.gyp' };\n",
  );
  fs.writeFileSync(
    path.join(packageDir, "node_modules", "node-addon-api", "package.json"),
    JSON.stringify({ name: "node-addon-api", version: "0.0.0-fixture" }),
  );
  fs.writeFileSync(
    path.join(packageDir, "node_modules", "node-addon-api", "node_addon_api.gyp"),
    "{ 'targets': [] }\n",
  );
  fs.writeFileSync(
    path.join(packageDir, "node_modules", "node-addon-api", "nothing.c"),
    "",
  );
  return packageDir;
}

function freshRepoStagingDir(label) {
  const dir = path.join(
    REPO_ROOT,
    "node_modules",
    ".cache",
    `rb-output-al-${label}-${RUN_UNIQUE}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  CREATED_PATHS.push(dir);
  return dir;
}

function prereqFixtureArgs({ fixtureRoot, manifestPath, stagingLabel }) {
  const args = [
    "-ValidatePrerequisitesOnly",
    ...LICENSE_ARGS,
    "-SourcePackageDir",
    fixtureRoot,
    "-SourceManifestPath",
    manifestPath,
    "-StagingRoot",
    freshRepoStagingDir(stagingLabel || "stage"),
  ];
  return args;
}

// ---------------------------------------------------------------------------
// Direct-function harness (dot-sources the builder with Main suppressed)
// ---------------------------------------------------------------------------
function psSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPsHarness(body) {
  const command = `$env:ALB_DOTSOURCE='1'; . ${psSingleQuoted(BUILDER_PATH)}; ${body}`;
  return spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      windowsHide: true,
      timeout: 240000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

function harnessHeadersCheck(cacheDir, manifestPath, expectedNodeLibSha) {
  const extra = expectedNodeLibSha
    ? ` -ExpectedNodeLibSha ${psSingleQuoted(expectedNodeLibSha)}`
    : "";
  return runPsHarness(
    `try { ` +
      `$m = Read-NodeHeadersManifest -Path ${psSingleQuoted(manifestPath)}; ` +
      `$p = Assert-NodeHeadersSurface -CacheRoot ${psSingleQuoted(cacheDir)} -Manifest $m${extra}; ` +
      `Write-Output ("OK files=" + $p.FileCount + " lib=" + $p.NodeLibSha256); exit 0 ` +
    `} catch { Write-Output ("THROW: " + $_.Exception.Message); exit 41 }`,
  );
}

function harnessManifestRead(manifestPath) {
  return runPsHarness(
    `try { $null = Read-NodeHeadersManifest -Path ${psSingleQuoted(manifestPath)}; Write-Output "OK"; exit 0 } ` +
      `catch { Write-Output ("THROW: " + $_.Exception.Message); exit 41 }`,
  );
}

function harnessGeneratedProject(stageDir, expectedLib) {
  return runPsHarness(
    `try { Assert-GeneratedProject -StagingSrc ${psSingleQuoted(stageDir)} -ExpectedNodeLib ${psSingleQuoted(expectedLib)}; Write-Output "OK"; exit 0 } ` +
      `catch { Write-Output ("THROW: " + $_.Exception.Message); exit 41 }`,
  );
}

function assertHarnessFailed(result, pattern, label) {
  const output = outputOf(result);
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded:\n${output}`);
  assert.match(output, pattern, `${label} failure output missing expectation:\n${output}`);
}

function makeHeadersFixtureCache(cacheDir) {
  const headersDir = path.join(cacheDir, "include", "node");
  fs.mkdirSync(path.join(headersDir, "uv"), { recursive: true });
  fs.mkdirSync(path.join(cacheDir, "x64"), { recursive: true });
  fs.writeFileSync(path.join(headersDir, "node.h"), "// node header\n");
  fs.writeFileSync(path.join(headersDir, "common.gypi"), "# gypi\n");
  fs.writeFileSync(path.join(headersDir, "uv", "uv.h"), "// uv header\n");
  const libBytes = Buffer.from("FAKE-WIN-X64-NODE-LIB-BYTES");
  fs.writeFileSync(path.join(cacheDir, "x64", "node.lib"), libBytes);
  return {
    files: [
      { path: "include/node/common.gypi", size: 7, sha256: sha256(Buffer.from("# gypi\n")) },
      { path: "include/node/node.h", size: 15, sha256: sha256(Buffer.from("// node header\n")) },
      { path: "include/node/uv/uv.h", size: 13, sha256: sha256(Buffer.from("// uv header\n")) },
    ],
    nodeLib: { path: "x64/node.lib", size: libBytes.length, sha256: sha256(libBytes) },
  };
}

function writeHeadersFixtureManifest(filePath, { files, nodeLib, meta }) {
  const manifest = {
    schema: "rb-output.ableton-link.node-headers-manifest/1",
    meta: {
      nodeVersion: "22.22.1",
      arch: "x64",
      sourceArchiveName: "node-v22.22.1-headers.tar.gz",
      sourceArchiveSha256: OFFICIAL_HEADERS_GZ_SHA,
      altSourceArchiveSha256: OFFICIAL_HEADERS_XZ_SHA,
      ...meta,
    },
    headersDir: "include/node",
    nodeLib,
    fileCount: files.length,
    files,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2));
  return filePath;
}

function makeVcxproj(stageDir, depsValue) {
  const buildDir = path.join(stageDir, "build");
  fs.mkdirSync(buildDir, { recursive: true });
  const content = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">',
    '  <ProjectConfiguration Include="Release|x64" />',
    "  <Link>",
    `    <AdditionalDependencies>${depsValue}</AdditionalDependencies>`,
    "  </Link>",
    "</Project>",
    "",
  ].join("\r\n");
  const vcxprojPath = path.join(buildDir, "abletonlink.vcxproj");
  fs.writeFileSync(vcxprojPath, content);
  return vcxprojPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
test("builder refuses to run without an explicit GPL-2.0-or-later acknowledgment", () => {
  const result = runBuilder(["-ValidatePrerequisitesOnly"], { timeout: 60000 });
  assertFailedWith(result, /GPL-2\.0-or-later/, "missing license mode");
});

test("wrong license mode values are rejected fail-closed", () => {
  const result = runBuilder(["-LinkLicenseMode", "proprietary", "-ValidatePrerequisitesOnly"], {
    timeout: 60000,
  });
  assertFailedWith(result, /unsupported license mode/, "wrong license mode");
});

test("prerequisites-only validates the pinned toolchain, sources, patch, and generated project", () => {
  const staging = freshRepoStagingDir("prereq-ok-stage");
  const result = runBuilder(
    ["-ValidatePrerequisitesOnly", ...LICENSE_ARGS, "-StagingRoot", staging],
    { timeout: 420000 },
  );
  const output = outputOf(result);
  assert.equal(result.status, 0, `prerequisites-only failed:\n${output}`);
  assert.match(output, /lockfile verified/);
  assert.match(output, /binding\.gyp patched and verified/);
  assert.match(output, /generated project inspection passed/);
  assert.match(output, /sanitized PATH proof: link resolves to pinned MSVC linker/);
  assert.match(output, /node headers cache proven against the tracked manifest/);

  const toolchain = JSON.parse(
    fs.readFileSync(path.join(staging, "toolchain.json"), "utf8"),
  );
  assert.equal(toolchain.nodeVersion, "v22.22.1");
  assert.equal(toolchain.nodeArch, "x64");
  assert.ok(toolchain.napiLevel >= 10);
  assert.equal(toolchain.nodeGypVersion, "12.4.0");
  assert.ok(toolchain.headersVerifiedFileCount >= 2700);
  assert.equal(toolchain.nodeLibSha256, OFFICIAL_NODE_LIB_SHA);
  assert.match(toolchain.sanitizedResolvedLink, /[\\/]Hostx64[\\/]x64[\\/]link\.exe$/i);
  for (const entry of toolchain.sanitizedPath) {
    assert.doesNotMatch(entry, /(^|[\\/])git([\\/]|$)/i);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const stagedPatched = fs.readFileSync(
    path.join(staging, "src-pkg", "binding.gyp"),
  );
  assert.equal(sha256(stagedPatched), manifest.patch.expectedPatchedSha256);
  assert.equal(
    sha256(fs.readFileSync(PATCHED_REFERENCE_PATH)),
    manifest.patch.expectedPatchedSha256,
  );
  const patchedText = stagedPatched.toString("utf8");
  assert.doesNotMatch(patchedText, /^      "cflags_cc": \[ "-std=c\+\+14" \],/m); // global flag removed
  assert.match(patchedText, /"cflags_cc": \[ "-std=c\+\+14", "-pthread" \]/); // linux condition retained
  assert.equal((patchedText.match(/LINK_PLATFORM_MACOSX=1/g) || []).length, 1); // mac condition only
  assert.doesNotMatch(patchedText, /"NAPI_DISABLE_CPP_EXCEPTIONS",\s*"LINK_PLATFORM_MACOSX=1"/);
  assert.match(patchedText, /LINK_PLATFORM_WINDOWS=1/);
  assert.match(patchedText, /LINK_PLATFORM_LINUX=1/);
  assert.doesNotMatch(patchedText, /AdditionalOptions/);
  assert.match(patchedText, /"ExceptionHandling": 1\n/);
});

test("spoofed ProgramFiles-like environment roots cannot influence trusted derivation", () => {
  const poison = freshDir("poison-env");
  const poisonPf = path.join(poison, "Program Files");
  const poisonPfX86 = path.join(poison, "Program Files (x86)");
  const poisonGitUsrBin = path.join(poison, "Git", "usr", "bin");
  fs.mkdirSync(poisonPf, { recursive: true });
  fs.mkdirSync(path.join(poisonPfX86, "Microsoft Visual Studio", "Installer"), { recursive: true });
  fs.mkdirSync(poisonGitUsrBin, { recursive: true });
  fs.writeFileSync(
    path.join(poisonPfX86, "Microsoft Visual Studio", "Installer", "vswhere.exe"),
    "fake vswhere",
  );
  fs.writeFileSync(path.join(poisonPf, "attacker-vs.txt"), "attacker");
  fs.writeFileSync(path.join(poisonGitUsrBin, "link.exe"), "malicious linker");

  const dumpPath = path.join(freshDir("spoof-dump"), "toolchain.json");
  const result = runBuilder(["-WriteToolchainJson", dumpPath], {
    timeout: 120000,
    env: {
      ProgramFiles: poisonPf,
      "ProgramFiles(x86)": poisonPfX86,
      ProgramW6432: poisonPf,
      CommonProgramFiles: poisonPf,
      "CommonProgramFiles(x86)": poisonPfX86,
      NODE_OPTIONS: "--require=payload.js",
      npm_config_node_gyp: "C:\\attacker\\node-gyp.js",
      PATH: `${poisonGitUsrBin};${process.env.PATH}`,
    },
  });
  const output = outputOf(result);
  assert.equal(result.status, 0, `spoofed-env toolchain dump failed:\n${output}`);

  const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
  const serialized = JSON.stringify(dump);
  assert.equal(serialized.includes(poison), false, "poisoned path leaked into toolchain derivation");
  assert.equal(serialized.toLowerCase().includes("--require=payload.js"), false);
  assert.equal(serialized.toLowerCase().includes("npm_config_node_gyp"), false);
  assert.match(dump.linkExe, /[\\/]Hostx64[\\/]x64[\\/]link\.exe$/i);
  assert.match(dump.sanitizedResolvedLink, /[\\/]Hostx64[\\/]x64[\\/]link\.exe$/i);
  assert.ok(dump.callerPathThreats.length >= 1, "git-tree threat was not detected as evidence");
  for (const entry of dump.sanitizedPath) {
    assert.equal(entry.toLowerCase().includes(poison.toLowerCase()), false);
  }
});

test("a malicious link.exe earlier on PATH never wins after sanitization", () => {
  const poison = freshDir("poison-link");
  const poisonBin = path.join(poison, "bin");
  fs.mkdirSync(poisonBin, { recursive: true });
  fs.writeFileSync(path.join(poisonBin, "link.exe"), "malicious linker");

  const dumpPath = path.join(freshDir("poison-link-dump"), "toolchain.json");
  const result = runBuilder(["-WriteToolchainJson", dumpPath], {
    timeout: 120000,
    env: { PATH: `${poisonBin};${process.env.PATH}` },
  });
  const output = outputOf(result);
  assert.equal(result.status, 0, `poisoned-link toolchain dump failed:\n${output}`);
  const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
  assert.match(dump.sanitizedResolvedLink, /[\\/]Hostx64[\\/]x64[\\/]link\.exe$/i);
  assert.equal(
    dump.sanitizedPath.some((e) => e.toLowerCase().startsWith(poisonBin.toLowerCase())),
    false,
  );
});

test("reparse-point source packages and staging roots are rejected", () => {
  const host = freshDir("reparse-host");
  const realDir = path.join(host, "real-package");
  makeMiniPackage(realDir);
  const junction = path.join(host, "junction-package");

  let made = false;
  try {
    fs.symlinkSync(realDir, junction, "junction");
    made = true;
  } catch (error) {
    if (!(error && (error.code === "EPERM" || error.code === "EACCES"))) throw error;
  }
  if (made) {
    const result = runBuilder(["-ValidatePrerequisitesOnly", ...LICENSE_ARGS, "-SourcePackageDir", junction], {
      timeout: 90000,
    });
    assertFailedWith(result, /reparse points are not allowed|symbolic link or junction/i, "reparse source package");
  }

  const cacheJunctionParent = path.join(
    REPO_ROOT,
    "node_modules",
    ".cache",
    `rb-output-junction-${RUN_UNIQUE}`,
  );
  const stagingJunction = path.join(cacheJunctionParent, "stage");
  fs.mkdirSync(cacheJunctionParent, { recursive: true });
  CREATED_PATHS.push(cacheJunctionParent);
  fs.symlinkSync(host, stagingJunction, "junction");
  const stagingResult = runBuilder(
    ["-ValidatePrerequisitesOnly", ...LICENSE_ARGS, "-StagingRoot", stagingJunction],
    { timeout: 180000 },
  );
  try {
    assertFailedWith(stagingResult, /reparse points are not allowed|symbolic link or junction/i, "reparse staging root");
  } finally {
    fs.rmSync(stagingJunction, { force: true });
  }
});

test("source drift (content change or extra watched file) is rejected", () => {
  const host = freshDir("drift-src");
  const pkg = makeMiniPackage(path.join(host, "pkg"));
  const manifestOut = path.join(host, "manifest.json");
  const authored = runBuilder(
    ["-SourcePackageDir", pkg, "-OutputManifestPath", manifestOut],
    { timeout: 120000 },
  );
  const authoredOutput = outputOf(authored);
  assert.equal(authored.status, 0, `manifest authoring failed:\n${authoredOutput}`);

  fs.appendFileSync(path.join(pkg, "src", "abletonlink.cc"), "// drifted\n");
  const drifted = runBuilder(prereqFixtureArgs({ fixtureRoot: pkg, manifestPath: manifestOut, stagingLabel: "drift" }), {
    timeout: 240000,
  });
  assertFailedWith(drifted, /source drift/, "content drift");
});

test("extra watched files change the tree hash and are rejected as drift", () => {
  const host = freshDir("drift-extra");
  const pkg = makeMiniPackage(path.join(host, "pkg"));
  const manifestOut = path.join(host, "manifest.json");
  const authored = runBuilder(
    ["-SourcePackageDir", pkg, "-OutputManifestPath", manifestOut],
    { timeout: 120000 },
  );
  assert.equal(authored.status, 0, outputOf(authored));

  fs.writeFileSync(path.join(pkg, "src", "extra.cc"), "// surprise\n");
  const drifted = runBuilder(prereqFixtureArgs({ fixtureRoot: pkg, manifestPath: manifestOut, stagingLabel: "drift" }), {
    timeout: 240000,
  });
  assertFailedWith(drifted, /source drift/, "extra-file drift");
});

test("patch drift: tampered original binding.gyp is rejected before patching", () => {
  const host = freshDir("drift-gyp");
  const pkg = makeMiniPackage(path.join(host, "pkg"));
  const manifestOut = path.join(host, "manifest.json");
  const authored = runBuilder(
    ["-SourcePackageDir", pkg, "-OutputManifestPath", manifestOut],
    { timeout: 120000 },
  );
  assert.equal(authored.status, 0, outputOf(authored));

  const gypPath = path.join(pkg, "binding.gyp");
  const original = fs.readFileSync(gypPath, "utf8");
  fs.writeFileSync(gypPath, original.replace('"ASIO_STANDALONE=1"', '"ASIO_STANDALONE=1", "EXTRA=1"'));

  const drifted = runBuilder(prereqFixtureArgs({ fixtureRoot: pkg, manifestPath: manifestOut, stagingLabel: "drift" }), {
    timeout: 240000,
  });
  assertFailedWith(
    drifted,
    /source drift: reviewed file hash changed \(leaf=binding\.gyp\)|patch drift/,
    "binding.gyp drift",
  );
});

test("patch drift: manifest with wrong expected patched hash is rejected post-patch", () => {
  const host = freshDir("drift-patched-sha");
  const pkg = makeMiniPackage(path.join(host, "pkg"));
  const manifestOut = path.join(host, "manifest.json");
  const authored = runBuilder(
    ["-SourcePackageDir", pkg, "-OutputManifestPath", manifestOut],
    { timeout: 120000 },
  );
  assert.equal(authored.status, 0, outputOf(authored));

  const manifest = JSON.parse(fs.readFileSync(manifestOut, "utf8"));
  manifest.patch.expectedPatchedSha256 = "0".repeat(64);
  fs.writeFileSync(manifestOut, JSON.stringify(manifest, null, 2));

  const drifted = runBuilder(prereqFixtureArgs({ fixtureRoot: pkg, manifestPath: manifestOut, stagingLabel: "drift" }), {
    timeout: 240000,
  });
  assertFailedWith(
    drifted,
    /reviewed binding\.gyp\.patched reference hash does not match|post-patch binding\.gyp does not match/,
    "patched-sha drift",
  );
});

test("promotion rejects wrong machine, non-DLL, Mach-O, and truncated images", (t) => {
  const host = freshDir("pe-gates");
  const destDir = path.join(host, "dest");
  fs.mkdirSync(destDir, { recursive: true });

  const cases = [
    { label: "arm64 machine", options: { machine: 0xaa64 }, pattern: /unsupported machine 0xAA64/i },
    { label: "non-DLL", options: { isDll: false }, pattern: /not marked as a DLL/ },
    {
      label: "Mach-O junk",
      bytes: Buffer.concat([Buffer.from("feedfacefeedface", "hex"), Buffer.alloc(600)]),
      pattern: /not a Windows PE image/,
    },
    { label: "truncated", bytes: Buffer.alloc(16), pattern: /truncated/ },
  ];

  for (const item of cases) {
    const stagedPath = path.join(host, `staged-${item.label.replace(/\W+/g, "-")}.node`);
    if (item.bytes) {
      fs.writeFileSync(stagedPath, item.bytes);
    } else {
      writePeFixture(stagedPath, item.options);
    }
    const destPath = path.join(destDir, "abletonlink.node");
    fs.writeFileSync(destPath, Buffer.from("previous-binary"));
    const result = runBuilder(
      [
        "-PromoteOnly",
        "-FixtureMode",
        ...LICENSE_ARGS,
        "-StagedAddonPath",
        stagedPath,
        "-DestinationAddonPath",
        destPath,
      ],
      { timeout: 180000 },
    );
    const output = outputOf(result);
    try {
      assertFailedWith(result, item.pattern, `PE gate (${item.label})`);
      assert.equal(
        fs.readFileSync(destPath).toString(),
        "previous-binary",
        `destination disturbed after ${item.label} rejection`,
      );
    } finally {
      fs.rmSync(destPath, { force: true });
    }
  }
});

test("promotion rejects unexpected imported modules from the import table", () => {
  const host = freshDir("imports-gate");
  const stagedPath = path.join(host, "staged.node");
  writePeFixture(stagedPath, { imports: ["KERNEL32.dll", "evilapi.dll"] });
  const destPath = path.join(host, "dest", "abletonlink.node");
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.from("previous-binary"));

  const result = runBuilder(
    ["-PromoteOnly", "-FixtureMode", ...LICENSE_ARGS, "-StagedAddonPath", stagedPath, "-DestinationAddonPath", destPath],
    { timeout: 180000 },
  );
  assertFailedWith(result, /unexpected imported module .*evilapi/i, "evil import");
  assert.equal(fs.readFileSync(destPath).toString(), "previous-binary");
});

test("load-probe failure rolls back the destination byte-for-byte", () => {
  const host = freshDir("rollback");
  const stagedPath = path.join(host, "staged.node");
  writePeFixture(stagedPath, {}); // structurally valid, but not a loadable addon
  const destPath = path.join(host, "dest", "abletonlink.node");
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const sentinel = crypto.randomBytes(512);
  fs.writeFileSync(destPath, sentinel);

  const result = runBuilder(
    ["-PromoteOnly", "-FixtureMode", ...LICENSE_ARGS, "-StagedAddonPath", stagedPath, "-DestinationAddonPath", destPath],
    { timeout: 240000 },
  );
  assertFailedWith(result, /promotion rolled back|could not be loaded/, "load-failure promotion");
  const restored = fs.readFileSync(destPath);
  assert.equal(restored.equals(sentinel), true, "rollback did not restore the previous binary");
  assert.equal(fs.existsSync(`${destPath}.rbak-abletonlink`), false, "backup leaked after rollback");
});

test("structurally valid fixtures promote successfully with SkipLoadProbe", () => {
  const host = freshDir("promote-ok");
  const stagedPath = path.join(host, "staged.node");
  writePeFixture(stagedPath, { imports: ["KERNEL32.dll"], delays: ["node.exe"] });
  const destPath = path.join(host, "dest", "abletonlink.node");
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, Buffer.from("old-binary"));

  const result = runBuilder(
    [
      "-PromoteOnly",
      "-FixtureMode",
      "-SkipLoadProbe",
      ...LICENSE_ARGS,
      "-StagedAddonPath",
      stagedPath,
      "-DestinationAddonPath",
      destPath,
    ],
    { timeout: 180000 },
  );
  const output = outputOf(result);
  assert.equal(result.status, 0, `positive promotion failed:\n${output}`);
  assert.equal(
    fs.readFileSync(destPath).equals(fs.readFileSync(stagedPath)),
    true,
    "promoted content mismatch",
  );
  assert.equal(fs.existsSync(`${destPath}.rbak-abletonlink`), false, "backup not reclaimed");
});

test("skip-load-probe is refused outside fixture mode", () => {
  const host = freshDir("skip-guard");
  const stagedPath = path.join(host, "staged.node");
  writePeFixture(stagedPath, {});
  const result = runBuilder(
    [
      "-PromoteOnly",
      "-SkipLoadProbe",
      ...LICENSE_ARGS,
      "-StagedAddonPath",
      stagedPath,
      "-DestinationAddonPath",
      path.join(REPO_ROOT, "node_modules", "elsewhere.node"),
    ],
    { timeout: 120000 },
  );
  assertFailedWith(result, /-SkipLoadProbe requires -FixtureMode/, "skip guard");
});

test("manifest authoring refuses to touch the tracked manifest implicitly", () => {
  const host = freshDir("authoring-guard");
  const pkg = makeMiniPackage(path.join(host, "pkg"));
  const before = fs.readFileSync(MANIFEST_PATH);
  const result = runBuilder(
    ["-SourcePackageDir", pkg, "-OutputManifestPath", MANIFEST_PATH],
    { timeout: 120000 },
  );
  assertFailedWith(result, /refusing to overwrite the tracked source manifest/, "tracked manifest guard");
  assert.equal(fs.readFileSync(MANIFEST_PATH).equals(before), true, "tracked manifest was modified");
});

test("reviewed manifest matches the installed lock-pinned tree right now", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  assert.equal(manifest.meta.packageVersion, "1.2.3");
  assert.equal(
    manifest.meta.lockIntegrity,
    "sha512-xST1G85OiYtpU2DXmhPlf4r6VwuNNiru82atuD3LSVLowuGOhsrcOh+grn7R4XIK2MP7bXJ6olFiKlrEb8j6/g==",
  );

  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(INSTALLED_PACKAGE_DIR, "package.json"), "utf8"),
  );
  assert.equal(pkgJson.version, "1.2.3");

  for (const f of manifest.files) {
    const buf = fs.readFileSync(path.join(INSTALLED_PACKAGE_DIR, ...f.path.split("/")));
    assert.equal(sha256(buf), f.sha256, `file drift for ${f.path}`);
  }
  assert.ok(manifest.trees.length >= 4);
});

test("tracked headers manifest proves the real node-gyp cache and official node.lib pin right now", (t) => {
  if (!fs.existsSync(REAL_HEADERS_CACHE_ROOT)) {
    t.skip("real node-gyp 22.22.1 cache is not present on this machine");
    return;
  }
  const result = harnessHeadersCheck(REAL_HEADERS_CACHE_ROOT, HEADERS_MANIFEST_PATH);
  const output = outputOf(result);
  assert.equal(result.status, 0, `real headers-cache proof failed:\n${output}`);
  assert.match(output, /OK files=(2[6-9]\d\d|\d{4,}) /);
  assert.match(output, new RegExp(`lib=${OFFICIAL_NODE_LIB_SHA}`));
});

test("poisoned cached node.lib is rejected against the pinned byte hash", () => {
  const host = freshDir("hdr-poison-lib");
  const cacheDir = path.join(host, "cache");
  const fixture = makeHeadersFixtureCache(cacheDir);
  const manifestPath = writeHeadersFixtureManifest(path.join(host, "manifest.json"), fixture);

  const libPath = path.join(cacheDir, "x64", "node.lib");
  const poisoned = Buffer.from(fs.readFileSync(libPath));
  poisoned[poisoned.length - 1] ^= 0xff;
  fs.writeFileSync(libPath, poisoned);

  assertHarnessFailed(
    harnessHeadersCheck(cacheDir, manifestPath, fixture.nodeLib.sha256),
    /cached node\.lib byte hash does not match the pinned official value/,
    "poisoned node.lib",
  );
});

test("runtime default binds fixture-free manifests to the official node.lib pin", () => {
  const host = freshDir("hdr-official-default");
  const cacheDir = path.join(host, "cache");
  const fixture = makeHeadersFixtureCache(cacheDir);
  const manifestPath = writeHeadersFixtureManifest(path.join(host, "manifest.json"), fixture);

  assertHarnessFailed(
    harnessHeadersCheck(cacheDir, manifestPath),
    /node headers manifest node\.lib hash does not match the pinned official value/,
    "manifest node.lib pin binding",
  );
});

test("changed header content is rejected before any build step", () => {
  const host = freshDir("hdr-changed");
  const cacheDir = path.join(host, "cache");
  const fixture = makeHeadersFixtureCache(cacheDir);
  const manifestPath = writeHeadersFixtureManifest(path.join(host, "manifest.json"), fixture);

  fs.writeFileSync(path.join(cacheDir, "include", "node", "uv", "uv.h"), "// drifted!!\n");
  assertHarnessFailed(
    harnessHeadersCheck(cacheDir, manifestPath, fixture.nodeLib.sha256),
    /content hash changed \(leaf=uv\.h\)/,
    "changed header",
  );
});

test("missing header file is rejected as exact-set drift", () => {
  const host = freshDir("hdr-missing");
  const cacheDir = path.join(host, "cache");
  const fixture = makeHeadersFixtureCache(cacheDir);
  const manifestPath = writeHeadersFixtureManifest(path.join(host, "manifest.json"), fixture);

  fs.rmSync(path.join(cacheDir, "include", "node", "common.gypi"));
  assertHarnessFailed(
    harnessHeadersCheck(cacheDir, manifestPath, fixture.nodeLib.sha256),
    /file\(s\) missing from the declared roots/,
    "missing header",
  );
});

test("extra header file inside the declared root is rejected as exact-set drift", () => {
  const host = freshDir("hdr-extra");
  const cacheDir = path.join(host, "cache");
  const fixture = makeHeadersFixtureCache(cacheDir);
  const manifestPath = writeHeadersFixtureManifest(path.join(host, "manifest.json"), fixture);

  fs.writeFileSync(path.join(cacheDir, "include", "node", "surprise.h"), "// extra\n");
  assertHarnessFailed(
    harnessHeadersCheck(cacheDir, manifestPath, fixture.nodeLib.sha256),
    /unexpected extra file\(s\) inside the declared roots/,
    "extra header",
  );
});

test("reparse point inside the declared header roots is rejected", () => {
  const host = freshDir("hdr-reparse");
  const cacheDir = path.join(host, "cache");
  const fixture = makeHeadersFixtureCache(cacheDir);
  const manifestPath = writeHeadersFixtureManifest(path.join(host, "manifest.json"), fixture);

  const target = path.join(host, "junction-target");
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "payload.h"), "// attacker\n");
  const junction = path.join(cacheDir, "include", "node", "linked");
  let made = false;
  try {
    fs.symlinkSync(target, junction, "junction");
    made = true;
  } catch (error) {
    if (!(error && (error.code === "EPERM" || error.code === "EACCES"))) throw error;
  }
  if (!made) return;

  assertHarnessFailed(
    harnessHeadersCheck(cacheDir, manifestPath, fixture.nodeLib.sha256),
    /symbolic link or junction inside the declared roots/,
    "reparse header",
  );
});

test("headers-manifest drift (tampered entry hash) is rejected against an intact tree", () => {
  const host = freshDir("hdr-manifest-drift");
  const cacheDir = path.join(host, "cache");
  const fixture = makeHeadersFixtureCache(cacheDir);
  const manifestPath = writeHeadersFixtureManifest(path.join(host, "manifest.json"), fixture);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.files[0].sha256 = "f".repeat(64);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  assertHarnessFailed(
    harnessHeadersCheck(cacheDir, manifestPath, fixture.nodeLib.sha256),
    /content hash changed/,
    "manifest drift",
  );
});

test("headers manifest with wrong pinned node version or arch fails closed in the reader", () => {
  const host = freshDir("hdr-meta");

  const wrongVersion = path.join(host, "wrong-version", "manifest.json");
  writeHeadersFixtureManifest(wrongVersion, {
    ...makeHeadersFixtureCache(path.join(host, "c1")),
    meta: { nodeVersion: "23.0.0" },
  });
  assertHarnessFailed(harnessManifestRead(wrongVersion), /version drift/, "wrong node version meta");

  const wrongArch = path.join(host, "wrong-arch", "manifest.json");
  writeHeadersFixtureManifest(wrongArch, {
    files: [],
    nodeLib: { path: "x64/node.lib", size: 1, sha256: OFFICIAL_NODE_LIB_SHA },
    meta: { arch: "arm64" },
  });
  assertHarnessFailed(harnessManifestRead(wrongArch), /arch drift/, "wrong node arch meta");
});

test("headers manifest whose recorded archive hash diverges from the official pin is rejected", () => {
  const host = freshDir("hdr-archive-pin");
  const manifestPath = path.join(host, "manifest.json");
  writeHeadersFixtureManifest(manifestPath, {
    files: [],
    nodeLib: { path: "x64/node.lib", size: 1, sha256: OFFICIAL_NODE_LIB_SHA },
    meta: { sourceArchiveSha256: "a".repeat(64) },
  });
  assertHarnessFailed(
    harnessManifestRead(manifestPath),
    /source archive hash does not match the official pin/,
    "archive pin drift",
  );
});

test("unsafe or out-of-root paths are rejected from the headers manifest", () => {
  const host = freshDir("hdr-traversal");
  const cacheDir = path.join(host, "cache");
  const fixture = makeHeadersFixtureCache(cacheDir);
  fixture.files.push({ path: "include/node/../evil.h", size: 1, sha256: sha256(Buffer.from("x")) });
  const manifestPath = writeHeadersFixtureManifest(path.join(host, "manifest.json"), fixture);

  assertHarnessFailed(
    harnessHeadersCheck(cacheDir, manifestPath, fixture.nodeLib.sha256),
    /unsafe or out-of-root path|malformed sha256|duplicate path/,
    "path traversal entry",
  );
});

test("generated project normalizes only the pinned node.lib escape form and re-validates", () => {
  const stage = freshDir("vx-known-escape");
  const expectedLib = "C:\\fake\\cache\\22.22.1\\x64\\node.lib";
  const escapedLib = expectedLib.replace(/\\/g, "\\\\");
  const vcxprojPath = makeVcxproj(stage, `$(NOINHERIT) kernel32.lib user32.lib ${escapedLib}`);

  const result = harnessGeneratedProject(stage, expectedLib);
  const output = outputOf(result);
  assert.equal(result.status, 0, `pinned escape normalization failed:\n${output}`);

  const after = fs.readFileSync(vcxprojPath, "utf8");
  assert.match(
    after,
    new RegExp(`<AdditionalDependencies>\\$\\(NOINHERIT\\) kernel32\\.lib user32\\.lib ${expectedLib.replace(/\\/g, "\\\\")}</AdditionalDependencies>`),
  );
  assert.equal(after.includes("\\\\"), false, "escaped form survived normalization");
});

test("unrecognized double-backslash linker input fails without rewriting the generated project", () => {
  const stage = freshDir("vx-evil-escape");
  const expectedLib = "C:\\fake\\cache\\22.22.1\\x64\\node.lib";
  const vcxprojPath = makeVcxproj(stage, "$(NOINHERIT) kernel32.lib C:\\\\evil\\\\node.lib");
  const before = fs.readFileSync(vcxprojPath);

  const result = harnessGeneratedProject(stage, expectedLib);
  assertHarnessFailed(
    result,
    /unrecognized double-backslash linker input/,
    "evil escaped linker input",
  );
  assert.equal(fs.readFileSync(vcxprojPath).equals(before), true, "project was rewritten before validation completed");
});

test("non-canonical absolute linker inputs fail without rewriting the generated project", () => {
  const cases = [
    { label: "forward-slash absolute input", deps: "$(NOINHERIT) kernel32.lib C:/evil/node.lib" },
    { label: "unknown bare library", deps: "$(NOINHERIT) kernel32.lib foo.lib" },
    { label: "wrong absolute node.lib path", deps: "$(NOINHERIT) kernel32.lib C:\\elsewhere\\node.lib" },
  ];
  for (const item of cases) {
    const stage = freshDir(`vx-${item.label.replace(/\W+/g, "-")}`);
    const vcxprojPath = makeVcxproj(stage, item.deps);
    const before = fs.readFileSync(vcxprojPath);

    const result = harnessGeneratedProject(stage, "C:\\fake\\cache\\22.22.1\\x64\\node.lib");
    assertHarnessFailed(result, /unexpected absolute linker input|unrecognized bare library token/, item.label);
    assert.equal(fs.readFileSync(vcxprojPath).equals(before), true, `${item.label} disturbed the project file`);
  }
});

test("debug dump env writes and hardcoded python roots are gone from the builder", () => {
  const source = fs.readFileSync(BUILDER_PATH, "utf8");
  assert.equal(source.includes("ALB_DEBUG_OUT"), false, "ALB_DEBUG_OUT must not exist in production");
  assert.equal(source.includes("Python312"), false, "hardcoded C:\\Python312 trust must be gone");
  assert.match(source, /Get-TrustedPythonCandidateExes/);
});

test.after(() => {
  for (const p of CREATED_PATHS) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of this run's fixtures only
    }
  }
});
