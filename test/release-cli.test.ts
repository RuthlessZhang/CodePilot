import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runCli(args: string[], configDirectory: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const env = { ...process.env, CODEPILOT_CONFIG_DIR: configDirectory };
    delete env.OPENAI_API_KEY;
    delete env.DEEPSEEK_API_KEY;
    delete env.ANTHROPIC_API_KEY;
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: repositoryRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("release CLI exposes version and help without a credential", async () => {
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codepilot-release-config-"));
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8"));
  const version = await runCli(["--version"], configDirectory);
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.stdout.trim(), packageJson.version);

  const help = await runCli(["--help"], configDirectory);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /Usage:/);
  assert.match(help.stdout, /codepilot doctor/);
  assert.match(help.stdout, /codepilot init/);
});

test("release CLI initializes a workspace without a credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-release-init-"));
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codepilot-release-config-"));
  const result = await runCli(["init", "--cwd", root], configDirectory);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /AGENTS\.md/);
  assert.match(
    await readFile(path.join(root, "AGENTS.md"), "utf8"),
    /^# CodePilot Project Guide/m,
  );
});

test("release CLI doctor remains available without a credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-release-doctor-"));
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), "codepilot-release-config-"));
  const result = await runCli(["doctor", "--json", "--cwd", root], configDirectory);
  assert.equal(result.code, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "error");
  assert.equal(report.credentialSource, "missing");
});
