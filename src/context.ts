import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveInWorkspace } from "./tools.js";

const MAX_REFERENCES = 8;
const MAX_FILE_CHARS = 12000;

function cleanReference(value: string) {
  return value.replace(/[),.;:!?]+$/, "");
}

export function findFileReferences(prompt: string) {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const match of prompt.matchAll(/(^|\s)@([^\s`"'<>]+)/g)) {
    const value = cleanReference(match[2]);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    refs.push(value);
    if (refs.length >= MAX_REFERENCES) break;
  }
  return refs;
}

export async function expandFileReferences(root: string, prompt: string) {
  const refs = findFileReferences(prompt);
  if (!refs.length) return prompt;

  const blocks: string[] = [];
  for (const ref of refs) {
    try {
      const target = resolveInWorkspace(root, ref);
      const content = await readFile(target, "utf8");
      const truncated =
        content.length > MAX_FILE_CHARS
          ? `${content.slice(0, MAX_FILE_CHARS)}\n\n[truncated ${content.length - MAX_FILE_CHARS} chars]`
          : content;
      blocks.push(`--- ${path.relative(root, target)} ---\n${truncated}`);
    } catch (error) {
      blocks.push(`--- ${ref} ---\n[unable to read: ${(error as Error).message}]`);
    }
  }

  return `${prompt}

Referenced files:

${blocks.join("\n\n")}`;
}
