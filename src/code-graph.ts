import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import * as ts from "typescript";
import { contentHash } from "./patch.js";

export type CodeSymbol = { name: string; kind: string; line: number };
export type CodeImport = { specifier: string; line: number; resolved?: string };
export type CodeCall = { name: string; line: number };
export type CodeGraphFile = {
  path: string;
  language: "typescript" | "javascript" | "python";
  hash: string;
  symbols: CodeSymbol[];
  imports: CodeImport[];
  calls: CodeCall[];
};
export type CodeGraph = {
  version: 1;
  generatedAt: string;
  root: string;
  files: CodeGraphFile[];
};

const ignored = new Set(["node_modules", ".git", "dist", ".codepilot", "coverage", ".venv", "venv", "build"]);
const supported = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);
const cache = new Map<string, CodeGraph>();

async function sourceFiles(root: string, limit = 3000) {
  const files: string[] = [];
  async function visit(dir: string) {
    if (files.length >= limit) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (supported.has(path.extname(entry.name).toLowerCase())) files.push(target);
      if (files.length >= limit) return;
    }
  }
  await visit(root);
  return files;
}

function scriptKind(extension: string) {
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parseTypeScript(relativePath: string, content: string): Omit<CodeGraphFile, "hash"> {
  const extension = path.extname(relativePath).toLowerCase();
  const source = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true, scriptKind(extension));
  const symbols: CodeSymbol[] = [];
  const imports: CodeImport[] = [];
  const calls: CodeCall[] = [];
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const addSymbol = (node: ts.Node, name: ts.Node | undefined, kind: string) => {
    if (!name) return;
    const text = name.getText(source).trim();
    if (text && text.length < 200) symbols.push({ name: text, kind, line: lineOf(node) });
  };
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node)) addSymbol(node, node.name, "function");
    else if (ts.isClassDeclaration(node)) addSymbol(node, node.name, "class");
    else if (ts.isInterfaceDeclaration(node)) addSymbol(node, node.name, "interface");
    else if (ts.isTypeAliasDeclaration(node)) addSymbol(node, node.name, "type");
    else if (ts.isEnumDeclaration(node)) addSymbol(node, node.name, "enum");
    else if (ts.isMethodDeclaration(node)) addSymbol(node, node.name, "method");
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) addSymbol(node, node.name, "variable");

    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push({ specifier: node.moduleSpecifier.text, line: lineOf(node) });
    }
    if (ts.isCallExpression(node)) {
      const name = node.expression.getText(source).trim();
      if (name && name.length < 200) calls.push({ name, line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return {
    path: relativePath,
    language: [".ts", ".tsx"].includes(extension) ? "typescript" : "javascript",
    symbols,
    imports,
    calls,
  };
}

function parsePython(relativePath: string, content: string): Omit<CodeGraphFile, "hash"> {
  const symbols: CodeSymbol[] = [];
  const imports: CodeImport[] = [];
  const calls: CodeCall[] = [];
  const ignoredCalls = new Set(["if", "for", "while", "return", "def", "class", "with", "assert", "yield"]);
  content.split(/\r?\n/).forEach((line, index) => {
    const lineNumber = index + 1;
    let match = /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
    if (match) symbols.push({ name: match[1], kind: "function", line: lineNumber });
    match = /^\s*class\s+([A-Za-z_]\w*)\b/.exec(line);
    if (match) symbols.push({ name: match[1], kind: "class", line: lineNumber });
    match = /^\s*from\s+([.\w]+)\s+import\s+/.exec(line);
    if (match) imports.push({ specifier: match[1], line: lineNumber });
    match = /^\s*import\s+([.\w]+)/.exec(line);
    if (match) imports.push({ specifier: match[1], line: lineNumber });
    for (const call of line.matchAll(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/g)) {
      if (!ignoredCalls.has(call[1]) && !/^\s*(?:async\s+)?def\s+/.test(line) && !/^\s*class\s+/.test(line)) {
        calls.push({ name: call[1], line: lineNumber });
      }
    }
  });
  return { path: relativePath, language: "python", symbols, imports, calls };
}

function normalize(value: string) {
  return value.replace(/\\/g, "/");
}

function resolveImport(from: CodeGraphFile, specifier: string, known: Set<string>) {
  const directory = path.posix.dirname(from.path);
  const candidates: string[] = [];
  if (from.language === "python") {
    const relativeModule = specifier.startsWith(".")
      ? path.posix.join(directory, specifier.replace(/^\.+/, "").replace(/\./g, "/"))
      : specifier.replace(/\./g, "/");
    candidates.push(`${relativeModule}.py`, `${relativeModule}/__init__.py`);
  } else if (specifier.startsWith(".")) {
    const requested = path.posix.normalize(path.posix.join(directory, specifier));
    candidates.push(requested);
    const requestedExtension = path.posix.extname(requested).toLowerCase();
    const base = supported.has(requestedExtension)
      ? requested.slice(0, -requestedExtension.length)
      : requested;
    for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]) {
      candidates.push(`${base}${extension}`, `${base}/index${extension}`);
    }
  }
  return candidates.find((candidate) => known.has(candidate));
}

export async function buildCodeGraph(root: string, force = false): Promise<CodeGraph> {
  const normalizedRoot = path.resolve(root);
  if (!force && cache.has(normalizedRoot)) return cache.get(normalizedRoot)!;
  const previous = cache.get(normalizedRoot);
  const previousFiles = new Map(previous?.files.map((file) => [file.path, file]));
  const files: CodeGraphFile[] = [];
  for (const file of await sourceFiles(normalizedRoot)) {
    const relativePath = normalize(path.relative(normalizedRoot, file));
    const content = await readFile(file, "utf8");
    const hash = contentHash(content);
    const cached = previousFiles.get(relativePath);
    if (cached?.hash === hash) {
      files.push(cached);
      continue;
    }
    const parsed = path.extname(relativePath).toLowerCase() === ".py"
      ? parsePython(relativePath, content)
      : parseTypeScript(relativePath, content);
    files.push({ ...parsed, hash });
  }
  const known = new Set(files.map((file) => file.path));
  for (const file of files) {
    for (const item of file.imports) item.resolved = resolveImport(file, item.specifier, known);
  }
  const graph: CodeGraph = { version: 1, generatedAt: new Date().toISOString(), root: normalizedRoot, files };
  cache.set(normalizedRoot, graph);
  return graph;
}

export function invalidateCodeGraph(root: string) {
  cache.delete(path.resolve(root));
}

export async function saveCodeGraph(root: string) {
  const graph = await buildCodeGraph(root, true);
  const target = path.join(root, ".codepilot", "code-graph.json");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(graph, null, 2));
  return graph;
}

export function codeGraphSummary(graph: CodeGraph) {
  return {
    files: graph.files.length,
    symbols: graph.files.reduce((sum, file) => sum + file.symbols.length, 0),
    imports: graph.files.reduce((sum, file) => sum + file.imports.filter((item) => item.resolved).length, 0),
    calls: graph.files.reduce((sum, file) => sum + file.calls.length, 0),
  };
}

export async function queryCodeGraph(root: string, input: { query?: string; path?: string }) {
  const graph = await buildCodeGraph(root);
  const importedBy = new Map<string, string[]>();
  for (const file of graph.files) {
    for (const item of file.imports) {
      if (!item.resolved) continue;
      const values = importedBy.get(item.resolved) ?? [];
      values.push(file.path);
      importedBy.set(item.resolved, values);
    }
  }
  if (input.path) {
    const requested = normalize(input.path);
    const file = graph.files.find((item) => item.path === requested);
    if (!file) return JSON.stringify({ error: "File is not indexed", path: requested }, null, 2);
    return JSON.stringify({ ...file, importedBy: importedBy.get(file.path) ?? [] }, null, 2);
  }
  const query = (input.query ?? "").toLowerCase();
  const matches = graph.files.flatMap((file) => [
    ...file.symbols.filter((symbol) => symbol.name.toLowerCase().includes(query)).map((symbol) => ({ file: file.path, ...symbol })),
    ...file.calls.filter((call) => call.name.toLowerCase().includes(query)).map((call) => ({ file: file.path, kind: "call", ...call })),
  ]).slice(0, 100);
  return JSON.stringify({ query, matches }, null, 2);
}
