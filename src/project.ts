import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { codeGraphSummary, saveCodeGraph } from "./code-graph.js";

type PackageJson = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export type ProjectIndex = {
  generatedAt: string;
  root: string;
  name: string;
  stack: string[];
  scripts: Record<string, string>;
  importantFiles: string[];
  sourceRoots: string[];
  checkCommands: string[];
  codeGraph?: {
    files: number;
    symbols: number;
    imports: number;
    calls: number;
  };
};

const ignored = new Set(["node_modules", ".git", "dist", ".codepilot"]);

async function exists(file: string) {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

async function maybeJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function listTopLevel(root: string) {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    files.push(entry.name);
  }
  return files.sort();
}

function detectStack(pkg: PackageJson | undefined, topLevel: string[]) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const stack = new Set<string>();
  if (topLevel.includes("tsconfig.json") || deps.typescript) stack.add("TypeScript");
  if (deps.react) stack.add("React");
  if (deps.next) stack.add("Next.js");
  if (deps.vite) stack.add("Vite");
  if (deps.express) stack.add("Express");
  if (deps["@types/node"] || deps.tsx || topLevel.includes("package.json")) stack.add("Node.js");
  if (topLevel.includes("pyproject.toml") || topLevel.includes("requirements.txt")) stack.add("Python");
  if (topLevel.includes("Cargo.toml")) stack.add("Rust");
  if (topLevel.includes("go.mod")) stack.add("Go");
  return [...stack];
}

export function inferCheckCommands(index: Pick<ProjectIndex, "scripts" | "importantFiles">) {
  const commands: string[] = [];
  const scripts = index.scripts;
  for (const name of ["typecheck", "test", "build", "lint"]) {
    if (scripts[name]) commands.push(`npm run ${name}`);
  }
  if (!commands.length && scripts.test) commands.push("npm test");
  if (index.importantFiles.includes("pyproject.toml") || index.importantFiles.includes("requirements.txt")) {
    commands.push("pytest");
  }
  if (index.importantFiles.includes("Cargo.toml")) commands.push("cargo test");
  if (index.importantFiles.includes("go.mod")) commands.push("go test ./...");
  return commands.slice(0, 4);
}

export async function buildProjectIndex(root: string): Promise<ProjectIndex> {
  const topLevel = await listTopLevel(root);
  const pkg = await maybeJson<PackageJson>(path.join(root, "package.json"));
  const scripts = pkg?.scripts ?? {};
  const sourceRoots = [];
  for (const candidate of ["src", "app", "lib", "test", "tests"]) {
    if (topLevel.includes(candidate)) sourceRoots.push(candidate);
  }
  const importantFiles = [];
  for (const candidate of [
    "package.json",
    "tsconfig.json",
    "README.md",
    "AGENTS.md",
    "CLAUDE.md",
    "Dockerfile",
    "docker-compose.yml",
    "pyproject.toml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
  ]) {
    if (await exists(path.join(root, candidate))) importantFiles.push(candidate);
  }

  const partial = {
    scripts,
    importantFiles,
  };

  return {
    generatedAt: new Date().toISOString(),
    root,
    name: pkg?.name ?? path.basename(root),
    stack: detectStack(pkg, topLevel),
    scripts,
    importantFiles,
    sourceRoots,
    checkCommands: inferCheckCommands(partial),
  };
}

export async function saveProjectIndex(root: string) {
  const project = await buildProjectIndex(root);
  const graph = await saveCodeGraph(root);
  const index: ProjectIndex = { ...project, codeGraph: codeGraphSummary(graph) };
  const target = path.join(root, ".codepilot", "index.json");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(index, null, 2));
  return index;
}

export async function readProjectIndex(root: string) {
  return await maybeJson<ProjectIndex>(path.join(root, ".codepilot", "index.json"));
}

export function summarizeProjectIndex(index: ProjectIndex) {
  return [
    `Project: ${index.name}`,
    `Stack: ${index.stack.join(", ") || "Unknown"}`,
    `Source roots: ${index.sourceRoots.join(", ") || "Unknown"}`,
    `Important files: ${index.importantFiles.join(", ") || "None detected"}`,
    `Check commands: ${index.checkCommands.join(", ") || "None detected"}`,
    ...(index.codeGraph
      ? [`Code graph: ${index.codeGraph.files} files, ${index.codeGraph.symbols} symbols, ${index.codeGraph.imports} resolved imports, ${index.codeGraph.calls} calls`]
      : []),
  ].join("\n");
}
