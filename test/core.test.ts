import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { Agent } from "../src/agent.js";
import { expandFileReferences, findFileReferences } from "../src/context.js";
import { loadInstructions, loadRelevantRules } from "../src/instructions.js";
import { loadConfig } from "../src/config.js";
import { initProject } from "../src/init.js";
import { activeLspServerCount, closeLspServers } from "../src/lsp.js";
import { applyCodePilotPatch } from "../src/patch.js";
import { readMemory, remember } from "../src/memory.js";
import { buildProjectIndex } from "../src/project.js";
import { readSessionSummary } from "../src/session-summary.js";
import { summarizeWithDeepSeekFlash } from "../src/summarizer.js";
import { selectTargetedTestCommands } from "../src/test-selection.js";
import { readTodos } from "../src/todo.js";
import { resolvePermission } from "../src/permissions.js";
import { createTools, resolveInWorkspace } from "../src/tools.js";
import { UndoManager } from "../src/undo.js";
import { selectWorkspaceContext } from "../src/workspace-context.js";
import { resolveWorkspace } from "../src/workspace.js";
import { parseVerificationFailures } from "../src/verification.js";
import { listSessions } from "../src/sessions.js";
import type { Provider } from "../src/types.js";

test("blocks traversal", () => {
  assert.throws(() => resolveInWorkspace(path.resolve("x"), "../y"));
});

test("resolves only existing project directories as workspaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  assert.equal(await resolveWorkspace(root), await realpath(root));
  await assert.rejects(resolveWorkspace(root, "missing"), /not an existing directory/);
});

test("finds code with glob, grep, and focused file reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.ts"), "first\nconst answer = 42;\nlast\n");
  await writeFile(path.join(root, "README.md"), "guide");
  const tools = createTools(root);
  const byName = (name: string) => tools.find((tool) => tool.definition.name === name)!;

  assert.match(await byName("glob").execute({ pattern: "src/**/*.ts" }), /src[\\/]main\.ts/);
  assert.match(
    await byName("grep").execute({ query: "answer\\s*=\\s*42", regex: true, path: "src/**/*.ts", context_lines: 1 }),
    /> const answer = 42/,
  );
  assert.equal(await byName("read_file").execute({ path: "src/main.ts", start_line: 2, end_line: 2 }), "2: const answer = 42;");
});

test("streams shell output through tool hook", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  const chunks: string[] = [];
  const shell = createTools(root, { onOutput: (_name, chunk) => chunks.push(chunk) }).find(
    (tool) => tool.definition.name === "shell",
  );
  assert.ok(shell);
  const result = await shell.execute({ command: `"${process.execPath}" -e "console.log('live-output')"` });
  assert.match(chunks.join(""), /live-output/);
  assert.match(result, /exit_code: 0/);
});

test("gets TypeScript document symbols through a reused LSP server", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-lsp-"));
  t.after(() => closeLspServers(root));
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  await writeFile(
    path.join(root, "main.ts"),
    "export function greet(name: string) { return `Hello ${name}`; }\nexport const message = greet(\"Ada\");\n",
  );
  const tool = createTools(root).find((item) => item.definition.name === "lsp");
  assert.ok(tool);
  assert.match(await tool.execute({ operation: "documentSymbols", path: "main.ts" }), /greet/);
  assert.match(
    await tool.execute({ operation: "definition", path: "main.ts", line: 2, character: 24 }),
    /main\.ts/,
  );
  assert.match(
    await tool.execute({ operation: "workspaceSymbols", path: "main.ts", query: "greet" }),
    /greet/,
  );
  await writeFile(path.join(root, "main.ts"), 'const total: number = "wrong";\n');
  assert.match(await tool.execute({ operation: "diagnostics", path: "main.ts" }), /not assignable|不能分配/i);
  assert.equal(activeLspServerCount(root), 1);
});

test("gets Python document symbols through a reused LSP server", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-lsp-"));
  t.after(() => closeLspServers(root));
  await writeFile(path.join(root, "main.py"), "def greet(name: str) -> str:\n    return f'Hello {name}'\n");
  const tool = createTools(root).find((item) => item.definition.name === "lsp");
  assert.ok(tool);
  assert.match(await tool.execute({ operation: "documentSymbols", path: "main.py" }), /greet/);
  await writeFile(path.join(root, "main.py"), 'total: int = "wrong"\n');
  assert.match(await tool.execute({ operation: "diagnostics", path: "main.py" }), /not assignable|不能赋值/i);
  assert.equal(activeLspServerCount(root), 1);
});

test("cancels and evicts an active LSP server", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-lsp-"));
  t.after(() => closeLspServers(root));
  await writeFile(path.join(root, "main.py"), "value: int = 1\n");
  const tool = createTools(root).find((item) => item.definition.name === "lsp");
  assert.ok(tool);
  const controller = new AbortController();
  const result = tool.execute({ operation: "diagnostics", path: "main.py" }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(result, /cancel/i);
  assert.equal(activeLspServerCount(root), 0);
});

test("selects compact task-relevant workspace excerpts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "auth.ts"), "export function validateToken(token: string) { return token.length > 0; }");
  await writeFile(path.join(root, "src", "view.ts"), "export const title = 'home';");

  const context = await selectWorkspaceContext(root, "fix validateToken authentication bug");
  assert.match(context, /src[\\/]auth\.ts/);
  assert.match(context, /validateToken/);
  assert.doesNotMatch(context, /src[\\/]view\.ts/);
});

test("permission policy prioritizes tools and specific shell patterns", () => {
  const policy = {
    apply_patch: "ask",
    "shell:npm *": "allow",
    "shell:npm publish *": "deny",
  } as const;

  assert.deepEqual(
    resolvePermission(policy, ["read"], "write", "apply_patch", {}),
    { decision: "ask", source: "apply_patch" },
  );
  assert.deepEqual(
    resolvePermission(policy, ["read"], "execute", "shell", { command: "npm run test" }),
    { decision: "allow", source: "shell:npm *" },
  );
  assert.deepEqual(
    resolvePermission(policy, ["execute"], "execute", "shell", { command: "npm publish next" }),
    { decision: "deny", source: "shell:npm publish *" },
  );
});

test("loads valid permission decisions from project config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  await writeFile(
    path.join(root, ".codepilot.json"),
    JSON.stringify({
      provider: "openai",
      permissions: { apply_patch: "ask", "shell:git push *": "deny", invalid: "maybe" },
    }),
  );

  const config = await loadConfig(root);
  assert.deepEqual(config.permissions, { apply_patch: "ask", "shell:git push *": "deny" });
});

test("runs tool loop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  let calls = 0;
  const provider: Provider = {
    async complete() {
      return ++calls === 1
        ? {
            text: "",
            toolCalls: [
              {
                id: "1",
                name: "write_file",
                arguments: { path: "a", content: "ok" },
              },
            ],
          }
        : { text: "done", toolCalls: [] };
    },
  };
  const agent = new Agent({
    root,
    provider,
    tools: createTools(root),
    approve: async () => true,
    maxSteps: 3,
    contextBudgetTokens: 64000,
    mode: "build",
  });

  assert.equal(await agent.run("go"), "done");
  assert.equal(await readFile(path.join(root, "a"), "utf8"), "ok");
});

test("automatically verifies code changes and asks the agent to repair failures", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-verify-"));
  t.after(() => closeLspServers(root));
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  let calls = 0;
  let receivedFailure = false;
  const provider: Provider = {
    async complete(input) {
      calls++;
      if (calls === 1) {
        return { text: "", toolCalls: [{ id: "write-bad", name: "write_file", arguments: { path: "main.ts", content: 'const value: number = "bad";\n' } }] };
      }
      if (calls === 2) return { text: "done", toolCalls: [] };
      if (calls === 3) {
        receivedFailure = input.messages.some((message) => message.role === "user" && /Automatic verification failed/.test(message.content));
        return { text: "", toolCalls: [{ id: "write-fix", name: "write_file", arguments: { path: "main.ts", content: "const value: number = 1;\n" } }] };
      }
      return { text: "fixed", toolCalls: [] };
    },
  };
  const tools = createTools(root);
  const rendered: string[] = [];
  const agent = new Agent({
    root,
    provider,
    tools,
    approve: async () => true,
    maxSteps: 6,
    contextBudgetTokens: 64000,
    mode: "build",
    onText: (text) => rendered.push(text),
  });

  assert.equal(await agent.run("fix the type error"), "fixed");
  assert.equal(calls, 4);
  assert.equal(receivedFailure, true);
  assert.deepEqual(rendered, ["fixed"]);
  assert.equal(await readFile(path.join(root, "main.ts"), "utf8"), "const value: number = 1;\n");
  const reports = await readdir(path.join(root, ".codepilot", "runs"));
  assert.equal(reports.length, 1);
  const report = JSON.parse(await readFile(path.join(root, ".codepilot", "runs", reports[0]), "utf8"));
  assert.equal(report.finalStatus, "passed");
  assert.equal(report.sessionId, agent.getSessionId());
  assert.equal(report.attempts.length, 2);
});

test("does not fail verification for diagnostics that existed before the edit", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-baseline-"));
  t.after(() => closeLspServers(root));
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
  await writeFile(path.join(root, "main.ts"), 'const value: number = "existing";\nexport const label = "before";\n');
  let calls = 0;
  const provider: Provider = {
    async complete() {
      calls++;
      return calls === 1
        ? {
            text: "",
            toolCalls: [{
              id: "patch",
              name: "apply_patch",
              arguments: {
                patch: [
                  "*** Begin Patch",
                  "*** Update File: main.ts",
                  "@@",
                  '-export const label = "before";',
                  '+export const label = "after";',
                  "*** End Patch",
                ].join("\n"),
              },
            }],
          }
        : { text: "done", toolCalls: [] };
    },
  };
  const agent = new Agent({
    root,
    provider,
    tools: createTools(root),
    approve: async () => true,
    maxSteps: 4,
    contextBudgetTokens: 64000,
    mode: "build",
  });

  assert.equal(await agent.run("rename the label"), "done");
  assert.equal(calls, 2);
  const reports = await readdir(path.join(root, ".codepilot", "runs"));
  const report = JSON.parse(await readFile(path.join(root, ".codepilot", "runs", reports[0]), "utf8"));
  assert.equal(report.finalStatus, "passed");
  assert.equal(report.attempts[0].checks[0].kind, "diagnostics");
  assert.deepEqual(JSON.parse(report.attempts[0].checks[0].output).newDiagnostics, []);
});

test("reports automatic verification as incomplete when required permission is denied", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-verify-"));
  let calls = 0;
  const provider: Provider = {
    async complete() {
      calls++;
      return calls === 1
        ? { text: "", toolCalls: [{ id: "write", name: "write_file", arguments: { path: "main.ts", content: "export const value = 1;\n" } }] }
        : { text: "done", toolCalls: [] };
    },
  };
  const agent = new Agent({
    root,
    provider,
    tools: createTools(root),
    approve: async (_risk, name) => name !== "lsp",
    maxSteps: 3,
    contextBudgetTokens: 64000,
    mode: "build",
  });

  assert.match(await agent.run("edit code"), /verification was incomplete/i);
  const reports = await readdir(path.join(root, ".codepilot", "runs"));
  const report = JSON.parse(await readFile(path.join(root, ".codepilot", "runs", reports[0]), "utf8"));
  assert.equal(report.finalStatus, "skipped");
});

test("does not resend empty tool call arrays from prior turns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  let received: import("../src/types.js").Message[] = [];
  const provider: Provider = {
    async complete(input) {
      received = input.messages;
      return { text: "done", toolCalls: [] };
    },
  };
  const agent = new Agent({
    root,
    provider,
    tools: createTools(root),
    approve: async () => true,
    maxSteps: 3,
    contextBudgetTokens: 64000,
    mode: "build",
  });

  await agent.run("first task");
  await agent.run("second task");
  assert.ok(!received.some((message) => message.role === "assistant" && message.toolCalls?.length === 0));
});

test("cancels an active provider request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let calls = 0;
  let messagesAfterCancel: import("../src/types.js").Message[] = [];
  const provider: Provider = {
    async complete(input) {
      calls++;
      if (calls > 1) {
        messagesAfterCancel = input.messages;
        return { text: "recovered", toolCalls: [] };
      }
      markStarted();
      return await new Promise((_resolve, reject) => {
        input.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      });
    },
  };
  const agent = new Agent({
    root,
    provider,
    tools: createTools(root),
    approve: async () => true,
    maxSteps: 3,
    contextBudgetTokens: 64000,
    mode: "build",
  });

  const running = agent.run("long task");
  await started;
  assert.equal(agent.cancel(), true);
  await assert.rejects(running, (error: Error) => error.name === "AbortError");
  assert.equal(agent.cancel(), false);
  assert.equal(await agent.run("next task"), "recovered");
  assert.ok(!messagesAfterCancel.some((message) => message.role === "user" && message.content === "long task"));
});

test("sanitizes malformed persisted session messages on load", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  await mkdir(path.join(root, ".codepilot"));
  await writeFile(
    path.join(root, ".codepilot", "session.json"),
    JSON.stringify([
      { role: "assistant", content: "old", toolCalls: [] },
      { role: "unexpected", content: "discard" },
    ]),
  );
  let received: import("../src/types.js").Message[] = [];
  const provider: Provider = {
    async complete(input) {
      received = input.messages;
      return { text: "done", toolCalls: [] };
    },
  };
  const agent = new Agent({
    root,
    provider,
    tools: createTools(root),
    approve: async () => true,
    maxSteps: 3,
    contextBudgetTokens: 64000,
    mode: "build",
  });
  await agent.load();
  await agent.run("new task");
  assert.deepEqual(received[0], { role: "assistant", content: "old" });
});

test("saves indexed sessions and resumes an exact session id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  const provider: Provider = { async complete() { return { text: "done", toolCalls: [] }; } };
  const options = {
    root,
    provider,
    tools: createTools(root),
    approve: async () => true,
    maxSteps: 3,
    contextBudgetTokens: 64000,
    mode: "build" as const,
  };
  const first = new Agent(options);
  await first.run("remember this");
  const id = first.getSessionId();
  const sessions = await listSessions(root);
  assert.equal(sessions[0].id, id);
  assert.equal(sessions[0].messageCount, 2);

  const continued = new Agent(options);
  assert.equal(await continued.load(), true);
  assert.equal(continued.getSessionId(), id);

  const resumed = new Agent(options);
  assert.equal(await resumed.load(id), true);
  await resumed.run("continue");
  let received: import("../src/types.js").Message[] = [];
  const inspecting = new Agent({ ...options, provider: { async complete(input) { received = input.messages; return { text: "ok", toolCalls: [] }; } } });
  assert.equal(await inspecting.load(id), true);
  await inspecting.run("inspect");
  assert.match(received[0].content, /remember this/);
});

test("plan mode blocks write tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  let calls = 0;
  const provider: Provider = {
    async complete() {
      return ++calls === 1
        ? {
            text: "",
            toolCalls: [
              {
                id: "1",
                name: "write_file",
                arguments: { path: "a", content: "nope" },
              },
            ],
          }
        : { text: "planned", toolCalls: [] };
    },
  };
  const agent = new Agent({
    root,
    provider,
    tools: createTools(root),
    approve: async () => true,
    maxSteps: 3,
    contextBudgetTokens: 64000,
    mode: "plan",
  });

  assert.equal(await agent.run("go"), "planned");
  await assert.rejects(readFile(path.join(root, "a"), "utf8"));
});

test("undo restores the previous file state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  const undo = new UndoManager(root);
  const target = path.join(root, "a.txt");
  await writeFile(target, "before");

  const writeTool = createTools(root, { beforeWrite: (file) => undo.snapshot(file) }).find(
    (tool) => tool.definition.name === "write_file",
  );
  assert.ok(writeTool);

  await writeTool.execute({ path: "a.txt", content: "after" });
  assert.equal(await readFile(target, "utf8"), "after");
  assert.equal(await undo.undo(), 1);
  assert.equal(await readFile(target, "utf8"), "before");
});

test("applies auditable patches through tool layer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  const target = path.join(root, "a.txt");
  await writeFile(target, "before");
  const tool = createTools(root).find((item) => item.definition.name === "apply_patch");
  assert.ok(tool);

  const result = await tool.execute({
    patch: [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-before",
      "+after",
      "*** End Patch",
    ].join("\n"),
  });

  const transaction = JSON.parse(result);
  assert.equal(transaction.status, "committed");
  assert.deepEqual(transaction.changes.map((change: { path: string; operation: string }) => [change.path, change.operation]), [["a.txt", "update"]]);
  assert.equal(await readFile(target, "utf8"), "after");
});

test("preflights every patch operation before modifying files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-patch-"));
  await writeFile(path.join(root, "a.txt"), "alpha");
  await writeFile(path.join(root, "b.txt"), "beta");
  const patch = [
    "*** Begin Patch",
    "*** Update File: a.txt",
    "@@",
    "-alpha",
    "+changed",
    "*** Update File: b.txt",
    "@@",
    "-missing",
    "+changed",
    "*** End Patch",
  ].join("\n");

  await assert.rejects(applyCodePilotPatch(root, patch), /not found/);
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "alpha");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "beta");
});

test("rolls back all files when a patch commit fails midway", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-patch-"));
  await writeFile(path.join(root, "a.txt"), "alpha");
  await writeFile(path.join(root, "b.txt"), "beta");
  const patch = [
    "*** Begin Patch",
    "*** Update File: a.txt",
    "@@",
    "-alpha",
    "+changed-a",
    "*** Update File: b.txt",
    "@@",
    "-beta",
    "+changed-b",
    "*** End Patch",
  ].join("\n");

  await assert.rejects(
    applyCodePilotPatch(root, patch, undefined, {
      beforeCommit: async (index) => {
        if (index === 1) await writeFile(path.join(root, "b.txt"), "external beta");
      },
    }),
    /changed during patch transaction/,
  );
  assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), "alpha");
  assert.equal(await readFile(path.join(root, "b.txt"), "utf8"), "external beta");
  assert.deepEqual((await readdir(root)).sort(), ["a.txt", "b.txt"]);
});

test("rejects edits when a file changed after CodePilot read it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-patch-"));
  const target = path.join(root, "a.txt");
  await writeFile(target, "original");
  const tools = createTools(root);
  const read = tools.find((item) => item.definition.name === "read_file");
  const patch = tools.find((item) => item.definition.name === "apply_patch");
  assert.ok(read && patch);
  await read.execute({ path: "a.txt" });
  await writeFile(target, "external change");

  await assert.rejects(patch.execute({
    patch: [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-external change",
      "+agent change",
      "*** End Patch",
    ].join("\n"),
  }), /changed since it was read/);
  assert.equal(await readFile(target, "utf8"), "external change");
});

test("writes and reads task list through todo tools", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  const tools = createTools(root);
  const write = tools.find((item) => item.definition.name === "todo_write");
  const read = tools.find((item) => item.definition.name === "todo_read");
  assert.ok(write);
  assert.ok(read);

  await write.execute({
    todos: [
      { content: "inspect files", status: "completed" },
      { content: "edit code", status: "in_progress" },
    ],
  });

  assert.deepEqual(await readTodos(root), [
    { content: "inspect files", status: "completed" },
    { content: "edit code", status: "in_progress" },
  ]);
  assert.match(await read.execute({}), /\[in_progress\] edit code/);
});

test("init creates AGENTS.md", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "demo", scripts: { test: "node --test" } }),
  );

  assert.match(await initProject(root), /Created AGENTS.md/);
  const guide = await readFile(path.join(root, "AGENTS.md"), "utf8");
  assert.match(guide, /Project: demo/);
  assert.match(guide, /test: `node --test`/);
});

test("expands @file references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  await writeFile(path.join(root, "note.md"), "hello from file");

  assert.deepEqual(findFileReferences("read @note.md please"), ["note.md"]);
  const expanded = await expandFileReferences(root, "read @note.md please");
  assert.match(expanded, /Referenced files:/);
  assert.match(expanded, /hello from file/);
});

test("builds project index with check commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "demo",
      scripts: { typecheck: "tsc --noEmit", test: "node --test", build: "tsc" },
      devDependencies: { typescript: "latest" },
    }),
  );
  await writeFile(path.join(root, "tsconfig.json"), "{}");

  const index = await buildProjectIndex(root);
  assert.equal(index.name, "demo");
  assert.ok(index.stack.includes("TypeScript"));
  assert.deepEqual(index.checkCommands, ["npm run typecheck", "npm run test", "npm run build"]);
});

test("selects related JavaScript and Python tests before full verification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-tests-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "test"));
  await mkdir(path.join(root, "tests"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  await writeFile(path.join(root, "src", "parser.ts"), "export const parse = () => 1;\n");
  await writeFile(path.join(root, "test", "parser.test.ts"), "test('parser', () => {});\n");
  await writeFile(path.join(root, "test", "unrelated.test.ts"), "test('other', () => {});\n");
  await writeFile(path.join(root, "src", "reader.py"), "def read(): return 1\n");
  await writeFile(path.join(root, "tests", "test_reader.py"), "def test_read(): pass\n");

  const commands = await selectTargetedTestCommands(root, ["src/parser.ts", "src/reader.py"]);
  assert.equal(commands.length, 2);
  assert.match(commands[0], /pytest .*test_reader\.py.* -q/);
  assert.match(commands[1], /npm test -- .*parser\.test\.ts/);
  assert.doesNotMatch(commands.join("\n"), /unrelated/);
});

test("parses common test and compiler failures into structured records", () => {
  const failures = parseVerificationFailures([
    "FAILED tests/test_parser.py::test_empty - AssertionError: expected []",
    "src/parser.py:42: AssertionError: invalid value",
    "src/app.ts(7,13): error TS2322: Type 'string' is not assignable to type 'number'.",
  ].join("\n"));
  assert.deepEqual(failures, [
    { test: "tests/test_parser.py::test_empty", message: "AssertionError: expected []" },
    { file: "src/parser.py", line: 42, character: undefined, message: "AssertionError: invalid value" },
    { file: "src/app.ts", line: 7, character: 13, code: "TS2322", message: "Type 'string' is not assignable to type 'number'." },
  ]);
});

test("loads instructions, rules, imports, and memory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  await writeFile(path.join(root, "README.md"), "readme context");
  await writeFile(path.join(root, "AGENTS.md"), "project rule @README.md");
  await mkdir(path.join(root, ".codepilot", "rules"), { recursive: true });
  await writeFile(path.join(root, ".codepilot", "rules", "style.md"), "style rule");
  await remember(root, "prefer focused edits");

  const instructions = await loadInstructions(root);
  assert.match(instructions, /Instructions from AGENTS.md/);
  assert.match(instructions, /readme context/);
  assert.match(instructions, /Instructions from \.codepilot[\\/]rules[\\/]style\.md/);
  assert.match(instructions, /prefer focused edits/);
  assert.match(await readMemory(root), /prefer focused edits/);
});

test("selects relevant project rules by query", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  await mkdir(path.join(root, ".codepilot", "rules"), { recursive: true });
  await writeFile(path.join(root, ".codepilot", "rules", "testing.md"), "# Testing\nRun npm test after changes.");
  await writeFile(path.join(root, ".codepilot", "rules", "style.md"), "# Style\nUse concise names.");

  const rules = await loadRelevantRules(root, "fix failing tests");
  assert.equal(rules[0]?.source, path.join(".codepilot", "rules", "testing.md"));
  assert.ok(rules.every((rule) => !rule.source.endsWith("style.md")));
});

test("injects only relevant rules into agent context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  await mkdir(path.join(root, ".codepilot", "rules"), { recursive: true });
  await writeFile(path.join(root, ".codepilot", "rules", "testing.md"), "# Testing\nRun npm test after changes.");
  await writeFile(path.join(root, ".codepilot", "rules", "release.md"), "# Release\nUpdate changelog before publishing.");
  let system = "";
  const provider: Provider = {
    async complete(input) {
      system = input.system;
      return { text: "done", toolCalls: [] };
    },
  };
  const agent = new Agent({
    root,
    provider,
    tools: createTools(root),
    approve: async () => true,
    maxSteps: 3,
    contextBudgetTokens: 64000,
    mode: "build",
  });

  await agent.run("fix failing tests");
  assert.match(system, /Testing/);
  assert.doesNotMatch(system, /Release/);
});

test("compacts old messages into session summary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  let calls = 0;
  const provider: Provider = {
    async complete() {
      calls += 1;
      return { text: `reply ${calls}`, toolCalls: [] };
    },
  };
  const agent = new Agent({
    root,
    provider,
    tools: createTools(root),
    approve: async () => true,
    maxSteps: 3,
    contextBudgetTokens: 1200,
    mode: "build",
  });

  await agent.run("first message");
  await agent.run("second message");
  const compacted = await agent.compact(2);
  assert.ok(compacted.count > 0);
  assert.match(await readSessionSummary(root, agent.getSessionId()), /first message/);
  assert.match(await agent.contextReport(), /budgetTokens:/);
});

test("auto compacts omitted messages before provider call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  let seenMessages = 0;
  const provider: Provider = {
    async complete(input) {
      seenMessages = input.messages.length;
      return { text: "done", toolCalls: [] };
    },
  };
  const agent = new Agent({
    root,
    provider,
    tools: createTools(root),
    approve: async () => true,
    maxSteps: 3,
    contextBudgetTokens: 2000,
    mode: "build",
  });

  await agent.run("x".repeat(12000));
  await agent.run("current");
  assert.ok(seenMessages < 4);
  assert.match(await readSessionSummary(root, agent.getSessionId()), /user:/);
});

test("keeps compacted summaries isolated by session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  const provider: Provider = {
    async complete() {
      return { text: "done", toolCalls: [] };
    },
  };
  const options = {
    root,
    provider,
    tools: createTools(root),
    approve: async () => true,
    maxSteps: 3,
    contextBudgetTokens: 64000,
    mode: "build" as const,
  };

  const first = new Agent(options);
  await first.run("alpha durable detail");
  await first.run("alpha current task");
  await first.compact(2);

  const second = new Agent(options);
  await second.run("beta durable detail");
  await second.run("beta current task");
  await second.compact(2);

  const firstSummary = await readSessionSummary(root, first.getSessionId());
  const secondSummary = await readSessionSummary(root, second.getSessionId());
  assert.match(firstSummary, /alpha durable detail/);
  assert.doesNotMatch(firstSummary, /beta durable detail/);
  assert.match(secondSummary, /beta durable detail/);
  assert.doesNotMatch(secondSummary, /alpha durable detail/);

  let system = "";
  const fresh = new Agent({
    ...options,
    provider: {
      async complete(input) {
        system = input.system;
        return { text: "fresh", toolCalls: [] };
      },
    },
  });
  await fresh.run("unrelated fresh session");
  assert.doesNotMatch(system, /alpha durable detail|beta durable detail/);
});

test("migrates one legacy summary when its session is resumed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  const provider: Provider = {
    async complete() {
      return { text: "done", toolCalls: [] };
    },
  };
  const options = {
    root,
    provider,
    tools: createTools(root),
    approve: async () => true,
    maxSteps: 3,
    contextBudgetTokens: 64000,
    mode: "build" as const,
  };
  const original = new Agent(options);
  await original.run("seed session");
  const id = original.getSessionId();
  const legacy = path.join(root, ".codepilot", "session-summary.md");
  await writeFile(legacy, "legacy compacted context");

  const resumed = new Agent(options);
  assert.equal(await resumed.load(id), true);
  assert.equal(await readSessionSummary(root, id), "legacy compacted context");
  await assert.rejects(readFile(legacy));
});

test("deepseek flash summarizer falls back without api key", async () => {
  const old = process.env.DEEPSEEK_API_KEY;
  try {
    delete process.env.DEEPSEEK_API_KEY;
    const result = await summarizeWithDeepSeekFlash([{ role: "user", content: "remember this task" }]);
    assert.equal(result.mode, "fallback");
    assert.equal(result.model, "local-fallback");
    assert.match(result.text, /remember this task/);
  } finally {
    old === undefined ? delete process.env.DEEPSEEK_API_KEY : (process.env.DEEPSEEK_API_KEY = old);
  }
});

test("selects deepseek from environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-"));
  const old = {
    deepseek: process.env.DEEPSEEK_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };

  try {
    process.env.DEEPSEEK_API_KEY = "test-key";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const config = await loadConfig(root);
    assert.equal(config.provider, "deepseek");
    assert.equal(config.model, "deepseek-v4-pro");
    assert.equal(config.baseUrl, "https://api.deepseek.com");
    assert.equal(config.apiKey, "test-key");
    assert.equal(config.providerMaxRetries, 2);
    assert.equal(config.providerRequestTimeoutMs, 120_000);
    assert.equal(config.maxToolCalls, 100);
    assert.equal(config.headlessMaxRuntimeMs, 900_000);
  } finally {
    old.deepseek === undefined
      ? delete process.env.DEEPSEEK_API_KEY
      : (process.env.DEEPSEEK_API_KEY = old.deepseek);
    old.anthropic === undefined
      ? delete process.env.ANTHROPIC_API_KEY
      : (process.env.ANTHROPIC_API_KEY = old.anthropic);
    old.openai === undefined
      ? delete process.env.OPENAI_API_KEY
      : (process.env.OPENAI_API_KEY = old.openai);
  }
});
