import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { Agent, AgentBudgetError, type AgentRunStats } from "../src/agent.js";
import { captureGitPatch, runHeadless } from "../src/headless.js";
import { nonInteractiveApproval } from "../src/permissions.js";
import { createTools } from "../src/tools.js";
import type { Provider } from "../src/types.js";

const execFileAsync = promisify(execFile);

class FakeAgent {
  cancelled = false;

  constructor(
    private implementation: () => Promise<string>,
    private stats: AgentRunStats = { modelSteps: 1, toolCalls: 0, verificationStatus: "passed" },
  ) {}

  run() {
    return this.implementation();
  }

  cancel() {
    this.cancelled = true;
    return true;
  }

  getSessionId() {
    return "session-test";
  }

  getLastRunStats() {
    return this.stats;
  }
}

test("writes a machine-readable headless result and patch artifact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-headless-"));
  const agent = new FakeAgent(async () => "completed task");
  const result = await runHeadless({
    root,
    task: "fix the bug",
    agent,
    maxRuntimeMs: 1000,
    maxSteps: 20,
    maxToolCalls: 50,
    resultPath: "artifacts/result.json",
    patchPath: "artifacts/result.patch",
    capturePatch: async () => ({ available: true, patch: "diff --git a/a b/a\n" }),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.artifact.patchAvailable, true);
  assert.match(await readFile(path.join(root, "artifacts", "result.json"), "utf8"), /"status": "completed"/);
  assert.equal(await readFile(path.join(root, "artifacts", "result.patch"), "utf8"), "diff --git a/a b/a\n");
});

test("maps skipped verification and budget failures to stable headless exit codes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-headless-status-"));
  const incomplete = await runHeadless({
    root,
    task: "edit",
    agent: new FakeAgent(async () => "checks unavailable", { modelSteps: 1, toolCalls: 1, verificationStatus: "skipped" }),
    maxRuntimeMs: 1000,
    maxSteps: 3,
    maxToolCalls: 3,
    capturePatch: async () => ({ available: false, patch: "", error: "not a repository" }),
  });
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.exitCode, 3);

  const missingPatch = await runHeadless({
    root,
    task: "edit",
    agent: new FakeAgent(async () => "done"),
    maxRuntimeMs: 1000,
    maxSteps: 3,
    maxToolCalls: 3,
    capturePatch: async () => ({ available: false, patch: "", error: "not a repository" }),
  });
  assert.equal(missingPatch.status, "incomplete");
  assert.equal(missingPatch.exitCode, 3);

  const budget = await runHeadless({
    root,
    task: "edit",
    agent: new FakeAgent(async () => { throw new AgentBudgetError("tool_calls", 3); }),
    maxRuntimeMs: 1000,
    maxSteps: 3,
    maxToolCalls: 3,
    capturePatch: async () => ({ available: false, patch: "" }),
  });
  assert.equal(budget.status, "budget_exceeded");
  assert.equal(budget.exitCode, 2);
});

test("cancels a headless task when its runtime budget expires", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-headless-timeout-"));
  let rejectRun: ((error: Error) => void) | undefined;
  const agent = new FakeAgent(() => new Promise((_resolve, reject) => {
    rejectRun = reject;
  }));
  agent.cancel = () => {
    agent.cancelled = true;
    const error = new Error("cancelled");
    error.name = "AbortError";
    rejectRun?.(error);
    return true;
  };

  const result = await runHeadless({
    root,
    task: "slow task",
    agent,
    maxRuntimeMs: 20,
    maxSteps: 3,
    maxToolCalls: 3,
    capturePatch: async () => ({ available: false, patch: "" }),
  });
  assert.equal(result.status, "timeout");
  assert.equal(result.exitCode, 124);
  assert.equal(agent.cancelled, true);
});

test("captures tracked changes and untracked files without mutating the Git index", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-headless-git-"));
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "codepilot@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "CodePilot Test"], { cwd: root });
  await writeFile(path.join(root, "tracked.txt"), "before\n");
  await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "base"], { cwd: root });
  await writeFile(path.join(root, "tracked.txt"), "after\n");
  await writeFile(path.join(root, "new.txt"), "new file\n");
  await mkdir(path.join(root, ".codepilot"));
  await writeFile(path.join(root, ".codepilot", "session.json"), "{}\n");

  const captured = await captureGitPatch(root);
  assert.equal(captured.available, true, captured.error);
  assert.match(captured.patch, /tracked\.txt/);
  assert.match(captured.patch, /new\.txt/);
  assert.doesNotMatch(captured.patch, /session\.json/);
  const status = await execFileAsync("git", ["status", "--short"], { cwd: root });
  assert.match(status.stdout, / M tracked\.txt/);
  assert.match(status.stdout, /\?\? new\.txt/);
});

test("enforces the Agent tool-call budget and headless permissions fail closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-headless-agent-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  const provider: Provider = {
    async complete() {
      return {
        text: "",
        toolCalls: [
          { id: "one", name: "read_file", arguments: { path: "src/a.ts" } },
          { id: "two", name: "read_file", arguments: { path: "src/a.ts" } },
        ],
      };
    },
  };
  const agent = new Agent({
    root,
    provider,
    tools: createTools(root),
    approve: async () => true,
    maxSteps: 3,
    maxToolCalls: 1,
    contextBudgetTokens: 64000,
    mode: "build",
    autoVerify: false,
  });
  await assert.rejects(agent.run("inspect twice"), (error: Error) => error instanceof AgentBudgetError);
  assert.equal(agent.getLastRunStats()?.toolCalls, 1);

  const approve = nonInteractiveApproval(["read"], { apply_patch: "ask", shell: "deny" });
  assert.equal(await approve("read", "read_file", {}), true);
  assert.equal(await approve("write", "apply_patch", {}), false);
  assert.equal(await approve("execute", "shell", { command: "npm test" }), false);
});
