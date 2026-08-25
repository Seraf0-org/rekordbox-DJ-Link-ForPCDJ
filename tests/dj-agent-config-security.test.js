const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadDjAgentConfig,
  readConfigFile,
} = require("../server/dj-agent/config");

const TEST_TOKEN = "0123456789abcdef0123456789abcdef";
const PRIVATE_PATH = "C:\\Users\\alice\\Documents\\dj-agent-secret.json";

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
