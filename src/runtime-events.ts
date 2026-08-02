import type { AgentMode, Risk } from "./types.js";

export type RuntimeEventDataMap = {
  "run.started": { prompt: string; mode: AgentMode };
  "run.completed": { responseLength: number; modelSteps: number; toolCalls: number; verificationStatus: string };
  "run.failed": { error: string; errorName: string };
  "run.cancelled": { reason: string };
  "context.prepared": {
    step: number;
    budgetTokens: number;
    contextWindowTokens?: number;
    outputReserveTokens?: number;
    safetyMarginTokens?: number;
    toolDefinitionTokens?: number;
    totalTokens: number;
    keptMessages: number;
    omittedMessages: number;
  };
  "model.requested": { step: number; messageCount: number; toolCount: number };
  "model.responded": { step: number; textLength: number; toolCalls: string[] };
  "tool.requested": { name: string; risk?: Risk; args: Record<string, unknown> };
  "tool.authorizing": { name: string; risk: Risk; args: Record<string, unknown> };
  "tool.started": { name: string; risk: Risk; args: Record<string, unknown> };
  "tool.completed": { name: string; risk: Risk; durationMs: number; outputLength: number };
  "tool.failed": { name: string; risk?: Risk; durationMs?: number; reason: string };
  "edit.preparing": { tool: string; args: Record<string, unknown> };
  "edit.applied": { tool: string; changedFiles: string[] };
  "verification.started": { attempt: number };
  "verification.passed": { attempt: number; changedFiles: string[]; checkCount: number };
  "verification.failed": { attempt: number; changedFiles: string[]; checkCount: number; summary: string };
  "verification.skipped": { attempt: number; changedFiles: string[]; checkCount: number; summary: string };
  "repair.started": { attempt: number; attemptsRemaining: number };
};

export type RuntimeEventName = keyof RuntimeEventDataMap;

export type RuntimeEvent<Name extends RuntimeEventName = RuntimeEventName> = Readonly<{
  version: 1;
  name: Name;
  timestamp: string;
  sequence: number;
  runId: string;
  sessionId: string;
  data: RuntimeEventDataMap[Name];
}>;

export type AnyRuntimeEvent = {
  [Name in RuntimeEventName]: RuntimeEvent<Name>;
}[RuntimeEventName];

export type RuntimeHookResult = void | { deny: string };

export type RuntimeHook = {
  name: string;
  events?: readonly RuntimeEventName[];
  handle(event: AnyRuntimeEvent, context: { signal: AbortSignal }): RuntimeHookResult | Promise<RuntimeHookResult>;
};

export type RuntimeHookError = { hook: string; event: RuntimeEventName; error: Error };

export type RuntimeEventOutcome<Name extends RuntimeEventName> = {
  event: RuntimeEvent<Name>;
  denied?: { hook: string; reason: string };
};

export type RuntimeEventBusOptions = {
  hooks?: readonly RuntimeHook[];
  hookTimeoutMs?: number;
  onEvent?: (event: AnyRuntimeEvent) => void | Promise<void>;
  onHookError?: (failure: RuntimeHookError) => void;
};

class HookTimeoutError extends Error {
  constructor(hook: string, timeoutMs: number) {
    super(`Runtime hook ${hook} timed out after ${timeoutMs}ms`);
    this.name = "HookTimeoutError";
  }
}

function abortError(reason?: unknown) {
  if (reason instanceof Error) return reason;
  return new DOMException(typeof reason === "string" ? reason : "Operation cancelled", "AbortError");
}

/** Ordered, fail-isolated lifecycle dispatcher. Hooks can veto but never grant permission. */
export class RuntimeEventBus {
  private sequences = new Map<string, number>();
  private readonly hooks: readonly RuntimeHook[];
  private readonly hookTimeoutMs: number;

  constructor(private options: RuntimeEventBusOptions = {}) {
    this.hooks = options.hooks ?? [];
    this.hookTimeoutMs = Math.max(1, options.hookTimeoutMs ?? 5_000);
  }

  async emit<Name extends RuntimeEventName>(input: {
    name: Name;
    runId: string;
    sessionId: string;
    data: RuntimeEventDataMap[Name];
    signal?: AbortSignal;
  }): Promise<RuntimeEventOutcome<Name>> {
    input.signal?.throwIfAborted();
    const sequence = (this.sequences.get(input.runId) ?? 0) + 1;
    this.sequences.set(input.runId, sequence);
    const event = Object.freeze({
      version: 1 as const,
      name: input.name,
      timestamp: new Date().toISOString(),
      sequence,
      runId: input.runId,
      sessionId: input.sessionId,
      data: input.data,
    }) as RuntimeEvent<Name>;

    try {
      await this.options.onEvent?.(event as AnyRuntimeEvent);
    } catch (error) {
      this.reportHookError({ hook: "onEvent", event: input.name, error: asError(error) });
    }

    let denied: RuntimeEventOutcome<Name>["denied"];
    for (const hook of this.hooks) {
      if (hook.events && !hook.events.includes(input.name)) continue;
      try {
        const result = await this.runHook(hook, event as AnyRuntimeEvent, input.signal);
        if (result?.deny && !denied) denied = { hook: hook.name, reason: result.deny };
      } catch (error) {
        if (input.signal?.aborted && asError(error).name === "AbortError") throw error;
        this.reportHookError({ hook: hook.name, event: input.name, error: asError(error) });
      }
    }
    return { event, ...(denied ? { denied } : {}) };
  }

  forgetRun(runId: string) {
    this.sequences.delete(runId);
  }

  private reportHookError(failure: RuntimeHookError) {
    try {
      this.options.onHookError?.(failure);
    } catch {
      // Error reporting is observational and must never break the Agent loop.
    }
  }

  private async runHook(hook: RuntimeHook, event: AnyRuntimeEvent, parentSignal?: AbortSignal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", onAbort, { once: true });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new HookTimeoutError(hook.name, this.hookTimeoutMs);
          controller.abort(error);
          reject(error);
        }, this.hookTimeoutMs);
      });
      const abortPromise = new Promise<never>((_resolve, reject) => {
        if (!parentSignal) return;
        if (parentSignal.aborted) reject(abortError(parentSignal.reason));
        else parentSignal.addEventListener("abort", () => reject(abortError(parentSignal.reason)), { once: true });
      });
      return await Promise.race([
        Promise.resolve(hook.handle(event, { signal: controller.signal })),
        timeoutPromise,
        abortPromise,
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onAbort);
    }
  }
}

function asError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}
