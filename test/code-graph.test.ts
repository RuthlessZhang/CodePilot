import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { buildCodeGraph, invalidateCodeGraph, queryCodeGraph } from "../src/code-graph.js";
import { analyzeImpact, formatImpactAnalysis } from "../src/impact-analysis.js";
import { saveProjectIndex } from "../src/project.js";
import { createTools } from "../src/tools.js";
import { selectWorkspaceContext } from "../src/workspace-context.js";

test("builds and queries a TypeScript symbol, import, and call graph", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-graph-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "service.ts"), [
    "export function loadUser(id: string) {",
    "  return normalizeUser(id);",
    "}",
    "function normalizeUser(id: string) { return id.trim(); }",
  ].join("\n"));
  await writeFile(path.join(root, "src", "app.ts"), [
    'import { loadUser } from "./service.js";',
    'export const current = loadUser(" 7 ");',
  ].join("\n"));

  const graph = await buildCodeGraph(root, true);
  const service = graph.files.find((file) => file.path === "src/service.ts");
  const app = graph.files.find((file) => file.path === "src/app.ts");
  assert.ok(service?.symbols.some((symbol) => symbol.name === "loadUser" && symbol.kind === "function"));
  assert.ok(service?.calls.some((call) => call.name === "normalizeUser"));
  assert.equal(app?.imports[0]?.resolved, "src/service.ts");
  assert.ok(app?.calls.some((call) => call.name === "loadUser"));

  const matches = JSON.parse(await queryCodeGraph(root, { query: "loadUser" }));
  assert.ok(matches.matches.some((match: { file: string; kind: string }) =>
    match.file === "src/service.ts" && match.kind === "function"));
  const details = JSON.parse(await queryCodeGraph(root, { path: "src/service.ts" }));
  assert.deepEqual(details.importedBy, ["src/app.ts"]);
});

test("extracts Python symbols, local imports, and calls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-python-graph-"));
  await mkdir(path.join(root, "pkg"));
  await writeFile(path.join(root, "pkg", "parser.py"), [
    "class Parser:",
    "    pass",
    "",
    "def parse_item(value):",
    "    return Parser()",
  ].join("\n"));
  await writeFile(path.join(root, "pkg", "app.py"), [
    "from .parser import parse_item",
    "",
    "result = parse_item('x')",
  ].join("\n"));

  const graph = await buildCodeGraph(root, true);
  const parser = graph.files.find((file) => file.path === "pkg/parser.py");
  const app = graph.files.find((file) => file.path === "pkg/app.py");
  assert.ok(parser?.symbols.some((symbol) => symbol.name === "Parser" && symbol.kind === "class"));
  assert.ok(parser?.symbols.some((symbol) => symbol.name === "parse_item"));
  assert.ok(parser?.calls.some((call) => call.name === "Parser"));
  assert.equal(app?.imports[0]?.resolved, "pkg/parser.py");
  assert.ok(app?.calls.some((call) => call.name === "parse_item"));
});

test("uses code relationships when selecting initial workspace context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-context-graph-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "account-service.ts"), "export function loadUser() { return 1; }\n");
  await writeFile(
    path.join(root, "src", "screen.ts"),
    'import { loadUser } from "./account-service";\nexport const value = loadUser();\n',
  );
  await writeFile(path.join(root, "src", "unrelated.ts"), "export const unrelated = true;\n");

  const context = await selectWorkspaceContext(root, "Change loadUser behavior");
  assert.match(context, /account-service\.ts/);
  assert.match(context, /function loadUser@1/);
  assert.match(context, /Imported by: src\/screen\.ts/);
});

test("persists the code graph in the project index and exposes a read tool", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-index-graph-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.ts"), "export function start() { return run(); }\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));

  const index = await saveProjectIndex(root);
  assert.equal(index.codeGraph?.files, 1);
  assert.ok(index.codeGraph && index.codeGraph.symbols >= 1);
  const persisted = JSON.parse(await readFile(path.join(root, ".codepilot", "code-graph.json"), "utf8"));
  assert.equal(persisted.version, 1);

  const tool = createTools(root).find((candidate) => candidate.definition.name === "code_graph");
  assert.ok(tool);
  assert.match(await tool.execute({ query: "start" }), /src\/main\.ts/);

  await writeFile(path.join(root, "src", "main.ts"), "export function stop() { return 0; }\n");
  invalidateCodeGraph(root);
  assert.match(await queryCodeGraph(root, { query: "stop" }), /stop/);
});

test("builds a pre-edit impact plan from symbols, callers, imports, and tests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-impact-"));
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "test"));
  await writeFile(path.join(root, "src", "service.ts"), "export function loadUser(id: string) { return id; }\n");
  await writeFile(path.join(root, "src", "controller.ts"), [
    'import { loadUser } from "./service.js";',
    "export function showUser() { return loadUser('7'); }",
  ].join("\n"));
  await writeFile(path.join(root, "src", "route.ts"), [
    'import { showUser } from "./controller.js";',
    "export const route = () => showUser();",
  ].join("\n"));
  await writeFile(path.join(root, "test", "service.test.ts"), [
    'import { loadUser } from "../src/service.js";',
    "loadUser('7');",
  ].join("\n"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));

  const analysis = await analyzeImpact(root, "Change loadUser behavior");
  assert.ok(analysis.targets.some((target) => target.file === "src/service.ts" && target.name === "loadUser"));
  assert.ok(analysis.files.some((file) => file.path === "src/controller.ts" && file.role === "caller"));
  assert.ok(analysis.files.some((file) => file.path === "src/route.ts" && file.role === "dependent" && file.distance === 2));
  assert.ok(analysis.relatedTests.includes("test/service.test.ts"));
  assert.ok(analysis.suggestedChecks.some((command) => command.includes("service.test.ts")));
  assert.match(formatImpactAnalysis(analysis), /Recommended edit plan/);
});

test("injects impact planning into workspace context and exposes an analysis tool", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-impact-tool-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "service.ts"), "export function loadUser() { return 1; }\n");

  const context = await selectWorkspaceContext(root, "Change loadUser behavior");
  assert.match(context, /Pre-edit impact analysis/);
  assert.match(context, /loadUser/);

  const tool = createTools(root).find((candidate) => candidate.definition.name === "impact_analysis");
  assert.ok(tool);
  const result = JSON.parse(await tool.execute({ query: "Change loadUser behavior" }));
  assert.equal(result.targets[0]?.name, "loadUser");
});

test("prefers an exact compound symbol over generic split-term matches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-impact-precision-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "verification.ts"), "export class VerificationController {}\n");
  await writeFile(path.join(root, "src", "noise.ts"), "const controller = {}; const test = () => true;\n");

  const analysis = await analyzeImpact(root, "Improve VerificationController targeted test behavior");
  assert.deepEqual(analysis.targets.map((target) => target.name), ["VerificationController"]);
});
