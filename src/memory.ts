import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export async function readMemory(root: string) {
  try {
    return await readFile(path.join(root, ".codepilot", "memory.md"), "utf8");
  } catch {
    return "";
  }
}

export async function remember(root: string, note: string) {
  const target = path.join(root, ".codepilot", "memory.md");
  await mkdir(path.dirname(target), { recursive: true });
  const line = `- ${new Date().toISOString()}: ${note.trim()}\n`;
  await appendFile(target, line);
  return line.trim();
}
