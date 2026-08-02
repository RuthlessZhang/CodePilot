import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveModelContextProfile, type ProviderName } from "./model-context.js";
import type { Risk } from "./types.js";

export type { ProviderName } from "./model-context.js";
export type PermissionDecision = "allow" | "ask" | "deny";
export type PermissionPolicy = Record<string, PermissionDecision>;

export type Config = {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl: string;
  maxSteps: number;
  maxToolCalls: number;
  maxRunInputTokens: number;
  maxRunOutputTokens: number;
  maxRunTotalTokens: number;
  headlessMaxRuntimeMs: number;
  contextWindowTokens: number;
  contextBudgetTokens: number;
  maxOutputTokens: number;
  contextSafetyMarginTokens: number;
  toolResultMaxTokens: number;
  oldToolResultMaxTokens: number;
  memoryIndexMaxTokens: number;
  memoryTopicMaxTokens: number;
  memoryTopicLimit: number;
  autoVerify: boolean;
  maxVerificationAttempts: number;
  providerMaxRetries: number;
  providerRequestTimeoutMs: number;
  providerRecordPath?: string;
  providerReplayPath?: string;
  shellTimeoutMs: number;
  shellMaxOutputChars: number;
  autoApprove: Risk[];
  permissions: PermissionPolicy;
  runtimeAudit: boolean;
  runtimeAuditPath: string;
  runtimeHookTimeoutMs: number;
  protectedPaths: string[];
};

const defaults: Record<
  ProviderName,
  {
    model: string;
    apiKeyEnv: string;
    modelEnv: string;
    baseUrlEnv: string;
    baseUrl: string;
  }
> = {
  openai: {
    model: "gpt-4.1",
    apiKeyEnv: "OPENAI_API_KEY",
    modelEnv: "OPENAI_MODEL",
    baseUrlEnv: "OPENAI_BASE_URL",
    baseUrl: "https://api.openai.com/v1",
  },
  anthropic: {
    model: "claude-sonnet-4-5",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    modelEnv: "ANTHROPIC_MODEL",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    baseUrl: "https://api.anthropic.com",
  },
  deepseek: {
    model: "deepseek-v4-pro",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    modelEnv: "DEEPSEEK_MODEL",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    baseUrl: "https://api.deepseek.com",
  },
};

function inferProvider(): ProviderName {
  if (process.env.DEEPSEEK_API_KEY) return "deepseek";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "openai";
}

function permissionPolicy(value: unknown): PermissionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, PermissionDecision] =>
        entry[1] === "allow" || entry[1] === "ask" || entry[1] === "deny",
    ),
  );
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))]
    : [];
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function loadConfig(
  cwd: string,
  overrides: Partial<Config> = {},
): Promise<Config> {
  let fileConfig: Partial<Config> = {};
  try {
    fileConfig = JSON.parse(
      await readFile(path.join(cwd, ".codepilot.json"), "utf8"),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const provider = overrides.provider ?? fileConfig.provider ?? inferProvider();
  const providerDefaults = defaults[provider];
  const model =
    overrides.model ??
    fileConfig.model ??
    process.env[providerDefaults.modelEnv] ??
    providerDefaults.model;
  const contextProfile = resolveModelContextProfile(provider, model);
  const contextWindowTokens = boundedInteger(
    overrides.contextWindowTokens ?? fileConfig.contextWindowTokens,
    contextProfile.contextWindowTokens,
    8_192,
    2_000_000,
  );
  const maxOutputTokens = boundedInteger(
    overrides.maxOutputTokens ?? fileConfig.maxOutputTokens,
    Math.min(8_192, contextProfile.modelMaxOutputTokens),
    256,
    Math.max(256, Math.min(contextProfile.modelMaxOutputTokens, contextWindowTokens - 4_096)),
  );
  const contextSafetyMarginTokens = boundedInteger(
    overrides.contextSafetyMarginTokens ?? fileConfig.contextSafetyMarginTokens,
    Math.min(16_384, Math.max(2_048, Math.floor(contextWindowTokens * 0.02))),
    512,
    Math.max(512, contextWindowTokens - maxOutputTokens - 2_000),
  );
  const maximumInputBudget = Math.max(2_000, contextWindowTokens - maxOutputTokens - contextSafetyMarginTokens);
  const runtimeAudit = overrides.runtimeAudit ?? fileConfig.runtimeAudit;
  const runtimeAuditPath = overrides.runtimeAuditPath ?? fileConfig.runtimeAuditPath;
  const providerRecordPath = optionalString(overrides.providerRecordPath ?? fileConfig.providerRecordPath);
  const providerReplayPath = optionalString(overrides.providerReplayPath ?? fileConfig.providerReplayPath);
  if (providerRecordPath && providerReplayPath) {
    throw Error("Provider record and replay modes are mutually exclusive");
  }

  return {
    provider,
    model,
    apiKey: fileConfig.apiKey ?? process.env[providerDefaults.apiKeyEnv],
    baseUrl:
      fileConfig.baseUrl ??
      process.env[providerDefaults.baseUrlEnv] ??
      providerDefaults.baseUrl,
    maxSteps: boundedInteger(overrides.maxSteps ?? fileConfig.maxSteps, 30, 1, 500),
    maxToolCalls: boundedInteger(overrides.maxToolCalls ?? fileConfig.maxToolCalls, 100, 1, 2_000),
    maxRunInputTokens: boundedInteger(
      overrides.maxRunInputTokens ?? fileConfig.maxRunInputTokens,
      2_000_000,
      1,
      100_000_000,
    ),
    maxRunOutputTokens: boundedInteger(
      overrides.maxRunOutputTokens ?? fileConfig.maxRunOutputTokens,
      100_000,
      1,
      10_000_000,
    ),
    maxRunTotalTokens: boundedInteger(
      overrides.maxRunTotalTokens ?? fileConfig.maxRunTotalTokens,
      2_100_000,
      1,
      100_000_000,
    ),
    headlessMaxRuntimeMs: boundedInteger(
      overrides.headlessMaxRuntimeMs ?? fileConfig.headlessMaxRuntimeMs,
      900_000,
      1_000,
      86_400_000,
    ),
    contextWindowTokens,
    contextBudgetTokens: boundedInteger(
      overrides.contextBudgetTokens ?? fileConfig.contextBudgetTokens,
      Math.min(128_000, maximumInputBudget),
      2_000,
      maximumInputBudget,
    ),
    maxOutputTokens,
    contextSafetyMarginTokens,
    toolResultMaxTokens: boundedInteger(
      overrides.toolResultMaxTokens ?? fileConfig.toolResultMaxTokens,
      1_200,
      100,
      16_384,
    ),
    oldToolResultMaxTokens: boundedInteger(
      overrides.oldToolResultMaxTokens ?? fileConfig.oldToolResultMaxTokens,
      160,
      50,
      4_096,
    ),
    memoryIndexMaxTokens: boundedInteger(
      overrides.memoryIndexMaxTokens ?? fileConfig.memoryIndexMaxTokens,
      800,
      100,
      8_192,
    ),
    memoryTopicMaxTokens: boundedInteger(
      overrides.memoryTopicMaxTokens ?? fileConfig.memoryTopicMaxTokens,
      800,
      100,
      8_192,
    ),
    memoryTopicLimit: boundedInteger(
      overrides.memoryTopicLimit ?? fileConfig.memoryTopicLimit,
      3,
      0,
      20,
    ),
    autoVerify: fileConfig.autoVerify ?? true,
    maxVerificationAttempts: fileConfig.maxVerificationAttempts ?? 3,
    providerMaxRetries: boundedInteger(overrides.providerMaxRetries ?? fileConfig.providerMaxRetries, 2, 0, 5),
    providerRequestTimeoutMs: boundedInteger(
      overrides.providerRequestTimeoutMs ?? fileConfig.providerRequestTimeoutMs,
      120_000,
      1_000,
      600_000,
    ),
    providerRecordPath,
    providerReplayPath,
    shellTimeoutMs: boundedInteger(
      overrides.shellTimeoutMs ?? fileConfig.shellTimeoutMs,
      120_000,
      100,
      900_000,
    ),
    shellMaxOutputChars: boundedInteger(
      overrides.shellMaxOutputChars ?? fileConfig.shellMaxOutputChars,
      1_000_000,
      1_000,
      10_000_000,
    ),
    autoApprove: fileConfig.autoApprove ?? ["read"],
    permissions: permissionPolicy(fileConfig.permissions),
    runtimeAudit: typeof runtimeAudit === "boolean" ? runtimeAudit : true,
    runtimeAuditPath: typeof runtimeAuditPath === "string" && runtimeAuditPath.trim()
      ? runtimeAuditPath
      : ".codepilot/audit/runtime.jsonl",
    runtimeHookTimeoutMs: boundedInteger(
      overrides.runtimeHookTimeoutMs ?? fileConfig.runtimeHookTimeoutMs,
      5_000,
      10,
      60_000,
    ),
    protectedPaths: stringArray(overrides.protectedPaths ?? fileConfig.protectedPaths),
  };
}
