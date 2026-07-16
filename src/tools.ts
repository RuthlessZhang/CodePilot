import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { applyCodePilotPatch, contentHash, patchPaths, writeTextFileAtomic, type PatchTransactionResult } from "./patch.js";
import { buildCodeGraph, codeGraphSummary, queryCodeGraph } from "./code-graph.js";
import { analyzeImpact } from "./impact-analysis.js";
import { buildProjectIndex, summarizeProjectIndex } from "./project.js";
import { normalizeTodos, readTodos, summarizeTodos, writeTodos } from "./todo.js";
import { closeLspServers, queryLsp } from "./lsp.js";
import type { Tool } from "./types.js";

type ToolHooks = {
  beforeWrite?: (absPath: string) => Promise<void>;
  onOutput?: (name: string, chunk: string) => void;
};

const schema = (properties: unknown, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const stringArg = (value: unknown) => {
  if (typeof value !== "string") throw Error("Expected string");
  return value;
};

const numberArg = (value: unknown, fallback: number) => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) throw Error("Expected integer");
  return value;
};

export function resolveInWorkspace(root: string, value: string) {
  const resolved = path.resolve(root, value);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw Error("Path escapes workspace");
  }
  return resolved;
}

async function allFiles(root: string, dir: string) {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", ".codepilot"].includes(entry.name)) {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await allFiles(root, entryPath)));
    else out.push(entryPath);
  }
  return out.slice(0, 2000);
}

function globMatches(value: string, pattern: string) {
  const normalized = value.replace(/\\/g, "/");
  const source = pattern.replace(/\\/g, "/");
  let expression = "";
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === "*") {
      if (source[index + 1] === "*") {
        index++;
        if (source[index + 1] === "/") {
          index++;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
    } else if (char === "?") {
      expression += "[^/]";
    } else {
      expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${expression}$`).test(normalized);
}

async function matchingFiles(root: string, pattern = "**/*") {
  const files = await allFiles(root, root);
  return files.filter((file) => globMatches(path.relative(root, file), pattern));
}

function lineSlice(content: string, startLine: number, endLine?: number) {
  if (startLine < 1) throw Error("start_line must be at least 1");
  const lines = content.split(/\r?\n/);
  const end = endLine ?? lines.length;
  if (end < startLine) throw Error("end_line must be greater than or equal to start_line");
  return lines.slice(startLine - 1, end).map((line, index) => `${startLine + index}: ${line}`).join("\n");
}

function cancellationError() {
  const error = new Error("Operation cancelled");
  error.name = "AbortError";
  return error;
}

function run(root: string, command: string, onOutput?: (chunk: string) => void, signal?: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) return reject(cancellationError());
    const child = spawn(command, { cwd: root, shell: true, windowsHide: true });
    const maxOutputChars = 1_000_000;
    let output = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      onOutput?.(text);
      if (output.length >= maxOutputChars) {
        truncated = true;
        return;
      }
      output += text.slice(0, maxOutputChars - output.length);
      if (output.length >= maxOutputChars) truncated = true;
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 120000);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      reject(cancellationError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => append(Buffer.from(`Unable to start command: ${error.message}\n`)));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      const suffix = `${truncated ? "\n[output truncated]" : ""}${timedOut ? "\n[command timed out after 120s]" : ""}`;
      resolve(`exit_code: ${timedOut ? 124 : code ?? 1}\n${output}${suffix}`);
    });
  });
}

export function createTools(root: string, hooks: ToolHooks = {}): Tool[] {
  const observedHashes = new Map<string, string>();
  const rememberTransaction = (result: PatchTransactionResult) => {
    for (const change of result.changes) {
      const target = resolveInWorkspace(root, change.path);
      if (change.afterHash) observedHashes.set(target, change.afterHash);
      else observedHashes.delete(target);
    }
    return JSON.stringify(result, null, 2);
  };
  return [
    {
      risk: "read",
      definition: {
        name: "todo_read",
        description: "Read CodePilot's current task list for this workspace.",
        inputSchema: schema({}),
      },
      async execute() {
        return summarizeTodos(await readTodos(root));
      },
    },
    {
      risk: "read",
      definition: {
        name: "todo_write",
        description:
          "Replace CodePilot's task list for the current work. Use pending, in_progress, and completed statuses to track multi-step coding tasks.",
        inputSchema: schema(
          {
            todos: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  content: { type: "string" },
                  status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                },
                required: ["content", "status"],
                additionalProperties: false,
              },
            },
          },
          ["todos"],
        ),
      },
      async execute(args) {
        return await writeTodos(root, normalizeTodos(args.todos));
      },
    },
    {
      risk: "read",
      definition: {
        name: "read_file",
        description: "Read a text file from the workspace. Use start_line and end_line for a focused range.",
        inputSchema: schema({
          path: { type: "string" },
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
        }, ["path"]),
      },
      async execute(args) {
        const target = resolveInWorkspace(root, stringArg(args.path));
        const content = await readFile(target, "utf8");
        observedHashes.set(target, contentHash(content));
        if (args.start_line === undefined && args.end_line === undefined) return content;
        return lineSlice(content, numberArg(args.start_line, 1), numberArg(args.end_line, content.split(/\r?\n/).length));
      },
    },
    {
      risk: "read",
      definition: {
        name: "list_files",
        description: "List workspace files, excluding dependencies, build output, git data, and CodePilot state.",
        inputSchema: schema({}),
      },
      async execute() {
        return (await allFiles(root, root))
          .map((file) => path.relative(root, file))
          .join("\n");
      },
    },
    {
      risk: "read",
      definition: {
        name: "glob",
        description: "Find workspace files by glob pattern, for example src/**/*.ts or test/?.test.ts. Dependencies, git data, build output, and CodePilot state are excluded.",
        inputSchema: schema({ pattern: { type: "string" } }, ["pattern"]),
      },
      async execute(args) {
        const pattern = stringArg(args.pattern);
        return (await matchingFiles(root, pattern))
          .slice(0, 500)
          .map((file) => path.relative(root, file))
          .join("\n") || "No matches";
      },
    },
    {
      risk: "read",
      definition: {
        name: "grep",
        description: "Search workspace text with a literal string or regular expression. Optionally restrict files with a glob and include surrounding context lines.",
        inputSchema: schema({
          query: { type: "string" },
          path: { type: "string", description: "Optional file glob, such as src/**/*.ts" },
          regex: { type: "boolean", description: "Treat query as a JavaScript regular expression" },
          ignore_case: { type: "boolean" },
          context_lines: { type: "integer", minimum: 0, maximum: 10 },
          max_results: { type: "integer", minimum: 1, maximum: 500 },
        }, ["query"]),
      },
      async execute(args) {
        const query = stringArg(args.query);
        const pattern = typeof args.path === "string" ? args.path : "**/*";
        const flags = args.ignore_case === true ? "i" : "";
        const expression = args.regex === true
          ? new RegExp(query, flags)
          : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
        const contextLines = Math.min(10, Math.max(0, numberArg(args.context_lines, 0)));
        const maxResults = Math.min(500, Math.max(1, numberArg(args.max_results, 100)));
        const matches: string[] = [];
        for (const file of await matchingFiles(root, pattern)) {
          try {
            const lines = (await readFile(file, "utf8")).split(/\r?\n/);
            for (let index = 0; index < lines.length && matches.length < maxResults; index++) {
              expression.lastIndex = 0;
              if (!expression.test(lines[index])) continue;
              const start = Math.max(0, index - contextLines);
              const end = Math.min(lines.length, index + contextLines + 1);
              const block = lines.slice(start, end).map((line, offset) => {
                const lineNumber = start + offset + 1;
                return `${path.relative(root, file)}:${lineNumber}:${lineNumber === index + 1 ? ">" : " "} ${line}`;
              });
              matches.push(block.join("\n"));
            }
          } catch {
            // Ignore binary or unreadable files.
          }
          if (matches.length >= maxResults) break;
        }
        return matches.join("\n\n") || "No matches";
      },
    },
    {
      risk: "read",
      definition: {
        name: "search",
        description: "Search for literal text in workspace files.",
        inputSchema: schema({ query: { type: "string" } }, ["query"]),
      },
      async execute(args) {
        const query = stringArg(args.query);
        const matches: string[] = [];
        for (const file of await allFiles(root, root)) {
          try {
            const lines = (await readFile(file, "utf8")).split(/\r?\n/);
            lines.forEach((line, index) => {
              if (line.includes(query) && matches.length < 500) {
                matches.push(`${path.relative(root, file)}:${index + 1}:${line}`);
              }
            });
          } catch {
            // Ignore binary or unreadable files.
          }
        }
        return matches.join("\n") || "No matches";
      },
    },
    {
      risk: "read",
      definition: {
        name: "lsp",
        description: "Use language intelligence for TypeScript, JavaScript, or Python. Supports document/workspace symbols, definition, references, hover, and diagnostics. Line and character inputs are 1-based.",
        inputSchema: schema(
          {
            operation: { type: "string", enum: ["documentSymbols", "workspaceSymbols", "definition", "references", "hover", "diagnostics"] },
            path: { type: "string" },
            line: { type: "integer", minimum: 1 },
            character: { type: "integer", minimum: 1 },
            includeDeclaration: { type: "boolean" },
            query: { type: "string", description: "Symbol name query for workspaceSymbols." },
          },
          ["operation", "path"],
        ),
      },
      async execute(args, context) {
        const operation = stringArg(args.operation);
        if (!["documentSymbols", "workspaceSymbols", "definition", "references", "hover", "diagnostics"].includes(operation)) throw Error("Unsupported LSP operation");
        return await queryLsp(root, {
          operation: operation as "documentSymbols" | "workspaceSymbols" | "definition" | "references" | "hover" | "diagnostics",
          path: stringArg(args.path),
          line: args.line === undefined ? undefined : numberArg(args.line, 1),
          character: args.character === undefined ? undefined : numberArg(args.character, 1),
          includeDeclaration: typeof args.includeDeclaration === "boolean" ? args.includeDeclaration : undefined,
          query: args.query === undefined ? undefined : stringArg(args.query),
        }, context?.signal);
      },
      async dispose() {
        await closeLspServers(root);
      },
    },
    {
      risk: "read",
      definition: {
        name: "git_status",
        description: "Show concise git working tree status.",
        inputSchema: schema({}),
      },
      async execute(_args, context) {
        return await run(root, "git status --short", (chunk) => hooks.onOutput?.("git_status", chunk), context?.signal);
      },
    },
    {
      risk: "read",
      definition: {
        name: "project_index",
        description: "Summarize detected project metadata and the semantic code graph.",
        inputSchema: schema({}),
      },
      async execute() {
        const index = await buildProjectIndex(root);
        const graph = await buildCodeGraph(root);
        return `${summarizeProjectIndex(index)}\nCode graph: ${JSON.stringify(codeGraphSummary(graph))}`;
      },
    },
    {
      risk: "read",
      definition: {
        name: "git_diff",
        description: "Show the current unstaged git diff.",
        inputSchema: schema({ path: { type: "string" } }),
      },
      async execute(args, context) {
        const target = typeof args.path === "string" ? ` -- ${stringArg(args.path)}` : "";
        return await run(root, `git diff${target}`, (chunk) => hooks.onOutput?.("git_diff", chunk), context?.signal);
      },
    },
    {
      risk: "write",
      definition: {
        name: "apply_patch",
        description:
          "Atomically apply an auditable multi-file CodePilot patch. All operations are preflighted and rolled back together on failure. Patch format supports *** Add File, *** Update File, and *** Delete File blocks.",
        inputSchema: schema({
          patch: { type: "string" },
          expected_hashes: { type: "object", additionalProperties: { type: "string" }, description: "Optional path-to-SHA256 preconditions." },
        }, ["patch"]),
      },
      async execute(args, context) {
        const patch = stringArg(args.patch);
        const expectedHashes: Record<string, string> = {};
        for (const file of patchPaths(patch)) {
          const target = resolveInWorkspace(root, file);
          const observed = observedHashes.get(target);
          if (observed) expectedHashes[file] = observed;
        }
        if (args.expected_hashes && typeof args.expected_hashes === "object" && !Array.isArray(args.expected_hashes)) {
          for (const [file, hash] of Object.entries(args.expected_hashes)) {
            if (typeof hash !== "string") throw Error("expected_hashes values must be strings");
            expectedHashes[file] = hash;
          }
        }
        const beforeWrite = async (file: string) => {
          await context?.beforeWrite?.(file);
          await hooks.beforeWrite?.(file);
        };
        const result = JSON.parse(await applyCodePilotPatch(root, patch, beforeWrite, {
          expectedHashes,
          signal: context?.signal,
        })) as PatchTransactionResult;
        return rememberTransaction(result);
      },
    },
    {
      risk: "write",
      definition: {
        name: "write_file",
        description: "Write a text file in the workspace.",
        inputSchema: schema(
          { path: { type: "string" }, content: { type: "string" } },
          ["path", "content"],
        ),
      },
      async execute(args, context) {
        const file = stringArg(args.path);
        const target = resolveInWorkspace(root, file);
        const result = await writeTextFileAtomic(
          root,
          file,
          stringArg(args.content),
          observedHashes.get(target),
          async (targetFile) => {
            await context?.beforeWrite?.(targetFile);
            await hooks.beforeWrite?.(targetFile);
          },
          context?.signal,
        );
        return rememberTransaction(result);
      },
    },
    {
      risk: "write",
      definition: {
        name: "replace_text",
        description: "Replace exact unique text in a workspace file.",
        inputSchema: schema(
          {
            path: { type: "string" },
            old_text: { type: "string" },
            new_text: { type: "string" },
          },
          ["path", "old_text", "new_text"],
        ),
      },
      async execute(args, context) {
        const target = resolveInWorkspace(root, stringArg(args.path));
        const source = await readFile(target, "utf8");
        const oldText = stringArg(args.old_text);
        const index = source.indexOf(oldText);
        if (index < 0 || source.indexOf(oldText, index + oldText.length) >= 0) {
          throw Error("old_text missing or not unique");
        }
        const result = await writeTextFileAtomic(
          root,
          stringArg(args.path),
          source.slice(0, index) + stringArg(args.new_text) + source.slice(index + oldText.length),
          contentHash(source),
          async (targetFile) => {
            await context?.beforeWrite?.(targetFile);
            await hooks.beforeWrite?.(targetFile);
          },
          context?.signal,
        );
        return rememberTransaction(result);
      },
    },
    {
      risk: "execute",
      definition: {
        name: "shell",
        description: "Run a shell command in the workspace.",
        inputSchema: schema({ command: { type: "string" } }, ["command"]),
      },
      async execute(args, context) {
        return await run(root, stringArg(args.command), (chunk) => hooks.onOutput?.("shell", chunk), context?.signal);
      },
    },
    {
      risk: "read",
      definition: {
        name: "impact_analysis",
        description: "Analyze a coding task against the code graph before editing. Returns target symbols, callers, import dependents, related tests, suggested checks, and an edit plan.",
        inputSchema: schema({
          query: { type: "string", description: "The coding task or behavior change to analyze." },
          max_depth: { type: "integer", minimum: 1, maximum: 3, description: "Reverse-import traversal depth. Defaults to 2." },
        }, ["query"]),
      },
      async execute(args) {
        return JSON.stringify(await analyzeImpact(root, stringArg(args.query), numberArg(args.max_depth, 2)), null, 2);
      },
    },
    {
      risk: "read",
      definition: {
        name: "code_graph",
        description: "Query the workspace code graph by symbol/call name, or inspect one file's symbols, local imports, calls, and reverse importers.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Symbol or call name to search for." },
            path: { type: "string", description: "Workspace-relative source path to inspect." },
          },
          anyOf: [{ required: ["query"] }, { required: ["path"] }],
          additionalProperties: false,
        },
      },
      async execute(args) {
        return await queryCodeGraph(root, {
          query: typeof args.query === "string" ? args.query : undefined,
          path: typeof args.path === "string" ? args.path : undefined,
        });
      },
    },
  ];
}
