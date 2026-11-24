"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  fixedPathHasNoReparsePoints,
  parseIcaclsAclOutput,
  restrictiveAclFromIcaclsOutput,
} = require("../server/dj-agent/rekordboxLocalTestAcl");

const CONFIG_PATH = "C:\\SyndocalShow\\rb-output-rekordbox-local-test-v1.json";
const CURRENT_IDENTITY = "DJPC\\operator";

function icaclsOutput(...entries) {
  return `${CONFIG_PATH} ${entries[0]}\r\n${entries.slice(1).map((entry) => `    ${entry}`).join("\r\n")}\r\n正常に処理しました。`;
}

function topologyOptions({ symbolicLink = null, reparsePoint = null, queryResult = false } = {}) {
  return {
    pathApi: path.win32,
    fsApi: {
      lstatSync(component) {
        return {
          isSymbolicLink: () => component === symbolicLink,
          isReparsePoint: () => component === reparsePoint,
        };
      },
    },
    queryReparsePoint: () => queryResult,
  };
}

test("ACL parser recognizes every ACE and preserves localized non-ACL output", () => {
  const output = icaclsOutput(
    `${CURRENT_IDENTITY}:(F)`,
    "NT AUTHORITY\\SYSTEM:(F)",
    "BUILTIN\\Administrators:(F)",
    "利用者:(R,RC)",
    "Mandatory Label\\Medium Mandatory Level:(NW)",
  );
  const entries = parseIcaclsAclOutput(output, CONFIG_PATH);
  assert.equal(entries?.length, 5);
  assert.equal(entries?.[3].principal, "利用者");
  assert.equal(restrictiveAclFromIcaclsOutput(output, CONFIG_PATH, CURRENT_IDENTITY), true);
});

test("ACL verifier rejects inherited and broad write ACEs that old matching skipped", () => {
  const cases = [
    "BUILTIN\\Users:(I)(F)",
    "Everyone:(I)(M)",
    "利用者:(W)",
    "Authenticated Users:(F)",
  ];
  for (const broadAce of cases) {
    assert.equal(
      restrictiveAclFromIcaclsOutput(icaclsOutput(`${CURRENT_IDENTITY}:(F)`, broadAce), CONFIG_PATH, CURRENT_IDENTITY),
      false,
      broadAce,
    );
  }
});

test("ACL verifier fails closed on unrecognized, malformed, and deny ACEs", () => {
  const cases = [
    "利用者:(Q)",
    "利用者:(F)(UNKNOWN)",
    "Everyone:(DENY)(W)",
    "not an ACL entry",
  ];
  for (const unknownAce of cases) {
    assert.equal(
      restrictiveAclFromIcaclsOutput(icaclsOutput(`${CURRENT_IDENTITY}:(F)`, unknownAce), CONFIG_PATH, CURRENT_IDENTITY),
      false,
      unknownAce,
    );
  }
});

test("fixed config topology rejects every parent, target, and query ambiguity reparse point", () => {
  const parent = "C:\\SyndocalShow";
  const safeOptions = topologyOptions();
  const inspected = [];
  const originalLstat = safeOptions.fsApi.lstatSync;
  safeOptions.fsApi.lstatSync = (component) => {
    inspected.push(component);
    return originalLstat(component);
  };
  assert.equal(fixedPathHasNoReparsePoints(CONFIG_PATH, safeOptions), true);
  assert.deepEqual(inspected, [parent, CONFIG_PATH]);
  assert.equal(fixedPathHasNoReparsePoints(CONFIG_PATH, topologyOptions({ symbolicLink: parent })), false);
  assert.equal(fixedPathHasNoReparsePoints(CONFIG_PATH, topologyOptions({ symbolicLink: CONFIG_PATH })), false);
  assert.equal(fixedPathHasNoReparsePoints(CONFIG_PATH, topologyOptions({ reparsePoint: parent })), false);
  assert.equal(fixedPathHasNoReparsePoints(CONFIG_PATH, topologyOptions({ queryResult: true })), false);
  assert.equal(fixedPathHasNoReparsePoints(CONFIG_PATH, topologyOptions({ queryResult: null })), false);
});

test("fixed config topology fails closed if any inspected component cannot be statted", () => {
  assert.equal(fixedPathHasNoReparsePoints(CONFIG_PATH, {
    pathApi: path.win32,
    fsApi: { lstatSync() { throw new Error("access denied"); } },
    queryReparsePoint: () => false,
  }), false);
});
