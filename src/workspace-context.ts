import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { buildCodeGraph, type CodeGraph } from "./code-graph.js";
import { analyzeImpact, formatImpactAnalysis } from "./impact-analysis.js";

const IGNORED = new Set(["node_modules", ".git", "dist", ".codepilot"]);
const MAX_FILES = 4;
const MAX_FILE_CHARS = 3500;
const MAX_TOTAL_CHARS = 10000;

async function filesIn(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(target)));
    else files.push(target);
    if (files.length >= 2000) break;
  }
  return files;
}

function termsFrom(query: string) {
  return Array.from(
    new Set(
      (query.toLowerCase().match(/[a-z_][a-z0-9_./-]{1,}|[\u4e00-\u9fff]{2,}/g) ?? [])
        .filter((term) => !["this", "that", "with", "from", "please", "代码", "项目", "一下"].includes(term)),
    ),
  ).slice(0, 20);
}

function score(pathText: string, content: string, terms: string[]) {
  const relative = pathText.toLowerCase();
  const body = content.toLowerCase();
  return terms.reduce((total, term) => {
    const filenameScore = relative.includes(term) ? 8 : 0;
    const contentScore = body.includes(term) ? 2 : 0;
    return total + filenameScore + contentScore;
  }, 0);
}

function graphScores(graph: CodeGraph, terms: string[]) {
  const scores = new Map<string, number>();
  const add = (file: string, value: number) => scores.set(file, (scores.get(file) ?? 0) + value);
  for (const file of graph.files) {
    for (const symbol of file.symbols) {
      const name = symbol.name.toLowerCase();
      for (const term of terms) {
        if (name === term) add(file.path, 30);
        else if (name.includes(term)) add(file.path, 15);
      }
    }
    for (const call of file.calls) {
      const name = call.name.toLowerCase();
      if (terms.some((term) => name.includes(term))) add(file.path, 8);
    }
  }
  const seeded = new Set([...scores].filter(([, value]) => value > 0).map(([file]) => file));
  for (const file of graph.files) {
    if (seeded.has(file.path)) {
      for (const item of file.imports) if (item.resolved) add(item.resolved, 8);
    }
    for (const item of file.imports) {
      if (item.resolved && seeded.has(item.resolved)) add(file.path, 6);
    }
  }
  return scores;
}

function relationshipSummary(graph: CodeGraph, source: string) {
  const normalized = source.replace(/\\/g, "/");
  const file = graph.files.find((item) => item.path === normalized);
  if (!file) return "";
  const importedBy = graph.files
    .filter((candidate) => candidate.imports.some((item) => item.resolved === file.path))
    .map((candidate) => candidate.path)
    .slice(0, 6);
  const lines = [
    file.symbols.length
      ? `Symbols: ${file.symbols.slice(0, 8).map((symbol) => `${symbol.kind} ${symbol.name}@${symbol.line}`).join(", ")}`
      : "",
    file.imports.some((item) => item.resolved)
      ? `Local imports: ${file.imports.filter((item) => item.resolved).slice(0, 6).map((item) => item.resolved).join(", ")}`
      : "",
    importedBy.length ? `Imported by: ${importedBy.join(", ")}` : "",
  ].filter(Boolean);
  return lines.length ? `Code graph: ${lines.join(" | ")}` : "";
}

function excerpt(content: string, terms: string[]) {
  const lines = content.split(/\r?\n/);
  const firstMatch = lines.findIndex((line) => {
    const lower = line.toLowerCase();
    return terms.some((term) => lower.includes(term));
  });
  if (firstMatch < 0) return content.slice(0, MAX_FILE_CHARS);

  const selected = lines.slice(Math.max(0, firstMatch - 20), firstMatch + 80).join("\n");
  return selected.length > MAX_FILE_CHARS
    ? `${selected.slice(0, MAX_FILE_CHARS)}\n[truncated]`
    : selected;
}

/** Deterministically selects small, task-relevant code excerpts for the initial agent context. */
export async function selectWorkspaceContext(root: string, query: string) {
  const terms = termsFrom(query);
  if (!terms.length) return "";
  const graph = await buildCodeGraph(root);
  const impact = formatImpactAnalysis(await analyzeImpact(root, query));
  const semanticScores = graphScores(graph, terms);

  const candidates: Array<{ source: string; content: string; score: number }> = [];
  for (const file of await filesIn(root)) {
    try {
      const content = await readFile(file, "utf8");
      if (content.length > 200_000) continue;
      const source = path.relative(root, file);
      const relevance = score(source, content.slice(0, 60_000), terms)
        + (semanticScores.get(source.replace(/\\/g, "/")) ?? 0);
      if (relevance > 0) candidates.push({ source, content, score: relevance });
    } catch {
      // Ignore binary and unreadable files.
    }
  }

  let used = 0;
  const blocks: string[] = [];
  for (const candidate of candidates
    .sort((left, right) => right.score - left.score || left.source.localeCompare(right.source))
    .slice(0, MAX_FILES)) {
    const text = excerpt(candidate.content, terms);
    if (used + text.length > MAX_TOTAL_CHARS && blocks.length) break;
    const relationships = relationshipSummary(graph, candidate.source);
    blocks.push(`--- ${candidate.source} (relevance ${candidate.score}) ---\n${relationships ? `${relationships}\n` : ""}${text}`);
    used += text.length;
  }

  const excerpts = blocks.length ? `Task-relevant workspace excerpts:\n${blocks.join("\n\n")}` : "";
  return [impact, excerpts].filter(Boolean).join("\n\n");
}
