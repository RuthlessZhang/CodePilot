import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { Agent } from "../src/agent.js";
import {
  clearRunCheckpoint,
  readRunCheckpoint,
  runCheckpointPath,
  writeRunCheckpoint,
} from "../src/run-checkpoint.js";
import { createSessionId, loadSession, saveSession } from "../src/sessions.js";
import type { Provider, Tool } from "../src/types.js";

function checkpoint(runId: string, sessionId: string) {
  return {
    runId,
    sessionId,
    phase: "tool" as const,
    messageCount: 2,
    progress: { step: 1, modelSteps: 1, toolCalls: 1, totalTokens: 25 },
    tool: { id: "call-1", name: "read_file", index: 0, total: 1, state: "running" as const },
  };
}

test("atomically stores privacy-safe run checkpoints and clears them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-checkpoint-"));
  const sessionId = createSessionId();
  const value = await writeRunCheckpoint(root, checkpoint("run-1", sessionId));

  assert.equal(value.phase, "tool");
  assert.deepEqual(await readRunCheckpoint(root, sessionId), value);
  const content = await readFile(runCheckpointPath(root, sessionId), "utf8");
  assert.doesNotMatch(content, /prompt|arguments|source code|api.?key/i);
  assert.equal(await clearRunCheckpoint(root, sessionId), true);
  assert.equal(await readRunCheckpoint(root, sessionId), undefined);
});

test("checkpoints model and active tool phases while persisting protocol messages", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-checkpoint-agent-"));
  let modelCalls = 0;
  let modelPhase = "";
  let toolPhase = "";
  let assistantWasDurable = false;
  let agent!: Agent;
  const provider: Provider = {
    async complete() {
      modelCalls++;
      modelPhase = (await readRunCheckpoint(root, agent.getSessionId()))?.phase ?? "";
      return modelCalls === 1
        ? { text: "", toolCalls: [{ id: "call-1", name: "probe", arguments: {} }], usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
        : { text: "done", toolCalls: [], usage: { inputTokens: 13, outputTokens: 1, totalTokens: 14 } };
    },
  };
  const tool: Tool = {
    definition: { name: "probe", description: "Probe checkpoint state", inputSchema: { type: "object" } },
    risk: "read",
    async execute() {
      const active = await readRunCheckpoint(root, agent.getSessionId());
      toolPhase = `${active?.phase}:${active?.tool?.state}`;
      const durable = await loadSession(root, agent.getSessionId());
      assistantWasDurable = durable?.some((message) => message.role === "assistant" && message.toolCalls?.[0]?.id === "call-1") ?? false;
      return "observed";
    },
  };
  agent = new Agent({
    root,
    provider,
    tools: [tool],
    approve: async () => true,
    maxSteps: 3,
    contextBudgetTokens: 64_000,
    mode: "build",
    autoVerify: false,
  });

  assert.equal(await agent.run("inspect checkpoint transitions"), "done");
  assert.equal(modelPhase, "model");
  assert.equal(toolPhase, "tool:running");
  assert.equal(assistantWasDurable, true);
  assert.equal(await readRunCheckpoint(root, agent.getSessionId()), undefined);
});

test("recovers an interrupted active tool without replaying it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-checkpoint-recover-"));
  const sessionId = createSessionId();
  const createdAt = new Date().toISOString();
  await saveSession(root, sessionId, createdAt, [
    { role: "user", content: "inspect" },
    { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }] },
  ]);
  await writeRunCheckpoint(root, checkpoint("run-interrupted", sessionId));
  let providerCalls = 0;
  const provider: Provider = {
    async complete() {
      providerCalls++;
      return { text: "done", toolCalls: [] };
    },
  };
  const agent = new Agent({
    root,
    provider,
    tools: [],
    approve: async () => true,
    maxSteps: 2,
    contextBudgetTokens: 64_000,
    mode: "build",
  });

  assert.equal(await agent.load(sessionId), true);
  assert.equal(providerCalls, 0);
  assert.equal(agent.getLastRecoveryNotice()?.recoveredToolCalls, 1);
  const messages = await loadSession(root, sessionId);
  const recovered = messages?.at(-1);
  assert.equal(recovered?.role, "tool");
  assert.match(recovered?.content ?? "", /outcome is unknown|inspect the workspace/i);
  assert.equal(await readRunCheckpoint(root, sessionId), undefined);
});

test("cancellation during an active tool preserves an ambiguity marker", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-checkpoint-cancel-"));
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const provider: Provider = {
    async complete() {
      return { text: "", toolCalls: [{ id: "call-cancel", name: "slow_tool", arguments: {} }] };
    },
  };
  const tool: Tool = {
    definition: { name: "slow_tool", description: "Wait", inputSchema: { type: "object" } },
    risk: "execute",
    async execute(_args, context) {
      markStarted();
      return await new Promise<string>((_resolve, reject) => {
        context?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      });
    },
  };
  const agent = new Agent({
    root,
    provider,
    tools: [tool],
    approve: async () => true,
    maxSteps: 2,
    contextBudgetTokens: 64_000,
    mode: "build",
    autoVerify: false,
  });

  const running = agent.run("run a slow tool");
  await started;
  agent.cancel();
  await assert.rejects(running, (error: Error) => error.name === "AbortError");
  const messages = await loadSession(root, agent.getSessionId());
  assert.equal(messages?.at(-1)?.role, "tool");
  assert.match(messages?.at(-1)?.content ?? "", /outcome is unknown/i);
  assert.equal(agent.getLastRecoveryNotice()?.recoveredToolCalls, 1);
  assert.equal(await readRunCheckpoint(root, agent.getSessionId()), undefined);
});
