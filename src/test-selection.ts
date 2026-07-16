import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const ignored = new Set(["node_modules", ".git", "dist", ".codepilot", "coverage", ".venv", "venv"]);
const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);

async function workspaceFiles(dir: string, limit = 5000): Promise<string[]> {
  const files: string[] = [];
  async function visit(current: string) {
    if (files.length >= limit) return;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else files.push(target);
      if (files.length >= limit) return;
    }
  }
  await visit(dir);
  return files;
}

function isTestFile(file: string) {
  const normalized = file.replace(/\\/g, "/").toLowerCase();
  const name = path.basename(normalized);
  return normalized.includes("/test/")
    || normalized.includes("/tests/")
    || normalized.includes("/__tests__/")
    || /(?:\.test|\.spec)\.[^.]+$/.test(name)
    || /^test_.+\.py$/.test(name)
    || /_test\.py$/.test(name);
}

function logicalStem(file: string) {
  return path.basename(file)
    .toLowerCase()
    .replace(/\.(?:ts|tsx|js|jsx|mjs|cjs|py)$/, "")
    .replace(/^(?:test_)/, "")
    .replace(/(?:\.test|\.spec|_test)$/, "");
}

function quote(value: string) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function rankTest(test: string, changedFiles: string[]) {
  const normalizedTest = test.replace(/\\/g, "/").toLowerCase();
  const testStem = logicalStem(test);
  let score = changedFiles.includes(test) ? 100 : 0;
  for (const changed of changedFiles) {
    const sourceStem = logicalStem(changed);
    if (testStem === sourceStem) score = Math.max(score, 80);
    else if (normalizedTest.includes(sourceStem)) score = Math.max(score, 30);
  }
  return score;
}

export async function selectTargetedTestFiles(root: string, changedFiles: string[]) {
  const normalizedChanges = changedFiles
    .filter((file) => codeExtensions.has(path.extname(file).toLowerCase()))
    .map((file) => file.replace(/\\/g, "/"));
  if (!normalizedChanges.length) return [];

  return (await workspaceFiles(root))
    .map((file) => path.relative(root, file).replace(/\\/g, "/"))
    .filter((file) => codeExtensions.has(path.extname(file).toLowerCase()) && isTestFile(file))
    .map((file) => ({ file, score: rankTest(file, normalizedChanges) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
    .map((item) => item.file);
}

export async function selectTargetedTestCommands(root: string, changedFiles: string[]) {
  const candidates = await selectTargetedTestFiles(root, changedFiles);

  const python = candidates.filter((file) => path.extname(file).toLowerCase() === ".py").slice(0, 5);
  const javascript = candidates.filter((file) => path.extname(file).toLowerCase() !== ".py").slice(0, 5);
  const commands: string[] = [];
  if (python.length) commands.push(`pytest ${python.map(quote).join(" ")} -q`);

  if (javascript.length) {
    try {
      const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.test) commands.push(`npm test -- ${javascript.map(quote).join(" ")}`);
    } catch {
      // A JavaScript test command cannot be inferred without a package test script.
    }
  }
  return commands;
}
