"use strict";

// Deterministic, hermetic tests for the fail-closed pinned Inno Setup 6.7.3
// compiler path in scripts/build-dist.ps1 and the --tool evidence recording in
// scripts/write-release-manifest.js.
//
// No live Inno Setup install is required and none is trusted: the PowerShell
// harness extracts ONLY the Resolve-PinnedInnoSetupCompiler function from
// build-dist.ps1 (brace-balanced scan) and runs it against synthetic fixture
// files with injected Authenticode/VersionInfo reader seams. The real
// cmdlet-backed defaults are probed once to prove they reject an unsigned
// fixture (fail-closed), never that they accept one.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");
const BUILD_DIST = path.join(REPO_ROOT, "scripts", "build-dist.ps1");
const RELEASE_WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "release.yml");
const RELEASE_WRITER = path.join(REPO_ROOT, "scripts", "write-release-manifest.js");

const ISCC_SHA256_PIN = "0A8757031B33777E4C9CBFFEE40F11A5062B36D25CBE144C1DB73B6102B80AD7";
const INSTALLER_SHA256_PIN = "9C73C3BAE7ED48D44112A0F48E66742C00090BDB5BEF71D9D3C056C66E97B732";
const INNO_VERSION_PIN = "6.7.3";
const SIGNER_FRAGMENT = "Pyrsys B.V.";
const DISCOVERED_RELATIVE_PATH = "Programs\\Inno Setup 6\\ISCC.exe";

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function extractPowerShellFunction(source, functionName) {
  const marker = `function ${functionName}`;
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`function ${functionName} not found in build-dist.ps1`);
  }
  const openBrace = source.indexOf("{", start);
  if (openBrace < 0) throw new Error(`${functionName} has no opening brace`);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const ch = source[index];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${functionName} braces are unbalanced`);
}

function stripCommentLines(source) {
  return source.split(/\r?\n/).filter((line) => !/^\s*#/.test(line)).join("\n");
}

// ---------------------------------------------------------------------------
// Static contracts (cross-platform; no PowerShell execution)
// ---------------------------------------------------------------------------

test("build-dist pins the exact Inno Setup compiler provenance order and rejects spoofable discovery", () => {
  const source = fs.readFileSync(BUILD_DIST, "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));

  assert.equal(
    packageJson.scripts["build:dist"],
    "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/build-dist.ps1",
    "npm must launch build-dist through exact non-interactive Windows PowerShell hygiene",
  );

  const bootstrapDefinitionIndex = source.indexOf("function Initialize-WindowsDesktopPowerShellBuildEnvironment");
  const bootstrapInvocationIndex = source.search(/^Initialize-WindowsDesktopPowerShellBuildEnvironment$/m);
  const projectRootIndex = source.indexOf("if ([string]::IsNullOrWhiteSpace($ProjectRoot))");
  assert.ok(bootstrapDefinitionIndex >= 0, "build-dist Windows PowerShell bootstrap is missing");
  assert.ok(bootstrapInvocationIndex > bootstrapDefinitionIndex, "build-dist Windows PowerShell bootstrap is not invoked");
  assert.ok(projectRootIndex > bootstrapInvocationIndex, "build-dist must normalize the PowerShell module path before project work");
  assert.match(source, /\$PSVersionTable\.PSEdition\s+-cne\s+"Desktop"/);
  assert.match(source, /Join-Path\s+-Path\s+\$PSHOME\s+-ChildPath\s+"Modules"/);
  assert.match(source, /\$env:PSModulePath\s*=\s+\$nativeModuleDirectory/);
  assert.match(
    source,
    /Get-Command\s+-Name\s+\$requiredCommand\.Name\s+-All\s+-ErrorAction\s+SilentlyContinue/,
  );
  for (const [commandName, moduleName, commandType] of [
    ["Get-FileHash", "Microsoft.PowerShell.Utility", "Function"],
    ["Get-AuthenticodeSignature", "Microsoft.PowerShell.Security", "Cmdlet"],
    ["Compress-Archive", "Microsoft.PowerShell.Archive", "Function"],
  ]) {
    assert.match(
      source,
      new RegExp(
        `\\[pscustomobject\\]@\\{\\s*Name\\s*=\\s*"${commandName}";\\s*Source\\s*=\\s*"${moduleName.replaceAll(".", "\\.")}";\\s*CommandType\\s*=\\s*"${commandType}"\\s*\\}`,
      ),
    );
  }

  // Explicit parameter + environment override are supported alongside the
  // existing script API.
  assert.match(source, /\[string\]\$IsccPath = ""/);
  assert.match(source, /RB_OUTPUT_ISCC_PATH/);

  // Discovery is derived from the OS shell API only; caller-spoofable
  // ProgramFiles environment values must never select the compiler.
  assert.doesNotMatch(source, /env:ProgramFiles/);
  assert.match(
    source,
    /\[Environment\]::GetFolderPath\(\[Environment\+SpecialFolder\]::LocalApplicationData\)/,
  );
  assert.match(source, new RegExp(DISCOVERED_RELATIVE_PATH.replaceAll("\\", "\\\\")));

  // Exact pins: version, ISCC SHA256, signer subject fragment.
  assert.match(source, new RegExp(`"${INNO_VERSION_PIN}"`));
  assert.match(source, new RegExp(`"${ISCC_SHA256_PIN}"`));
  assert.match(source, new RegExp(`"${SIGNER_FRAGMENT.replaceAll(".", "\\.")}"`));

  // The resolver is defined and its call happens BEFORE identity generation,
  // so an invalid compiler aborts before any artifact work and the evidence
  // can be recorded in the identity.
  assert.match(source, /function Resolve-PinnedInnoSetupCompiler/);
  const resolveCallIndex = source.indexOf("-RequiredIsccSha256 $innoSetupIsccRequiredSha256");
  assert.ok(resolveCallIndex > 0, "resolver call site missing");
  const step2Index = source.indexOf('Write-Host "Step 2/7');
  assert.ok(step2Index > 0 && resolveCallIndex < step2Index, "compiler resolution moved after identity generation");

  // Installer runs only a fully resolved compiler object; there is no silent
  // Test-Path fallback, and the documented skip applies only when nothing
  // was found at all.
  assert.match(source, /\$iscc = \$innoCompiler\.Path/);
  assert.match(source, /& \$iscc installer\.iss/);
  assert.doesNotMatch(source, /Test-Path \$iscc\b/);
  assert.match(source, /if \(\$null -ne \$innoCompiler\) \{/);
  assert.match(source, /Pinned Inno Setup compiler absent - skipping installer/);

  // Evidence reaches both the identity generator and the release manifest.
  const shaEvidenceCount = source.split("inno-setup-iscc-sha256=").length - 1;
  assert.ok(shaEvidenceCount >= 2, "compiler SHA evidence must reach identity AND release manifest");
  assert.match(source, /"inno-setup=\$innoSetupToolVersion"/);
});

test("build-dist re-resolves the exact same pinned compiler immediately before invoking ISCC", () => {
  const source = fs.readFileSync(BUILD_DIST, "utf8");
  const stripped = stripCommentLines(source);
  const needle = "Resolve-PinnedInnoSetupCompiler";
  const explicitToken = "-ExplicitPath $explicitIsccPath";

  // Exactly two production call sites plus the definition; both calls pass
  // byte-identical parameter blocks built from the captured inputs, so the
  // second run is the same resolution, never a weaker or different one.
  const defIndex = stripped.indexOf(`function ${needle}`);
  assert.ok(defIndex > 0, "resolver definition missing");
  const firstSite = stripped.indexOf(needle, defIndex + needle.length);
  const secondSite = stripped.indexOf(needle, firstSite + needle.length);
  assert.ok(firstSite > defIndex && secondSite > firstSite, "expected exactly two resolver call sites");
  assert.equal(stripped.indexOf(needle, secondSite + needle.length), -1, "unexpected third resolver call site");
  function siteText(site) {
    const end = stripped.indexOf(explicitToken, site);
    assert.ok(end > site, "resolver call must reuse the captured explicit path input");
    return stripped.slice(site, end + explicitToken.length).replace(/\s+/g, " ").trim();
  }
  assert.equal(siteText(secondSite), siteText(firstSite), "second resolution must be the exact same resolver call");

  // The first resolution stays before identity generation so an invalid
  // compiler aborts before any artifact work (pre-existing contract).
  const step2Index = stripped.indexOf('Write-Host "Step 2/7');
  assert.ok(step2Index > 0 && firstSite < step2Index, "first resolution moved after identity generation");

  // The second resolution happens after install-manifest staging and inside
  // the final non-null compiler guard, immediately before ISCC.
  const stagingIndex = stripped.indexOf("node scripts\\write-install-manifest.js");
  assert.ok(stagingIndex > 0 && secondSite > stagingIndex, "second resolution must follow install-manifest staging");
  const invokeIndex = stripped.indexOf("& $iscc installer.iss");
  assert.ok(invokeIndex > secondSite, "ISCC invocation must follow the second resolution");
  const guardBeforeInvoke = stripped.lastIndexOf("if ($null -ne $innoCompiler)", invokeIndex);
  assert.ok(guardBeforeInvoke > stagingIndex && secondSite > guardBeforeInvoke, "second resolution escaped the final non-null guard");

  // Between the second validation and ISCC only fixed guard/assignment/logging
  // operations may appear: no cleanup, copy, write, archive, process launch,
  // or other side effect.
  const sliceStart = stripped.indexOf(explicitToken, secondSite) + explicitToken.length;
  const slice = stripped.slice(sliceStart, invokeIndex);
  assert.match(slice, /Assert-InnoCompilerRevalidated -Resolved \$innoCompiler -Revalidated \$innoCompilerRevalidated/);
  assert.match(slice, /\$innoCompiler = \$innoCompilerRevalidated/, "tool evidence must be rebound to the revalidated values");
  assert.match(slice, /\$iscc = \$innoCompiler\.Path/);
  for (const banned of [
    "Remove-Item", "Copy-Item", "Move-Item", "Rename-Item", "New-Item",
    "Set-Content", "Add-Content", "Out-File", "Export-", "Import-",
    "Compress-Archive", "Expand-Archive", "Start-Process", "Start-Job",
    "Invoke-Expression", "Invoke-Command", "Invoke-Item", "Stop-Process",
    "Test-Path", "New-Object", "[IO.File]", "[IO.Directory]",
    "Set-Location", "Push-Location", "Pop-Location", "node ", "npm ", "npx ", "git ",
  ]) {
    assert.ok(!slice.includes(banned), `forbidden operation '${banned.trim()}' between second validation and ISCC`);
  }

  // The spoofable environment value is read exactly once at capture time; the
  // revalidation reuses the already-captured variable instead.
  const envCapture = stripped.indexOf("$env:RB_OUTPUT_ISCC_PATH");
  assert.ok(envCapture > 0, "explicit environment capture missing");
  assert.equal(stripped.indexOf("$env:RB_OUTPUT_ISCC_PATH", envCapture + 1), -1, "environment value was re-read after capture");

  // The comparator fails closed on a null revalidation and checks every
  // evidence field, so drift in any dimension aborts before invocation.
  assert.match(stripped, /function Assert-InnoCompilerRevalidated/);
  assert.match(
    stripped,
    /"Path",\s*"Origin",\s*"Sha256",\s*"SignerSubject",\s*"ProductVersionDeclared"/,
  );
});

test("release workflow installs the exact official 6.7.3 installer without weakening GitHub trust", () => {
  const workflow = fs.readFileSync(RELEASE_WORKFLOW, "utf8");

  assert.match(workflow, new RegExp(INSTALLER_SHA256_PIN));
  assert.match(
    workflow,
    /https:\/\/github\.com\/jrsoftware\/issrc\/releases\/download\/is-6_7_3\/innosetup-6\.7\.3\.exe/,
  );
  // The files.jrsoftware.org mirror serves a different binary for 6.7.3
  // (sha256 D5A89E26BEAE0BC03AD18A0B0D1D3D75F87C32047879D25DA11970CB5C4662A3),
  // so it must never be the pinned source of the recorded installer hash.
  assert.doesNotMatch(workflow, /files\.jrsoftware\.org/);
  assert.doesNotMatch(workflow, /choco install innosetup/);

  // Hash verification happens BEFORE the downloaded installer is executed.
  const hashIndex = workflow.indexOf("Get-FileHash");
  const execIndex = workflow.indexOf("Start-Process");
  assert.ok(hashIndex > 0 && execIndex > hashIndex, "installer must be hash-verified before execution");

  // Per-user install so OS-derived LocalApplicationData discovery applies;
  // first-party action pins unchanged.
  assert.match(workflow, /\/CURRENTUSER/);
  assert.match(workflow, /actions\/checkout@v4/);
  assert.match(workflow, /actions\/setup-node@v4/);
});

test("release writer records validated tool evidence", () => {
  const writer = fs.readFileSync(RELEASE_WRITER, "utf8");
  assert.match(writer, /argValues\("--tool"\)/);
  assert.match(writer, /duplicate --tool name/);
  assert.match(writer, /\n    tools,\n/);
});

// ---------------------------------------------------------------------------
// Functional: write-release-manifest.js --tool evidence (hermetic fixtures)
// ---------------------------------------------------------------------------

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function releaseWriterFixture(t) {
  const root = tempDir(t, "rb-inno-release-writer-");
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist, { recursive: true });
  const installManifest = {
    schemaVersion: 1,
    kind: "rb-output-install-manifest/v1",
    productVersion: "1.1.3",
    identityHash: "a".repeat(64),
    payloads: [],
  };
  fs.writeFileSync(path.join(dist, "install-manifest.json"), `${canonicalJson(installManifest)}\n`);
  fs.writeFileSync(path.join(dist, "tool-evidence.zip"), "release artifact\n");
  return root;
}

function runReleaseWriter(root, extraArgs) {
  return spawnSync(process.execPath, [
    path.join(REPO_ROOT, "scripts", "write-release-manifest.js"),
    "--project-root", root,
    "--install-manifest", "dist/install-manifest.json",
    "--artifact", "dist/tool-evidence.zip",
    "--expect-artifact", "dist/tool-evidence.zip",
    ...extraArgs,
  ], { encoding: "utf8" });
}

test("release writer binds tool evidence into canonical release-manifest.json", (t) => {
  const root = releaseWriterFixture(t);
  const compilerSha = crypto.randomBytes(32).toString("hex");
  const run = runReleaseWriter(root, [
    "--tool", `inno-setup=${INNO_VERSION_PIN}`,
    "--tool", `inno-setup-iscc-sha256=${compilerSha}`,
  ]);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const manifestPath = path.join(root, "dist", "release-manifest.json");
  const raw = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(raw.toString("utf8"));
  assert.deepEqual(manifest.tools, {
    "inno-setup": INNO_VERSION_PIN,
    "inno-setup-iscc-sha256": compilerSha,
  });
  assert.deepEqual(raw, Buffer.from(`${canonicalJson(manifest)}\n`, "utf8"));
});

for (const [name, args, pattern] of [
  ["duplicate tool name", ["--tool", "k=1", "--tool", "k=2"], /duplicate --tool name: k/],
  ["malformed pair", ["--tool", "justname"], /--tool expects name=value/],
  ["empty value", ["--tool", "k="], /value must be a non-empty string/],
  ["trailing flag", ["--tool"], /missing value for --tool/],
]) {
  test(`release writer fails closed on ${name}`, (t) => {
    const root = releaseWriterFixture(t);
    const run = runReleaseWriter(root, args);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, pattern);
    assert.equal(fs.existsSync(path.join(root, "dist", "release-manifest.json")), false);
  });
}

// ---------------------------------------------------------------------------
// Functional: PS5.1 harness for the extracted resolver against synthetic
// fixtures (junctions, wrapper names, wrong hashes/signatures/versions)
// ---------------------------------------------------------------------------

function runPinningHarness(t) {
  const buildSource = fs.readFileSync(BUILD_DIST, "utf8");
  const bootstrapFn = extractPowerShellFunction(buildSource, "Initialize-WindowsDesktopPowerShellBuildEnvironment");
  const resolverFn = extractPowerShellFunction(buildSource, "Resolve-PinnedInnoSetupCompiler");
  const revalidateFn = extractPowerShellFunction(buildSource, "Assert-InnoCompilerRevalidated");
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "",
    "# Parse-level PS5.1 compatibility gate for the edited build script.",
    "$tokens = $null",
    "$parseErrors = $null",
    `[void][System.Management.Automation.Language.Parser]::ParseFile('${BUILD_DIST.replaceAll("'", "''")}', [ref]$tokens, [ref]$parseErrors)`,
    "if ($parseErrors.Count -gt 0) {",
    "  $messages = ($parseErrors | ForEach-Object { $_.Message }) -join '; '",
    "  throw ('build-dist.ps1 parse errors under PS5.1: ' + $messages)",
    "}",
    "Write-Output 'build-dist parses clean under PS5.1'",
    "",
    bootstrapFn,
    "",
    "Initialize-WindowsDesktopPowerShellBuildEnvironment",
    "if ($env:PSModulePath -cne (Join-Path -Path $PSHOME -ChildPath 'Modules')) { throw 'build-dist did not normalize PSModulePath to the inbox module directory' }",
    "$expectedCommands = @([pscustomobject]@{ Name = 'Get-FileHash'; Source = 'Microsoft.PowerShell.Utility'; CommandType = 'Function' }, [pscustomobject]@{ Name = 'Get-AuthenticodeSignature'; Source = 'Microsoft.PowerShell.Security'; CommandType = 'Cmdlet' }, [pscustomobject]@{ Name = 'Compress-Archive'; Source = 'Microsoft.PowerShell.Archive'; CommandType = 'Function' })",
    "foreach ($expectedCommand in $expectedCommands) { $commandInfos = @(Get-Command -Name $expectedCommand.Name -All -ErrorAction SilentlyContinue); if ($commandInfos.Count -ne 1 -or $commandInfos[0].Source -cne $expectedCommand.Source -or [string]$commandInfos[0].CommandType -cne $expectedCommand.CommandType) { throw ('required inbox command did not resolve exactly after bootstrap: ' + $expectedCommand.Name) } }",
    "Write-Output 'adversarial PSModulePath normalized by build-dist bootstrap'",
    "",
    resolverFn,
    "",
    revalidateFn,
    "",
    "$script:FakeSignatureStatus = 'Valid'",
    "$script:FakeSignerSubject = 'CN=Inno Setup, O=Pyrsys B.V., C=NL'",
    "$script:FakeProductVersion = ''",
    "$script:FakeFileVersion = ''",
    "",
    "function Read-FakeAuthenticode { param([string]$LiteralPath)",
    "  [pscustomobject]@{ Status = $script:FakeSignatureStatus; SignerCertificate = [pscustomobject]@{ Subject = $script:FakeSignerSubject } }",
    "}",
    "function Read-FakeVersionInfo { param([string]$LiteralPath)",
    "  [pscustomobject]@{ ProductVersion = $script:FakeProductVersion; FileVersion = $script:FakeFileVersion }",
    "}",
    "function New-FixtureIscc([string]$Directory) {",
    "  New-Item -ItemType Directory -Force -Path $Directory | Out-Null",
    "  $bytes = New-Object byte[] 512",
    "  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()",
    "  $rng.GetBytes($bytes)",
    "  $rng.Dispose()",
    "  $bytes[0] = 0x4D",
    "  $bytes[1] = 0x5A",
    "  $leaf = Join-Path $Directory 'ISCC.exe'",
    "  [IO.File]::WriteAllBytes($leaf, $bytes)",
    "  return @{ Path = $leaf; Sha256 = (Get-FileHash -LiteralPath $leaf -Algorithm SHA256).Hash }",
    "}",
    "function Assert-ThrowsLike([string]$Name, [string]$Pattern, [scriptblock]$Action) {",
    "  try {",
    "    & $Action",
    "  } catch {",
    "    if ($_.Exception.Message -notmatch $Pattern) {",
    "      throw ('{0} failed with an unexpected error: {1}' -f $Name, $_.Exception.Message)",
    "    }",
    "    return",
    "  }",
    "  throw ('{0} was accepted' -f $Name)",
    "}",
    "function Add-JunctionOrSkip([string]$Link, [string]$Target) {",
    "  try {",
    "    New-Item -ItemType Junction -Path $Link -Value $Target -ErrorAction Stop | Out-Null",
    "    return $true",
    "  } catch {",
    "    Write-Output 'junction-unavailable'",
    "    return $false",
    "  }",
    "}",
    "function Get-SentinelSnapshot([string]$Root) {",
    "  $entries = @()",
    "  foreach ($item in (Get-ChildItem -LiteralPath $Root -Recurse -Force -File | Sort-Object FullName)) {",
    "    $relative = $item.FullName.Substring($Root.Length).TrimStart('\\')",
    "    $hash = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash",
    "    $entries += ('{0}|{1}|{2}' -f $relative, $item.Length, $hash)",
    "  }",
    "  return ($entries -join \"`n\")",
    "}",
    "$script:InvocationMarkerReached = $false",
    "function Set-InvocationMarker {",
    "  $script:InvocationMarkerReached = $true",
    "}",
    "function Assert-NoInvocationOnFailure([string]$Name, [scriptblock]$Action) {",
    "  # Mirrors the production tail: the ISCC invocation marker is only reachable",
    "  # when every second-validation guard passes; any rejection must stop first.",
    "  $script:InvocationMarkerReached = $false",
    "  try {",
    "    & $Action",
    "    Set-InvocationMarker",
    "  } catch {",
    "    if ($script:InvocationMarkerReached) {",
    "      throw ('{0} set the invocation marker during rejection' -f $Name)",
    "    }",
    "    return",
    "  }",
    "  throw ('{0} unexpectedly validated and reached the ISCC invocation marker' -f $Name)",
    "}",
    "function Invoke-Resolver { param([string]$Base, [string]$Explicit, [string]$RequiredSha)",
    "  Resolve-PinnedInnoSetupCompiler `",
    "    -RequiredVersion '6.7.3' `",
    "    -RequiredIsccSha256 $RequiredSha `",
    "    -RequiredSignerSubjectFragment 'Pyrsys B.V.' `",
    "    -DiscoveredRelativePath 'Programs\\Inno Setup 6\\ISCC.exe' `",
    "    -DiscoveredBaseDirectory $Base `",
    "    -ExplicitPath $Explicit `",
    "    -AuthenticodeReader ${function:Read-FakeAuthenticode} `",
    "    -VersionInfoReader ${function:Read-FakeVersionInfo}",
    "}",
    "",
    `$work = Join-Path ([IO.Path]::GetTempPath()) ('rb-inno-pinning-' + [guid]::NewGuid().ToString('N'))`,
    "New-Item -ItemType Directory -Force -Path $work | Out-Null",
    "try {",
    "  # 1. valid discovered compiler resolves with recorded evidence",
    "  $acceptRoot = Join-Path $work 'accept'",
    "  $fixture = New-FixtureIscc (Join-Path $acceptRoot 'Programs\\Inno Setup 6')",
    "  $resolved = Invoke-Resolver -Base $acceptRoot -Explicit '' -RequiredSha $fixture.Sha256",
    "  if ($null -eq $resolved) { throw 'valid discovered compiler was not resolved' }",
    "  if ($resolved.Origin -cne 'discovered') { throw ('unexpected origin: ' + $resolved.Origin) }",
    "  if (-not $resolved.Sha256.Equals($fixture.Sha256.ToLowerInvariant(), [System.StringComparison]::OrdinalIgnoreCase)) { throw 'resolved sha mismatch' }",
    "  if (-not $resolved.Path.Equals($fixture.Path, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'resolved path mismatch' }",
    "  if ($resolved.ProductVersionDeclared -cne '') { throw 'undeclared version must surface as empty' }",
    "",
    "  # 2. explicit candidate wins even when discovery finds nothing",
    "  $explicitRoot = Join-Path $work 'explicit'",
    "  $explicitFx = New-FixtureIscc $explicitRoot",
    "  $resolvedExplicit = Invoke-Resolver -Base (Join-Path $work 'empty-discovery') -Explicit $explicitFx.Path -RequiredSha $explicitFx.Sha256",
    "  if ($null -eq $resolvedExplicit -or $resolvedExplicit.Origin -cne 'explicit') { throw 'explicit origin not honored' }",
    "",
    "  # 3. discovered absence is the ONLY skip path (returns null, no throw)",
    "  $absent = Invoke-Resolver -Base (Join-Path $work 'nothing-here') -Explicit '' -RequiredSha $fixture.Sha256",
    "  if ($null -ne $absent) { throw 'absent discovery must yield null' }",
    "",
    "  # 4. explicit candidate that does not exist fails closed",
    "  Assert-ThrowsLike 'missing explicit candidate' 'explicit Inno Setup compiler does not exist' {",
    "    Invoke-Resolver -Base (Join-Path $work 'accept') -Explicit (Join-Path $work 'gone\\ISCC.exe') -RequiredSha $fixture.Sha256",
    "  }",
    "",
    "  # 5. present-but-wrong-hash discovered compiler aborts (never skips)",
    "  Assert-ThrowsLike 'wrong hash' 'sha256 mismatch' {",
    "    Invoke-Resolver -Base (Join-Path $work 'accept') -Explicit '' -RequiredSha ('e' * 64)",
    "  }",
    "",
    "  # 6. unsigned/invalid Authenticode status aborts",
    "  $script:FakeSignatureStatus = 'NotSigned'",
    "  Assert-ThrowsLike 'not-signed' 'Authenticode status must be Valid' {",
    "    Invoke-Resolver -Base (Join-Path $work 'accept') -Explicit '' -RequiredSha $fixture.Sha256",
    "  }",
    "  $script:FakeSignatureStatus = 'Valid'",
    "",
    "  # 7. unreadable signature aborts",
    "  Assert-ThrowsLike 'unreadable signature' 'Authenticode' {",
    "    Resolve-PinnedInnoSetupCompiler -RequiredVersion '6.7.3' -RequiredIsccSha256 $fixture.Sha256 -RequiredSignerSubjectFragment 'Pyrsys B.V.' -DiscoveredRelativePath 'Programs\\Inno Setup 6\\ISCC.exe' -DiscoveredBaseDirectory (Join-Path $work 'accept') -ExplicitPath '' -AuthenticodeReader { param([string]$LiteralPath) $null } -VersionInfoReader ${function:Read-FakeVersionInfo}",
    "  }",
    "",
    "  # 8. foreign signer subject aborts",
    "  $previousSubject = $script:FakeSignerSubject",
    "  $script:FakeSignerSubject = 'CN=Evil Attacker, O=Evil Corp'",
    "  Assert-ThrowsLike 'foreign signer' 'signer subject must contain' {",
    "    Invoke-Resolver -Base (Join-Path $work 'accept') -Explicit '' -RequiredSha $fixture.Sha256",
    "  }",
    "  $script:FakeSignerSubject = $previousSubject",
    "",
    "  # 9/10. declared-but-wrong versions abort; undeclared versions stay fine",
    "  $script:FakeProductVersion = '6.7.4'",
    "  Assert-ThrowsLike 'wrong product version' 'ProductVersion must be exactly 6\\.7\\.3' {",
    "    Invoke-Resolver -Base (Join-Path $work 'accept') -Explicit '' -RequiredSha $fixture.Sha256",
    "  }",
    "  $script:FakeProductVersion = ''",
    "  $script:FakeFileVersion = '6.7.9'",
    "  Assert-ThrowsLike 'wrong file version' 'FileVersion must be exactly 6\\.7\\.3' {",
    "    Invoke-Resolver -Base (Join-Path $work 'accept') -Explicit '' -RequiredSha $fixture.Sha256",
    "  }",
    "  $script:FakeFileVersion = ''",
    "",
    "  # 10a. Genuine pinned 6.7.3 ISCC.exe carries literal 0.0.0.0 in BOTH",
    "  # version resources (confirmed live on the Authenticode-valid install);",
    "  # placeholders are undeclared rather than mismatches and surface empty.",
    "  $script:FakeProductVersion = '0.0.0.0'",
    "  $script:FakeFileVersion = '0.0.0.0'",
    "  $resolvedPlaceholder = Invoke-Resolver -Base (Join-Path $work 'accept') -Explicit '' -RequiredSha $fixture.Sha256",
    "  if ($null -eq $resolvedPlaceholder) { throw 'both-placeholder compiler was not resolved' }",
    "  if ($resolvedPlaceholder.ProductVersionDeclared -cne '') { throw 'placeholder product version must surface as empty' }",
    "",
    "  # 10b. One placeholder plus one exact declaration stays accepted,",
    "  # regardless of which field carries the placeholder.",
    "  $script:FakeFileVersion = '6.7.3'",
    "  $placeholderPlusExact = Invoke-Resolver -Base (Join-Path $work 'accept') -Explicit '' -RequiredSha $fixture.Sha256",
    "  if ($null -eq $placeholderPlusExact -or $placeholderPlusExact.ProductVersionDeclared -cne '') { throw 'placeholder product + exact file version failed' }",
    "  $script:FakeProductVersion = '6.7.3'",
    "  $script:FakeFileVersion = ''",
    "  $exactPlusPlaceholder = Invoke-Resolver -Base (Join-Path $work 'accept') -Explicit '' -RequiredSha $fixture.Sha256",
    "  if ($null -eq $exactPlusPlaceholder -or $exactPlusPlaceholder.ProductVersionDeclared -cne '6.7.3') { throw 'exact product + placeholder file version failed' }",
    "  $script:FakeProductVersion = ''",
    "",
    "  # 10c. Whitespace padding still trims to the exact 0.0.0.0 literal, so",
    "  # it remains an undeclared placeholder.",
    "  $script:FakeProductVersion = '   0.0.0.0   '",
    "  if ($null -eq (Invoke-Resolver -Base (Join-Path $work 'accept') -Explicit '' -RequiredSha $fixture.Sha256)) { throw 'padded placeholder product version failed' }",
    "  $script:FakeProductVersion = ''",
    "",
    "  # 10d. Near-zero, comma-decorated, prefixed/suffixed, and foreign values",
    "  # are NOT placeholders: each must fail closed on whichever field declares it.",
    "  foreach ($versionVariant in @('0.0.0', '0.0.0.1', '00.0.0.0', '0.0.0.0.0', '0,0,0,0', 'v0.0.0.0', '0.0.0.0-beta', 'not-a-version', '6.7.3 (build 1)')) {",
    "    $script:FakeProductVersion = $versionVariant",
    "    Assert-ThrowsLike (\"near-zero product '$versionVariant'\") 'ProductVersion must be exactly 6\\.7\\.3' {",
    "      Invoke-Resolver -Base (Join-Path $work 'accept') -Explicit '' -RequiredSha $fixture.Sha256",
    "    }",
    "    $script:FakeProductVersion = ''",
    "    $script:FakeFileVersion = $versionVariant",
    "    Assert-ThrowsLike (\"near-zero file '$versionVariant'\") 'FileVersion must be exactly 6\\.7\\.3' {",
    "      Invoke-Resolver -Base (Join-Path $work 'accept') -Explicit '' -RequiredSha $fixture.Sha256",
    "    }",
    "    $script:FakeFileVersion = ''",
    "  }",
    "",
    "  # 11. wrapper or renamed launcher is rejected",
    "  $wrapperDir = Join-Path $work 'wrapper'",
    "  New-Item -ItemType Directory -Force -Path $wrapperDir | Out-Null",
    "  $wrapper = Join-Path $wrapperDir 'ISCC.cmd'",
    "  [IO.File]::WriteAllBytes($wrapper, [IO.File]::ReadAllBytes($fixture.Path))",
    "  Assert-ThrowsLike 'wrapper name' 'exact file ISCC\\.exe' {",
    "    Invoke-Resolver -Base (Join-Path $work 'accept') -Explicit $wrapper -RequiredSha $fixture.Sha256",
    "  }",
    "",
    "  # 12. directory named ISCC.exe is rejected",
    "  $dirLeaf = Join-Path $work 'dir-leaf\\Programs\\Inno Setup 6\\ISCC.exe'",
    "  New-Item -ItemType Directory -Force -Path $dirLeaf | Out-Null",
    "  Assert-ThrowsLike 'directory leaf' 'is a directory' {",
    "    Invoke-Resolver -Base (Join-Path $work 'dir-leaf') -Explicit '' -RequiredSha $fixture.Sha256",
    "  }",
    "",
    "  # 13. junction at an intermediate component of the chain is rejected",
    "  $outsideReal = New-FixtureIscc (Join-Path $work 'outside-real\\Programs\\Inno Setup 6')",
    "  $junctionBase = Join-Path $work 'junction-base'",
    "  New-Item -ItemType Directory -Force -Path $junctionBase | Out-Null",
    "  if (Add-JunctionOrSkip (Join-Path $junctionBase 'Programs') (Join-Path $work 'outside-real')) {",
    "    Assert-ThrowsLike 'intermediate junction' 'symbolic link or junction' {",
    "      Invoke-Resolver -Base $junctionBase -Explicit '' -RequiredSha $outsideReal.Sha256",
    "    }",
    "  }",
    "",
    "  # 14. reparse point AS the leaf is rejected before any content check",
    "  $reparseLeafBase = Join-Path $work 'reparse-leaf'",
    "  New-Item -ItemType Directory -Force -Path (Join-Path $reparseLeafBase 'Programs\\Inno Setup 6') | Out-Null",
    "  if (Add-JunctionOrSkip (Join-Path $reparseLeafBase 'Programs\\Inno Setup 6\\ISCC.exe') $explicitRoot) {",
    "    Assert-ThrowsLike 'reparse leaf' 'symbolic link or junction' {",
    "      Invoke-Resolver -Base $reparseLeafBase -Explicit '' -RequiredSha $explicitFx.Sha256",
    "    }",
    "  }",
    "",
    "  # 15. explicit invalid NEVER falls back to a valid discovered compiler",
    "  $fallbackFx = New-FixtureIscc (Join-Path $work 'fallback-bad')",
    "  Assert-ThrowsLike 'no silent fallback' 'sha256 mismatch for .*expected' {",
    "    Invoke-Resolver -Base $acceptRoot -Explicit $fallbackFx.Path -RequiredSha $fixture.Sha256",
    "  }",
    "",
    "  # 16. default readers are the REAL cmdlets: an unsigned fixture fails.",
    "  # This proves production wiring stays fail-closed; acceptance of the real",
    "  # signed binary is only ever proven on a machine that actually installs it.",
    "  Assert-ThrowsLike 'real cmdlet defaults reject unsigned fixture' 'Authenticode' {",
    "    Resolve-PinnedInnoSetupCompiler -RequiredVersion '6.7.3' -RequiredIsccSha256 $fixture.Sha256 -RequiredSignerSubjectFragment 'Pyrsys B.V.' -DiscoveredRelativePath 'Programs\\Inno Setup 6\\ISCC.exe' -DiscoveredBaseDirectory (Join-Path $work 'accept') -ExplicitPath ''",
    "  }",
    "",
    "  # 17. Second-validation seam: sentinel tree snapshot proves the extracted",
    "  # revalidation comparator and the second resolver pass are read-only.",
    "  $sentinelRoot = Join-Path $work 'sentinel'",
    "  $sentinelFx = New-FixtureIscc (Join-Path $sentinelRoot 'Programs\\Inno Setup 6')",
    "  $sentinelFirst = Invoke-Resolver -Base $sentinelRoot -Explicit '' -RequiredSha $sentinelFx.Sha256",
    "  if ($null -eq $sentinelFirst) { throw 'sentinel compiler was not resolved' }",
    "  if ($sentinelFirst.SignerSubject -cne 'CN=Inno Setup, O=Pyrsys B.V., C=NL') { throw ('valid-case signer subject evidence wrong: ' + $sentinelFirst.SignerSubject) }",
    "  $sentinelSnapshot = Get-SentinelSnapshot -Root $sentinelRoot",
    "  $sentinelValidAgain = Invoke-Resolver -Base $sentinelRoot -Explicit '' -RequiredSha $sentinelFx.Sha256",
    "  Assert-InnoCompilerRevalidated -Resolved $sentinelFirst -Revalidated $sentinelValidAgain",
    "  if ($sentinelValidAgain.SignerSubject -cne 'CN=Inno Setup, O=Pyrsys B.V., C=NL') { throw 'revalidated signer subject evidence was lost' }",
    "  Write-Output 'case valid-revalidation-signer-subject: ok'",
    "",
    "  # 18. Every evidence-field mismatch stops before the ISCC marker.",
    "  $driftValues = @{ Path = 'C:\\elsewhere\\ISCC.exe'; Origin = 'explicit'; Sha256 = ('f' * 64); SignerSubject = 'CN=Evil Attacker, O=Evil Corp'; ProductVersionDeclared = '6.7.4' }",
    "  foreach ($driftField in @('Path', 'Origin', 'Sha256', 'SignerSubject', 'ProductVersionDeclared')) {",
    "    $drifted = Invoke-Resolver -Base $sentinelRoot -Explicit '' -RequiredSha $sentinelFx.Sha256",
    "    $drifted.$driftField = $driftValues[$driftField]",
    "    Assert-NoInvocationOnFailure ('drifted ' + $driftField) {",
    "      Assert-InnoCompilerRevalidated -Resolved $sentinelFirst -Revalidated $drifted",
    "      Set-InvocationMarker",
    "    }",
    "    Write-Output ('case evidence-' + $driftField.ToLowerInvariant() + '-drift-stops-before-iscc: ok')",
    "  }",
    "",
    "  # 19. A null second resolution (total disappearance) never degrades to skip.",
    "  Assert-NoInvocationOnFailure 'disappeared compiler evidence' {",
    "    Assert-InnoCompilerRevalidated -Resolved $sentinelFirst -Revalidated $null",
    "    Set-InvocationMarker",
    "  }",
    "  Write-Output 'case disappearance-null-evidence-stops-before-iscc: ok'",
    "",
    "  # 20. The synthetic compiler vanishing between first and second validation",
    "  # makes the resolver return null for a discovered origin and the guard aborts.",
    "  $vanishRoot = Join-Path $work 'vanish'",
    "  $vanishFx = New-FixtureIscc (Join-Path $vanishRoot 'Programs\\Inno Setup 6')",
    "  $vanishFirst = Invoke-Resolver -Base $vanishRoot -Explicit '' -RequiredSha $vanishFx.Sha256",
    "  Rename-Item -LiteralPath $vanishFx.Path -NewName 'renamed-away.bin'",
    "  Assert-NoInvocationOnFailure 'vanished compiler between validations' {",
    "    $vanishSecond = Invoke-Resolver -Base $vanishRoot -Explicit '' -RequiredSha $vanishFirst.Sha256",
    "    Assert-InnoCompilerRevalidated -Resolved $vanishFirst -Revalidated $vanishSecond",
    "    Set-InvocationMarker",
    "  }",
    "  Write-Output 'case vanished-between-validations-stops-before-iscc: ok'",
    "",
    "  # 21. Byte-level tampering between validations is rejected by the second",
    "  # resolver run itself while the pristine sentinel tree stays identical.",
    "  $tamperRoot = Join-Path $work 'tamper'",
    "  $tamperFx = New-FixtureIscc (Join-Path $tamperRoot 'Programs\\Inno Setup 6')",
    "  $tamperFirst = Invoke-Resolver -Base $tamperRoot -Explicit '' -RequiredSha $tamperFx.Sha256",
    "  $tamperedBytes = [IO.File]::ReadAllBytes($tamperFx.Path)",
    "  $tamperedBytes[500] = $tamperedBytes[500] -bxor 0xFF",
    "  [IO.File]::WriteAllBytes($tamperFx.Path, $tamperedBytes)",
    "  Assert-NoInvocationOnFailure 'tampered compiler bytes between validations' {",
    "    $tamperSecond = Invoke-Resolver -Base $tamperRoot -Explicit '' -RequiredSha $tamperFirst.Sha256",
    "    Assert-InnoCompilerRevalidated -Resolved $tamperFirst -Revalidated $tamperSecond",
    "    Set-InvocationMarker",
    "  }",
    "",
    "  # The whole second-validation flow left the sentinel tree byte-for-byte intact.",
    "  if ((Get-SentinelSnapshot -Root $sentinelRoot) -cne $sentinelSnapshot) { throw 'sentinel tree drifted during second-validation probes' }",
    "  Write-Output 'case sentinel-tree-unchanged-after-probes: ok'",
    "",
    "  Write-Output 'INNO SECOND-VALIDATION PROBE OK'",
    "  Write-Output 'INNO PINNING PROBE OK'",
    "} finally {",
    "  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue",
    "}",
  ];
  const script = lines.join("\r\n");
  // The driver is far too large for an -EncodedCommand argument (32K
  // CreateProcess limit), so it runs from a temporary file instead.
  const driverDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-inno-driver-"));
  const driverPath = path.join(driverDir, "inno-pinning-driver.ps1");
  // BOM is required so Windows PowerShell 5.1 reads the driver as UTF-8.
  fs.writeFileSync(driverPath, `\ufeff${script}`, "utf8");
  t.after(() => fs.rmSync(driverDir, { recursive: true, force: true }));
  // Model the Git-Bash/pwsh environment that previously made the production
  // launcher miss Windows PowerShell inbox commands. The extracted production
  // bootstrap, rather than a harness-only environment deletion, must repair it.
  const childEnv = { ...process.env };
  childEnv.PSModulePath = [
    "C:\\Program Files\\PowerShell\\Modules",
    "C:\\Program Files\\PowerShell\\7\\Modules",
    "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\Modules",
  ].join(";");
  return spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", driverPath],
    { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true, timeout: 120000, env: childEnv },
  );
}

test("PS5.1 pinning harness accepts synthetic valid compiler and rejects every tampered variant", (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows PowerShell 5.1 is required");
    return;
  }
  const result = runPinningHarness(t);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /build-dist parses clean under PS5\.1/);
  assert.match(result.stdout, /adversarial PSModulePath normalized by build-dist bootstrap/);
  assert.match(result.stdout, /case valid-revalidation-signer-subject: ok/);
  for (const field of ["path", "origin", "sha256", "signersubject", "productversiondeclared"]) {
    assert.match(result.stdout, new RegExp(`case evidence-${field}-drift-stops-before-iscc: ok`));
  }
  assert.match(result.stdout, /case disappearance-null-evidence-stops-before-iscc: ok/);
  assert.match(result.stdout, /case vanished-between-validations-stops-before-iscc: ok/);
  assert.match(result.stdout, /case sentinel-tree-unchanged-after-probes: ok/);
  assert.match(result.stdout, /INNO SECOND-VALIDATION PROBE OK/);
  assert.match(result.stdout, /INNO PINNING PROBE OK/);
});
