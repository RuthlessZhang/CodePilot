import path from "node:path";
import { buildCodeGraph, type CodeGraph } from "./code-graph.js";
import { selectTargetedTestCommands, selectTargetedTestFiles } from "./test-selection.js";

export type ImpactTarget = {
  file: string;
  name: string;
  kind: string;
  line: number;
  match: "exact" | "partial";
};

export type ImpactFile = {
  path: string;
  role: "target" | "caller" | "dependent" | "dependency" | "test";
  distance: number;
  reasons: string[];
};

export type ImpactAnalysis = {
  query: string;
  targets: ImpactTarget[];
  files: ImpactFile[];
  relatedTests: string[];
  suggestedChecks: string[];
  editPlan: string[];
  warnings: string[];
};

const stopWords = new Set([
  "add", "adjust", "behavior", "bug", "change", "code", "create", "feature", "fix", "implement", "improve",
  "issue", "make", "modify", "please", "project", "refactor", "remove", "support", "targeted", "test", "tests", "the", "this", "update", "verify", "with",
  "代码", "修改", "完善", "功能", "项目", "实现", "修复", "增加", "新增", "调整", "优化", "支持",
]);

function normalize(value: string) {
  return value.replace(/\\/g, "/");
}

function taskTerms(query: string) {
  const matches = query.match(/[A-Za-z_][A-Za-z0-9_./-]{1,}|[\u4e00-\u9fff]{2,}/g) ?? [];
  const primary = new Set<string>();
  const terms = new Set<string>();
  for (const match of matches) {
    const normalized = match.toLowerCase();
    if (!stopWords.has(normalized)) {
      primary.add(normalized);
      terms.add(normalized);
    }
    for (const part of match.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_./-]+/)) {
      const value = part.toLowerCase();
      if (value.length >= 3 && !stopWords.has(value)) terms.add(value);
    }
  }
  return { primary: [...primary].slice(0, 16), expanded: [...terms].slice(0, 24) };
}

function isTestPath(file: string) {
  const normalized = normalize(file).toLowerCase();
  const name = path.posix.basename(normalized);
  return normalized.includes("/test/")
    || normalized.includes("/tests/")
    || normalized.includes("/__tests__/")
    || /(?:\.test|\.spec)\.[^.]+$/.test(name)
    || /^test_.+\.py$/.test(name)
    || /_test\.py$/.test(name);
}

function terminalCallName(name: string) {
  return name.replace(/\?\./g, ".").split(".").at(-1)?.toLowerCase() ?? name.toLowerCase();
}

function reverseImports(graph: CodeGraph) {
  const reverse = new Map<string, string[]>();
  for (const file of graph.files) {
    for (const item of file.imports) {
      if (!item.resolved) continue;
      const values = reverse.get(item.resolved) ?? [];
      if (!values.includes(file.path)) values.push(file.path);
      reverse.set(item.resolved, values);
    }
  }
  return reverse;
}

function explicitPaths(graph: CodeGraph, query: string) {
  const lower = normalize(query).toLowerCase();
  return graph.files.filter((file) => lower.includes(file.path.toLowerCase())).map((file) => file.path);
}

function targetSymbols(graph: CodeGraph, primaryTerms: string[], expandedTerms: string[]) {
  const candidates = graph.files.flatMap((file) => file.symbols.flatMap((symbol) => {
    const name = symbol.name.toLowerCase();
    const primaryExact = primaryTerms.some((term) => term === name);
    const expandedExact = expandedTerms.some((term) => term === name);
    const partial = !expandedExact && expandedTerms.some((term) => term.length >= 3 && (name.includes(term) || term.includes(name)));
    return primaryExact || expandedExact || partial
      ? [{ file: file.path, ...symbol, match: primaryExact || expandedExact ? "exact" as const : "partial" as const, primaryExact }]
      : [];
  }));
  const primaryExact = candidates.filter((candidate) => candidate.primaryExact);
  if (primaryExact.length) return primaryExact.map(({ primaryExact: _primaryExact, ...candidate }) => candidate).slice(0, 10);
  const exact = candidates.filter((candidate) => candidate.match === "exact");
  return (exact.length ? exact : candidates)
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
    .map(({ primaryExact: _primaryExact, ...candidate }) => candidate)
    .slice(0, 10);
}

function roleRank(role: ImpactFile["role"]) {
  return { target: 0, caller: 1, dependent: 2, test: 3, dependency: 4 }[role];
}

export async function analyzeImpact(root: string, query: string, maxDepth = 2): Promise<ImpactAnalysis> {
  const graph = await buildCodeGraph(root);
  const terms = taskTerms(query);
  const targets = targetSymbols(graph, terms.primary, terms.expanded);
  const explicit = explicitPaths(graph, query);
  const reverse = reverseImports(graph);
  const indexed = new Map(graph.files.map((file) => [file.path, file]));
  const impacted = new Map<string, ImpactFile>();

  const add = (file: string, role: ImpactFile["role"], distance: number, reason: string) => {
    const existing = impacted.get(file);
    if (!existing) {
      impacted.set(file, { path: file, role, distance, reasons: [reason] });
      return;
    }
    if (roleRank(role) < roleRank(existing.role)) existing.role = role;
    existing.distance = Math.min(existing.distance, distance);
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
  };

  for (const target of targets) add(target.file, "target", 0, `${target.match} ${target.kind} ${target.name}@${target.line}`);
  for (const file of explicit) add(file, "target", 0, "path mentioned in task");

  const targetNames = new Set(targets.map((target) => target.name.toLowerCase()));
  for (const file of graph.files) {
    for (const call of file.calls.filter((item) => targetNames.has(terminalCallName(item.name))).slice(0, 6)) {
      add(file.path, isTestPath(file.path) ? "test" : "caller", 1, `calls ${call.name}@${call.line}`);
    }
  }

  const seeds = new Set([...targets.map((target) => target.file), ...explicit]);
  let frontier = [...seeds];
  const visited = new Set(frontier);
  for (let distance = 1; distance <= Math.max(1, Math.min(maxDepth, 3)); distance++) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const importer of reverse.get(current) ?? []) {
        add(importer, isTestPath(importer) ? "test" : "dependent", distance, `imports ${current}`);
        if (!visited.has(importer)) {
          visited.add(importer);
          next.push(importer);
        }
      }
    }
    frontier = next;
  }

  for (const seed of seeds) {
    for (const item of indexed.get(seed)?.imports ?? []) {
      if (item.resolved) add(item.resolved, "dependency", 1, `imported by ${seed}`);
    }
  }

  const affectedCode = [...impacted.values()]
    .filter((item) => item.role !== "dependency" && item.role !== "test")
    .map((item) => item.path);
  for (const test of await selectTargetedTestFiles(root, affectedCode)) {
    add(test, "test", 1, "name-matched related test");
  }

  const files = [...impacted.values()]
    .sort((left, right) => roleRank(left.role) - roleRank(right.role) || left.distance - right.distance || left.path.localeCompare(right.path))
    .slice(0, 30);
  const relatedTests = files.filter((file) => file.role === "test").map((file) => file.path);
  const suggestedChecks = await selectTargetedTestCommands(root, [...affectedCode, ...relatedTests]);
  const warnings: string[] = [];
  if (!targets.length && !explicit.length) warnings.push("No target symbol or indexed source path matched the task; inspect the workspace before editing.");
  if (targets.length > 1 && new Set(targets.map((target) => target.name.toLowerCase())).size === 1) {
    warnings.push(`The symbol ${targets[0].name} has multiple candidate declarations; disambiguate before editing.`);
  }
  if (targets.length || explicit.length) warnings.push("Call impacts are syntactic name matches; dynamic dispatch and runtime wiring may require LSP or text-search confirmation.");

  const editPlan: string[] = [];
  if (targets.length || explicit.length) {
    editPlan.push("Inspect target declarations and their local contracts before editing.");
    if (files.some((file) => file.role === "caller" || file.role === "dependent")) {
      editPlan.push("Review direct callers and importers for compatibility and required companion edits.");
    }
    editPlan.push("Apply the smallest coherent change across target and affected files.");
    editPlan.push(relatedTests.length ? "Update or extend the identified related tests." : "Locate or add focused tests for the changed behavior.");
    editPlan.push(suggestedChecks.length ? "Run targeted tests before full project checks." : "Run the project's detected validation commands.");
  }

  return { query, targets, files, relatedTests, suggestedChecks, editPlan, warnings };
}

export function formatImpactAnalysis(analysis: ImpactAnalysis) {
  if (!analysis.targets.length && !analysis.files.length) return "";
  const targets = analysis.targets.length
    ? analysis.targets.map((target) => `- ${target.kind} ${target.name} at ${target.file}:${target.line} (${target.match})`).join("\n")
    : "- Source path mentioned directly; no matching symbol identified.";
  const files = analysis.files.slice(0, 16)
    .map((file) => `- ${file.path} [${file.role}, distance ${file.distance}]: ${file.reasons.join("; ")}`)
    .join("\n");
  const tests = analysis.relatedTests.length ? analysis.relatedTests.map((file) => `- ${file}`).join("\n") : "- None identified automatically.";
  const checks = analysis.suggestedChecks.length ? analysis.suggestedChecks.map((command) => `- ${command}`).join("\n") : "- Use detected project checks.";
  const plan = analysis.editPlan.map((step, index) => `${index + 1}. ${step}`).join("\n");
  const warnings = analysis.warnings.length ? `\nLimits:\n${analysis.warnings.map((warning) => `- ${warning}`).join("\n")}` : "";
  return `Pre-edit impact analysis (code-graph-derived):\nTargets:\n${targets}\nLikely affected files:\n${files}\nRelated tests:\n${tests}\nSuggested verification:\n${checks}\nRecommended edit plan:\n${plan}${warnings}`;
}
