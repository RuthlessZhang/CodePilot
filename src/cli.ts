#!/usr/bin/env node
import { exec } from "node:child_process";
import { createRequire } from "node:module";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Agent } from "./agent.js";
import { runAuthCommand } from "./auth.js";
import { runChecks } from "./check.js";
import { expandFileReferences } from "./context.js";
import { diagnose, formatDoctorReport } from "./doctor.js";
import { runHeadless } from "./headless.js";
import { initProject } from "./init.js";
import { loadInstructions, loadRelevantRules } from "./instructions.js";
import { assertSafeCredentialPolicy, loadConfig } from "./config.js";
import { loadRelevantMemory, readMemory, remember } from "./memory.js";
import { loadMcpConfiguration } from "./mcp-config.js";
import { connectMcpServers, formatMcpStatuses } from "./mcp-runtime.js";
import { saveProjectIndex, summarizeProjectIndex } from "./project.js";
import { approval, nonInteractiveApproval } from "./permissions.js";
import { readTodos, summarizeTodos } from "./todo.js";
import { listSessions } from "./sessions.js";
import { createConfiguredRuntime } from "./runtime-config.js";
import {
  AnthropicProvider,
  DeepSeekProvider,
  OpenAIProvider,
} from "./providers.js";
import { RecordingProvider, ReplayProvider, type ProviderExecutionMode } from "./provider-replay.js";
import { createTools } from "./tools.js";
import { ToolRegistry } from "./tool-registry.js";
import { UndoManager } from "./undo.js";
import { resolveWorkspace } from "./workspace.js";
import type { AgentMode, ProviderStreamEvent, ToolEvent } from "./types.js";

const packageVersion = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

function argValue(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function integerArg(args: string[], flag: string) {
  const value = argValue(args, flag);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw Error(`${flag} must be a positive integer`);
  return parsed;
}

async function connectMcpWithInterrupt(
  root: string,
  configuration: Awaited<ReturnType<typeof loadMcpConfiguration>>,
  registry?: ToolRegistry,
) {
  const controller = new AbortController();
  const interrupt = () => controller.abort(new DOMException("MCP startup cancelled", "AbortError"));
  process.once("SIGINT", interrupt);
  try {
    return await connectMcpServers(root, configuration, controller.signal, registry);
  } finally {
    process.off("SIGINT", interrupt);
  }
}

function promptFromArgs(args: string[]) {
  const flagsWithValues = new Set([
    "--provider", "--model", "--mode", "--cwd", "--session", "--max-runtime-ms", "--max-steps",
    "--max-tool-calls", "--max-run-input-tokens", "--max-run-output-tokens", "--max-run-total-tokens",
    "--output", "--patch-output", "--record-provider", "--replay-provider",
  ]);
  return args
    .filter((arg, index) => !arg.startsWith("--") && !flagsWithValues.has(args[index - 1]))
    .join(" ");
}

function git(root: string, command: string) {
  return new Promise<string>((resolve) =>
    exec(command, { cwd: root, timeout: 120000, maxBuffer: 1e6 }, (_error, stdout, stderr) =>
      resolve(`${stdout}${stderr}`.trim() || "(no output)"),
    ),
  );
}

function help() {
  return `Commands:
/help                 Show this help
/workspace            Show the active workspace root
/session              Show the active session ID
/sessions             List saved sessions for this workspace
/mode                 Show current mode
/mode plan            Read-only planning mode
/mode build           Editing and command mode
/init [--force]       Create or regenerate AGENTS.md
/index                Build .codepilot/index.json
/check                Run detected verification commands
/doctor               Diagnose provider, credentials, dependencies, and project checks
/mcp                  Show configured MCP server connection and tool status
/remember [topic:] <note> Save a durable topic memory
/memory [query]       Show the memory index and relevant topics
/rules [query]        Show all instructions or rules selected for a query
/context              Show context budget report
/usage                Show usage for the last agent run
/compact              Summarize old messages and keep recent context
/todo                 Show current task list
/undo                 Restore files changed by the previous agent run
/status               Show git status --short
/diff                 Show git diff
/clear                Clear in-memory conversation
/exit                 Exit CodePilot`;
}

function usage() {
  return `CodePilot ${packageVersion}

Usage:
  codepilot [options] [task]
  codepilot auth <set|status|remove> [provider]
  codepilot doctor [--json] [--cwd <workspace>]
  codepilot init [--force] [--cwd <workspace>]
  codepilot mcp status [--cwd <workspace>]

Options:
  --provider <name>            openai, deepseek, or anthropic
  --model <name>               Override the Provider model
  --cwd <workspace>            Select the workspace explicitly
  --mode <plan|build>          Start in read-only or editing mode
  --resume, --continue         Resume the latest workspace session
  --session <id>               Resume an exact session
  --headless                   Run one non-interactive task
  --doctor                     Run credential-safe diagnostics
  --json                       Print supported commands as JSON where available
  --version, -v                Show the installed version
  --help, -h                   Show this help`;
}

async function main() {
  const args = process.argv.slice(2);
  if (["--version", "-v", "version"].includes(args[0] ?? "")) {
    console.log(packageVersion);
    return;
  }
  if (["--help", "-h", "help"].includes(args[0] ?? "")) {
    console.log(usage());
    return;
  }
  if (args[0] === "auth") {
    await runAuthCommand(args.slice(1));
    return;
  }
  if (args[0] === "mcp") {
    const action = args[1];
    if (!action || action === "help" || action === "--help" || action === "-h") {
      console.log("Usage: codepilot mcp status [--cwd <workspace>]");
      return;
    }
    if (action !== "status") throw Error(`Unknown MCP command: ${action}`);
    const mcpRoot = await resolveWorkspace(process.cwd(), argValue(args, "--cwd"));
    const configuration = await loadMcpConfiguration();
    const runtime = await connectMcpWithInterrupt(mcpRoot, configuration);
    try {
      console.log(formatMcpStatuses(runtime.statuses));
      process.exitCode = runtime.statuses.some((status) => status.state === "failed") ? 1 : 0;
    } finally {
      await runtime.dispose();
    }
    return;
  }
  if (args[0] === "init") {
    const initRoot = await resolveWorkspace(process.cwd(), argValue(args, "--cwd"));
    console.log(await initProject(initRoot, args.includes("--force")));
    return;
  }
  const headless = args.includes("--headless");
  const verbose = args.includes("--verbose");
  const root = await resolveWorkspace(process.cwd(), argValue(args, "--cwd"));
  const cliMode = argValue(args, "--mode") as AgentMode | undefined;
  let mode: AgentMode = cliMode === "plan" ? "plan" : "build";

  const config = await loadConfig(root, {
    provider: argValue(args, "--provider") as any,
    model: argValue(args, "--model"),
    maxSteps: integerArg(args, "--max-steps"),
    maxToolCalls: integerArg(args, "--max-tool-calls"),
    maxRunInputTokens: integerArg(args, "--max-run-input-tokens"),
    maxRunOutputTokens: integerArg(args, "--max-run-output-tokens"),
    maxRunTotalTokens: integerArg(args, "--max-run-total-tokens"),
    headlessMaxRuntimeMs: integerArg(args, "--max-runtime-ms"),
    providerRecordPath: argValue(args, "--record-provider"),
    providerReplayPath: argValue(args, "--replay-provider"),
  });
  const mcpConfiguration = await loadMcpConfiguration();

  if (config.providerRecordPath && config.providerReplayPath) {
    throw Error("Provider record and replay modes are mutually exclusive");
  }
  if (args[0] === "doctor" || args.includes("--doctor")) {
    const report = await diagnose(root, config, mcpConfiguration);
    console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatDoctorReport(report));
    process.exitCode = report.status === "error" ? 1 : 0;
    return;
  }
  assertSafeCredentialPolicy(config);
  if (!config.providerReplayPath && !config.apiKey) throw Error("Missing API key environment variable");

  const providerOptions = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    maxOutputTokens: config.maxOutputTokens,
    maxRetries: config.providerMaxRetries,
    requestTimeoutMs: config.providerRequestTimeoutMs,
  };
  const liveProvider = config.providerReplayPath
    ? undefined
    : config.provider === "anthropic"
      ? new AnthropicProvider({ ...providerOptions, apiKey: config.apiKey! })
      : config.provider === "deepseek"
        ? new DeepSeekProvider({ ...providerOptions, apiKey: config.apiKey! })
        : new OpenAIProvider({ ...providerOptions, apiKey: config.apiKey! });
  const providerMode: ProviderExecutionMode = config.providerReplayPath
    ? "replay"
    : config.providerRecordPath
      ? "record"
      : "live";
  const providerTracePath = config.providerReplayPath ?? config.providerRecordPath;
  const provider = config.providerReplayPath
    ? new ReplayProvider(root, config.providerReplayPath)
    : config.providerRecordPath
      ? new RecordingProvider(root, config.providerRecordPath, liveProvider!)
      : liveProvider!;

  const undo = new UndoManager(root);
  const renderToolEvent = (event: ToolEvent) => {
    if (headless && !verbose) return;
    if (event.phase === "output") {
      process.stdout.write(event.content ?? "");
      return;
    }
    if (event.phase === "started") {
      console.log(`\n[tool:start] ${event.name} ${JSON.stringify(event.args).slice(0, 180)}`);
      return;
    }
    const duration = event.durationMs === undefined ? "" : ` (${event.durationMs}ms)`;
    console.log(`\n[tool:${event.phase}] ${event.name}${duration}${event.content ? `: ${event.content}` : ""}`);
  };
  const renderProviderEvent = (event: ProviderStreamEvent) => {
    if (headless && !verbose) return;
    if (event.type === "text_delta") {
      process.stdout.write(event.text);
      return;
    }
    if (event.type === "usage" && verbose) {
      console.error(`\n[provider:usage] ${JSON.stringify(event.usage)}`);
    }
  };
  const runtimeEvents = createConfiguredRuntime(root, config, ({ hook, event, error }) => {
    if (!headless || verbose) console.error(`[hook:error] ${hook} on ${event}: ${error.message}`);
  });
  const toolRegistry = new ToolRegistry(createTools(root, {
    beforeWrite: (file) => undo.snapshot(file),
    onOutput: (name, chunk) => renderToolEvent({ phase: "output", name, args: {}, content: chunk }),
    shellTimeoutMs: config.shellTimeoutMs,
    shellMaxOutputChars: config.shellMaxOutputChars,
  }));
  let mcpRuntime: Awaited<ReturnType<typeof connectMcpServers>>;
  try {
    mcpRuntime = await connectMcpWithInterrupt(root, mcpConfiguration, toolRegistry);
  } catch (error) {
    await toolRegistry.dispose();
    throw error;
  }
  for (const status of mcpRuntime.statuses.filter((entry) => entry.state === "failed")) {
    console.error(`[mcp] ${status.name}: ${status.detail}`);
  }
  const disposeTools = async () => {
    await mcpRuntime.dispose();
    await toolRegistry.dispose();
  };
  let agent: Agent;
  try {
    agent = new Agent({
      root,
      provider,
      tools: toolRegistry,
      approve: headless
        ? nonInteractiveApproval(config.autoApprove, config.permissions)
        : approval(config.autoApprove, root, config.permissions),
      maxSteps: config.maxSteps,
      maxToolCalls: config.maxToolCalls,
      maxRunInputTokens: config.maxRunInputTokens,
      maxRunOutputTokens: config.maxRunOutputTokens,
      maxRunTotalTokens: config.maxRunTotalTokens,
      contextBudgetTokens: config.contextBudgetTokens,
      contextWindowTokens: config.contextWindowTokens,
      maxOutputTokens: config.maxOutputTokens,
      contextSafetyMarginTokens: config.contextSafetyMarginTokens,
      toolResultMaxTokens: config.toolResultMaxTokens,
      oldToolResultMaxTokens: config.oldToolResultMaxTokens,
      memoryIndexMaxTokens: config.memoryIndexMaxTokens,
      memoryTopicMaxTokens: config.memoryTopicMaxTokens,
      memoryTopicLimit: config.memoryTopicLimit,
      autoVerify: config.autoVerify,
      maxVerificationAttempts: config.maxVerificationAttempts,
      mode,
      onText: headless && !verbose ? undefined : (text) => console.log(text),
      onProviderEvent: headless && !verbose ? undefined : renderProviderEvent,
      onToolEvent: renderToolEvent,
      runtimeEvents,
    });
  } catch (error) {
    await disposeTools();
    throw error;
  }

  const setMode = (next: AgentMode) => {
    mode = next;
    agent.setMode(next);
    console.log(`Mode: ${next}`);
  };

  let agentRunning = false;
  let shuttingDown = false;
  const interrupt = () => {
    if (agentRunning && agent.cancel()) {
      if (!headless) console.log("\nCancelling current CodePilot operation...");
      return;
    }
    if (shuttingDown) return;
    shuttingDown = true;
    void disposeTools().finally(() => process.exit(130));
  };
  process.on("SIGINT", interrupt);

  const runAgent = async (prompt: string) => {
    await undo.clear();
    agentRunning = true;
    try {
      await agent.run(await expandFileReferences(root, prompt));
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        console.log("Operation cancelled.");
        return;
      }
      throw error;
    } finally {
      agentRunning = false;
    }
  };

  const requestedSession = argValue(args, "--session");
  if (requestedSession) {
    if (!(await agent.load(requestedSession))) throw Error(`Saved session not found: ${requestedSession}`);
  } else if (args.includes("--resume") || args.includes("--continue")) {
    if (!(await agent.load())) console.log("No previous session found for this workspace; starting a new one.");
  }
  const recovery = agent.getLastRecoveryNotice();
  if (recovery) {
    const notice = `[recovery] ${recovery.message}`;
    if (headless) console.error(notice);
    else console.log(notice);
  }

  const prompt = promptFromArgs(args);
  if (!prompt && headless) throw Error("--headless requires a task prompt");
  if (!headless) console.log(`CodePilot - ${config.provider}/${config.model} - ${mode}\nWorkspace: ${root}\nSession: ${agent.getSessionId()}`);

  if (prompt) {
    try {
      if (headless) {
        await undo.clear();
        agentRunning = true;
        const result = await runHeadless({
          root,
          task: prompt,
          agentPrompt: await expandFileReferences(root, prompt),
          agent,
          maxRuntimeMs: config.headlessMaxRuntimeMs,
          maxSteps: config.maxSteps,
          maxToolCalls: config.maxToolCalls,
          maxRunInputTokens: config.maxRunInputTokens,
          maxRunOutputTokens: config.maxRunOutputTokens,
          maxRunTotalTokens: config.maxRunTotalTokens,
          resultPath: argValue(args, "--output"),
          patchPath: argValue(args, "--patch-output"),
          provider: {
            name: config.provider,
            model: config.model,
            mode: providerMode,
            ...(providerTracePath ? { tracePath: providerTracePath } : {}),
          },
        });
        console.log(JSON.stringify(result));
        process.exitCode = result.exitCode;
      } else {
        await runAgent(prompt);
      }
      return;
    } finally {
      agentRunning = false;
      process.off("SIGINT", interrupt);
      await disposeTools();
    }
  }

  const readline = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const question = (await readline.question(`codepilot:${mode}> `)).trim();
      if (!question) continue;
      if (["/exit", "/quit"].includes(question)) break;
      if (question === "/help") {
        console.log(help());
        continue;
      }
      if (question === "/workspace") {
        console.log(root);
        continue;
      }
      if (question === "/session") {
        console.log(agent.getSessionId());
        continue;
      }
      if (question === "/sessions") {
        const sessions = await listSessions(root);
        console.log(
          sessions.length
            ? sessions.map((item) => `${item.id}  ${item.updatedAt}  ${item.messageCount} messages`).join("\n")
            : "(no saved sessions)",
        );
        continue;
      }
      if (question === "/clear") {
        agent.clear();
        console.log("Conversation cleared.");
        continue;
      }
      if (question === "/mode") {
        console.log(`Mode: ${mode}`);
        continue;
      }
      if (question === "/mode plan") {
        setMode("plan");
        continue;
      }
      if (question === "/mode build") {
        setMode("build");
        continue;
      }
      if (question.startsWith("/init")) {
        console.log(await initProject(root, question.includes("--force")));
        continue;
      }
      if (question === "/index") {
        const index = await saveProjectIndex(root);
        console.log(`Saved .codepilot/index.json\n${summarizeProjectIndex(index)}`);
        continue;
      }
      if (question === "/check") {
        console.log(await runChecks(root));
        continue;
      }
      if (question === "/doctor") {
        console.log(formatDoctorReport(await diagnose(root, config, mcpConfiguration)));
        continue;
      }
      if (question === "/mcp") {
        console.log(formatMcpStatuses(mcpRuntime.statuses));
        continue;
      }
      if (question.startsWith("/remember ")) {
        console.log(`Remembered: ${await remember(root, question.slice("/remember ".length))}`);
        continue;
      }
      if (question === "/memory" || question.startsWith("/memory ")) {
        const query = question.slice("/memory".length).trim();
        const blocks = query
          ? await loadRelevantMemory(root, query, {
              indexMaxTokens: config.memoryIndexMaxTokens,
              topicMaxTokens: config.memoryTopicMaxTokens,
              topicLimit: config.memoryTopicLimit,
            })
          : [];
        console.log(query
          ? blocks.map((block) => `Memory from ${block.source}:\n${block.content}`).join("\n\n") || "(no memory yet)"
          : (await readMemory(root)) || "(no memory yet)");
        continue;
      }
      if (question === "/rules") {
        console.log((await loadInstructions(root)) || "(no project instructions loaded)");
        continue;
      }
      if (question.startsWith("/rules ")) {
        const query = question.slice("/rules ".length).trim();
        const rules = await loadRelevantRules(root, query);
        if (!rules.length) {
          console.log("(no matching rules)");
        } else {
          console.log(
            rules
              .map((rule) => `Rule ${rule.source} (score ${rule.score}):\n${rule.content}`)
              .join("\n\n"),
          );
        }
        continue;
      }
      if (question === "/context") {
        console.log(await agent.contextReport());
        continue;
      }
      if (question === "/usage") {
        const usage = agent.getLastRunStats();
        console.log(usage ? JSON.stringify(usage, null, 2) : "(no completed run yet)");
        continue;
      }
      if (question === "/compact") {
        const result = await agent.compact();
        const summary = result.summary
          ? ` using ${result.summary.mode}:${result.summary.model}`
          : "";
        console.log(`Compacted ${result.count} old message(s) into .codepilot/sessions/${agent.getSessionId()}.summary.md${summary}.`);
        continue;
      }
      if (question === "/todo") {
        console.log(summarizeTodos(await readTodos(root)));
        continue;
      }
      if (question === "/undo") {
        try {
          const count = await undo.undo();
          console.log(`Restored ${count} file(s).`);
        } catch (error) {
          console.log(`Nothing to undo: ${(error as Error).message}`);
        }
        continue;
      }
      if (question === "/status") {
        console.log(await git(root, "git status --short"));
        continue;
      }
      if (question === "/diff") {
        console.log(await git(root, "git diff"));
        continue;
      }
      if (question.startsWith("/")) {
        console.log("Unknown command. Use /help.");
        continue;
      }
      await runAgent(question);
    }
  } finally {
    readline.close();
    process.off("SIGINT", interrupt);
    await disposeTools();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = error.name === "AbortError" ? 130 : 1;
});
