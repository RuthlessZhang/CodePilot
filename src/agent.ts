import { randomUUID } from "node:crypto";
import path from "node:path";
import { invalidateCodeGraph } from "./code-graph.js";
import { formatContextReport, packContext, type ContextReport, type SystemContext } from "./context-manager.js";
import { loadInstructionBlocks } from "./instructions.js";
import type { MemoryLoadOptions } from "./memory.js";
import { readProjectIndex, summarizeProjectIndex } from "./project.js";
import { appendSessionSummary, migrateLegacySessionSummary, readSessionSummary } from "./session-summary.js";
import { summarizeWithDeepSeekFlash, type SummaryResult } from "./summarizer.js";
import { selectWorkspaceContext } from "./workspace-context.js";
import { createSessionId, getSessionInfo, listSessions, loadSession, saveSession } from "./sessions.js";
import { VerificationController, type VerificationResult } from "./verification.js";
import { RuntimeEventBus, type RuntimeEventDataMap, type RuntimeEventName } from "./runtime-events.js";
import { ToolRegistry } from "./tool-registry.js";
import type { AgentMode, Message, Provider, Risk, Tool, ToolEvent } from "./types.js";

export type AgentRunStats = {
  modelSteps: number;
  toolCalls: number;
  verificationStatus: "not_run" | "passed" | "failed" | "skipped";
};

export class AgentBudgetError extends Error {
  constructor(readonly budget: "steps" | "tool_calls", readonly limit: number) {
    super(`Maximum ${budget === "steps" ? "model steps" : "tool calls"} reached (${limit})`);
    this.name = "AgentBudgetError";
  }
}

export type AgentOptions = {
  root: string;
  provider: Provider;
  tools: Tool[] | ToolRegistry;
  approve: (risk: Risk, name: string, args: Record<string, unknown>) => Promise<boolean>;
  maxSteps: number;
  maxToolCalls?: number;
  contextBudgetTokens: number;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  contextSafetyMarginTokens?: number;
  toolResultMaxTokens?: number;
  oldToolResultMaxTokens?: number;
  memoryIndexMaxTokens?: number;
  memoryTopicMaxTokens?: number;
  memoryTopicLimit?: number;
  mode: AgentMode;
  autoVerify?: boolean;
  maxVerificationAttempts?: number;
  onText?: (text: string) => void;
  onToolEvent?: (event: ToolEvent) => void;
  runtimeEvents?: RuntimeEventBus;
};

export class Agent {
  private messages: Message[] = [];
  private readonly options: AgentOptions;
  private readonly tools: ToolRegistry;
  private readonly runtimeEvents: RuntimeEventBus;

  constructor(options: AgentOptions) {
    this.options = options;
    this.tools = options.tools instanceof ToolRegistry ? options.tools : new ToolRegistry(options.tools);
    this.runtimeEvents = options.runtimeEvents ?? new RuntimeEventBus();
  }

  private lastContextReport?: ContextReport;
  private lastSummary?: SummaryResult;
  private workspaceContext = "";
  private sessionId: string = createSessionId();
  private sessionCreatedAt = new Date().toISOString();
  private activeController?: AbortController;
  private activeRunStats?: AgentRunStats;
  private lastRunStats?: AgentRunStats;

  setMode(mode: AgentMode) {
    this.options.mode = mode;
  }

  getMode() {
    return this.options.mode;
  }

  getSessionId() {
    return this.sessionId;
  }

  getLastRunStats() {
    return this.lastRunStats ? { ...this.lastRunStats } : undefined;
  }

  async run(prompt: string) {
    if (this.activeController) throw Error("Agent is already running");
    const controller = new AbortController();
    const runId = randomUUID();
    const startingMessageCount = this.messages.length;
    this.activeController = controller;
    this.activeRunStats = { modelSteps: 0, toolCalls: 0, verificationStatus: "not_run" };
    try {
      await this.emitRuntime(runId, "run.started", { prompt, mode: this.options.mode }, controller.signal);
      const response = await this.runWithSignal(prompt, controller.signal, runId);
      const stats = this.activeRunStats;
      await this.emitRuntime(runId, "run.completed", {
        responseLength: response.length,
        modelSteps: stats?.modelSteps ?? 0,
        toolCalls: stats?.toolCalls ?? 0,
        verificationStatus: stats?.verificationStatus ?? "not_run",
      });
      return response;
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        this.messages = this.messages.slice(0, startingMessageCount);
        await this.emitRuntime(runId, "run.cancelled", { reason: (error as Error).message });
      } else {
        await this.emitRuntime(runId, "run.failed", { error: (error as Error).message, errorName: (error as Error).name });
      }
      throw error;
    } finally {
      if (this.activeRunStats) this.lastRunStats = { ...this.activeRunStats };
      this.activeRunStats = undefined;
      if (this.activeController === controller) this.activeController = undefined;
      this.runtimeEvents.forgetRun(runId);
    }
  }

  cancel() {
    if (!this.activeController) return false;
    this.activeController.abort();
    return true;
  }

  private async runWithSignal(prompt: string, signal: AbortSignal, runId: string) {
    this.workspaceContext = await selectWorkspaceContext(this.options.root, prompt);
    this.messages.push({ role: "user", content: prompt });
    const verification = new VerificationController({
      root: this.options.root,
      tools: this.tools.list(),
      approve: this.options.approve,
      onToolEvent: this.options.onToolEvent,
    });
    let verificationAttempts = 0;
    let previousFailure = "";
    let lastVerification: VerificationResult | undefined;

    for (let step = 0; step < this.options.maxSteps; step++) {
      signal.throwIfAborted();
      if (this.activeRunStats) this.activeRunStats.modelSteps = step + 1;
      let packed = this.pack(await system(
        this.options.root,
        this.options.mode,
        this.sessionId,
        prompt,
        this.workspaceContext,
        memoryOptions(this.options),
      ));
      if (packed.report.omittedMessages > 0) {
        const oldMessages = this.messages.slice(0, packed.report.omittedMessages);
        const summary = await summarizeWithDeepSeekFlash(oldMessages);
        this.lastSummary = summary;
        await appendSessionSummary(
          this.options.root,
          this.sessionId,
          oldMessages,
          async () => `## ${new Date().toISOString()} (${summary.mode}: ${summary.model})\n${summary.text}\n`,
        );
        this.messages = this.messages.slice(packed.report.omittedMessages);
        await this.save();
        packed = this.pack(await system(
          this.options.root,
          this.options.mode,
          this.sessionId,
          prompt,
          this.workspaceContext,
          memoryOptions(this.options),
        ));
      }
      this.lastContextReport = packed.report;
      await this.emitRuntime(runId, "context.prepared", {
        step: step + 1,
        budgetTokens: packed.report.budgetTokens,
        contextWindowTokens: packed.report.contextWindowTokens,
        outputReserveTokens: packed.report.outputReserveTokens,
        safetyMarginTokens: packed.report.safetyMarginTokens,
        toolDefinitionTokens: packed.report.toolDefinitionTokens,
        totalTokens: packed.report.totalTokens,
        keptMessages: packed.report.keptMessages,
        omittedMessages: packed.report.omittedMessages,
      }, signal);
      await this.emitRuntime(runId, "model.requested", {
        step: step + 1,
        messageCount: packed.messages.length,
        toolCount: this.tools.list().length,
      }, signal);
      const response = await this.options.provider.complete({
        system: packed.system,
        messages: packed.messages.map(withoutEmptyToolCalls),
        tools: this.tools.definitions(),
        signal,
      });
      await this.emitRuntime(runId, "model.responded", {
        step: step + 1,
        textLength: response.text.length,
        toolCalls: response.toolCalls.map((call) => call.name),
      }, signal);

      const deferCompletionText = response.toolCalls.length === 0
        && this.options.mode === "build"
        && this.options.autoVerify !== false
        && (verification.hasPendingCodeChanges() || lastVerification?.status === "failed");
      if (response.text && !deferCompletionText) this.options.onText?.(response.text);
      this.messages.push({
        role: "assistant",
        content: response.text,
        ...(response.toolCalls.length ? { toolCalls: response.toolCalls } : {}),
      });

      if (!response.toolCalls.length) {
        if (this.options.mode === "build" && this.options.autoVerify !== false && verification.hasPendingCodeChanges()) {
          const verificationAttempt = verificationAttempts + 1;
          await this.emitRuntime(runId, "verification.started", { attempt: verificationAttempt }, signal);
          lastVerification = await verification.verify(signal);
          if (this.activeRunStats) this.activeRunStats.verificationStatus = lastVerification.status;
          verificationAttempts++;
          await this.emitVerification(runId, verificationAttempt, lastVerification, signal);
          if (lastVerification.status === "failed") {
            const signature = JSON.stringify(lastVerification.checks.map((check) => [check.target, check.status, check.output.slice(0, 2000)]));
            const attemptsLeft = verificationAttempts < (this.options.maxVerificationAttempts ?? 3);
            const repeated = signature === previousFailure;
            previousFailure = signature;
            if (attemptsLeft && !repeated && step + 1 < this.options.maxSteps) {
              await this.emitRuntime(runId, "repair.started", {
                attempt: verificationAttempt,
                attemptsRemaining: (this.options.maxVerificationAttempts ?? 3) - verificationAttempts,
              }, signal);
              this.messages.push({ role: "user", content: verificationFeedback(lastVerification) });
              await this.save();
              continue;
            }
            await verification.saveReport(this.sessionId, prompt, "failed");
            const notice = `Verification failed${repeated ? " with the same result twice" : " after the retry limit"}.\n${lastVerification.summary}`;
            this.options.onText?.(`${response.text}\n\n${notice}`.trim());
            await this.save();
            return `${response.text}\n\n${notice}`.trim();
          }
          await verification.saveReport(this.sessionId, prompt, lastVerification.status);
          if (lastVerification.status === "skipped") {
            const notice = `Automatic verification was incomplete because required checks were unavailable or not approved.\n${lastVerification.summary}`;
            this.options.onText?.(`${response.text}\n\n${notice}`.trim());
            await this.save();
            return `${response.text}\n\n${notice}`.trim();
          }
          if (response.text && deferCompletionText) this.options.onText?.(response.text);
        } else if (lastVerification?.status === "failed") {
          await verification.saveReport(this.sessionId, prompt, "failed");
          const notice = `Verification is still failing and no new code change was made.\n${lastVerification.summary}`;
          this.options.onText?.(`${response.text}\n\n${notice}`.trim());
          await this.save();
          return `${response.text}\n\n${notice}`.trim();
        }
        await this.save();
        return response.text;
      }

      for (const call of response.toolCalls) {
        const maxToolCalls = this.options.maxToolCalls ?? Number.POSITIVE_INFINITY;
        if ((this.activeRunStats?.toolCalls ?? 0) >= maxToolCalls) {
          throw new AgentBudgetError("tool_calls", maxToolCalls);
        }
        if (this.activeRunStats) this.activeRunStats.toolCalls++;
        const tool = this.tools.get(call.name);
        let content = "Unknown tool";
        await this.emitRuntime(runId, "tool.requested", {
          name: call.name,
          risk: tool?.risk,
          args: call.arguments,
        }, signal);

        if (!tool) {
          await this.emitRuntime(runId, "tool.failed", { name: call.name, reason: content }, signal);
        } else if (this.options.mode === "plan" && tool.risk !== "read") {
          content = `Permission denied: CodePilot is in plan mode, so ${tool.risk} tools are disabled.`;
          this.emitTool({ phase: "failed", name: call.name, args: call.arguments, content });
          await this.emitRuntime(runId, "tool.failed", { name: call.name, risk: tool.risk, reason: content }, signal);
        } else {
          const authorization = await this.emitRuntime(runId, "tool.authorizing", {
            name: call.name,
            risk: tool.risk,
            args: call.arguments,
          }, signal);
          if (authorization.denied) {
            content = `Hook denied (${authorization.denied.hook}): ${authorization.denied.reason}`;
            this.emitTool({ phase: "failed", name: call.name, args: call.arguments, content });
            await this.emitRuntime(runId, "tool.failed", { name: call.name, risk: tool.risk, reason: content }, signal);
          } else if (!(await this.options.approve(tool.risk, call.name, call.arguments))) {
            content = "Permission denied";
            this.emitTool({ phase: "failed", name: call.name, args: call.arguments, content });
            await this.emitRuntime(runId, "tool.failed", { name: call.name, risk: tool.risk, reason: content }, signal);
          } else {
            const editPreparation = tool.risk === "write"
              ? await this.emitRuntime(runId, "edit.preparing", { tool: call.name, args: call.arguments }, signal)
              : undefined;
            if (editPreparation?.denied) {
              content = `Hook denied (${editPreparation.denied.hook}): ${editPreparation.denied.reason}`;
              this.emitTool({ phase: "failed", name: call.name, args: call.arguments, content });
              await this.emitRuntime(runId, "tool.failed", { name: call.name, risk: tool.risk, reason: content }, signal);
            } else {
            const startedAt = Date.now();
            this.emitTool({ phase: "started", name: call.name, args: call.arguments });
            await this.emitRuntime(runId, "tool.started", {
              name: call.name,
              risk: tool.risk,
              args: call.arguments,
            }, signal);
            try {
              content = await tool.execute(call.arguments, {
                signal,
                beforeWrite: (file) => verification.captureBaseline(file, signal),
              });
              if (["apply_patch", "write_file", "replace_text"].includes(call.name)) {
                invalidateCodeGraph(this.options.root);
              }
              verification.recordToolSuccess(call.name, call.arguments, content);
              const durationMs = Date.now() - startedAt;
              if (tool.risk === "write") {
                await this.emitRuntime(runId, "edit.applied", {
                  tool: call.name,
                  changedFiles: changedFilesFromTool(call.name, call.arguments, content),
                }, signal);
              }
              this.emitTool({ phase: "completed", name: call.name, args: call.arguments, durationMs });
              await this.emitRuntime(runId, "tool.completed", {
                name: call.name,
                risk: tool.risk,
                durationMs,
                outputLength: content.length,
              }, signal);
            } catch (error) {
              content = `Error: ${(error as Error).message}`;
              const durationMs = Date.now() - startedAt;
              this.emitTool({ phase: "failed", name: call.name, args: call.arguments, content, durationMs });
              await this.emitRuntime(runId, "tool.failed", {
                name: call.name,
                risk: tool.risk,
                durationMs,
                reason: content,
              });
              if ((error as Error).name === "AbortError") throw error;
            }
            }
          }
        }

        this.messages.push({
          role: "tool",
          name: call.name,
          toolCallId: call.id,
          content,
        });
      }

      await this.save();
    }

    throw new AgentBudgetError("steps", this.options.maxSteps);
  }

  async load(id?: string) {
    const info = id
      ? await getSessionInfo(this.options.root, id)
      : (await listSessions(this.options.root))[0];
    const resolvedId = info?.id ?? id;
    const messages = await loadSession(this.options.root, resolvedId);
    if (!messages) return false;
    this.messages = sanitizeMessages(messages);
    if (resolvedId) {
      this.sessionId = resolvedId;
      this.sessionCreatedAt = info?.createdAt ?? this.sessionCreatedAt;
      await migrateLegacySessionSummary(this.options.root, resolvedId);
    }
    return true;
  }

  clear() {
    this.messages = [];
  }

  async compact(keepRecent = 6) {
    const cutoff = Math.max(0, this.messages.length - keepRecent);
    const oldMessages = this.messages.slice(0, cutoff);
    if (!oldMessages.length) return { count: 0, summary: this.lastSummary };
    const summary = await summarizeWithDeepSeekFlash(oldMessages);
    this.lastSummary = summary;
    await appendSessionSummary(
      this.options.root,
      this.sessionId,
      oldMessages,
      async () => `## ${new Date().toISOString()} (${summary.mode}: ${summary.model})\n${summary.text}\n`,
    );
    this.messages = this.messages.slice(cutoff);
    await this.save();
    return { count: oldMessages.length, summary };
  }

  async contextReport() {
    const packed = this.pack(await system(
      this.options.root,
      this.options.mode,
      this.sessionId,
      undefined,
      "",
      memoryOptions(this.options),
    ));
    this.lastContextReport = packed.report;
    return formatContextReport(packed.report);
  }

  private async save() {
    await saveSession(this.options.root, this.sessionId, this.sessionCreatedAt, this.messages);
  }

  private pack(systemContext: SystemContext) {
    return packContext(systemContext, this.messages, this.options.contextBudgetTokens, {
      contextWindowTokens: this.options.contextWindowTokens,
      outputReserveTokens: this.options.maxOutputTokens,
      safetyMarginTokens: this.options.contextSafetyMarginTokens,
      toolDefinitions: this.tools.definitions(),
      toolResultMaxTokens: this.options.toolResultMaxTokens,
      oldToolResultMaxTokens: this.options.oldToolResultMaxTokens,
    });
  }

  private async emitRuntime<Name extends RuntimeEventName>(
    runId: string,
    name: Name,
    data: RuntimeEventDataMap[Name],
    signal?: AbortSignal,
  ) {
    return await this.runtimeEvents.emit({ name, runId, sessionId: this.sessionId, data, signal });
  }

  private async emitVerification(runId: string, attempt: number, result: VerificationResult, signal?: AbortSignal) {
    const common = { attempt, changedFiles: result.changedFiles, checkCount: result.checks.length };
    if (result.status === "passed") {
      await this.emitRuntime(runId, "verification.passed", common, signal);
    } else if (result.status === "failed") {
      await this.emitRuntime(runId, "verification.failed", { ...common, summary: result.summary }, signal);
    } else {
      await this.emitRuntime(runId, "verification.skipped", { ...common, summary: result.summary }, signal);
    }
  }

  private emitTool(event: ToolEvent) {
    this.options.onToolEvent?.(event);
  }
}

function changedFilesFromTool(name: string, args: Record<string, unknown>, output: string) {
  try {
    const result = JSON.parse(output) as { status?: unknown; changes?: Array<{ path?: unknown }> };
    if (result.status === "committed" && Array.isArray(result.changes)) {
      return result.changes.flatMap((change) => typeof change.path === "string" ? [change.path] : []);
    }
  } catch {
    // Fall back to the requested paths when a tool does not return a transaction result.
  }
  if ((name === "write_file" || name === "replace_text") && typeof args.path === "string") return [args.path];
  if (name === "apply_patch" && typeof args.patch === "string") {
    return [...args.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)].map((match) => match[1].trim());
  }
  return [];
}

function verificationFeedback(result: VerificationResult) {
  const details = result.checks
    .filter((check) => check.status === "failed")
    .map((check) => {
      const structured = check.failures?.length
        ? `Structured failures:\n${JSON.stringify(check.failures, null, 2)}\n\nRaw output:\n${check.output}`
        : check.output;
      return `${check.kind} ${check.target}:\n${structured.slice(0, 6000)}`;
    })
    .join("\n\n");
  return `Automatic verification failed after your proposed completion.
Changed files: ${result.changedFiles.join(", ")}
${details}

Continue the same task: inspect these failures, make a focused fix, and verify again. Do not claim completion while verification is failing.`;
}

function sanitizeMessages(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Message[] => {
    if (!item || typeof item !== "object") return [];
    const message = item as Record<string, unknown>;
    if ((message.role === "user" || message.role === "assistant") && typeof message.content === "string") {
      if (!Array.isArray(message.toolCalls) || !message.toolCalls.length) {
        return [{ role: message.role, content: message.content }];
      }
      const calls = message.toolCalls.filter((call): call is { id: string; name: string; arguments: Record<string, unknown> } => {
        if (!call || typeof call !== "object") return false;
        const record = call as Record<string, unknown>;
        return typeof record.id === "string" && typeof record.name === "string" && !!record.arguments && typeof record.arguments === "object";
      });
      return [{ role: message.role, content: message.content, ...(calls.length ? { toolCalls: calls } : {}) }];
    }
    if (
      message.role === "tool" &&
      typeof message.content === "string" &&
      typeof message.name === "string" &&
      typeof message.toolCallId === "string"
    ) {
      return [{ role: "tool", content: message.content, name: message.name, toolCallId: message.toolCallId }];
    }
    return [];
  });
}

function withoutEmptyToolCalls(message: Message): Message {
  if (message.role !== "assistant" || message.toolCalls?.length) return message;
  return { role: "assistant", content: message.content };
}

function memoryOptions(options: AgentOptions): MemoryLoadOptions {
  return {
    indexMaxTokens: options.memoryIndexMaxTokens,
    topicMaxTokens: options.memoryTopicMaxTokens,
    topicLimit: options.memoryTopicLimit,
  };
}

async function system(
  root: string,
  mode: AgentMode,
  sessionId: string,
  query?: string,
  workspaceContext = "",
  memoryLoadOptions: MemoryLoadOptions = {},
) {
  const index = await readProjectIndex(root);
  const instructionBlocks = await loadInstructionBlocks(root, query, memoryLoadOptions);
  const summary = await readSessionSummary(root, sessionId);

  const modeRules =
    mode === "plan"
      ? "You are in PLAN mode. Inspect and reason, but do not modify files or run commands. If implementation is needed, produce a concrete plan."
      : "You are in BUILD mode. You may modify files and run commands after permission checks.";

  const base = `You are CodePilot, a careful coding agent in ${root}.
${modeRules}
Inspect before editing, stay in the workspace, preserve user changes, and run relevant tests.
Before editing code, use the pre-edit impact analysis when available; confirm uncertain callers or dynamic relationships with impact_analysis, code_graph, LSP, or search.
For multi-step coding tasks, use todo_write to keep an explicit task list and update it as work progresses.
Prefer apply_patch for code edits; use write_file only when creating or replacing a whole file is clearer.
Use memory_write only for durable architecture decisions, commands, debugging lessons, or user preferences; never store transient task state.
Never claim validation not performed.`;
  const sections = [
    { name: "base", content: base },
    ...(summary ? [{ name: "sessionSummary", content: `Session summary:\n${summary}` }] : []),
    ...instructionBlocks.map((block) => ({
      name: block.kind,
      content: `Instructions from ${block.source}:\n${block.content}`,
    })),
    ...(workspaceContext ? [{ name: "workspaceContext", content: workspaceContext }] : []),
    ...(index ? [{ name: "projectIndex", content: `Project index:\n${summarizeProjectIndex(index)}` }] : []),
  ];
  return { text: sections.map((section) => section.content).join("\n\n"), sections };
}
