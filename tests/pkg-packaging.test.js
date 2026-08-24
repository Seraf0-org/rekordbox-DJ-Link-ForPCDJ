"use strict";

// REAL @yao-pkg/pkg packaging smoke for the provenance P0: prove the generated
// release commitment is actually COMPILED INTO a packaged executable and
// verified at startup by the REAL server/buildIdentity.js code path — not by
// injected JS fixtures or dependency-detector assumptions.
//
// Heavyweight (runs a real pkg build twice, may fetch the pinned node22 base
// image on a cold cache), so it is gated behind RB_OUTPUT_PKG_SMOKE=1:
//   RB_OUTPUT_PKG_SMOKE=1 node --test tests/pkg-packaging.test.js
// CI/release preflight must run this gate before shipping server.exe.
//
// Positive case: a minimal identity self-check app built with the repo's real
// buildIdentity.js + real generator + real bind-executable launches as a REAL
// pkg exe and reports verified-packaged with the exact bound hashes.
// Adversarial negative control: an identical build WITHOUT the generated
// commitment module must fail closed (non-zero exit, missing-commitment
// error) — proving the positive result comes from the embedded commitment and
// that a broken inclusion can never pass silently.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const {
  computeCoreIdentityHash,
  validateEmbeddedReleaseCommitment,
} = require("../server/buildIdentity");

const REPO_ROOT = path.join(__dirname, "..");
const PKG_VERSION = "6.22.0";
const PKG_TARGET = "node22-win-x64";
const SCRATCH_VERSION = "9.9.9";
const EXE_TIMEOUT_MS = 120_000;
const PKG_TIMEOUT_MS = 600_000;

function tempRoot(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function localPkgBin() {
  // Invoke the pkg JS entry directly through process.execPath: Node >= 18.20
  // refuses to spawn .cmd shims without a shell (CVE-2024-27980 hardening),
  // and shell-true spawning of build tools is avoided elsewhere in this repo.
  const candidate = path.join(REPO_ROOT, "node_modules", "@yao-pkg", "pkg", "lib-es5", "bin.js");
  return fs.existsSync(candidate) ? candidate : null;
}

// Minimal hermetic scratch project: a clean annotated-tag git repo whose shape
// satisfies the real release preflight, carrying ONLY the identity machinery.
function makeScratchProject(t, { withCommitment }) {
  const root = tempRoot(t, "rb-pkg-smoke-");
  const git = (args) =>
    spawnSync("git", [
      "-C", root,
      "-c", "user.email=qa@example.invalid",
      "-c", "user.name=qa",
      "-c", "commit.gpgsign=false",
      ...args,
    ], { encoding: "utf8" });
  assert.equal(git(["init"]).status, 0);

  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({
    name: "rb-output",
    version: SCRATCH_VERSION,
    private: true,
    type: "commonjs",
    main: "main.js",
    devDependencies: { "@yao-pkg/pkg": PKG_VERSION },
    pkg: { scripts: ["main.js", "server/**/*.js"], targets: [PKG_TARGET], outputPath: "dist" },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "package-lock.json"), `${JSON.stringify({
    name: "rb-output",
    version: SCRATCH_VERSION,
    packages: {
      "": {
        name: "rb-output",
        version: SCRATCH_VERSION,
        devDependencies: { "@yao-pkg/pkg": PKG_VERSION },
      },
      "node_modules/@yao-pkg/pkg": { version: PKG_VERSION },
    },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, "installer.iss"), `AppVersion=${SCRATCH_VERSION}\n`);
  // The identity generator deliberately refuses to create an unchecked
  // output directory; release build-dist creates dist before this step.
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });

  // The REAL production identity resolver under the same relative layout the
  // packaged exe uses.
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  fs.copyFileSync(
    path.join(REPO_ROOT, "server", "buildIdentity.js"),
    path.join(root, "server", "buildIdentity.js"),
  );

  // Bounded identity self-check entry: resolves packaged provenance exactly
  // like server/index.js does, prints machine-readable results, exits 0 only
  // when the embedded commitment was present AND verified.
  fs.writeFileSync(path.join(root, "main.js"), `"use strict";
const { resolveBuildIdentity } = require("./server/buildIdentity");
try {
  const identity = resolveBuildIdentity();
  console.log(\`PROVENANCE_STATUS:\${identity.provenance.status}\`);
  console.log(\`COMMITMENT_VERIFIED:\${identity.provenance.commitmentVerified}\`);
  console.log(\`IDENTITY_HASH:\${identity.provenance.identityHash}\`);
  console.log(\`MEASURED_EXE_SHA256:\${identity.provenance.measuredExeSha256}\`);
  process.exit(identity.provenance.commitmentVerified ? 0 : 3);
} catch (error) {
  console.error(\`SELF_CHECK_FAILED:\${error.message}\`);
  process.exit(1);
}
`);

  // Everything must be committed BEFORE the generator's preflight runs so the
  // scratch worktree is clean (mirrors the real release order).
  assert.equal(git(["add", "-A"]).status, 0);
  assert.equal(git(["commit", "-m", "scratch"]).status, 0);
  assert.equal(git(["tag", "-a", `v${SCRATCH_VERSION}`, "-m", "smoke"]).status, 0);

  const node = process.execPath;
  const tools = ["--tool", `pkg=${PKG_VERSION}`, "--tool", "pyinstaller=6.22.2"];

  // Step 1: canonical core identity (+ commitment module only in the
  // positive variant), produced by the REAL generator against the REAL
  // preflight gate.
  const genArgs = [
    path.join(REPO_ROOT, "scripts", "generate-build-identity.js"),
    "--project-root", root,
    "--out", path.join(root, "dist", "build-identity.json"),
    ...tools,
  ];
  if (withCommitment) {
    genArgs.push("--emit-module", path.join(root, "server", "embedded-commitment.js"));
  }
  const gen = spawnSync(node, genArgs, { encoding: "utf8", timeout: 120_000 });
  assert.equal(gen.status, 0, gen.stderr || gen.stdout);

  let commitment = null;
  if (withCommitment) {
    ({ EMBEDDED_RELEASE_COMMITMENT: commitment } =
      require(path.join(root, "server", "embedded-commitment.js")));
    assert.equal(validateEmbeddedReleaseCommitment(commitment).ok, true);
  }

  // Step 2: REAL pkg packaging with the locally pinned @yao-pkg/pkg.
  const pkgBin = localPkgBin();
  assert.ok(pkgBin, "local @yao-pkg/pkg missing; run: npm ci");
  const exePath = path.join(root, "dist", "smoke-server.exe");
  const pkgRun = spawnSync(process.execPath, [
    pkgBin,
    "main.js",
    "--targets", PKG_TARGET,
    "--output", exePath,
  ], { cwd: root, encoding: "utf8", timeout: PKG_TIMEOUT_MS });
  assert.equal(pkgRun.status, 0,
    `pkg failed (${pkgRun.status}):\n${pkgRun.stdout}\n${pkgRun.stderr}`);
  assert.ok(fs.existsSync(exePath), "pkg produced no executable");
  const exeSha256 = crypto.createHash("sha256").update(fs.readFileSync(exePath)).digest("hex");

  // Step 3: REAL post-package binding of the measured exe hash into the
  // sidecar, exactly like scripts/build-dist.ps1 step 4.
  const bind = spawnSync(node, [
    path.join(REPO_ROOT, "scripts", "bind-executable.js"),
    "--project-root", root,
    "--dist", "dist",
    "--exe", path.join("dist", "smoke-server.exe"),
  ], { encoding: "utf8", timeout: 60_000 });
  assert.equal(bind.status, 0, bind.stderr || bind.stdout);

  const sidecar = JSON.parse(
    fs.readFileSync(path.join(root, "dist", "build-identity.json"), "utf8"),
  );
  assert.equal(sidecar.executableBinding.exeSha256, exeSha256);

  return { root, exePath, exeSha256, sidecar, commitment };
}

const SMOKE_ENABLED = process.env.RB_OUTPUT_PKG_SMOKE === "1";
const SKIP_REASON = "REAL pkg smoke gated off; set RB_OUTPUT_PKG_SMOKE=1 to run";

test(
  "REAL pkg exe embeds and verifies the release commitment at startup",
  { skip: SMOKE_ENABLED ? false : SKIP_REASON },
  (t) => {
    const fx = makeScratchProject(t, { withCommitment: true });

    // Launch the REAL packaged executable (bounded identity self-check mode).
    const run = spawnSync(fx.exePath, [], {
      encoding: "utf8",
      timeout: EXE_TIMEOUT_MS,
    });
    assert.equal(run.status, 0,
      `self-check exited ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);

    const fields = Object.fromEntries(
      run.stdout.split(/\r?\n/).filter((line) => line.includes(":")).map((line) => {
        const idx = line.indexOf(":");
        return [line.slice(0, idx), line.slice(idx + 1)];
      }),
    );
    assert.equal(fields.PROVENANCE_STATUS, "verified-packaged");
    assert.equal(fields.COMMITMENT_VERIFIED, "true");
    // The commitment INSIDE the exe covers exactly this release identity...
    assert.equal(fields.IDENTITY_HASH, fx.commitment.identityHash);
    assert.equal(fields.IDENTITY_HASH, computeCoreIdentityHash(fx.sidecar));
    // ...and the RUNNING exe is byte-identical to the bound sidecar value.
    assert.equal(fields.MEASURED_EXE_SHA256, fx.exeSha256);
    assert.equal(fields.MEASURED_EXE_SHA256, fx.sidecar.executableBinding.exeSha256);
  },
);

test(
  "ADVERSARY pkg exe built without the commitment module fails closed at startup",
  { skip: SMOKE_ENABLED ? false : SKIP_REASON },
  (t) => {
    const fx = makeScratchProject(t, { withCommitment: false });

    const run = spawnSync(fx.exePath, [], {
      encoding: "utf8",
      timeout: EXE_TIMEOUT_MS,
    });
    assert.notEqual(run.status, 0,
      `exe without embedded commitment must fail closed, stdout:\n${run.stdout}`);
    assert.match(run.stderr || run.stdout, /SELF_CHECK_FAILED/);
    assert.match(run.stderr || run.stdout, /embedded release commitment/i);
  },
);
