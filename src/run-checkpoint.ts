import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type RunCheckpointPhase = "starting" | "context" | "model" | "tool" | "verification";

export type RunCheckpoint = {
  version: 1;
  runId: string;
  sessionId: string;
  updatedAt: string;
  phase: RunCheckpointPhase;
  messageCount: number;
  progress: {
    step: number;
    modelSteps: number;
    toolCalls: number;
    totalTokens: number;
  };
  tool?: {
    id: string;
    name: string;
    index: number;
    total: number;
    state: "pending" | "running" | "recorded";
  };
};

const safeId = /^[a-zA-Z0-9-]+$/;

export function runCheckpointPath(root: string, sessionId: string) {
  if (!safeId.test(sessionId)) throw Error("Invalid checkpoint session id");
  return path.join(root, ".codepilot", "runs", "checkpoints", `${sessionId}.json`);
}

function validCheckpoint(value: unknown): value is RunCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<RunCheckpoint>;
  const tool = item.tool as Partial<NonNullable<RunCheckpoint["tool"]>> | undefined;
  const validTool = tool === undefined || (
    typeof tool.id === "string" && tool.id.length > 0
    && typeof tool.name === "string" && tool.name.length > 0
    && Number.isInteger(tool.index) && (tool.index ?? -1) >= 0
    && Number.isInteger(tool.total) && (tool.total ?? 0) > 0
    && ["pending", "running", "recorded"].includes(tool.state ?? "")
  );
  return item.version === 1
    && typeof item.runId === "string" && safeId.test(item.runId)
    && typeof item.sessionId === "string" && safeId.test(item.sessionId)
    && typeof item.updatedAt === "string"
    && ["starting", "context", "model", "tool", "verification"].includes(item.phase ?? "")
    && Number.isInteger(item.messageCount) && (item.messageCount ?? -1) >= 0
    && !!item.progress
    && Number.isInteger(item.progress.step) && item.progress.step >= 0
    && Number.isInteger(item.progress.modelSteps) && item.progress.modelSteps >= 0
    && Number.isInteger(item.progress.toolCalls) && item.progress.toolCalls >= 0
    && Number.isFinite(item.progress.totalTokens) && item.progress.totalTokens >= 0
    && validTool;
}

export async function writeRunCheckpoint(root: string, checkpoint: Omit<RunCheckpoint, "version" | "updatedAt">) {
  const target = runCheckpointPath(root, checkpoint.sessionId);
  await mkdir(path.dirname(target), { recursive: true });
  const value: RunCheckpoint = { version: 1, ...checkpoint, updatedAt: new Date().toISOString() };
  if (!validCheckpoint(value)) throw Error("Invalid run checkpoint");
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
  return value;
}

export async function readRunCheckpoint(root: string, sessionId: string) {
  const target = runCheckpointPath(root, sessionId);
  try {
    const value: unknown = JSON.parse(await readFile(target, "utf8"));
    if (!validCheckpoint(value) || value.sessionId !== sessionId) throw Error(`Invalid run checkpoint: ${target}`);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function clearRunCheckpoint(root: string, sessionId: string) {
  const target = runCheckpointPath(root, sessionId);
  let cleared = false;
  try {
    await unlink(target);
    cleared = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await rmdir(path.dirname(target));
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
  return cleared;
}
