import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { truncateToTokens } from "./token.js";
import type { Message } from "./types.js";

type Summarize = (messages: Message[]) => Promise<string>;

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

export async function readSessionSummary(root: string) {
  try {
    return await readFile(path.join(root, ".codepilot", "session-summary.md"), "utf8");
  } catch {
    return "";
  }
}

export async function writeSessionSummary(root: string, summary: string) {
  const target = path.join(root, ".codepilot", "session-summary.md");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, summary);
}

export async function appendSessionSummary(
  root: string,
  messages: Message[],
  summarize: Summarize = async (items) => summarizeMessages(items),
) {
  const existing = await readSessionSummary(root);
  const generated = await summarize(messages);
  const next = `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${generated}${generated.endsWith("\n") ? "" : "\n"}`;
  await writeSessionSummary(root, truncateToTokens(next, 4000));
}
