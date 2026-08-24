#!/usr/bin/env node
"use strict";

// Release preflight gate. Run BEFORE any dist deletion or build step.
// Exits non-zero with the full failure list when anything is off.

const path = require("node:path");
const { runPreflight } = require("./lib/provenance-preflight");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const projectRoot = path.resolve(
  argValue("--project-root") || path.join(__dirname, ".."),
);

try {
  const result = runPreflight({ projectRoot });
  console.log(
    JSON.stringify(
      {
        ok: true,
        commit: result.commit,
        tree: result.tree,
        tag: result.tag,
        productVersion: result.productVersion,
        packageLockHash: result.packageLockHash,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
