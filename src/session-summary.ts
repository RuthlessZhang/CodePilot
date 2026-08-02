import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { truncateToTokens } from "./token.js";
import type { Message } from "./types.js";

type Summarize = (messages: Message[]) => Promise<string>;
const sessionIdPattern = /^[a-zA-Z0-9-]+$/;

function summariesDirectory(root: string) {
  return path.join(root, ".codepilot", "sessions");
}

export function sessionSummaryPath(root: string, sessionId: string) {
  if (!sessionIdPattern.test(sessionId)) throw Error("Invalid session id");
  return path.join(summariesDirectory(root), `${sessionId}.summary.md`);
}

function legacySessionSummaryPath(root: string) {
  return path.join(root, ".codepilot", "session-summary.md");
}

function messageLine(message: Message) {
  if (message.role === "tool") {
    return `- tool ${message.name}: ${truncateToTokens(message.content, 80).replace(/\s+/g, " ")}`;
  }
  const calls = message.toolCalls?.length
    ? ` tool_calls=${message.toolCalls.map((call) => call.name).join(",")}`
    : "";
  return `- ${message.role}${calls}: ${truncateToTokens(message.content, 120).replace(/\s+/g, " ")}`;
}

export function summarizeMessages(messages: Message[]) {
  if (!messages.length) return "";
  return [
    `## ${new Date().toISOString()}`,
    ...messages.map(messageLine),
    "",
  ].join("\n");
}

export async function readSessionSummary(root: string, sessionId: string) {
  try {
    return await readFile(sessionSummaryPath(root, sessionId), "utf8");
  } catch {
    return "";
  }
}

export async function writeSessionSummary(root: string, sessionId: string, summary: string) {
  const target = sessionSummaryPath(root, sessionId);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, summary);
}

export async function migrateLegacySessionSummary(root: string, sessionId: string) {
  const target = sessionSummaryPath(root, sessionId);
  try {
    await readFile(target, "utf8");
    return false;
  } catch {
    // A session-specific summary does not exist yet.
  }
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await rename(legacySessionSummaryPath(root), target);
    return true;
  } catch {
    return false;
  }
}

export async function appendSessionSummary(
  root: string,
  sessionId: string,
  messages: Message[],
  summarize: Summarize = async (items) => summarizeMessages(items),
) {
  const existing = await readSessionSummary(root, sessionId);
  const generated = await summarize(messages);
  const next = `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${generated}${generated.endsWith("\n") ? "" : "\n"}`;
  await writeSessionSummary(root, sessionId, truncateToTokens(next, 4000));
}
