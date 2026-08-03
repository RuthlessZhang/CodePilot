import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { formatCommandResult, runCommand } from "../src/command-runner.js";
import { loadConfig } from "../src/config.js";
import { createTools } from "../src/tools.js";

const node = `"${process.execPath}"`;

test("streams and structures command output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-command-"));
  const chunks: string[] = [];
  const result = await runCommand({
    root,
    command: `${node} -e "console.log('runner-ok')"`,
    onOutput: (chunk) => chunks.push(chunk),
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(chunks.join(""), /runner-ok/);
  assert.match(formatCommandResult(result), /duration_ms:/);
});

test("caps captured output while continuing to stream", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-command-"));
  const chunks: string[] = [];
  const result = await runCommand({
    root,
    command: `${node} -e "console.log('x'.repeat(5000))"`,
    maxOutputChars: 1_000,
    onOutput: (chunk) => chunks.push(chunk),
  });
  assert.equal(result.truncated, true);
  assert.equal(result.output.length, 1_000);
  assert.ok(chunks.join("").length > result.output.length);
});

test("returns exit code 124 after timeout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-command-"));
  const result = await runCommand({
    root,
    command: `${node} -e "setTimeout(()=>{},5000)"`,
    timeoutMs: 100,
  });
  assert.equal(result.exitCode, 124);
  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs < 5_000);
});

test("cancels an active process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-command-"));
  const controller = new AbortController();
  const result = runCommand({
    root,
    command: `${node} -e "setTimeout(()=>{},5000)"`,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(result, (error: Error) => error.name === "AbortError");
});

test("shell tool and project config expose command limits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-command-"));
  await writeFile(path.join(root, ".codepilot.json"), JSON.stringify({
    shellTimeoutMs: 3456,
    shellMaxOutputChars: 2345,
    verificationTimeoutMs: 4567,
  }));
  const config = await loadConfig(root);
  assert.equal(config.shellTimeoutMs, 3456);
  assert.equal(config.shellMaxOutputChars, 2345);
  assert.equal(config.verificationTimeoutMs, 4567);
  const shell = createTools(root, { shellTimeoutMs: 100 }).find((tool) => tool.definition.name === "shell");
  assert.ok(shell);
  const output = await shell.execute({ command: `${node} -e "setTimeout(()=>{},5000)"` });
  assert.match(output, /exit_code: 124/);
  assert.match(output, /timed_out: true/);
});
