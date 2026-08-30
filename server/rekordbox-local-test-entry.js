"use strict";

if (process.argv.length !== 2) {
  console.error("[ERROR] rekordbox-local-test-entry accepts no arguments.");
  process.exit(64);
}

// Keep the process command line compatible with the source-server ownership
// fence while making the runtime mode explicit to server/index.js. No
// environment variable selects this path.
process.argv.push("--rekordbox-local-test");
require("./index");
