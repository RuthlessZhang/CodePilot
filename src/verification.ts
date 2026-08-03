import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildProjectIndex } from "./project.js";
import { selectTargetedTestCommands } from "./test-selection.js";
import type { Risk, Tool, ToolEvent } from "./types.js";

export type VerificationStatus = "passed" | "failed" | "skipped";

export type VerificationCheck = {
  kind: "diagnostics" | "targeted_test" | "command";
  target: string;
  status: VerificationStatus;
  output: string;
  durationMs: number;
  failures?: VerificationFailure[];
};

export type VerificationFailure = {
  test?: string;
  file?: string;
  line?: number;
  character?: number;
  code?: string;
  message: string;
};

export type VerificationResult = {
  status: VerificationStatus;
  changedFiles: string[];
  checks: VerificationCheck[];
  summary: string;
};

type VerificationOptions = {
  root: string;
  tools: Tool[];
  approve: (risk: Risk, name: string, args: Record<string, unknown>) => Promise<boolean>;
  onToolEvent?: (event: ToolEvent) => void;
  timeoutMs?: number;
};

const languageExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);

function pathsFromPatch(patch: string) {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)].map((match) => match[1].trim());
}

function changedPaths(name: string, args: Record<string, unknown>) {
  if ((name === "write_file" || name === "replace_text") && typeof args.path === "string") return [args.path];
  if (name === "apply_patch" && typeof args.patch === "string") return pathsFromPatch(args.patch);
  return [];
}

function committedPaths(output?: string) {
  if (!output) return [];
  try {
    const parsed = JSON.parse(output) as { status?: unknown; changes?: Array<{ path?: unknown }> };
    if (parsed.status !== "committed" || !Array.isArray(parsed.changes)) return [];
    return parsed.changes.flatMap((change) => typeof change.path === "string" ? [change.path] : []);
  } catch {
    return [];
  }
}

type LspDiagnostic = {
  severity?: unknown;
  source?: unknown;
  code?: unknown;
  message?: unknown;
  range?: unknown;
};

function errorDiagnostics(output: string) {
  try {
    const parsed = JSON.parse(output) as { diagnostics?: LspDiagnostic[] };
    return (parsed.diagnostics ?? []).filter((item) => item.severity === "error" || item.severity === 1);
  } catch {
    return [];
  }
}

function diagnosticFingerprint(item: LspDiagnostic) {
  return JSON.stringify([item.source ?? "", item.code ?? "", item.message ?? ""]);
}

function summarize(status: VerificationStatus, checks: VerificationCheck[]) {
  const lines = checks.map((check) =>
    `${check.status === "passed" ? "PASS" : check.status === "failed" ? "FAIL" : "SKIP"} ${check.kind} ${check.target}`,
  );
  return [`Automatic verification: ${status}`, ...lines].join("\n");
}

export function parseVerificationFailures(output: string) {
  const failures: VerificationFailure[] = [];
  const seen = new Set<string>();
  const add = (failure: VerificationFailure) => {
    const key = JSON.stringify(failure);
    if (seen.has(key) || failures.length >= 20) return;
    seen.add(key);
    failures.push(failure);
  };
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    let match = /^FAILED\s+(\S+)(?:\s+-\s+(.+))?$/.exec(line);
    if (match) {
      add({ test: match[1], message: match[2] ?? "Test failed" });
      continue;
    }
    match = /^(.+\.(?:ts|tsx|js|jsx|mjs|cjs))\((\d+),(\d+)\):\s*(?:error|warning)\s*([^:]+):\s*(.+)$/i.exec(line);
    if (match) {
      add({ file: match[1], line: Number(match[2]), character: Number(match[3]), code: match[4], message: match[5] });
      continue;
    }
    match = /^(.+\.(?:py|ts|tsx|js|jsx|mjs|cjs)):(\d+)(?::(\d+))?\s*[:\-]?\s*(.+)$/.exec(line);
    if (match) add({ file: match[1], line: Number(match[2]), character: match[3] ? Number(match[3]) : undefined, message: match[4] });
  }
  return failures;
}

export class VerificationController {
  private pendingFiles = new Set<string>();
  private history: VerificationResult[] = [];
  private diagnosticBaselines = new Map<string, Set<string>>();
  private unavailableBaselines = new Set<string>();
  private runId = randomUUID();
  private startedAt = new Date().toISOString();

  constructor(private options: VerificationOptions) {}

  async captureBaseline(absPath: string, signal?: AbortSignal) {
    const relativePath = path.relative(this.options.root, absPath);
    if (!languageExtensions.has(path.extname(relativePath).toLowerCase())) return;
    if (this.diagnosticBaselines.has(relativePath) || this.unavailableBaselines.has(relativePath)) return;
    try {
      await access(absPath);
    } catch {
      this.diagnosticBaselines.set(relativePath, new Set());
      return;
    }
    const lsp = this.options.tools.find((tool) => tool.definition.name === "lsp");
    if (!lsp) {
      this.unavailableBaselines.add(relativePath);
      return;
    }
    const check = await this.executeCheck(
      lsp,
      { operation: "diagnostics", path: relativePath },
      "diagnostics",
      `baseline:${relativePath}`,
      signal,
      () => true,
    );
    if (check.status !== "passed") {
      this.unavailableBaselines.add(relativePath);
      return;
    }
    this.diagnosticBaselines.set(relativePath, new Set(errorDiagnostics(check.output).map(diagnosticFingerprint)));
  }

  recordToolSuccess(name: string, args: Record<string, unknown>, output?: string) {
    const actualPaths = committedPaths(output);
    for (const value of actualPaths.length ? actualPaths : changedPaths(name, args)) {
      const absolute = path.resolve(this.options.root, value);
      if (absolute !== this.options.root && !absolute.startsWith(this.options.root + path.sep)) continue;
      this.pendingFiles.add(path.relative(this.options.root, absolute));
    }
  }

  hasPendingCodeChanges() {
    return [...this.pendingFiles].some((file) => languageExtensions.has(path.extname(file).toLowerCase()));
  }

  getHistory() {
    return [...this.history];
  }

  async verify(signal?: AbortSignal): Promise<VerificationResult> {
    const changedFiles = [...this.pendingFiles].sort();
    this.pendingFiles.clear();
    const codeFiles = changedFiles.filter((file) => languageExtensions.has(path.extname(file).toLowerCase()));
    const checks: VerificationCheck[] = [];
    const lsp = this.options.tools.find((tool) => tool.definition.name === "lsp");

    for (const file of codeFiles.slice(0, 20)) {
      signal?.throwIfAborted();
      if (!lsp) break;
      try {
        await access(path.join(this.options.root, file));
      } catch {
        continue;
      }
      const args = { operation: "diagnostics", path: file };
      if (this.unavailableBaselines.has(file)) {
        checks.push({ kind: "diagnostics", target: file, status: "skipped", output: "Pre-edit diagnostic baseline was unavailable", durationMs: 0 });
        continue;
      }
      const baseline = this.diagnosticBaselines.get(file) ?? new Set<string>();
      const check = await this.executeCheck(
        lsp,
        args,
        "diagnostics",
        file,
        signal,
        (output) => errorDiagnostics(output).every((item) => baseline.has(diagnosticFingerprint(item))),
      );
      if (check.status !== "skipped") {
        const current = errorDiagnostics(check.output);
        const additions = current.filter((item) => !baseline.has(diagnosticFingerprint(item)));
        check.status = additions.length ? "failed" : "passed";
        check.output = JSON.stringify({
          baselineErrorCount: baseline.size,
          currentErrorCount: current.length,
          newDiagnostics: additions,
        }, null, 2);
      }
      checks.push(check);
    }

    if (!checks.some((check) => check.status === "failed")) {
      const shell = this.options.tools.find((tool) => tool.definition.name === "shell");
      if (shell) {
        for (const command of await selectTargetedTestCommands(this.options.root, changedFiles)) {
          signal?.throwIfAborted();
          const check = await this.executeCheck(
            shell,
            { command, timeout_ms: this.options.timeoutMs ?? 300_000 },
            "targeted_test",
            command,
            signal,
            (output) => /(?:^|\n)exit_code:\s*0(?:\n|$)/.test(output),
          );
          checks.push(check);
          if (check.status === "failed") break;
        }
      }
    }

    if (!checks.some((check) => check.status === "failed")) {
      const shell = this.options.tools.find((tool) => tool.definition.name === "shell");
      if (shell) {
        const index = await buildProjectIndex(this.options.root);
        for (const command of index.checkCommands.slice(0, 3)) {
          signal?.throwIfAborted();
          const check = await this.executeCheck(
            shell,
            { command, timeout_ms: this.options.timeoutMs ?? 300_000 },
            "command",
            command,
            signal,
            (output) => /(?:^|\n)exit_code:\s*0(?:\n|$)/.test(output),
          );
          checks.push(check);
          if (check.status === "failed") break;
        }
      }
    }

    const status: VerificationStatus = checks.some((check) => check.status === "failed")
      ? "failed"
      : !checks.length || checks.some((check) => check.status === "skipped")
        ? "skipped"
        : "passed";
    const result = { status, changedFiles, checks, summary: summarize(status, checks) };
    this.history.push(result);
    return result;
  }

  async saveReport(sessionId: string, prompt: string, finalStatus: VerificationStatus) {
    const target = path.join(this.options.root, ".codepilot", "runs", `${this.runId}.json`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify({
      version: 1,
      runId: this.runId,
      sessionId,
      prompt,
      finalStatus,
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
      attempts: this.history,
    }, null, 2));
    return target;
  }

  private async executeCheck(
    tool: Tool,
    args: Record<string, unknown>,
    kind: VerificationCheck["kind"],
    target: string,
    signal: AbortSignal | undefined,
    passed: (output: string) => boolean,
  ): Promise<VerificationCheck> {
    const startedAt = Date.now();
    if (!(await this.options.approve(tool.risk, tool.definition.name, args))) {
      return { kind, target, status: "skipped", output: "Permission denied", durationMs: Date.now() - startedAt };
    }
    this.options.onToolEvent?.({ phase: "started", name: tool.definition.name, args });
    try {
      const output = await tool.execute(args, { signal });
      const status = passed(output) ? "passed" : "failed";
      this.options.onToolEvent?.({
        phase: status === "passed" ? "completed" : "failed",
        name: tool.definition.name,
        args,
        content: status === "failed" ? output.slice(0, 1000) : undefined,
        durationMs: Date.now() - startedAt,
      });
      return {
        kind,
        target,
        status,
        output,
        durationMs: Date.now() - startedAt,
        ...(status === "failed" && kind !== "diagnostics" ? { failures: parseVerificationFailures(output) } : {}),
      };
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      const output = `Error: ${(error as Error).message}`;
      this.options.onToolEvent?.({ phase: "failed", name: tool.definition.name, args, content: output, durationMs: Date.now() - startedAt });
      return { kind, target, status: "failed", output, durationMs: Date.now() - startedAt };
    }
  }
}
