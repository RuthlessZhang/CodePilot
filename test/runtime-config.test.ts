import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { JsonlRuntimeAudit } from "../src/runtime-audit.js";
import { createProtectedPathsHook } from "../src/runtime-config.js";
import { RuntimeEventBus } from "../src/runtime-events.js";

test("JSONL runtime audit preserves metadata while redacting prompts, code, and secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-audit-"));
  const audit = new JsonlRuntimeAudit(root);
  const bus = new RuntimeEventBus({ onEvent: (event) => audit.record(event) });

  await bus.emit({
    name: "run.started",
    runId: "run-audit",
    sessionId: "session-audit",
    data: { prompt: "implement secret feature", mode: "build" },
  });
  await bus.emit({
    name: "tool.requested",
    runId: "run-audit",
    sessionId: "session-audit",
    data: {
      name: "write_file",
      risk: "write",
      args: { path: "src/a.ts", content: "export const value = 1;", apiKey: "do-not-store", token: "hidden" },
    },
  });
  await bus.emit({
    name: "context.prepared",
    runId: "run-audit",
    sessionId: "session-audit",
    data: { step: 1, budgetTokens: 64000, totalTokens: 1200, keptMessages: 2, omittedMessages: 0 },
  });

  const records = (await readFile(audit.file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 3);
  assert.equal(records[0].sequence, 1);
  assert.equal(records[1].sequence, 2);
  assert.equal(records[0].data.prompt.redacted, true);
  assert.equal(records[0].data.prompt.length, "implement secret feature".length);
  assert.equal(records[1].data.args.path, "src/a.ts");
  assert.equal(records[1].data.args.content.redacted, true);
  assert.equal(records[1].data.args.apiKey, "[REDACTED]");
  assert.equal(records[1].data.args.token, "[REDACTED]");
  assert.equal(records[2].data.budgetTokens, 64000);
  assert.equal(records[2].data.totalTokens, 1200);
  assert.doesNotMatch(await readFile(audit.file, "utf8"), /do-not-store|secret feature|export const/);
});

test("runtime audit path cannot escape the workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-audit-"));
  assert.throws(() => new JsonlRuntimeAudit(root, "../audit.jsonl"), /escapes workspace/);
});

test("protected path hook blocks direct and patch-based edits", async () => {
  const bus = new RuntimeEventBus({ hooks: [createProtectedPathsHook(["generated/**", "docs/*.md"])] });
  const direct = await bus.emit({
    name: "edit.preparing",
    runId: "run-protect",
    sessionId: "session-protect",
    data: { tool: "write_file", args: { path: "generated/client.ts" } },
  });
  const patchResult = await bus.emit({
    name: "edit.preparing",
    runId: "run-protect",
    sessionId: "session-protect",
    data: {
      tool: "apply_patch",
      args: { patch: "*** Begin Patch\n*** Update File: docs/api.md\n@@\n-old\n+new\n*** End Patch" },
    },
  });
  const allowed = await bus.emit({
    name: "edit.preparing",
    runId: "run-protect",
    sessionId: "session-protect",
    data: { tool: "write_file", args: { path: "src/client.ts" } },
  });

  assert.match(direct.denied?.reason ?? "", /generated\/client\.ts/);
  assert.match(patchResult.denied?.reason ?? "", /docs\/api\.md/);
  assert.equal(allowed.denied, undefined);
});

test("loads validated runtime audit and protected path configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-config-"));
  await writeFile(path.join(root, ".codepilot.json"), JSON.stringify({
    runtimeAudit: false,
    runtimeAuditPath: ".codepilot/custom-audit.jsonl",
    runtimeHookTimeoutMs: 1,
    providerRecordPath: ".codepilot/replays/latest.jsonl",
    maxRunInputTokens: 500_000,
    maxRunOutputTokens: 25_000,
    maxRunTotalTokens: 525_000,
    protectedPaths: ["generated/**", "", "generated/**", 42],
  }));

  const config = await loadConfig(root);
  assert.equal(config.runtimeAudit, false);
  assert.equal(config.runtimeAuditPath, ".codepilot/custom-audit.jsonl");
  assert.equal(config.runtimeHookTimeoutMs, 10);
  assert.equal(config.providerRecordPath, ".codepilot/replays/latest.jsonl");
  assert.equal(config.providerReplayPath, undefined);
  assert.equal(config.maxRunInputTokens, 500_000);
  assert.equal(config.maxRunOutputTokens, 25_000);
  assert.equal(config.maxRunTotalTokens, 525_000);
  assert.deepEqual(config.protectedPaths, ["generated/**"]);
});

test("rejects simultaneous provider record and replay modes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-config-replay-"));
  await writeFile(path.join(root, ".codepilot.json"), JSON.stringify({
    providerRecordPath: ".codepilot/replays/record.jsonl",
    providerReplayPath: ".codepilot/replays/replay.jsonl",
  }));
  await assert.rejects(loadConfig(root), /mutually exclusive/);
});

test("autoVerify defaults to true and rejects non-boolean values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-autoverify-"));
  // default (no file)
  assert.equal((await loadConfig(root)).autoVerify, true);
  // explicit true
  await writeFile(path.join(root, ".codepilot.json"), JSON.stringify({ autoVerify: true }));
  assert.equal((await loadConfig(root)).autoVerify, true);
  // explicit false
  await writeFile(path.join(root, ".codepilot.json"), JSON.stringify({ autoVerify: false }));
  assert.equal((await loadConfig(root)).autoVerify, false);
  // non-boolean string
  await writeFile(path.join(root, ".codepilot.json"), JSON.stringify({ autoVerify: "yes" }));
  await assert.rejects(loadConfig(root), /Expected boolean, got string/);
  // number
  await writeFile(path.join(root, ".codepilot.json"), JSON.stringify({ autoVerify: 1 }));
  await assert.rejects(loadConfig(root), /Expected boolean, got number/);
});

test("maxVerificationAttempts defaults to 3 and bounds values 1–10", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-maxverify-"));
  // default (no file)
  assert.equal((await loadConfig(root)).maxVerificationAttempts, 3);
  // explicit valid
  await writeFile(path.join(root, ".codepilot.json"), JSON.stringify({ maxVerificationAttempts: 5 }));
  assert.equal((await loadConfig(root)).maxVerificationAttempts, 5);
  // lower bound (1)
  await writeFile(path.join(root, ".codepilot.json"), JSON.stringify({ maxVerificationAttempts: 1 }));
  assert.equal((await loadConfig(root)).maxVerificationAttempts, 1);
  // upper bound (10)
  await writeFile(path.join(root, ".codepilot.json"), JSON.stringify({ maxVerificationAttempts: 10 }));
  assert.equal((await loadConfig(root)).maxVerificationAttempts, 10);
  // below minimum clamps to 1
  await writeFile(path.join(root, ".codepilot.json"), JSON.stringify({ maxVerificationAttempts: 0 }));
  assert.equal((await loadConfig(root)).maxVerificationAttempts, 1);
  // above maximum clamps to 10
  await writeFile(path.join(root, ".codepilot.json"), JSON.stringify({ maxVerificationAttempts: 100 }));
  assert.equal((await loadConfig(root)).maxVerificationAttempts, 10);
});
