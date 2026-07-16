import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export function isUnsafeWorkspace(root: string, systemRoot = process.env.SystemRoot ?? process.env.WINDIR) {
  const normalized = path.resolve(root).toLowerCase();
  const filesystemRoot = path.parse(normalized).root.toLowerCase();
  if (normalized === filesystemRoot) return true;
  if (!systemRoot) return false;
  const system = path.resolve(systemRoot).toLowerCase();
  return normalized === system || normalized.startsWith(`${system}${path.sep}`);
}

/** Resolves and validates the directory that CodePilot is allowed to treat as a project. */
export async function resolveWorkspace(currentDirectory: string, requested?: string) {
  const candidate = path.resolve(currentDirectory, requested ?? currentDirectory);
  const details = await stat(candidate).catch(() => undefined);
  if (!details?.isDirectory()) throw Error(`Workspace is not an existing directory: ${candidate}`);
  const root = await realpath(candidate);
  if (isUnsafeWorkspace(root)) {
    throw Error(`Refusing to use a system directory as the workspace: ${root}. Use --cwd with a project directory.`);
  }
  return root;
}
