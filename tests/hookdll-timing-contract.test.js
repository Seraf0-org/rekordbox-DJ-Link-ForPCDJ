"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const HOOK_SOURCE = path.join(__dirname, "..", "native", "hookdll", "hookdll.cpp");

function findSupportedGxx() {
  const systemDrive = (process.env.SystemDrive || "C:").replace(/\\$/, "");
  const candidates = [
    path.join(systemDrive, "\\TDM-GCC-64\\bin\\g++.exe"),
    path.join(systemDrive, "\\msys64\\mingw64\\bin\\g++.exe"),
    path.join(systemDrive, "\\msys32\\mingw64\\bin\\g++.exe"),
  ];
  for (const candidate of candidates) {
    try {
      const item = fs.statSync(candidate);
      if (item.isFile()) return candidate;
    } catch {
      // not installed; try the next known trusted root
    }
  }
  return null;
}

function compileProbe(gxx, tuPath, outPath) {
  return spawnSync(
    gxx,
    ["-std=gnu++17", "-O2", "-DWIN32_LEAN_AND_MEAN", "-c", tuPath, "-o", outPath],
    { encoding: "utf8", timeout: 120_000, windowsHide: true },
  );
}

test("hookdll declares the Vista+ OS floor before windows.h so GetTickCount64 stays visible", () => {
  const source = fs.readFileSync(HOOK_SOURCE, "utf8");
  const includeIndex = source.indexOf("#include <windows.h>");
  assert.ok(includeIndex > 0, "windows.h include not found in hookdll.cpp");
  const preamble = source.slice(0, includeIndex);

  for (const macro of ["_WIN32_WINNT", "WINVER"]) {
    const pattern = new RegExp(
      `#ifndef ${macro}\\s*#define ${macro} 0x([0-9A-Fa-f]+)\\s*#endif`,
    );
    const match = preamble.match(pattern);
    assert.ok(match, `guarded ${macro} floor define must precede #include <windows.h>`);
    const value = Number.parseInt(match[1], 16);
    assert.ok(
      value >= 0x0600,
      `${macro} floor must be >= 0x0600 (Vista) for GetTickCount64; got 0x${value.toString(16)}`,
    );
  }
});

test("hookdll main poll loop uses monotonic wrap-safe GetTickCount64 with no shim or downgrade", () => {
  const source = fs.readFileSync(HOOK_SOURCE, "utf8");
  assert.match(
    source,
    /const ULONGLONG nowTick = static_cast<ULONGLONG>\(GetTickCount64\(\)\);/,
    "main worker loop tick read must use GetTickCount64",
  );
  assert.doesNotMatch(
    source,
    /#\s*define\s+GetTickCount64\b/,
    "GetTickCount64 must never be shimmed or aliased to a wrapping fallback",
  );
  assert.doesNotMatch(
    source,
    /GetTickCount64\s*\([^)]*\)\s*%\s*/,
    "GetTickCount64 result must not be narrowed through modulo arithmetic",
  );
});

test("hookdll has zero production GetTickCount( calls; every tick read is GetTickCount64", () => {
  const source = fs.readFileSync(HOOK_SOURCE, "utf8");
  // `GetTickCount(` cannot match `GetTickCount64(` because the digits sit
  // between the name and the paren, so this proves no 32-bit wrap-prone read
  // remains anywhere in the translation unit (production or otherwise).
  assert.doesNotMatch(
    source,
    /\bGetTickCount\s*\(/,
    "plain 32-bit GetTickCount() must not appear anywhere in hookdll.cpp",
  );
  assert.doesNotMatch(
    source,
    /#\s*define\s+GetTickCount\b/,
    "plain GetTickCount must never be shimmed or remapped",
  );

  const nowTickReads = [
    ...source.matchAll(/const ULONGLONG nowTick = static_cast<ULONGLONG>\((\w+)\(\)\);/g),
  ];
  assert.ok(nowTickReads.length >= 5, `expected >=5 nowTick read sites, found ${nowTickReads.length}`);
  for (const [, api] of nowTickReads) {
    assert.equal(
      api,
      "GetTickCount64",
      `every nowTick read must call GetTickCount64; found ${api}`,
    );
  }
});

test("hookdll tick accumulators and deltas stay in 64-bit ULONGLONG end to end", () => {
  const source = fs.readFileSync(HOOK_SOURCE, "utf8");

  for (const decl of [
    "ULONGLONG g_lastProbeTick[8]",
    "ULONGLONG g_lastPlayerProbeTick[4]",
    "ULONGLONG g_lastRowDataDiagTick[4]",
    "ULONGLONG g_lastTrackDiagLogTick",
    "ULONGLONG g_lastLoadDetourLogTick",
    "ULONGLONG g_lastLoopDiagTick",
    "std::unordered_map<std::string, ULONGLONG> g_lastMixerProbeTick",
    "ULONGLONG lastSlowPollTick",
    "ULONGLONG lastMixerRescanTick",
  ]) {
    assert.ok(
      source.includes(decl),
      `tick accumulator must be declared 64-bit: ${decl}`,
    );
  }

  // No DWORD-typed tick variable may exist: DWORD is the 32-bit wrap-prone
  // width that GetTickCount() returns.
  assert.doesNotMatch(
    source,
    /\bDWORD\s+[A-Za-z_]*[Tt]ick/i,
    "no tick accumulator may use the 32-bit DWORD width",
  );
  // Tick values must never be narrowed through a cast to a smaller width.
  assert.doesNotMatch(
    source,
    /\((?:DWORD|uint32_t|unsigned int|int)\)[^;\n]{0,40}[Tt]ick/i,
    "tick values must never be narrowed through a truncating cast",
  );
});

test("compile contract: declared floor exposes GetTickCount64 and its absence reproduces the blocker", (t) => {
  const gxx = findSupportedGxx();
  if (!gxx) {
    t.skip("no supported MinGW-w64 g++ found under known trusted roots (TDM-GCC-64/msys64/msys32)");
    return;
  }

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-hookdll-tickfloor-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  const guardedFloor =
    "#ifndef _WIN32_WINNT\n#define _WIN32_WINNT 0x0600\n#endif\n" +
    "#ifndef WINVER\n#define WINVER 0x0600\n#endif\n";
  const body =
    "#include <windows.h>\n" +
    "static_assert(sizeof(ULONGLONG) == 8, \"ULONGLONG must be 64-bit for wrap-safe tick deltas\");\n" +
    "ULONGLONG f() { ULONGLONG t = GetTickCount64(); return t; }\n";

  const withFloorTu = path.join(fixtureRoot, "with_floor.cpp");
  const withoutFloorTu = path.join(fixtureRoot, "without_floor.cpp");
  fs.writeFileSync(withFloorTu, `#define WIN32_LEAN_AND_MEAN\n${guardedFloor}${body}`);
  fs.writeFileSync(withoutFloorTu, `#define WIN32_LEAN_AND_MEAN\n${body}`);

  const withFloor = compileProbe(gxx, withFloorTu, path.join(fixtureRoot, "with_floor.o"));
  assert.equal(
    withFloor.status,
    0,
    `declared-floor probe failed against ${gxx}:\n${withFloor.stdout}\n${withFloor.stderr}`,
  );

  const withoutFloor = compileProbe(gxx, withoutFloorTu, path.join(fixtureRoot, "without_floor.o"));
  assert.notEqual(
    withoutFloor.status,
    0,
    "no-floor probe unexpectedly compiled; the toolchain default changed, review this contract",
  );
  assert.match(
    `${withoutFloor.stderr || ""}\n${withoutFloor.stdout || ""}`,
    /GetTickCount64[\s\S]{0,80}was not declared/i,
    "no-floor failure is no longer the missing-declaration blocker; re-verify root cause",
  );
});
