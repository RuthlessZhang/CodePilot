import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import {
  ProviderReplayMismatchError,
  RecordingProvider,
  ReplayProvider,
  fingerprintProviderInput,
} from "../src/provider-replay.js";
import type { Provider, ProviderCompletionInput } from "../src/types.js";

function completionInput(overrides: Partial<ProviderCompletionInput> = {}): ProviderCompletionInput {
  return {
    system: "private system instructions",
    messages: [{ role: "user", content: "private source code" }],
    tools: [{
      name: "read_file",
      description: "Read a file",
      inputSchema: { properties: { path: { type: "string" } }, type: "object" },
    }],
    ...overrides,
  };
}

test("records credential-safe request fingerprints and replays provider responses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-provider-record-"));
  const trace = ".codepilot/replays/provider.jsonl";
  let calls = 0;
  const delegate: Provider = {
    async complete() {
      calls++;
      return {
        text: "inspect complete",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "src/app.ts" } }],
      };
    },
  };
  const input = completionInput();
  const recorded = await new RecordingProvider(root, trace, delegate).complete(input);
  assert.equal(calls, 1);
  assert.equal(recorded.text, "inspect complete");

  const content = await readFile(path.join(root, trace), "utf8");
  assert.doesNotMatch(content, /private system instructions|private source code/);
  assert.match(content, /inspect complete/);
  const record = JSON.parse(content.trim());
  assert.equal(record.request.sha256, fingerprintProviderInput(input).sha256);
  assert.equal(record.request.messageCount, 1);
  assert.equal(record.request.toolCount, 1);

  const replayInput = completionInput({
    tools: [{
      name: "read_file",
      description: "Read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
    }],
  });
  const replay = new ReplayProvider(root, trace);
  assert.deepEqual(await replay.complete(replayInput), recorded);
  assert.deepEqual(replay.getProgress(), { consumed: 1 });
  await assert.rejects(replay.complete(replayInput), /replay exhausted/);

  await new RecordingProvider(root, trace, delegate).complete(input);
  const appended = (await readFile(path.join(root, trace), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(appended.map((item) => item.sequence), [1, 2]);
});

test("fails closed when replay input differs from the recorded interaction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-provider-mismatch-"));
  const trace = "provider.jsonl";
  const delegate: Provider = { async complete() { return { text: "done", toolCalls: [] }; } };
  await new RecordingProvider(root, trace, delegate).complete(completionInput());
  const replay = new ReplayProvider(root, trace);
  await assert.rejects(
    replay.complete(completionInput({ messages: [{ role: "user", content: "different task" }] })),
    (error: Error) => error instanceof ProviderReplayMismatchError && /interaction 1/.test(error.message),
  );
  assert.deepEqual(replay.getProgress(), { consumed: 0 });
});

test("new traces fail closed when the per-request output limit changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-provider-limit-mismatch-"));
  const trace = "provider-limit.jsonl";
  const delegate: Provider = { async complete() { return { text: "done", toolCalls: [] }; } };
  await new RecordingProvider(root, trace, delegate).complete(completionInput({ maxOutputTokens: 500 }));

  await assert.rejects(
    new ReplayProvider(root, trace).complete(completionInput({ maxOutputTokens: 250 })),
    /output limit mismatch/,
  );
});

test("records and deterministically replays final provider failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-provider-error-"));
  const trace = "provider-error.jsonl";
  const delegate: Provider = {
    async complete() {
      const error = new Error("simulated outage");
      error.name = "ProviderTimeoutError";
      throw error;
    },
  };
  await assert.rejects(new RecordingProvider(root, trace, delegate).complete(completionInput()), (error: Error) => {
    return error.name === "ProviderTimeoutError" && error.message === "simulated outage";
  });
  await assert.rejects(new ReplayProvider(root, trace).complete(completionInput()), (error: Error) => {
    return error.name === "ProviderTimeoutError" && error.message === "simulated outage";
  });
});

test("rejects provider traces outside the workspace and malformed recordings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-provider-path-"));
  assert.throws(() => new ReplayProvider(root, "../trace.jsonl"), /escapes workspace/);
  await writeFile(path.join(root, "invalid.jsonl"), "not json\n");
  await assert.rejects(new ReplayProvider(root, "invalid.jsonl").complete(completionInput()), /line 1/);
});

test("records and replays provider stream events in order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-provider-stream-replay-"));
  const trace = "provider-stream.jsonl";
  const delegate: Provider = {
    async complete(input) {
      input.onEvent?.({ type: "text_delta", text: "hel" });
      input.onEvent?.({ type: "text_delta", text: "lo" });
      input.onEvent?.({ type: "usage", usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } });
      return { text: "hello", toolCalls: [], usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
    },
  };
  const recordedEvents: unknown[] = [];
  await new RecordingProvider(root, trace, delegate).complete(completionInput({ onEvent: (event) => recordedEvents.push(event) }));
  const replayedEvents: unknown[] = [];
  const result = await new ReplayProvider(root, trace).complete(completionInput({ onEvent: (event) => replayedEvents.push(event) }));

  assert.deepEqual(replayedEvents, recordedEvents);
  assert.equal(result.text, "hello");
  assert.equal(result.usage?.totalTokens, 3);
});
