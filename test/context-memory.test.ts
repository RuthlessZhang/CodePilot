import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { packContext } from "../src/context-manager.js";
import { loadConfig } from "../src/config.js";
import { loadRelevantMemory, readMemory, remember } from "../src/memory.js";
import { resolveModelContextProfile } from "../src/model-context.js";
import { createTools } from "../src/tools.js";
import type { Message, ToolDef } from "../src/types.js";

test("resolves model context profiles and clamps configured input budget", async () => {
  assert.deepEqual(resolveModelContextProfile("openai", "gpt-4.1"), {
    contextWindowTokens: 1_047_576,
    modelMaxOutputTokens: 32_768,
    source: "model",
  });
  assert.equal(resolveModelContextProfile("anthropic", "claude-sonnet-4-5").contextWindowTokens, 200_000);
  assert.equal(resolveModelContextProfile("deepseek", "deepseek-v4-pro").contextWindowTokens, 1_000_000);

  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-context-config-"));
  await writeFile(path.join(root, ".codepilot.json"), JSON.stringify({
    provider: "openai",
    model: "gpt-4.1",
    contextWindowTokens: 10_000,
    contextBudgetTokens: 50_000,
    maxOutputTokens: 2_000,
    contextSafetyMarginTokens: 1_000,
  }));
  const config = await loadConfig(root);
  assert.equal(config.contextWindowTokens, 10_000);
  assert.equal(config.maxOutputTokens, 2_000);
  assert.equal(config.contextSafetyMarginTokens, 1_000);
  assert.equal(config.contextBudgetTokens, 7_000);
});

test("packs model reserves, tool schemas, named system sections, and pruned tool results", () => {
  const tools: ToolDef[] = [{
    name: "read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  }];
  const messages: Message[] = [
    { role: "user", content: "old request" },
    { role: "assistant", content: "", toolCalls: [{ id: "one", name: "read_file", arguments: { path: "old.ts" } }] },
    { role: "tool", name: "read_file", toolCallId: "one", content: "x".repeat(4_000) },
    { role: "user", content: "middle request" },
    { role: "assistant", content: "", toolCalls: [{ id: "two", name: "read_file", arguments: { path: "new.ts" } }] },
    { role: "tool", name: "read_file", toolCallId: "two", content: "y".repeat(4_000) },
    { role: "user", content: "latest request" },
  ];
  const packed = packContext({
    text: "",
    sections: [
      { name: "base", content: "base ".repeat(300) },
      { name: "memory", content: "memory ".repeat(300) },
      { name: "workspaceContext", content: "code ".repeat(300) },
    ],
  }, messages, 10_000, {
    contextWindowTokens: 8_000,
    outputReserveTokens: 1_000,
    safetyMarginTokens: 1_000,
    toolDefinitions: tools,
    toolResultMaxTokens: 300,
    oldToolResultMaxTokens: 80,
    recentToolResults: 1,
  });

  assert.equal(packed.report.inputBudgetTokens, 6_000);
  assert.equal(packed.report.outputReserveTokens, 1_000);
  assert.equal(packed.report.safetyMarginTokens, 1_000);
  assert.ok(packed.report.toolDefinitionTokens > 0);
  assert.ok(packed.report.systemSectionTokens.base > 0);
  assert.ok(packed.report.systemSectionTokens.memory > 0);
  assert.ok(packed.report.prunedToolMessages >= 2);
  assert.ok(packed.report.totalTokens <= packed.report.inputBudgetTokens);
  assert.notEqual(packed.messages[0]?.role, "tool");
});

test("migrates legacy memory and loads only task-relevant topic files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-memory-v2-"));
  await mkdir(path.join(root, ".codepilot"), { recursive: true });
  await writeFile(path.join(root, ".codepilot", "memory.md"), "- legacy preference: keep edits focused\n");

  await remember(root, "architecture: keep provider adapters behind one interface");
  await remember(root, "commands: run npm test before release");

  const index = await readMemory(root);
  assert.match(index, /codepilot-memory-v2/);
  assert.match(index, /architecture/);
  assert.match(index, /commands/);
  assert.match(await readFile(path.join(root, ".codepilot", "memory", "general.md"), "utf8"), /legacy preference/);
  assert.match(await readFile(path.join(root, ".codepilot", "memory", "architecture.md"), "utf8"), /provider adapters/);

  const architecture = await loadRelevantMemory(root, "refactor the architecture and provider design");
  assert.ok(architecture.some((block) => block.source.endsWith("architecture.md")));
  assert.ok(!architecture.some((block) => block.source.endsWith("commands.md")));
  const unrelated = await loadRelevantMemory(root, "translate a poem");
  assert.deepEqual(unrelated.map((block) => block.source), [".codepilot/memory.md"]);
});

test("exposes approved memory read and write tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-memory-tools-"));
  const tools = createTools(root);
  const write = tools.find((tool) => tool.definition.name === "memory_write");
  const read = tools.find((tool) => tool.definition.name === "memory_read");
  assert.equal(write?.risk, "write");
  assert.equal(read?.risk, "read");
  assert.match(await write!.execute({ topic: "debugging", note: "inspect the failing assertion first" }), /debugging/);
  assert.match(await read!.execute({ query: "debug this failure" }), /failing assertion/);
});
