const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadDjAgentConfig,
  readConfigFile,
} = require("../server/dj-agent/config");

const TEST_TOKEN = "0123456789abcdef0123456789abcdef";
const PRIVATE_PATH = "C:\\Users\\alice\\Documents\\dj-agent-secret.json";
const DEPRECATION_WARNING =
  "DJ Agent security notice: DJ_AGENT_ALLOW_REMOTE_ACTIONS/allowRemoteActions is deprecated and ignored; HTTP action endpoints are permanently loopback-only";

function assertPublicWarning(warning, expectedCode, ...secrets) {
  assert.equal(warning, `DJ Agent config warning: ${expectedCode}`);
  for (const secret of secrets) {
    assert.equal(warning.includes(secret), false, `warning leaked ${secret}`);
  }
}

test("config read failure exposes only a generic public warning", () => {
  const privateError = new Error(
    `ENOENT: no such file or directory, open '${PRIVATE_PATH}' for ${TEST_TOKEN}`
  );
  const result = readConfigFile(PRIVATE_PATH, {
    readFileSync() {
      throw privateError;
    },
  });

  assert.deepEqual(result.config, {});
  assertPublicWarning(result.warning, "config-read-failed", PRIVATE_PATH, "alice", TEST_TOKEN, privateError.message);
});

test("invalid JSON and non-object config expose generic reason codes", () => {
  const invalidJson = readConfigFile(PRIVATE_PATH, {
    readFileSync() {
      return `{\"token\":\"${TEST_TOKEN}\"`;
    },
  });
  assert.deepEqual(invalidJson.config, {});
  assertPublicWarning(invalidJson.warning, "config-invalid-json", PRIVATE_PATH, "alice", TEST_TOKEN);

  const invalidObject = readConfigFile(PRIVATE_PATH, {
    readFileSync() {
      return JSON.stringify([PRIVATE_PATH, TEST_TOKEN]);
    },
  });
  assert.deepEqual(invalidObject.config, {});
  assertPublicWarning(invalidObject.warning, "config-invalid-object", PRIVATE_PATH, "alice", TEST_TOKEN);
});

test("load preserves the exact token while sanitizing a file warning", () => {
  const config = loadDjAgentConfig({
    cwd: "C:\\Users\\alice\\Documents",
    env: {
      DJ_AGENT_CONFIG_PATH: PRIVATE_PATH,
      SYNDOCAL_TOKEN: TEST_TOKEN,
    },
    fsApi: {
      readFileSync() {
        throw new Error(`EACCES ${PRIVATE_PATH} ${TEST_TOKEN}`);
      },
    },
  });

  assert.equal(config.syndocal.token, TEST_TOKEN);
  assertPublicWarning(config.warning, "config-read-failed", PRIVATE_PATH, "alice", TEST_TOKEN, "EACCES");
});

test("env attempts to enable remote actions grant no authority and emit one fixed secret-free warning", () => {
  for (const attemptValue of ["true", "1", "yes", "on", "enabled"]) {
    const config = loadDjAgentConfig({
      env: {
        DJ_AGENT_ENABLED: "true",
        DJ_AGENT_ALLOW_REMOTE_ACTIONS: attemptValue,
        SYNDOCAL_TOKEN: TEST_TOKEN,
      },
    });
    assert.equal(config.allowRemoteActions, false, attemptValue);
    // Exact deep equality proves the notice is fixed and echoes no caller
    // values (env contents, paths, or tokens).
    assert.equal(config.allowRemoteDeprecationWarning, DEPRECATION_WARNING, attemptValue);
    assert.equal(config.warning, null, attemptValue);
  }
});

test("config-file and inline JSON attempts to enable remote actions are equally inert", () => {
  const fileConfig = loadDjAgentConfig({
    cwd: "C:\\Users\\alice\\Documents",
    env: {
      DJ_AGENT_CONFIG_PATH: PRIVATE_PATH,
      SYNDOCAL_TOKEN: TEST_TOKEN,
    },
    fsApi: {
      readFileSync() {
        return JSON.stringify({ allowRemoteActions: true, note: TEST_TOKEN });
      },
    },
  });
  assert.equal(fileConfig.allowRemoteActions, false);
  assert.equal(fileConfig.allowRemoteDeprecationWarning, DEPRECATION_WARNING);

  const inlineConfig = loadDjAgentConfig({
    env: {
      DJ_AGENT_CONFIG: JSON.stringify({ allowRemoteActions: true }),
    },
  });
  assert.equal(inlineConfig.allowRemoteActions, false);
  assert.equal(inlineConfig.allowRemoteDeprecationWarning, DEPRECATION_WARNING);
});

test("combined env and file enablement attempts still produce exactly the same single warning", () => {
  const config = loadDjAgentConfig({
    cwd: "C:\\Users\\alice\\Documents",
    env: {
      DJ_AGENT_ALLOW_REMOTE_ACTIONS: "true",
      SYNDOCAL_TOKEN: TEST_TOKEN,
    },
    fsApi: {
      readFileSync() {
        return JSON.stringify({ allowRemoteActions: true });
      },
    },
  });
  assert.equal(config.allowRemoteActions, false);
  assert.equal(config.allowRemoteDeprecationWarning, DEPRECATION_WARNING);
});

test("the deprecation notice coexists with a sanitized file-read warning without leaking secrets", () => {
  const config = loadDjAgentConfig({
    cwd: "C:\\Users\\alice\\Documents",
    env: {
      DJ_AGENT_CONFIG_PATH: PRIVATE_PATH,
      DJ_AGENT_ALLOW_REMOTE_ACTIONS: "true",
      SYNDOCAL_TOKEN: TEST_TOKEN,
    },
    fsApi: {
      readFileSync() {
        throw new Error(`EACCES ${PRIVATE_PATH} ${TEST_TOKEN}`);
      },
    },
  });
  assert.equal(config.allowRemoteActions, false);
  assertPublicWarning(
    config.warning,
    "config-read-failed",
    PRIVATE_PATH,
    "alice",
    TEST_TOKEN,
    "EACCES"
  );
  assert.equal(config.allowRemoteDeprecationWarning, DEPRECATION_WARNING);
  assert.notEqual(config.allowRemoteDeprecationWarning, config.warning);
});

test("explicitly disabled or absent remote action settings never warn", () => {
  const absent = loadDjAgentConfig({ env: { DJ_AGENT_ENABLED: "true" } });
  assert.equal(absent.allowRemoteActions, false);
  assert.equal(absent.allowRemoteDeprecationWarning, null);

  const explicitFalse = loadDjAgentConfig({
    env: { DJ_AGENT_ALLOW_REMOTE_ACTIONS: "false" },
    fsApi: {
      readFileSync() {
        return JSON.stringify({ allowRemoteActions: false });
      },
    },
  });
  assert.equal(explicitFalse.allowRemoteActions, false);
  assert.equal(explicitFalse.allowRemoteDeprecationWarning, null);
});
