import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Message } from "./types.js";

export type SessionInfo = {
  id: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

const sessionIdPattern = /^[a-zA-Z0-9-]+$/;

function stateDirectory(root: string) {
  return path.join(root, ".codepilot");
}

function sessionsDirectory(root: string) {
  return path.join(stateDirectory(root), "sessions");
}

function sessionPath(root: string, id: string) {
  if (!sessionIdPattern.test(id)) throw Error("Invalid session id");
  return path.join(sessionsDirectory(root), `${id}.json`);
}

async function writeAtomically(target: string, content: string) {
  const temporary = `${target}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, target);
}

async function readIndex(root: string): Promise<SessionInfo[]> {
  try {
    const value = JSON.parse(await readFile(path.join(sessionsDirectory(root), "index.json"), "utf8"));
    return Array.isArray(value)
      ? value.filter((item): item is SessionInfo =>
          item && typeof item.id === "string" && sessionIdPattern.test(item.id) &&
          typeof item.createdAt === "string" && typeof item.updatedAt === "string" &&
          typeof item.messageCount === "number",
        )
      : [];
  } catch {
    return [];
  }
}

export function createSessionId() {
  return randomUUID();
}

export async function saveSession(
  root: string,
  id: string,
  createdAt: string,
  messages: Message[],
): Promise<SessionInfo> {
  const directory = sessionsDirectory(root);
  await mkdir(directory, { recursive: true });
  const info: SessionInfo = {
    id,
    createdAt,
    updatedAt: new Date().toISOString(),
    messageCount: messages.length,
  };
  await writeAtomically(sessionPath(root, id), JSON.stringify(messages, null, 2));
  const index = (await readIndex(root)).filter((item) => item.id !== id);
  index.unshift(info);
  await writeAtomically(path.join(directory, "index.json"), JSON.stringify(index.slice(0, 100), null, 2));
  await writeAtomically(path.join(stateDirectory(root), "session.json"), JSON.stringify(messages, null, 2));
  return info;
}

export async function loadSession(root: string, id?: string): Promise<Message[] | undefined> {
  const target = id ? sessionPath(root, id) : path.join(stateDirectory(root), "session.json");
  try {
    const value = JSON.parse(await readFile(target, "utf8"));
    return Array.isArray(value) ? value as Message[] : undefined;
  } catch {
    return undefined;
  }
}

export async function listSessions(root: string) {
  return (await readIndex(root)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getSessionInfo(root: string, id: string) {
  if (!sessionIdPattern.test(id)) return undefined;
  return (await readIndex(root)).find((item) => item.id === id);
}
