import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AgentBudgetError, type AgentRunStats } from "./agent.js";

export type HeadlessStatus = "completed" | "failed" | "incomplete" | "budget_exceeded" | "timeout" | "cancelled";

type HeadlessAgent = {
  run(prompt: string): Promise<string>;
  cancel(): boolean;
  getSessionId(): string;
  getLastRunStats(): AgentRunStats | undefined;
};

export type PatchCapture = {
  available: boolean;
  patch: string;
  error?: string;
};

export type HeadlessResult = {
  version: 1;
  runId: string;
  task: string;
  status: HeadlessStatus;
  exitCode: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  sessionId: string;
  response?: string;
  error?: string;
  budgets: { maxRuntimeMs: number; maxSteps: number; maxToolCalls: number };
  usage: AgentRunStats;
  artifact: {
    resultPath: string;
    patchAvailable: boolean;
    patchPath?: string;
    patchBytes: number;
    patchSha256?: string;
    patchError?: string;
  };
};

type RunHeadlessOptions = {
  root: string;
  task: string;
  agentPrompt?: string;
  agent: HeadlessAgent;
  maxRuntimeMs: number;
  maxSteps: number;
  maxToolCalls: number;
  resultPath?: string;
  patchPath?: string;
  capturePatch?: (root: string) => Promise<PatchCapture>;
};

function normalize(value: string) {
  return value.replace(/\\/g, "/");
}

function outputPath(root: string, value: string) {
  const resolved = path.resolve(root, value);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw Error("Headless output path escapes workspace");
  return resolved;
}

async function atomicWrite(target: string, content: string) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, target);
}

function runGit(root: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("git", args, { cwd: root, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => resolve({ code: 127, stdout: "", stderr: error.message }));
    child.on("close", (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

export async function captureGitPatch(root: string): Promise<PatchCapture> {
  const repository = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (repository.code !== 0 || repository.stdout.trim() !== "true") {
    return { available: false, patch: "", error: repository.stderr.trim() || "Workspace is not a Git repository" };
  }

  const hasHead = (await runGit(root, ["rev-parse", "--verify", "HEAD"])).code === 0;
  const tracked = await runGit(root, [
    "diff", "--binary", "--full-index", "--no-ext-diff", ...(hasHead ? ["HEAD"] : []),
    "--", ".", ":(exclude).codepilot/**",
  ]);
  if (tracked.code !== 0) return { available: false, patch: "", error: tracked.stderr.trim() || "Unable to capture tracked diff" };

  const untracked = await runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (untracked.code !== 0) return { available: false, patch: "", error: untracked.stderr.trim() || "Unable to list untracked files" };
  const untrackedFiles = untracked.stdout.split("\0").filter((file) => file && !normalize(file).startsWith(".codepilot/"));
  if (untrackedFiles.length > 100) {
    return { available: false, patch: "", error: `Patch capture refused ${untrackedFiles.length} untracked files (limit 100)` };
  }
  const additions: string[] = [];
  for (const file of untrackedFiles) {
    const diff = await runGit(root, ["diff", "--no-index", "--binary", "--full-index", "--", "/dev/null", file]);
    if (diff.code !== 0 && diff.code !== 1) {
      return { available: false, patch: "", error: diff.stderr.trim() || `Unable to capture untracked file ${file}` };
    }
    additions.push(diff.stdout);
  }
  return { available: true, patch: [tracked.stdout, ...additions].filter(Boolean).join("\n") };
}

function statusFrom(stats: AgentRunStats): HeadlessStatus {
  if (stats.verificationStatus === "failed") return "failed";
  if (stats.verificationStatus === "skipped") return "incomplete";
  return "completed";
}

function exitCode(status: HeadlessStatus) {
  return { completed: 0, failed: 1, budget_exceeded: 2, incomplete: 3, timeout: 124, cancelled: 130 }[status];
}

export async function runHeadless(options: RunHeadlessOptions): Promise<HeadlessResult> {
  const runId = randomUUID();
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const resultTarget = outputPath(options.root, options.resultPath ?? `.codepilot/runs/headless-${runId}.json`);
  const patchTarget = outputPath(options.root, options.patchPath ?? `.codepilot/runs/headless-${runId}.patch`);
  let timedOut = false;
  let status: HeadlessStatus = "completed";
  let response: string | undefined;
  let errorMessage: string | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    options.agent.cancel();
  }, Math.max(1, options.maxRuntimeMs));

  try {
    response = await options.agent.run(options.agentPrompt ?? options.task);
    status = statusFrom(options.agent.getLastRunStats() ?? { modelSteps: 0, toolCalls: 0, verificationStatus: "not_run" });
  } catch (error) {
    errorMessage = (error as Error).message;
    if (timedOut) status = "timeout";
    else if ((error as Error).name === "AbortError") status = "cancelled";
    else if (error instanceof AgentBudgetError) status = "budget_exceeded";
    else status = "failed";
  } finally {
    clearTimeout(timer);
  }

  const patch = await (options.capturePatch ?? captureGitPatch)(options.root);
  if (status === "completed" && !patch.available) status = "incomplete";
  if (patch.available) await atomicWrite(patchTarget, patch.patch);
  const completed = Date.now();
  const stats = options.agent.getLastRunStats() ?? { modelSteps: 0, toolCalls: 0, verificationStatus: "not_run" };
  const result: HeadlessResult = {
    version: 1,
    runId,
    task: options.task,
    status,
    exitCode: exitCode(status),
    startedAt,
    completedAt: new Date(completed).toISOString(),
    durationMs: completed - started,
    sessionId: options.agent.getSessionId(),
    ...(response !== undefined ? { response } : {}),
    ...(errorMessage ? { error: errorMessage } : {}),
    budgets: { maxRuntimeMs: options.maxRuntimeMs, maxSteps: options.maxSteps, maxToolCalls: options.maxToolCalls },
    usage: stats,
    artifact: {
      resultPath: normalize(path.relative(options.root, resultTarget)),
      patchAvailable: patch.available,
      ...(patch.available ? {
        patchPath: normalize(path.relative(options.root, patchTarget)),
        patchBytes: Buffer.byteLength(patch.patch),
        patchSha256: createHash("sha256").update(patch.patch).digest("hex"),
      } : { patchBytes: 0, patchError: patch.error }),
    },
  };
  await atomicWrite(resultTarget, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
