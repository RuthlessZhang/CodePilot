import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runCli(args: string[], credentialDirectory: string, input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const env = { ...process.env, CODEPILOT_CONFIG_DIR: credentialDirectory };
    delete env.DEEPSEEK_API_KEY;
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: repositoryRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("auth CLI sets, reports, and removes a credential without echoing its value", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codepilot-auth-cli-"));
  const secret = "cli-never-print-this-secret";

  const set = await runCli(["auth", "set", "deepseek"], directory, `${secret}\n`);
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stdout, /Stored deepseek credential/);
  assert.doesNotMatch(`${set.stdout}${set.stderr}`, new RegExp(secret));
  assert.equal(JSON.parse(await readFile(path.join(directory, "credentials.json"), "utf8")).providers.deepseek.apiKey, secret);

  const status = await runCli(["auth", "status", "deepseek"], directory);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /deepseek: configured \(user_store:/);
  assert.doesNotMatch(`${status.stdout}${status.stderr}`, new RegExp(secret));

  const remove = await runCli(["auth", "remove", "deepseek"], directory);
  assert.equal(remove.code, 0, remove.stderr);
  assert.match(remove.stdout, /Removed stored deepseek credential/);
  assert.doesNotMatch(`${remove.stdout}${remove.stderr}`, new RegExp(secret));

  const missing = await runCli(["auth", "status", "deepseek"], directory);
  assert.equal(missing.code, 0, missing.stderr);
  assert.match(missing.stdout, /deepseek: not configured/);
});

test("auth CLI rejects multiline piped credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codepilot-auth-cli-"));
  const result = await runCli(["auth", "set", "deepseek"], directory, "first-line\nsecond-line\n");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /exactly one line/);
  await assert.rejects(readFile(path.join(directory, "credentials.json")), { code: "ENOENT" });
});
