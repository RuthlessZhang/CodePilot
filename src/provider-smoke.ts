#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RecordingProvider, ReplayProvider } from "./provider-replay.js";
import { AnthropicProvider, DeepSeekProvider, OpenAIProvider } from "./providers.js";
import type { ProviderName } from "./model-context.js";
import { providerDefinition, providerNames } from "./provider-catalog.js";
import type { Provider, ProviderCompletion, ProviderStreamEvent, ProviderUsage } from "./types.js";

export type LiveSmokeProviderConfig = {
  name: ProviderName;
  model: string;
  baseUrl: string;
  apiKey: string;
};

export type SmokeScenarioName = "text" | "stream_replay" | "tool" | "cancel";

export type SmokeScenarioResult = {
  name: SmokeScenarioName;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  usage?: ProviderUsage;
  responseSha256?: string;
  textEvents?: number;
  toolEvents?: number;
  cancellationObserved?: boolean;
  errorName?: string;
  skipReason?: "prerequisite_failed";
};

export type SmokeProviderResult = {
  provider: ProviderName;
  model: string;
  status: "passed" | "failed";
  scenarios: SmokeScenarioResult[];
};

export type ProviderSmokeReport = {
  version: 1;
  runId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  status: "passed" | "failed";
  providers: SmokeProviderResult[];
  reportPath: string;
};

export type SmokeOptions = {
  root: string;
  configs: LiveSmokeProviderConfig[];
  timeoutMs?: number;
  maxOutputTokens?: number;
  reportPath?: string;
  providerFactory?: (config: LiveSmokeProviderConfig, options: { timeoutMs: number }) => Provider;
  onProgress?: (message: string) => void;
};

class SmokeAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmokeAssertionError";
  }
}

function assertSmoke(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeAssertionError(message);
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function normalizePath(value: string) {
  return value.replace(/\\/g, "/");
}

function outputPath(root: string, value: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, value);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw Error("Provider smoke report path escapes workspace");
  }
  return resolved;
}

async function atomicWrite(target: string, value: string) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, target);
}

function hashText(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function validateUsage(usage: ProviderUsage | undefined) {
  assertSmoke(usage, "Provider response omitted usage");
  assertSmoke((usage.inputTokens ?? 0) > 0, "Provider response has no input token usage");
  assertSmoke((usage.outputTokens ?? 0) > 0, "Provider response has no output token usage");
  assertSmoke((usage.totalTokens ?? 0) >= (usage.inputTokens ?? 0), "Provider total token usage is inconsistent");
  return usage;
}

function createLiveProvider(config: LiveSmokeProviderConfig, options: { timeoutMs: number }) {
  const providerOptions = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    maxRetries: 0,
    requestTimeoutMs: options.timeoutMs,
  };
  return config.name === "anthropic"
    ? new AnthropicProvider(providerOptions)
    : config.name === "deepseek"
      ? new DeepSeekProvider(providerOptions)
      : new OpenAIProvider(providerOptions);
}

function baseInput(marker: string, maxOutputTokens: number) {
  return {
    system: `CodePilot live provider protocol smoke test (${marker}). Follow the user's formatting instruction exactly.`,
    messages: [{ role: "user" as const, content: `Reply with exactly CODEPILOT_SMOKE_OK_${marker} and nothing else.` }],
    tools: [],
    maxOutputTokens,
  };
}

async function textScenario(provider: Provider, maxOutputTokens: number) {
  const marker = "TEXT";
  const response = await provider.complete(baseInput(marker, maxOutputTokens));
  assertSmoke(response.text.includes(`CODEPILOT_SMOKE_OK_${marker}`), "Provider text response omitted the smoke marker");
  return { usage: validateUsage(response.usage), responseSha256: hashText(response.text) };
}

async function streamReplayScenario(provider: Provider, maxOutputTokens: number) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codepilot-provider-smoke-"));
  try {
    const trace = "provider.jsonl";
    const recordedEvents: ProviderStreamEvent[] = [];
    const input = {
      ...baseInput("STREAM", maxOutputTokens),
      onEvent: (event: ProviderStreamEvent) => recordedEvents.push(event),
    };
    const response = await new RecordingProvider(temporaryRoot, trace, provider).complete(input);
    const streamedText = recordedEvents.flatMap((event) => event.type === "text_delta" ? [event.text] : []).join("");
    assertSmoke(streamedText.length > 0, "Provider stream emitted no text deltas");
    assertSmoke(streamedText === response.text, "Provider stream text differs from the final response");
    const replayedEvents: ProviderStreamEvent[] = [];
    const replayed = await new ReplayProvider(temporaryRoot, trace).complete({
      ...input,
      onEvent: (event) => replayedEvents.push(event),
    });
    assertSmoke(JSON.stringify(replayed) === JSON.stringify(response), "Provider replay response differs from the recording");
    assertSmoke(JSON.stringify(replayedEvents) === JSON.stringify(recordedEvents), "Provider replay events differ from the recording");
    return {
      usage: validateUsage(response.usage),
      responseSha256: hashText(response.text),
      textEvents: recordedEvents.filter((event) => event.type === "text_delta").length,
      toolEvents: recordedEvents.filter((event) => event.type === "tool_call_delta").length,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function toolScenario(provider: Provider, maxOutputTokens: number) {
  const events: ProviderStreamEvent[] = [];
  const response = await provider.complete({
    system: "CodePilot live provider tool protocol smoke test. Use the required tool exactly once.",
    messages: [{ role: "user", content: "Call echo_probe with value CODEPILOT_TOOL_OK. Do not answer directly." }],
    tools: [{
      name: "echo_probe",
      description: "Return a fixed smoke-test value.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string", const: "CODEPILOT_TOOL_OK" } },
        required: ["value"],
        additionalProperties: false,
      },
    }],
    toolChoice: { name: "echo_probe" },
    maxOutputTokens,
    onEvent: (event) => events.push(event),
  });
  const call = response.toolCalls.find((candidate) => candidate.name === "echo_probe");
  assertSmoke(call, "Provider did not return the required tool call");
  assertSmoke(call.arguments.value === "CODEPILOT_TOOL_OK", "Provider tool arguments failed schema contract");
  const toolEvents = events.filter((event) => event.type === "tool_call_delta").length;
  assertSmoke(toolEvents > 0, "Provider stream emitted no tool-call deltas");
  return { usage: validateUsage(response.usage), toolEvents, responseSha256: hashText(JSON.stringify(response.toolCalls)) };
}

async function cancelScenario(provider: Provider, maxOutputTokens: number, timeoutMs: number) {
  const controller = new AbortController();
  let observedEvent = false;
  const timer = setTimeout(() => controller.abort(), Math.min(2_000, Math.max(100, Math.floor(timeoutMs / 4))));
  try {
    await provider.complete({
      system: "CodePilot live provider cancellation smoke test.",
      messages: [{ role: "user", content: "Produce a long numbered list with one hundred detailed items." }],
      tools: [],
      signal: controller.signal,
      maxOutputTokens,
      onEvent: (event) => {
        if (event.type !== "usage") {
          observedEvent = true;
          controller.abort();
        }
      },
    });
    throw new SmokeAssertionError("Provider request completed after cancellation");
  } catch (error) {
    if ((error as Error).name === "SmokeAssertionError") throw error;
    assertSmoke((error as Error).name === "AbortError", `Provider cancellation returned ${(error as Error).name}`);
    return { cancellationObserved: true, textEvents: observedEvent ? 1 : 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function runScenario(
  name: SmokeScenarioName,
  operation: () => Promise<Omit<SmokeScenarioResult, "name" | "status" | "durationMs">>,
  onFailure?: (error: Error) => void,
): Promise<SmokeScenarioResult> {
  const started = Date.now();
  try {
    const observation = await operation();
    return { name, status: "passed", durationMs: Date.now() - started, ...observation };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    onFailure?.(failure);
    return { name, status: "failed", durationMs: Date.now() - started, errorName: failure.name };
  }
}

async function runOneProvider(
  config: LiveSmokeProviderConfig,
  options: Required<Pick<SmokeOptions, "timeoutMs" | "maxOutputTokens">> & Pick<SmokeOptions, "providerFactory" | "onProgress">,
) {
  const provider = (options.providerFactory ?? createLiveProvider)(config, { timeoutMs: options.timeoutMs });
  const scenarios: SmokeScenarioResult[] = [];
  const execute = async (name: SmokeScenarioName, operation: () => Promise<Omit<SmokeScenarioResult, "name" | "status" | "durationMs">>) => {
    options.onProgress?.(`[${config.name}] ${name}...`);
    const result = await runScenario(name, operation, (error) => options.onProgress?.(`[${config.name}] ${name} failed: ${error.name}`));
    scenarios.push(result);
  };
  await execute("text", () => textScenario(provider, options.maxOutputTokens));
  if (scenarios[0]?.status === "failed") {
    for (const name of ["stream_replay", "tool", "cancel"] as const) {
      scenarios.push({ name, status: "skipped", durationMs: 0, skipReason: "prerequisite_failed" });
    }
  } else {
    await execute("stream_replay", () => streamReplayScenario(provider, options.maxOutputTokens));
    await execute("tool", () => toolScenario(provider, options.maxOutputTokens));
    await execute("cancel", () => cancelScenario(provider, options.maxOutputTokens, options.timeoutMs));
  }
  return {
    provider: config.name,
    model: config.model,
    status: scenarios.every((scenario) => scenario.status === "passed") ? "passed" as const : "failed" as const,
    scenarios,
  };
}

export function smokeConfigsFromEnvironment(env: NodeJS.ProcessEnv = process.env) {
  const requested = env.CODEPILOT_SMOKE_PROVIDERS?.trim().toLowerCase();
  const names = requested && requested !== "all"
    ? [...new Set(requested.split(",").map((value) => value.trim()).filter(Boolean))]
    : providerNames.filter((name) => requested === "all" || Boolean(env[providerDefinition(name).apiKeyEnv]));
  const invalid = names.filter((name) => !providerNames.includes(name as ProviderName));
  if (invalid.length) throw Error(`Unknown smoke provider(s): ${invalid.join(", ")}`);
  if (!names.length) throw Error("No provider API keys are configured for live smoke tests");
  return (names as ProviderName[]).map((name) => {
    const setting = providerDefinition(name);
    const apiKey = env[setting.apiKeyEnv];
    if (!apiKey) throw Error(`Missing ${setting.apiKeyEnv} for selected provider ${name}`);
    return {
      name,
      apiKey,
      model: env[setting.modelEnv] ?? setting.defaultModel,
      baseUrl: env[setting.baseUrlEnv] ?? setting.defaultBaseUrl,
    };
  });
}

export async function runProviderSmoke(options: SmokeOptions): Promise<ProviderSmokeReport> {
  assertSmoke(options.configs.length > 0, "Provider smoke matrix has no providers");
  const runId = randomUUID();
  const started = Date.now();
  const timeoutMs = Math.max(1_000, Math.min(300_000, options.timeoutMs ?? 60_000));
  const maxOutputTokens = Math.max(16, Math.min(512, options.maxOutputTokens ?? 128));
  const relativeReport = options.reportPath ?? `.codepilot/runs/provider-smoke-${runId}.json`;
  const target = outputPath(options.root, relativeReport);
  const providers: SmokeProviderResult[] = [];
  for (const config of options.configs) {
    providers.push(await runOneProvider(config, {
      timeoutMs,
      maxOutputTokens,
      providerFactory: options.providerFactory,
      onProgress: options.onProgress,
    }));
  }
  const completed = Date.now();
  const report: ProviderSmokeReport = {
    version: 1,
    runId,
    startedAt: new Date(started).toISOString(),
    completedAt: new Date(completed).toISOString(),
    durationMs: completed - started,
    status: providers.every((provider) => provider.status === "passed") ? "passed" : "failed",
    providers,
    reportPath: normalizePath(path.relative(path.resolve(options.root), target)),
  };
  await atomicWrite(target, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function main() {
  if (process.env.CODEPILOT_LIVE_SMOKE !== "1") {
    throw Error("Live provider smoke tests are disabled. Set CODEPILOT_LIVE_SMOKE=1 to acknowledge real API usage.");
  }
  const root = process.cwd();
  const report = await runProviderSmoke({
    root,
    configs: smokeConfigsFromEnvironment(),
    timeoutMs: boundedInteger(process.env.CODEPILOT_SMOKE_TIMEOUT_MS, 60_000, 1_000, 300_000),
    maxOutputTokens: boundedInteger(process.env.CODEPILOT_SMOKE_MAX_OUTPUT_TOKENS, 128, 16, 512),
    reportPath: process.env.CODEPILOT_SMOKE_REPORT,
    onProgress: (message) => console.error(message),
  });
  console.log(JSON.stringify(report));
  if (report.status !== "passed") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
