import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  credentialStorePath,
  credentialStatuses,
  removeStoredCredential,
  resolveProviderCredential,
  setStoredCredential,
  userConfigPath,
} from "../src/credentials.js";
import { loadConfig } from "../src/config.js";

async function temporaryCredentialDirectory() {
  return await mkdtemp(path.join(os.tmpdir(), "codepilot-credentials-"));
}

async function writeHelper(directory: string, source: string) {
  await mkdir(directory, { recursive: true });
  const script = path.join(directory, "credential-helper.cjs");
  await writeFile(script, source);
  await writeFile(userConfigPath(directory), JSON.stringify({
    apiKeyHelpers: { deepseek: [process.execPath, script] },
  }));
}

test("stores, resolves, reports, and removes a user credential without returning values from status", async () => {
  const directory = await temporaryCredentialDirectory();
  await setStoredCredential("deepseek", " stored-secret ", directory);

  const stored = JSON.parse(await readFile(credentialStorePath(directory), "utf8"));
  assert.equal(stored.version, 1);
  assert.equal(stored.providers.deepseek.apiKey, "stored-secret");
  assert.match(stored.providers.deepseek.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(credentialStorePath(directory))).mode & 0o777, 0o600);
  }

  const resolution = await resolveProviderCredential({ provider: "deepseek", directory, env: {} });
  assert.equal(resolution.apiKey, "stored-secret");
  assert.equal(resolution.source?.kind, "user_store");

  const statuses = await credentialStatuses(directory, {});
  assert.equal(statuses.find((entry) => entry.provider === "deepseek")?.resolution.source?.kind, "user_store");
  assert.doesNotMatch(JSON.stringify(statuses), /stored-secret/);

  assert.equal(await removeStoredCredential("deepseek", directory), true);
  assert.equal(await removeStoredCredential("deepseek", directory), false);
  assert.deepEqual(await resolveProviderCredential({ provider: "deepseek", directory, env: {} }), {});
});

test("resolves credentials in override, environment, helper, store, then legacy project order", async () => {
  const directory = await temporaryCredentialDirectory();
  await setStoredCredential("deepseek", "stored-secret", directory);
  await writeHelper(directory, "process.stdout.write('helper-secret\\n')");

  const override = await resolveProviderCredential({
    provider: "deepseek",
    override: "override-secret",
    projectApiKey: "project-secret",
    directory,
    env: { DEEPSEEK_API_KEY: "environment-secret" },
  });
  assert.equal(override.apiKey, "override-secret");
  assert.equal(override.source?.kind, "override");

  const environment = await resolveProviderCredential({
    provider: "deepseek",
    projectApiKey: "project-secret",
    directory,
    env: { DEEPSEEK_API_KEY: "environment-secret" },
  });
  assert.equal(environment.apiKey, "environment-secret");
  assert.equal(environment.source?.kind, "environment");

  const helper = await resolveProviderCredential({ provider: "deepseek", projectApiKey: "project-secret", directory, env: {} });
  assert.equal(helper.apiKey, "helper-secret");
  assert.equal(helper.source?.kind, "helper");

  await rm(userConfigPath(directory));
  const store = await resolveProviderCredential({ provider: "deepseek", projectApiKey: "project-secret", directory, env: {} });
  assert.equal(store.apiKey, "stored-secret");
  assert.equal(store.source?.kind, "user_store");

  await removeStoredCredential("deepseek", directory);
  const project = await resolveProviderCredential({ provider: "deepseek", projectApiKey: "project-secret", directory, env: {} });
  assert.equal(project.apiKey, "project-secret");
  assert.equal(project.source?.kind, "project_config");
});

test("fails closed when a configured helper fails, is empty, or emits multiple lines", async () => {
  const directory = await temporaryCredentialDirectory();
  await setStoredCredential("deepseek", "stored-fallback-must-not-be-used", directory);

  await writeHelper(directory, "process.exit(9)");
  assert.deepEqual(
    await resolveProviderCredential({ provider: "deepseek", directory, env: {} }),
    { error: "helper_failed" },
  );

  await writeHelper(directory, "process.stdout.write('  \\n')");
  assert.deepEqual(
    await resolveProviderCredential({ provider: "deepseek", directory, env: {} }),
    { error: "helper_empty" },
  );

  await writeHelper(directory, "process.stdout.write('log line\\nsecret-key\\n')");
  assert.deepEqual(
    await resolveProviderCredential({ provider: "deepseek", directory, env: {} }),
    { error: "helper_failed" },
  );
});

test("reports malformed user configuration and credential stores without exposing their contents", async () => {
  const directory = await temporaryCredentialDirectory();
  await mkdir(directory, { recursive: true });
  await writeFile(userConfigPath(directory), "{invalid helper config containing helper-secret");
  const helperFailure = await resolveProviderCredential({ provider: "deepseek", directory, env: {} });
  assert.deepEqual(helperFailure, { error: "helper_failed" });
  assert.doesNotMatch(JSON.stringify(helperFailure), /helper-secret/);

  await writeFile(userConfigPath(directory), JSON.stringify({ apiKeyHelpers: { deepseek: "not-an-argument-array" } }));
  const invalidHelper = await resolveProviderCredential({ provider: "deepseek", directory, env: {} });
  assert.deepEqual(invalidHelper, { error: "helper_failed" });

  await rm(userConfigPath(directory));
  await writeFile(credentialStorePath(directory), "{invalid store containing stored-secret");
  if (process.platform !== "win32") await chmod(credentialStorePath(directory), 0o600);
  const storeFailure = await resolveProviderCredential({ provider: "deepseek", directory, env: {} });
  assert.deepEqual(storeFailure, { error: "store_invalid" });
  assert.doesNotMatch(JSON.stringify(storeFailure), /stored-secret/);
});

test("never executes credential helpers declared by a project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-project-helper-"));
  const directory = await temporaryCredentialDirectory();
  const marker = path.join(root, "helper-ran.txt");
  const script = path.join(root, "untrusted-helper.cjs");
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('project-secret')`);
  await writeFile(path.join(root, ".codepilot.json"), JSON.stringify({
    provider: "deepseek",
    apiKeyHelpers: { deepseek: [process.execPath, script] },
  }));

  const previousKey = process.env.DEEPSEEK_API_KEY;
  const previousDirectory = process.env.CODEPILOT_CONFIG_DIR;
  try {
    delete process.env.DEEPSEEK_API_KEY;
    process.env.CODEPILOT_CONFIG_DIR = directory;
    const config = await loadConfig(root);
    assert.equal(config.apiKey, undefined);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally {
    previousKey === undefined
      ? delete process.env.DEEPSEEK_API_KEY
      : (process.env.DEEPSEEK_API_KEY = previousKey);
    previousDirectory === undefined
      ? delete process.env.CODEPILOT_CONFIG_DIR
      : (process.env.CODEPILOT_CONFIG_DIR = previousDirectory);
  }
});
