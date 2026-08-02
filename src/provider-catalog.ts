import type { ProviderName } from "./model-context.js";

export type ProviderCapabilities = {
  streaming: boolean;
  streamingUsage: boolean;
  normalizedUsage: boolean;
  forcedToolChoice: boolean;
  thinkingMode: "none" | "optional" | "default";
  reasoningContent: boolean;
  reasoningToolContinuation: boolean;
  forcedToolChoiceInThinking: boolean;
  promptCacheUsage: boolean;
};

export type ProviderDefinition = {
  name: ProviderName;
  defaultModel: string;
  defaultBaseUrl: string;
  apiKeyEnv: string;
  modelEnv: string;
  baseUrlEnv: string;
};

export const providerNames = ["openai", "anthropic", "deepseek"] as const satisfies readonly ProviderName[];

const definitions: Record<ProviderName, ProviderDefinition> = {
  openai: {
    name: "openai",
    defaultModel: "gpt-4.1",
    defaultBaseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    modelEnv: "OPENAI_MODEL",
    baseUrlEnv: "OPENAI_BASE_URL",
  },
  anthropic: {
    name: "anthropic",
    defaultModel: "claude-sonnet-4-5",
    defaultBaseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    modelEnv: "ANTHROPIC_MODEL",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
  },
  deepseek: {
    name: "deepseek",
    defaultModel: "deepseek-v4-pro",
    defaultBaseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    modelEnv: "DEEPSEEK_MODEL",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
  },
};

const adapterCapabilities: Record<ProviderName, ProviderCapabilities> = {
  openai: {
    streaming: true,
    streamingUsage: true,
    normalizedUsage: true,
    forcedToolChoice: true,
    thinkingMode: "none",
    reasoningContent: false,
    reasoningToolContinuation: false,
    forcedToolChoiceInThinking: true,
    promptCacheUsage: true,
  },
  anthropic: {
    streaming: true,
    streamingUsage: true,
    normalizedUsage: true,
    forcedToolChoice: true,
    thinkingMode: "none",
    reasoningContent: false,
    reasoningToolContinuation: false,
    forcedToolChoiceInThinking: true,
    promptCacheUsage: true,
  },
  deepseek: {
    streaming: true,
    streamingUsage: true,
    normalizedUsage: true,
    forcedToolChoice: true,
    thinkingMode: "optional",
    reasoningContent: true,
    reasoningToolContinuation: true,
    forcedToolChoiceInThinking: false,
    promptCacheUsage: true,
  },
};

export function providerDefinition(name: ProviderName) {
  return definitions[name];
}

export function inferProviderFromEnvironment(env: NodeJS.ProcessEnv = process.env): ProviderName {
  if (env[definitions.deepseek.apiKeyEnv]) return "deepseek";
  if (env[definitions.anthropic.apiKeyEnv]) return "anthropic";
  return "openai";
}

/** Capabilities describe CodePilot's adapter behavior, not every feature exposed by the vendor API. */
export function resolveProviderCapabilities(provider: ProviderName, model: string): ProviderCapabilities {
  const base = adapterCapabilities[provider];
  if (provider === "deepseek" && /^deepseek-v4-(?:flash|pro)(?:-|$)/i.test(model)) {
    return { ...base, thinkingMode: "default" };
  }
  return { ...base };
}
