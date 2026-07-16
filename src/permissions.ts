import { readFile } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import type { PermissionDecision, PermissionPolicy } from "./config.js";
import { resolveInWorkspace } from "./tools.js";
import type { Risk } from "./types.js";

const dangerousShellPatterns = [
  /\brm\s+-rf\b/i,
  /\bdel\s+\/[sq]\b/i,
  /\brmdir\s+\/s\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bshutdown\b/i,
  /\bformat\b/i,
];

async function oldContent(root: string, filePath: string) {
  try {
    return await readFile(resolveInWorkspace(root, filePath), "utf8");
  } catch {
    return "";
  }
}

function previewLines(oldText: string, newText: string) {
  if (oldText === newText) return "(no textual changes)";
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const max = Math.max(oldLines.length, newLines.length);
  const out: string[] = [];

  for (let index = 0; index < max && out.length < 80; index++) {
    const before = oldLines[index];
    const after = newLines[index];
    if (before === after) continue;
    if (before !== undefined) out.push(`- ${before}`);
    if (after !== undefined) out.push(`+ ${after}`);
  }

  if (out.length >= 80) out.push("[diff preview truncated]");
  return out.join("\n") || "(changes not shown)";
}

async function writePreview(root: string, name: string, args: Record<string, unknown>) {
  if (name === "write_file" && typeof args.path === "string" && typeof args.content === "string") {
    const before = await oldContent(root, args.path);
    return `\nProposed write: ${args.path}\n${previewLines(before, args.content)}\n`;
  }

  if (
    name === "replace_text" &&
    typeof args.path === "string" &&
    typeof args.old_text === "string" &&
    typeof args.new_text === "string"
  ) {
    return `\nProposed replace: ${args.path}\n- ${args.old_text}\n+ ${args.new_text}\n`;
  }

  if (name === "apply_patch" && typeof args.patch === "string") {
    return `\nProposed patch:\n${args.patch.slice(0, 4000)}${args.patch.length > 4000 ? "\n[patch preview truncated]" : ""}\n`;
  }

  return "";
}

function shellWarning(name: string, args: Record<string, unknown>) {
  if (name !== "shell" || typeof args.command !== "string") return "";
  const highRisk = dangerousShellPatterns.some((pattern) => pattern.test(args.command as string));
  return highRisk
    ? "\nWarning: this shell command looks destructive or high risk. Review it carefully.\n"
    : "";
}

function globMatches(value: string, pattern: string) {
  const expression = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`, "i").test(value);
}

export type PermissionResult = {
  decision: PermissionDecision;
  source: string;
};

/** Resolves project policy before the legacy risk-level auto-approval fallback. */
export function resolvePermission(
  policy: PermissionPolicy,
  auto: Risk[],
  risk: Risk,
  name: string,
  args: Record<string, unknown>,
): PermissionResult {
  const direct = policy[name];
  if (direct) return { decision: direct, source: name };

  if (name === "shell" && typeof args.command === "string") {
    const candidates = Object.entries(policy)
      .filter(([key]) => key.startsWith("shell:"))
      .filter(([key]) => globMatches(args.command as string, key.slice("shell:".length)))
      .sort(([left], [right]) => right.replace(/\*/g, "").length - left.replace(/\*/g, "").length);
    if (candidates.length) {
      return { decision: candidates[0][1], source: candidates[0][0] };
    }
  }

  if (auto.includes(risk)) return { decision: "allow", source: `autoApprove:${risk}` };
  return { decision: "ask", source: "default" };
}

export const approval =
  (auto: Risk[], root = process.cwd(), policy: PermissionPolicy = {}) =>
  async (risk: Risk, name: string, args: Record<string, unknown>) => {
    const resolved = resolvePermission(policy, auto, risk, name, args);
    if (resolved.decision === "allow") return true;
    if (resolved.decision === "deny") {
      console.log(`Blocked by permission policy (${resolved.source}).`);
      return false;
    }

    const readline = createInterface({ input: stdin, output: stdout });
    try {
      const preview = risk === "write" ? await writePreview(root, name, args) : "";
      const warning = risk === "execute" ? shellWarning(name, args) : "";
      const value = (
        await readline.question(
          `${preview}${warning}Allow ${risk} ${name} ${JSON.stringify(args).slice(0, 200)}? [y/N/a] `,
        )
      ).toLowerCase();
      if (value === "a") auto.push(risk);
      return value === "y" || value === "yes" || value === "a";
    } finally {
      readline.close();
    }
  };

/** Headless tasks never prompt: explicit allow and auto-approved risks pass; ask/deny fail closed. */
export const nonInteractiveApproval =
  (auto: Risk[], policy: PermissionPolicy = {}) =>
  async (risk: Risk, name: string, args: Record<string, unknown>) =>
    resolvePermission(policy, auto, risk, name, args).decision === "allow";
