import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type PackageJson = {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

async function maybeRead(file: string) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

function detectStack(pkg: PackageJson, hasTsconfig: boolean) {
  const deps = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };
  const parts: string[] = [];
  if (hasTsconfig || deps.typescript) parts.push("TypeScript");
  if (deps.react) parts.push("React");
  if (deps.next) parts.push("Next.js");
  if (deps.vite) parts.push("Vite");
  if (deps.express) parts.push("Express");
  if (deps["@types/node"]) parts.push("Node.js");
  return parts.length ? parts.join(", ") : "Unknown";
}

export async function initProject(root: string, force = false) {
  const target = path.join(root, "AGENTS.md");
  if (!force && (await maybeRead(target))) {
    return "AGENTS.md already exists. Use /init --force to regenerate it.";
  }

  let pkg: PackageJson = {};
  const packageText = await maybeRead(path.join(root, "package.json"));
  if (packageText) pkg = JSON.parse(packageText) as PackageJson;

  const hasTsconfig = Boolean(await maybeRead(path.join(root, "tsconfig.json")));
  const scriptLines = Object.entries(pkg.scripts ?? {})
    .map(([name, command]) => `- ${name}: \`${command}\``)
    .join("\n");

  const content = `# CodePilot Project Guide

Project: ${pkg.name ?? path.basename(root)}
Stack: ${detectStack(pkg, hasTsconfig)}

## Working Rules

- Inspect relevant files before editing.
- Keep changes focused on the user's request.
- Preserve user changes and avoid unrelated rewrites.
- Prefer small, reviewable edits.
- Run the most relevant verification command when practical.
- Never claim a test, build, or check passed unless it was actually run.

## Commands

${scriptLines || "- No package scripts detected."}

## Notes

- Add project-specific architecture, testing, release, and style notes here.
- Keep secrets in environment variables, not in repository files.
`;

  await writeFile(target, content);
  return "Created AGENTS.md with a starter project guide.";
}
