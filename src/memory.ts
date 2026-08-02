import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { truncateToTokens } from "./token.js";

const INDEX_MARKER = "<!-- codepilot-memory-v2 -->";

export type MemoryBlock = {
  source: string;
  content: string;
  score: number;
};

export type MemoryLoadOptions = {
  indexMaxTokens?: number;
  topicMaxTokens?: number;
  topicLimit?: number;
};

function stateDirectory(root: string) {
  return path.join(root, ".codepilot");
}

function indexPath(root: string) {
  return path.join(stateDirectory(root), "memory.md");
}

function topicsDirectory(root: string) {
  return path.join(stateDirectory(root), "memory");
}

function normalizeTopic(value?: string) {
  const normalized = (value ?? "general").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized.length > 64) throw Error("Invalid memory topic");
  return normalized;
}

function parseNote(note: string, explicitTopic?: string) {
  const trimmed = note.trim();
  if (!trimmed) throw Error("Memory note must not be empty");
  if (explicitTopic) return { topic: normalizeTopic(explicitTopic), note: trimmed };
  const match = trimmed.match(/^([a-zA-Z0-9-]{1,64}):\s+([\s\S]+)$/);
  return match
    ? { topic: normalizeTopic(match[1]), note: match[2].trim() }
    : { topic: "general", note: trimmed };
}

async function readIfExists(file: string) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function topicFiles(root: string) {
  try {
    return (await readdir(topicsDirectory(root), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(topicsDirectory(root), entry.name))
      .sort();
  } catch {
    return [];
  }
}

function titleForTopic(topic: string) {
  return topic.split("-").map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(" ");
}

function latestNote(content: string) {
  return content.split(/\r?\n/).reverse().find((line) => /^-\s+/.test(line.trim()))?.replace(/^-\s+/, "").slice(0, 180) ?? "";
}

async function rebuildIndex(root: string) {
  const entries: string[] = [];
  for (const file of await topicFiles(root)) {
    const content = await readIfExists(file);
    const topic = path.basename(file, ".md");
    const preview = latestNote(content);
    entries.push(`- [${topic}](memory/${topic}.md)${preview ? ` — ${preview}` : ""}`);
  }
  const content = [
    "# CodePilot Memory Index",
    INDEX_MARKER,
    "",
    "Topic files are loaded on demand from the current task. Keep this index concise.",
    "",
    ...(entries.length ? entries : ["- No topic memories yet."]),
    "",
  ].join("\n");
  await mkdir(stateDirectory(root), { recursive: true });
  await writeFile(indexPath(root), content);
  return content;
}

async function migrateLegacyMemory(root: string) {
  const existing = await readIfExists(indexPath(root));
  if (!existing.trim() || existing.includes(INDEX_MARKER)) return false;
  await mkdir(topicsDirectory(root), { recursive: true });
  const target = path.join(topicsDirectory(root), "general.md");
  const current = await readIfExists(target);
  if (!current.trim()) await writeFile(target, `# General Memory\n\n## Imported legacy notes\n\n${existing.trim()}\n`);
  else if (!current.includes(existing.trim())) await appendFile(target, `\n## Imported legacy notes\n\n${existing.trim()}\n`);
  await rebuildIndex(root);
  return true;
}

function tokenize(text: string) {
  const stopWords = new Set(["a", "an", "and", "for", "in", "of", "on", "or", "the", "to", "with"]);
  return [...new Set(text.toLowerCase().match(/[a-z0-9_./-]+|[\u4e00-\u9fff]/g) ?? [])]
    .filter((term) => !stopWords.has(term));
}

function expandedTerms(query: string) {
  const groups = [
    ["architecture", "design", "structure", "架构", "设计", "结构"],
    ["commands", "command", "script", "run", "命令", "脚本", "运行"],
    ["debugging", "debug", "failure", "error", "bug", "调试", "错误", "故障"],
    ["preferences", "preference", "style", "convention", "偏好", "风格", "约定"],
    ["memory", "context", "summary", "记忆", "上下文", "摘要"],
  ];
  const normalizedQuery = query.toLowerCase();
  const baseTerms = new Set(tokenize(query));
  const terms = new Set(baseTerms);
  for (const group of groups) {
    if (group.some((item) => baseTerms.has(item) || normalizedQuery.includes(item))) {
      group.forEach((item) => terms.add(item));
    }
  }
  return [...terms];
}

function scoreTopic(query: string, file: string, content: string) {
  const terms = expandedTerms(query);
  const name = path.basename(file, ".md").toLowerCase();
  const heading = content.split(/\r?\n/).find((line) => line.startsWith("#"))?.toLowerCase() ?? "";
  const body = content.toLowerCase();
  return terms.reduce((score, term) => score + (name.includes(term) ? 8 : 0) + (heading.includes(term) ? 5 : 0) + (body.includes(term) ? 1 : 0), 0);
}

export async function readMemory(root: string) {
  return await readIfExists(indexPath(root));
}

export async function loadRelevantMemory(root: string, query = "", options: MemoryLoadOptions = {}): Promise<MemoryBlock[]> {
  const index = await readMemory(root);
  if (!index.trim()) return [];
  const blocks: MemoryBlock[] = [{
    source: ".codepilot/memory.md",
    content: truncateToTokens(index, Math.max(100, options.indexMaxTokens ?? 800)),
    score: Number.POSITIVE_INFINITY,
  }];
  if (!index.includes(INDEX_MARKER) || !query.trim() || (options.topicLimit ?? 3) <= 0) return blocks;

  const candidates: MemoryBlock[] = [];
  for (const file of await topicFiles(root)) {
    const content = await readIfExists(file);
    const score = scoreTopic(query, file, content);
    if (score <= 0) continue;
    candidates.push({
      source: path.relative(root, file),
      content: truncateToTokens(content, Math.max(100, options.topicMaxTokens ?? 800)),
      score,
    });
  }
  return blocks.concat(candidates
    .sort((left, right) => right.score - left.score || left.source.localeCompare(right.source))
    .slice(0, Math.max(0, options.topicLimit ?? 3)));
}

export async function remember(root: string, note: string, explicitTopic?: string) {
  const parsed = parseNote(note, explicitTopic);
  await migrateLegacyMemory(root);
  await mkdir(topicsDirectory(root), { recursive: true });
  const target = path.join(topicsDirectory(root), `${parsed.topic}.md`);
  const existing = await readIfExists(target);
  if (!existing.trim()) await writeFile(target, `# ${titleForTopic(parsed.topic)} Memory\n\n`);
  const line = `- ${new Date().toISOString()}: ${parsed.note}\n`;
  await appendFile(target, line);
  await rebuildIndex(root);
  return `[${parsed.topic}] ${line.trim()}`;
}
