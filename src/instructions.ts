import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { findFileReferences } from "./context.js";
import { loadRelevantMemory, type MemoryLoadOptions } from "./memory.js";
import { resolveInWorkspace } from "./tools.js";

const MAX_IMPORT_CHARS = 8000;
const MAX_IMPORT_DEPTH = 2;
const DEFAULT_RULE_LIMIT = 5;

export type InstructionBlock = {
  source: string;
  content: string;
  kind: "instructions" | "rules" | "memory";
};

export type RuleBlock = Omit<InstructionBlock, "kind"> & {
  score: number;
};

async function readIfExists(file: string) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

async function expandImports(
  root: string,
  sourceDir: string,
  content: string,
  seen = new Set<string>(),
  depth = 0,
): Promise<string> {
  if (depth >= MAX_IMPORT_DEPTH) return content;

  let expanded = content;
  for (const ref of findFileReferences(content)) {
    try {
      const target = resolveInWorkspace(root, path.resolve(sourceDir, ref));
      if (seen.has(target)) continue;
      seen.add(target);
      const imported = await readFile(target, "utf8");
      const truncated =
        imported.length > MAX_IMPORT_CHARS
          ? `${imported.slice(0, MAX_IMPORT_CHARS)}\n\n[truncated ${imported.length - MAX_IMPORT_CHARS} chars]`
          : imported;
      const nested = await expandImports(
        root,
        path.dirname(target),
        truncated,
        seen,
        depth + 1,
      );
      expanded += `\n\nImported from @${path.relative(root, target)}:\n${nested}`;
    } catch {
      // Ignore missing optional imports in instruction files.
    }
  }
  return expanded;
}

async function ruleFiles(root: string) {
  const dir = path.join(root, ".codepilot", "rules");
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function tokenize(text: string) {
  const stopWords = new Set(["a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with"]);
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .match(/[a-z0-9_./-]+|[\u4e00-\u9fff]/g) ?? [],
    ),
  ).filter((term) => !stopWords.has(term));
}

function expandQueryTerms(query: string) {
  const groups = [
    ["test", "tests", "testing", "check", "verify", "build", "lint", "测试", "检查", "验证", "构建"],
    ["architecture", "arch", "structure", "design", "layer", "架构", "结构", "设计", "分层"],
    ["style", "format", "lint", "naming", "风格", "格式", "命名"],
    ["provider", "model", "api", "openai", "anthropic", "deepseek", "模型", "供应商", "提供商"],
    ["context", "memory", "summary", "compact", "token", "上下文", "记忆", "摘要", "压缩"],
    ["security", "permission", "approval", "risk", "safe", "安全", "权限", "审批", "风险"],
    ["release", "publish", "version", "changelog", "发布", "版本"],
  ];
  const normalizedQuery = query.toLowerCase();
  const terms = new Set(tokenize(query));
  const expanded = new Set(terms);
  for (const group of groups) {
    if (group.some((item) => terms.has(item) || normalizedQuery.includes(item))) {
      group.forEach((item) => expanded.add(item));
    }
  }
  return [...expanded];
}

function heading(content: string) {
  return content
    .split(/\r?\n/)
    .find((line) => line.trim().startsWith("#"))
    ?.replace(/^#+\s*/, "")
    .trim() ?? "";
}

function scoreRule(query: string, source: string, content: string) {
  const terms = expandQueryTerms(query);
  if (!terms.length) return 0;

  const title = heading(content);
  const nameText = path.basename(source, ".md").toLowerCase();
  const titleText = title.toLowerCase();
  const bodyText = content.toLowerCase();
  let score = 0;

  for (const term of terms) {
    if (!term.trim()) continue;
    if (nameText.includes(term)) score += 8;
    if (titleText.includes(term)) score += 5;
    if (bodyText.includes(term)) score += 1;
  }

  return score;
}

export async function loadRelevantRules(root: string, query: string, limit = DEFAULT_RULE_LIMIT): Promise<RuleBlock[]> {
  const rules: RuleBlock[] = [];
  for (const file of await ruleFiles(root)) {
    const content = await readIfExists(file);
    if (!content.trim()) continue;
    const source = path.relative(root, file);
    const score = scoreRule(query, source, content);
    if (score <= 0) continue;
    rules.push({
      source,
      score,
      content: await expandImports(root, path.dirname(file), content),
    });
  }

  return rules
    .sort((a, b) => b.score - a.score || a.source.localeCompare(b.source))
    .slice(0, limit);
}

async function loadAllRules(root: string): Promise<RuleBlock[]> {
  const rules: RuleBlock[] = [];
  for (const file of await ruleFiles(root)) {
    const content = await readIfExists(file);
    if (!content.trim()) continue;
    rules.push({
      source: path.relative(root, file),
      score: 0,
      content: await expandImports(root, path.dirname(file), content),
    });
  }
  return rules;
}

export async function loadInstructionBlocks(root: string, query?: string, memoryOptions: MemoryLoadOptions = {}) {
  const files = [
    path.join(root, "AGENTS.md"),
    path.join(root, "CLAUDE.md"),
  ];
  const blocks: InstructionBlock[] = [];

  for (const file of files) {
    const content = await readIfExists(file);
    if (!content.trim()) continue;
    blocks.push({
      source: path.relative(root, file),
      content: await expandImports(root, path.dirname(file), content),
      kind: "instructions",
    });
  }

  const rules = query?.trim()
    ? await loadRelevantRules(root, query)
    : await loadAllRules(root);
  for (const rule of rules) {
    blocks.push({
      source: rule.source,
      content: rule.content,
      kind: "rules",
    });
  }

  for (const memory of await loadRelevantMemory(root, query, memoryOptions)) {
    blocks.push({ source: memory.source, content: memory.content, kind: "memory" });
  }

  return blocks;
}

export async function loadInstructions(root: string, query?: string, memoryOptions: MemoryLoadOptions = {}) {
  const blocks = await loadInstructionBlocks(root, query, memoryOptions);

  if (!blocks.length) return "";

  return blocks
    .map((block) => `Instructions from ${block.source}:\n${block.content}`)
    .join("\n\n");
}
