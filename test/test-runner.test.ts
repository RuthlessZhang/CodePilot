import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runTestRunner(target: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const env = {
      ...process.env,
      CODEPILOT_CONFIG_DIR: "must-not-leak",
      OPENAI_API_KEY: "must-not-leak",
      DEEPSEEK_API_KEY: "must-not-leak",
      ANTHROPIC_API_KEY: "must-not-leak",
    };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ["scripts/run-tests.mjs", target], {
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

test("test runner executes only requested files in an isolated credential environment", async (t) => {
  const relative = path.join("test", `.runner-probe-${process.pid}-${Date.now()}.test.ts`);
  const absolute = path.join(repositoryRoot, relative);
  t.after(() => rm(absolute, { force: true }));
  await writeFile(absolute, [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'test("isolated credential probe", () => {',
    '  assert.match(process.env.CODEPILOT_CONFIG_DIR ?? "", /codepilot-test-config-/);',
    '  assert.equal(process.env.OPENAI_API_KEY, undefined);',
    '  assert.equal(process.env.DEEPSEEK_API_KEY, undefined);',
    '  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);',
    '});',
  ].join("\n"));

  const result = await runTestRunner(relative);
  assert.equal(result.code, 0, result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /isolated credential probe/);
  assert.match(output, /tests 1/);
  assert.doesNotMatch(output, /release CLI exposes version/);
});
