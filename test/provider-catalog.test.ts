import test from "node:test";
import assert from "node:assert/strict";
import {
  inferProviderFromEnvironment,
  providerDefinition,
  resolveProviderCapabilities,
} from "../src/provider-catalog.js";

test("centralizes provider defaults and environment inference", () => {
  assert.equal(providerDefinition("deepseek").defaultModel, "deepseek-v4-pro");
  assert.equal(providerDefinition("anthropic").apiKeyEnv, "ANTHROPIC_API_KEY");
  assert.equal(inferProviderFromEnvironment({ OPENAI_API_KEY: "openai" }), "openai");
  assert.equal(inferProviderFromEnvironment({ ANTHROPIC_API_KEY: "anthropic", OPENAI_API_KEY: "openai" }), "anthropic");
  assert.equal(inferProviderFromEnvironment({ DEEPSEEK_API_KEY: "deepseek", ANTHROPIC_API_KEY: "anthropic" }), "deepseek");
});

test("describes adapter behavior separately from model context limits", () => {
  const deepSeek = resolveProviderCapabilities("deepseek", "deepseek-v4-pro");
  assert.equal(deepSeek.thinkingMode, "default");
  assert.equal(deepSeek.reasoningToolContinuation, true);
  assert.equal(deepSeek.forcedToolChoiceInThinking, false);
  assert.equal(resolveProviderCapabilities("deepseek", "custom-model").thinkingMode, "optional");
  assert.equal(resolveProviderCapabilities("openai", "gpt-4.1").forcedToolChoice, true);
});
