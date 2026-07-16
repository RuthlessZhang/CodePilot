import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { Agent } from "../src/agent.js";
import { RuntimeEventBus, type RuntimeEventName } from "../src/runtime-events.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { createTools } from "../src/tools.js";
import type { Provider } from "../src/types.js";

function writingProvider(file: string): Provider {
  let calls = 0;
  return {
    async complete() {
      return ++calls === 1
        ? { text: "", toolCalls: [{ id: "write", name: "write_file", arguments: { path: file, content: "ok\n" } }] }
        : { text: "done", toolCalls: [] };
    },
  };
}

test("Agent emits ordered kernel lifecycle events through a ToolRegistry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-kernel-"));
  const events: Array<{ name: RuntimeEventName; sequence: number }> = [];
  const runtimeEvents = new RuntimeEventBus({
    onEvent: (event) => events.push({ name: event.name, sequence: event.sequence }),
  });
  const agent = new Agent({
    root,
    provider: writingProvider("note.txt"),
    tools: new ToolRegistry(createTools(root)),
    approve: async () => true,
    maxSteps: 3,
    contextBudgetTokens: 64000,
    mode: "build",
    runtimeEvents,
  });

  assert.equal(await agent.run("write a note"), "done");
  assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "ok\n");
  assert.deepEqual(events.map((event) => event.sequence), events.map((_event, index) => index + 1));
  assert.deepEqual(events.map((event) => event.name).filter((name) => [
    "run.started", "tool.requested", "tool.authorizing", "edit.preparing", "tool.started",
    "edit.applied", "tool.completed", "run.completed",
  ].includes(name)), [
    "run.started", "tool.requested", "tool.authorizing", "edit.preparing", "tool.started",
    "edit.applied", "tool.completed", "run.completed",
  ]);
});

test("edit hooks can deny a write but cannot bypass the normal permission gate", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-hook-"));
  let approvals = 0;
  const names: RuntimeEventName[] = [];
  const runtimeEvents = new RuntimeEventBus({
    onEvent: (event) => names.push(event.name),
    hooks: [{
      name: "protect-generated",
      events: ["edit.preparing"],
      handle: () => ({ deny: "generated files are protected" }),
    }],
  });
  const agent = new Agent({
    root,
    provider: writingProvider("generated.ts"),
    tools: createTools(root),
    approve: async () => { approvals++; return true; },
    maxSteps: 3,
    contextBudgetTokens: 64000,
    mode: "build",
    runtimeEvents,
  });

  assert.equal(await agent.run("write generated code"), "done");
  assert.equal(approvals, 1);
  await assert.rejects(readFile(path.join(root, "generated.ts"), "utf8"));
  assert.ok(names.includes("edit.preparing"));
  assert.ok(names.includes("tool.failed"));
  assert.ok(!names.includes("tool.started"));
});
