"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const REPO_ROOT = path.resolve(__dirname, "..");

function section(text, name) {
  const header = new RegExp(`^\\[${name}\\]\\s*$`, "mi");
  const match = header.exec(text);
  assert.ok(match, `installer.iss must contain [${name}]`);
  const remainder = text.slice(match.index + match[0].length);
  const nextSection = remainder.search(/^\s*\[/m);
  return nextSection >= 0 ? remainder.slice(0, nextSection) : remainder;
}

function sourceForDestination(filesSection, destinationName) {
  const escaped = destinationName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = filesSection.match(new RegExp(
    `^Source:\\s*"([^"]+)";\\s*DestDir:\\s*"\\{app\\}";[^\\r\\n]*$`,
    "gmi",
  ));
  assert.ok(match, `[Files] must install ${destinationName} into {app}`);

  const matchingLine = match.find((line) => {
    const source = line.match(/^Source:\s*"([^"]+)"/i)?.[1];
    return source && new RegExp(`(?:^|[\\\\/])${escaped}$`, "i").test(source);
  });
  assert.ok(matchingLine, `[Files] must declare a source for ${destinationName}`);
  return matchingLine.match(/^Source:\s*"([^"]+)"/i)[1];
}

test("installer packages the manifest-bound staged launcher, not the mutable source launcher", (t) => {
  const installerText = fs.readFileSync(path.join(REPO_ROOT, "installer.iss"), "utf8");
  const files = section(installerText, "Files");
  const launcherSource = sourceForDestination(files, "start-rb.bat");

  assert.equal(launcherSource.replaceAll("/", "\\"), "dist\\start-rb.bat");
  assert.doesNotMatch(files, /^Source:\s*"start-rb\.bat";/mi);

  const buildDist = fs.readFileSync(path.join(REPO_ROOT, "scripts", "build-dist.ps1"), "utf8");
  const stageIndex = buildDist.search(/Copy-Item\s+start-rb\.bat\s+dist\\/i);
  const manifestIndex = buildDist.search(/scripts\\write-install-manifest\.js/i);
  const installerIndex = buildDist.search(/&\s+\$iscc\s+installer\.iss/i);
  assert.ok(stageIndex >= 0, "build-dist must stage start-rb.bat into dist");
  assert.ok(manifestIndex > stageIndex, "install manifest must bind the staged launcher");
  assert.ok(installerIndex > manifestIndex, "installer must consume the manifest-bound dist tree");
  assert.match(
    buildDist.slice(manifestIndex, installerIndex),
    /--payload\s+"start-rb\.bat"/i,
    "install manifest must include the staged launcher as an exact payload",
  );

  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rb-installer-source-"));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const stagedDir = path.join(fixtureRoot, "dist");
  fs.mkdirSync(stagedDir);
  const sourceLauncher = path.join(fixtureRoot, "start-rb.bat");
  const stagedLauncher = path.join(stagedDir, "start-rb.bat");
  fs.writeFileSync(sourceLauncher, "verified launcher\r\n");
  fs.copyFileSync(sourceLauncher, stagedLauncher);

  // Simulate a concurrent root-source drift after install-manifest generation.
  fs.writeFileSync(sourceLauncher, "drifted launcher\r\n");
  const resolvedInstallerSource = path.resolve(
    fixtureRoot,
    launcherSource.replaceAll("\\", path.sep),
  );
  assert.equal(resolvedInstallerSource, stagedLauncher);
  assert.equal(fs.readFileSync(resolvedInstallerSource, "utf8"), "verified launcher\r\n");
  assert.notEqual(
    fs.readFileSync(resolvedInstallerSource, "utf8"),
    fs.readFileSync(sourceLauncher, "utf8"),
  );
});

test("fresh-install launch path verifies the installed tree before starting the server", () => {
  const installerText = fs.readFileSync(path.join(REPO_ROOT, "installer.iss"), "utf8");
  const run = section(installerText, "Run");
  assert.match(
    run,
    /^Filename:\s*"\{app\}\\start-rb\.bat";[^\r\n]*\bpostinstall\b[^\r\n]*$/mi,
  );
  assert.doesNotMatch(
    run,
    /^Filename:\s*"\{app\}\\server\.exe";/mi,
    "installer must not bypass the verifying launcher",
  );

  const launcher = fs.readFileSync(path.join(REPO_ROOT, "start-rb.bat"), "utf8");
  const verifyIndex = launcher.search(/"%~dp0server\.exe"\s+--verify-install/i);
  const startIndex = launcher.search(/start\s+\/min\s+"DJLinkForPCDJ Server"\s+"%~dp0server\.exe"/i);
  assert.ok(verifyIndex >= 0, "start-rb.bat must invoke installed server.exe --verify-install");
  assert.ok(startIndex > verifyIndex, "server start must occur only after install verification");
  assert.match(
    launcher.slice(verifyIndex, startIndex),
    /if\s+errorlevel\s+1\s*\([\s\S]*?exit\s+\/b\s+1\s*\)/i,
    "verification failure must exit before server start",
  );
});
