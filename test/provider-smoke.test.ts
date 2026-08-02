import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { runProviderSmoke, smokeConfigsFromEnvironment } from "../src/provider-smoke.js";
import type { Provider } from "../src/types.js";

function fakeProvider(onCall?: () => void): Provider {
  return {
    async complete(input) {
      onCall?.();
      if (input.toolChoice) {
        input.onEvent?.({ type: "tool_call_delta", index: 0, id: "tool-1", name: "echo_probe" });
        input.onEvent?.({ type: "tool_call_delta", index: 0, argumentsDelta: '{"value":"CODEPILOT_TOOL_OK"}' });
        input.onEvent?.({ type: "usage", usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } });
        return {
          text: "",
          toolCalls: [{ id: "tool-1", name: "echo_probe", arguments: { value: "CODEPILOT_TOOL_OK" } }],
          usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
          finishReason: "tool_calls",
        };
      }
      if (input.system.includes("cancellation")) {
        input.onEvent?.({ type: "text_delta", text: "partial" });
        input.signal?.throwIfAborted();
        throw Error("Cancellation callback did not abort the signal");
      }
      const marker = input.messages[0]?.role !== "tool"
        ? input.messages[0]?.content.match(/CODEPILOT_SMOKE_OK_[A-Z_]+/)?.[0] ?? "CODEPILOT_SMOKE_OK"
        : "CODEPILOT_SMOKE_OK";
      const usage = { inputTokens: 8, outputTokens: 3, totalTokens: 11 };
      if (input.onEvent) {
        input.onEvent({ type: "text_delta", text: marker.slice(0, 10) });
        input.onEvent({ type: "text_delta", text: marker.slice(10) });
        input.onEvent({ type: "usage", usage });
      }
      return { text: marker, toolCalls: [], usage, finishReason: "stop" };
    },
  };
}

test("runs the complete provider smoke contract without persisting secrets or response text", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-provider-smoke-test-"));
  let calls = 0;
  const report = await runProviderSmoke({
    root,
    configs: [{ name: "openai", model: "fake-model", baseUrl: "https://secret.internal/v1", apiKey: "super-secret-key" }],
    reportPath: "reports/smoke.json",
    providerFactory: () => fakeProvider(() => { calls++; }),
  });

  assert.equal(report.status, "passed");
  assert.equal(calls, 4);
  assert.deepEqual(report.providers[0]?.scenarios.map((scenario) => scenario.status), ["passed", "passed", "passed", "passed"]);
  assert.equal(report.providers[0]?.scenarios[3]?.cancellationObserved, true);
  const persisted = await readFile(path.join(root, "reports", "smoke.json"), "utf8");
  assert.doesNotMatch(persisted, /super-secret-key|secret\.internal|CODEPILOT_SMOKE_OK|CODEPILOT_TOOL_OK/);
  assert.match(persisted, /responseSha256/);
});

test("redacts live provider failure messages and skips dependent network scenarios", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-provider-smoke-failure-"));
  const progress: string[] = [];
  const provider: Provider = {
    async complete() {
      throw new Error("sensitive provider response body");
    },
  };
  const report = await runProviderSmoke({
    root,
    configs: [{ name: "deepseek", model: "fake-model", baseUrl: "https://example.invalid", apiKey: "secret" }],
    providerFactory: () => provider,
    onProgress: (message) => progress.push(message),
  });

  assert.equal(report.status, "failed");
  assert.deepEqual(report.providers[0]?.scenarios.map((scenario) => scenario.status), ["failed", "skipped", "skipped", "skipped"]);
  const persisted = await readFile(path.join(root, report.reportPath), "utf8");
  assert.doesNotMatch(persisted, /sensitive provider response body|example\.invalid|secret/);
  assert.doesNotMatch(progress.join("\n"), /sensitive provider response body|example\.invalid|secret/);
  assert.match(persisted, /"errorName": "Error"/);
});

test("selects only configured smoke providers and validates explicit selections", () => {
  const configs = smokeConfigsFromEnvironment({
    OPENAI_API_KEY: "openai-secret",
    OPENAI_MODEL: "test-openai",
  });
  assert.deepEqual(configs, [{
    name: "openai",
    apiKey: "openai-secret",
    model: "test-openai",
    baseUrl: "https://api.openai.com/v1",
  }]);
  assert.throws(
    () => smokeConfigsFromEnvironment({ CODEPILOT_SMOKE_PROVIDERS: "anthropic" }),
    /Missing ANTHROPIC_API_KEY/,
  );
  assert.throws(
    () => smokeConfigsFromEnvironment({ CODEPILOT_SMOKE_PROVIDERS: "unknown", OPENAI_API_KEY: "key" }),
    /Unknown smoke provider/,
  );
});

test("provider smoke report path cannot escape the workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-provider-smoke-path-"));
  await assert.rejects(runProviderSmoke({
    root,
    configs: [{ name: "openai", model: "fake", baseUrl: "https://example.invalid", apiKey: "secret" }],
    reportPath: "../smoke.json",
    providerFactory: () => fakeProvider(),
  }), /escapes workspace/);
});
