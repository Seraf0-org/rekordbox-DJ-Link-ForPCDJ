"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");

const PACKAGE_JSON_PATH = path.join(__dirname, "..", "package.json");
const ABLETON_PACKAGE_JSON_PATH = path.join(
  __dirname,
  "..",
  "node_modules",
  "@ktamas77",
  "abletonlink",
  "package.json",
);
const ABLETON_NATIVE_PATH = path.join(
  __dirname,
  "..",
  "node_modules",
  "@ktamas77",
  "abletonlink",
  "build",
  "Release",
  "abletonlink.node",
);
const PROVIDER_PATH = path.join(
  __dirname,
  "..",
  "server",
  "providers",
  "abletonLinkProvider.js",
);
const BUILD_SCRIPT_PATH = path.join(
  __dirname,
  "..",
  "scripts",
  "build-dist.ps1",
);
const REPO_ROOT = path.join(__dirname, "..");
const {
  ABLETON_LINK_MODULE_NAME,
  resolveAbletonLinkModule,
} = require(PROVIDER_PATH);

function runAbletonGate(projectRoot) {
  return spawnSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      BUILD_SCRIPT_PATH,
      "-ProjectRoot",
      projectRoot,
      "-ValidateAbletonLinkOnly",
    ],
    { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true },
  );
}

function createAddonFixture(moduleSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rb-ableton-gate-"));
  const packageRoot = path.join(
    root,
    "node_modules",
    "@ktamas77",
    "abletonlink",
  );
  const releaseRoot = path.join(packageRoot, "build", "Release");
  fs.mkdirSync(releaseRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "@ktamas77/abletonlink", main: "index.js" }),
  );
  fs.writeFileSync(path.join(packageRoot, "index.js"), moduleSource);
  return { root, nativePath: path.join(releaseRoot, "abletonlink.node") };
}

function writeMachOBundleBytes(nativePath) {
  const bytes = Buffer.alloc(0x400);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x01000007, 4);
  bytes.writeUInt32LE(3, 8);
  bytes.writeUInt32LE(6, 12);
  fs.writeFileSync(nativePath, bytes);
}

function createMachOFixture({ moduleSource }) {
  const fixture = createAddonFixture(moduleSource);
  writeMachOBundleBytes(fixture.nativePath);
  return fixture;
}

function classifyNativeHeader(bytes) {
  if (bytes.length < 0x100) {
    return { kind: "truncated", pattern: /is truncated/ };
  }
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    return {
      kind: "foreign-header",
      pattern: /not a Windows PE image \(missing MZ signature\)/,
    };
  }
  const peOffset = bytes.readInt32LE(0x3c);
  if (peOffset < 0 || peOffset > bytes.length - 24) {
    return { kind: "invalid-pe-offset", pattern: /invalid PE header offset/ };
  }
  if (
    bytes[peOffset] !== 0x50 ||
    bytes[peOffset + 1] !== 0x45 ||
    bytes[peOffset + 2] !== 0x00 ||
    bytes[peOffset + 3] !== 0x00
  ) {
    return {
      kind: "foreign-header",
      pattern: /not a Windows PE image \(missing PE signature\)/,
    };
  }
  const machine = bytes.readUInt16LE(peOffset + 4);
  if (machine !== 0x8664) {
    return {
      kind: "wrong-machine",
      pattern: new RegExp(
        `unsupported machine 0x${machine.toString(16).toUpperCase()}`,
      ),
    };
  }
  const optionalHeaderSize = bytes.readUInt16LE(peOffset + 20);
  const optionalHeaderOffset = peOffset + 24;
  if (
    optionalHeaderSize < 72 ||
    optionalHeaderOffset > bytes.length - optionalHeaderSize
  ) {
    return {
      kind: "invalid-optional-header",
      pattern: /invalid optional PE header/,
    };
  }
  if (bytes.readUInt16LE(optionalHeaderOffset) !== 0x20b) {
    return { kind: "not-pe32plus", pattern: /not a PE32\+ image/ };
  }
  if ((bytes.readUInt16LE(peOffset + 22) & 0x2000) === 0) {
    return { kind: "not-dll", pattern: /not marked as a DLL/ };
  }
  return { kind: "windows-x64-pe-dll", pattern: null };
}

function createPeFixture({ machine = 0x8664, isDll = true, moduleSource }) {
  const fixture = createAddonFixture(moduleSource);

  const peOffset = 0x80;
  const optionalHeaderOffset = peOffset + 24;
  const bytes = Buffer.alloc(0x400);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(peOffset, 0x3c);
  bytes.write("PE\0\0", peOffset, "ascii");
  bytes.writeUInt16LE(machine, peOffset + 4);
  bytes.writeUInt16LE(1, peOffset + 6);
  bytes.writeUInt16LE(0xf0, peOffset + 20);
  bytes.writeUInt16LE(isDll ? 0x2000 : 0, peOffset + 22);
  bytes.writeUInt16LE(0x20b, optionalHeaderOffset);
  bytes.writeUInt16LE(0x8160, optionalHeaderOffset + 70);
  fs.writeFileSync(fixture.nativePath, bytes);
  return fixture;
}

function removeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(fs.existsSync(root), false, "fixture cleanup left files behind");
}

test("Ableton Link packaging assets are explicit and exist in the installed tree", () => {
  const rootPackage = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, "utf8"));
  const abletonPackage = JSON.parse(fs.readFileSync(ABLETON_PACKAGE_JSON_PATH, "utf8"));
  const assets = rootPackage.pkg?.assets || [];

  assert.equal(ABLETON_LINK_MODULE_NAME, "@ktamas77/abletonlink");
  assert.equal(abletonPackage.name, ABLETON_LINK_MODULE_NAME);
  assert.match(abletonPackage.version, /^1\.2\.3$/);
  assert.equal(
    assets.includes("node_modules/@ktamas77/abletonlink/package.json"),
    true,
  );
  assert.equal(
    assets.includes("node_modules/@ktamas77/abletonlink/build/Release/abletonlink.node"),
    true,
  );
  assert.equal(
    assets.some((asset) => asset === "node_modules/@ktamas77/abletonlink/**/*"),
    false,
  );
  const nativeStat = fs.statSync(ABLETON_NATIVE_PATH);
  assert.equal(nativeStat.isFile(), true);
  assert.ok(nativeStat.size > 0, "installed Ableton Link native addon is empty");
});

test("Ableton Link resolver follows one literal supported module in dev and pkg modes", () => {
  const source = fs.readFileSync(PROVIDER_PATH, "utf8");
  assert.match(source, /require\("@ktamas77\/abletonlink"\)/);
  assert.doesNotMatch(source, /require\(moduleName\)/);
  assert.doesNotMatch(source, /require\(\s*String\(moduleName\)/);

  const originalLoad = Module._load;
  const originalPkg = process.pkg;
  const fakeModule = { AbletonLink: function FakeAbletonLink() {} };
  const loadedRequests = [];
  Module._load = function load(request, parent, isMain) {
    loadedRequests.push(request);
    if (request === ABLETON_LINK_MODULE_NAME) return fakeModule;
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    for (const packaged of [false, true]) {
      if (packaged) {
        process.pkg = {};
      } else {
        delete process.pkg;
      }
      loadedRequests.length = 0;
      const resolved = resolveAbletonLinkModule();
      assert.equal(resolved.module, fakeModule);
      assert.equal(resolved.reason, null);
      assert.deepEqual(loadedRequests, [ABLETON_LINK_MODULE_NAME]);
    }

    loadedRequests.length = 0;
    const unsupported = resolveAbletonLinkModule("C:/attacker/native-addon");
    assert.equal(unsupported.module, null);
    assert.equal(unsupported.reason, "unsupported-module");
    assert.deepEqual(loadedRequests, []);
  } finally {
    Module._load = originalLoad;
    if (originalPkg === undefined) {
      delete process.pkg;
    } else {
      process.pkg = originalPkg;
    }
  }
});

test("build-dist rejects non-Windows Ableton binaries before pkg and sanitizes loader errors", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows PowerShell 5.1 is required");
    return;
  }

  const buildSource = fs.readFileSync(BUILD_SCRIPT_PATH, "utf8");
  const validationIndex = buildSource.lastIndexOf("Assert-AbletonLinkNativeAddon -ProjectRoot");
  const pkgBuildIndex = buildSource.indexOf("& $pkgBin server/index.js");
  assert.ok(validationIndex >= 0, "build-dist does not invoke the native gate");
  assert.ok(validationIndex < pkgBuildIndex, "native validation moved after pkg execution");
  assert.match(buildSource, /ValidateAbletonLinkOnly/);
  assert.match(buildSource, /0x8664/);
  assert.match(buildSource, /0x2000/);
  assert.match(buildSource, /ReparsePoint/);
  assert.match(buildSource, /require\("@ktamas77\/abletonlink"\)/);
  assert.doesNotMatch(buildSource, /probe\.(Stdout|Stderr).*throw/);

  const machOFixture = createMachOFixture({
    moduleSource: 'module.exports = { AbletonLink: function FakeAbletonLink() {} };',
  });
  try {
    const machO = runAbletonGate(machOFixture.root);
    const machOOutput = `${machO.stdout || ""}\n${machO.stderr || ""}`;
    assert.notEqual(machO.status, 0, "a Mach-O bundle must be rejected before pkg");
    assert.match(machOOutput, /not a Windows PE image \(missing MZ signature\)/);
    assert.doesNotMatch(machOOutput, new RegExp(machOFixture.nativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(machOOutput, new RegExp(machOFixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    removeFixture(machOFixture.root);
  }

  const installedHeader = classifyNativeHeader(fs.readFileSync(ABLETON_NATIVE_PATH));
  const current = runAbletonGate(REPO_ROOT);
  const currentOutput = `${current.stdout || ""}\n${current.stderr || ""}`;
  assert.doesNotMatch(
    currentOutput,
    new RegExp(ABLETON_NATIVE_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  if (installedHeader.pattern) {
    assert.notEqual(
      current.status,
      0,
      `installed addon header (${installedHeader.kind}) must be rejected`,
    );
    assert.match(currentOutput, installedHeader.pattern);
  } else {
    assert.equal(installedHeader.kind, "windows-x64-pe-dll");
    if (current.status !== 0) {
      assert.match(currentOutput, /could not be loaded by the packaging Node runtime/);
    } else {
      assert.match(current.stdout, /validated: Windows x64 PE32\+ DLL/);
    }
  }

  let fixture = createPeFixture({
    moduleSource: 'module.exports = { AbletonLink: function FakeAbletonLink() {} };',
  });
  try {
    const positive = runAbletonGate(fixture.root);
    assert.equal(positive.status, 0, `${positive.stdout}\n${positive.stderr}`);
    assert.match(positive.stdout, /validated: Windows x64 PE32\+ DLL/);
    assert.equal((positive.stderr || "").trim(), "");
  } finally {
    removeFixture(fixture.root);
  }

  fixture = createPeFixture({
    machine: 0xaa64,
    moduleSource: 'module.exports = { AbletonLink: function FakeAbletonLink() {} };',
  });
  try {
    const wrongMachine = runAbletonGate(fixture.root);
    const output = `${wrongMachine.stdout || ""}\n${wrongMachine.stderr || ""}`;
    assert.notEqual(wrongMachine.status, 0);
    assert.match(output, /unsupported machine 0xAA64/i);
    assert.doesNotMatch(output, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    removeFixture(fixture.root);
  }

  fixture = createPeFixture({
    isDll: false,
    moduleSource: 'module.exports = { AbletonLink: function FakeAbletonLink() {} };',
  });
  try {
    const nonDll = runAbletonGate(fixture.root);
    const output = `${nonDll.stdout || ""}\n${nonDll.stderr || ""}`;
    assert.notEqual(nonDll.status, 0);
    assert.match(output, /not marked as a DLL/);
    assert.doesNotMatch(output, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    removeFixture(fixture.root);
  }

  const loaderSecret = path.join(os.tmpdir(), "absolute-native-loader-secret", "native.node");
  fixture = createPeFixture({
    moduleSource: `throw new Error(${JSON.stringify(loaderSecret)});`,
  });
  try {
    const loaderFailure = runAbletonGate(fixture.root);
    const output = `${loaderFailure.stdout || ""}\n${loaderFailure.stderr || ""}`;
    assert.notEqual(loaderFailure.status, 0);
    assert.match(output, /could not be loaded by the packaging Node runtime/);
    assert.doesNotMatch(output, new RegExp(loaderSecret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(output, new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    removeFixture(fixture.root);
  }
});

test("build-dist rejects a reparse-point Ableton addon path", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows PowerShell 5.1 is required");
    return;
  }

  const fixture = createPeFixture({
    moduleSource: 'module.exports = { AbletonLink: function FakeAbletonLink() {} };',
  });
  const target = `${fixture.nativePath}.target`;
  try {
    fs.renameSync(fixture.nativePath, target);
    try {
      fs.symlinkSync(target, fixture.nativePath, "file");
    } catch (error) {
      if (error && (error.code === "EPERM" || error.code === "EACCES")) {
        t.skip("file symlink creation is unavailable on this Windows runner");
        return;
      }
      throw error;
    }
    const result = runAbletonGate(fixture.root);
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /symbolic link or junction/i);
  } finally {
    removeFixture(fixture.root);
  }
});
