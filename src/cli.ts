#!/usr/bin/env node
import { exec } from "node:child_process";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { Agent } from "./agent.js";
import { runChecks } from "./check.js";
import { expandFileReferences } from "./context.js";
import { runHeadless } from "./headless.js";
import { initProject } from "./init.js";
import { loadInstructions, loadRelevantRules } from "./instructions.js";
import { loadConfig } from "./config.js";
import { readMemory, remember } from "./memory.js";
import { saveProjectIndex, summarizeProjectIndex } from "./project.js";
import { approval, nonInteractiveApproval } from "./permissions.js";
import { readTodos, summarizeTodos } from "./todo.js";
import { listSessions } from "./sessions.js";
import {
  AnthropicProvider,
  DeepSeekProvider,
  OpenAIProvider,
} from "./providers.js";
import { createTools } from "./tools.js";
import { UndoManager } from "./undo.js";
import { resolveWorkspace } from "./workspace.js";
import type { AgentMode } from "./types.js";
import type { ToolEvent } from "./types.js";

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

function promptFromArgs(args: string[]) {
  const flagsWithValues = new Set([
    "--provider", "--model", "--mode", "--cwd", "--session", "--max-runtime-ms", "--max-steps",
    "--max-tool-calls", "--output", "--patch-output",
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
/remember <note>      Save a project memory note
/memory               Show .codepilot/memory.md
/rules [query]        Show all instructions or rules selected for a query
/context              Show context budget report
/compact              Summarize old messages and keep recent context
/todo                 Show current task list
/undo                 Restore files changed by the previous agent run
/status               Show git status --short
/diff                 Show git diff
/clear                Clear in-memory conversation
/exit                 Exit CodePilot`;
}

async function main() {
  const args = process.argv.slice(2);
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
    headlessMaxRuntimeMs: integerArg(args, "--max-runtime-ms"),
  });

  if (!config.apiKey) throw Error("Missing API key environment variable");

  const providerOptions = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    maxRetries: config.providerMaxRetries,
    requestTimeoutMs: config.providerRequestTimeoutMs,
  };
  const provider =
    config.provider === "anthropic"
      ? new AnthropicProvider(providerOptions)
      : config.provider === "deepseek"
        ? new DeepSeekProvider(providerOptions)
        : new OpenAIProvider(providerOptions);

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
  const tools = createTools(root, {
    beforeWrite: (file) => undo.snapshot(file),
    onOutput: (name, chunk) => renderToolEvent({ phase: "output", name, args: {}, content: chunk }),
  });
  const disposeTools = async () => {
    await Promise.allSettled(tools.map((tool) => tool.dispose?.()));
  };
  const agent = new Agent({
    root,
    provider,
    tools,
    approve: headless
      ? nonInteractiveApproval(config.autoApprove, config.permissions)
      : approval(config.autoApprove, root, config.permissions),
    maxSteps: config.maxSteps,
    maxToolCalls: config.maxToolCalls,
    contextBudgetTokens: config.contextBudgetTokens,
    autoVerify: config.autoVerify,
    maxVerificationAttempts: config.maxVerificationAttempts,
    mode,
    onText: headless ? undefined : (text) => console.log(text),
    onToolEvent: renderToolEvent,
  });

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
          resultPath: argValue(args, "--output"),
          patchPath: argValue(args, "--patch-output"),
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
      if (question.startsWith("/remember ")) {
        console.log(`Remembered: ${await remember(root, question.slice("/remember ".length))}`);
        continue;
      }
      if (question === "/memory") {
        console.log((await readMemory(root)) || "(no memory yet)");
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
      if (question === "/compact") {
        const result = await agent.compact();
        const summary = result.summary
          ? ` using ${result.summary.mode}:${result.summary.model}`
          : "";
        console.log(`Compacted ${result.count} old message(s) into .codepilot/session-summary.md${summary}.`);
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
  process.exitCode = 1;
});
