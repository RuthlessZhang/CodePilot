import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type PatchOperation =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; oldText: string; newText: string };

export type PatchChange = {
  path: string;
  operation: PatchOperation["type"];
  beforeHash: string | null;
  afterHash: string | null;
};

export type PatchTransactionResult = {
  transactionId: string;
  status: "committed";
  changes: PatchChange[];
};

type ApplyPatchOptions = {
  expectedHashes?: Record<string, string>;
  signal?: AbortSignal;
  beforeCommit?: (index: number, change: PatchChange) => Promise<void>;
};

function resolveInWorkspace(root: string, value: string) {
  const resolved = path.resolve(root, value);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw Error("Path escapes workspace");
  }
  return resolved;
}

function normalizePatch(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripTrailingNewline(text: string) {
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

function parseUpdate(pathName: string, lines: string[]) {
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const line of lines) {
    if (line === "@@" || line.startsWith("@@ ")) continue;
    if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith("+")) {
      newLines.push(line.slice(1));
      continue;
    }
    if (line.startsWith(" ")) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
      continue;
    }
    if (!line.trim()) {
      oldLines.push("");
      newLines.push("");
      continue;
    }
    throw Error(`Invalid update patch line for ${pathName}: ${line}`);
  }

  const oldText = stripTrailingNewline(oldLines.join("\n"));
  const newText = stripTrailingNewline(newLines.join("\n"));
  if (!oldText) throw Error(`Update patch for ${pathName} has no match text`);
  if (oldText === newText) throw Error(`Update patch for ${pathName} has no changes`);
  return { type: "update" as const, path: pathName, oldText, newText };
}

export function parsePatch(patch: string): PatchOperation[] {
  const lines = normalizePatch(patch).split("\n");
  if (lines[0] !== "*** Begin Patch") throw Error("Patch must start with *** Begin Patch");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines[lines.length - 1] !== "*** End Patch") throw Error("Patch must end with *** End Patch");

  const operations: PatchOperation[] = [];
  let index = 1;

  while (index < lines.length - 1) {
    const header = lines[index++];
    if (!header) continue;

    if (header.startsWith("*** Add File: ")) {
      const pathName = header.slice("*** Add File: ".length).trim();
      const content: string[] = [];
      while (index < lines.length - 1 && !lines[index].startsWith("*** ")) {
        const line = lines[index++];
        if (!line.startsWith("+")) throw Error(`Add file lines for ${pathName} must start with +`);
        content.push(line.slice(1));
      }
      operations.push({ type: "add", path: pathName, content: stripTrailingNewline(content.join("\n")) });
      continue;
    }

    if (header.startsWith("*** Delete File: ")) {
      operations.push({ type: "delete", path: header.slice("*** Delete File: ".length).trim() });
      continue;
    }

    if (header.startsWith("*** Update File: ")) {
      const pathName = header.slice("*** Update File: ".length).trim();
      const hunk: string[] = [];
      while (index < lines.length - 1 && !lines[index].startsWith("*** ")) {
        hunk.push(lines[index++]);
      }
      operations.push(parseUpdate(pathName, hunk));
      continue;
    }

    throw Error(`Unknown patch header: ${header}`);
  }

  if (!operations.length) throw Error("Patch has no operations");
  return operations;
}

export function patchPaths(patch: string) {
  return parsePatch(patch).map((operation) => operation.path);
}

export function contentHash(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function readExisting(target: string) {
  try {
    return { existed: true as const, content: await readFile(target, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { existed: false as const, content: "" };
    throw error;
  }
}

export async function writeTextFileAtomic(
  root: string,
  value: string,
  content: string,
  expectedHash?: string,
  beforeWrite?: (absPath: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<PatchTransactionResult> {
  signal?.throwIfAborted();
  const target = resolveInWorkspace(root, value);
  const relativePath = path.relative(root, target);
  const existing = await readExisting(target);
  const beforeHash = existing.existed ? contentHash(existing.content) : null;
  if (expectedHash && expectedHash !== beforeHash) {
    throw Error(`File changed since it was read: ${relativePath} (expected ${expectedHash}, found ${beforeHash})`);
  }
  await beforeWrite?.(target);
  await mkdir(path.dirname(target), { recursive: true });
  const transactionId = randomUUID();
  const temporary = `${target}.${transactionId}.codepilot-tmp`;
  const backup = existing.existed ? `${target}.${transactionId}.codepilot-bak` : undefined;
  await writeFile(temporary, content, { flag: "wx" });
  let backupMoved = false;
  let targetWritten = false;
  try {
    signal?.throwIfAborted();
    const current = await readExisting(target);
    const currentHash = current.existed ? contentHash(current.content) : null;
    if (currentHash !== beforeHash) {
      throw Error(`File changed during write transaction: ${relativePath} (expected ${beforeHash}, found ${currentHash})`);
    }
    if (backup) {
      await rename(target, backup);
      backupMoved = true;
    }
    await rename(temporary, target);
    targetWritten = true;
  } catch (error) {
    if (targetWritten) await rm(target, { force: true });
    if (backup && backupMoved) await rename(backup, target);
    await rm(temporary, { force: true });
    throw error;
  }
  if (backup) await rm(backup, { force: true });
  return {
    transactionId,
    status: "committed",
    changes: [{
      path: relativePath,
      operation: existing.existed ? "update" : "add",
      beforeHash,
      afterHash: contentHash(content),
    }],
  };
}

export async function applyCodePilotPatch(
  root: string,
  patch: string,
  beforeWrite?: (absPath: string) => Promise<void>,
  options: ApplyPatchOptions = {},
) {
  const operations = parsePatch(patch);
  const duplicate = operations.find((operation, index) =>
    operations.findIndex((candidate) => path.normalize(candidate.path) === path.normalize(operation.path)) !== index,
  );
  if (duplicate) throw Error(`Patch contains multiple operations for ${duplicate.path}`);

  const transactionId = randomUUID();
  const prepared = [] as Array<{
    target: string;
    relativePath: string;
    operation: PatchOperation["type"];
    existed: boolean;
    beforeContent: string;
    afterContent?: string;
    change: PatchChange;
    temporary?: string;
    backup?: string;
    backupMoved?: boolean;
    targetWritten?: boolean;
  }>;

  // Validate and calculate every result before mutating any workspace file.
  for (const operation of operations) {
    options.signal?.throwIfAborted();
    const target = resolveInWorkspace(root, operation.path);
    const relativePath = path.relative(root, target);
    const existing = await readExisting(target);
    if (operation.type === "add" && existing.existed) throw Error(`File already exists: ${operation.path}`);
    if (operation.type !== "add" && !existing.existed) throw Error(`File does not exist: ${operation.path}`);

    const beforeHash = existing.existed ? contentHash(existing.content) : null;
    const expectedHash = options.expectedHashes?.[operation.path] ?? options.expectedHashes?.[relativePath];
    if (expectedHash && expectedHash !== beforeHash) {
      throw Error(`File changed since it was read: ${relativePath} (expected ${expectedHash}, found ${beforeHash})`);
    }

    let afterContent: string | undefined;
    if (operation.type === "add") afterContent = operation.content;
    if (operation.type === "update") {
      const first = existing.content.indexOf(operation.oldText);
      if (first < 0) throw Error(`Patch text not found in ${operation.path}`);
      if (existing.content.indexOf(operation.oldText, first + operation.oldText.length) >= 0) {
        throw Error(`Patch text is not unique in ${operation.path}`);
      }
      afterContent = existing.content.slice(0, first) + operation.newText + existing.content.slice(first + operation.oldText.length);
    }
    const change: PatchChange = {
      path: relativePath,
      operation: operation.type,
      beforeHash,
      afterHash: afterContent === undefined ? null : contentHash(afterContent),
    };
    prepared.push({ target, relativePath, operation: operation.type, existed: existing.existed, beforeContent: existing.content, afterContent, change });
  }

  for (const entry of prepared) await beforeWrite?.(entry.target);

  try {
    // Stage all new contents beside their destination before beginning the commit.
    for (const entry of prepared) {
      options.signal?.throwIfAborted();
      await mkdir(path.dirname(entry.target), { recursive: true });
      if (entry.afterContent !== undefined) {
        entry.temporary = `${entry.target}.${transactionId}.codepilot-tmp`;
        await writeFile(entry.temporary, entry.afterContent, { flag: "wx" });
      }
      if (entry.existed) entry.backup = `${entry.target}.${transactionId}.codepilot-bak`;
    }

    for (let index = 0; index < prepared.length; index++) {
      const entry = prepared[index];
      options.signal?.throwIfAborted();
      await options.beforeCommit?.(index, entry.change);
      const current = await readExisting(entry.target);
      const currentHash = current.existed ? contentHash(current.content) : null;
      if (currentHash !== entry.change.beforeHash) {
        throw Error(`File changed during patch transaction: ${entry.relativePath} (expected ${entry.change.beforeHash}, found ${currentHash})`);
      }
      if (entry.backup) {
        await rename(entry.target, entry.backup);
        entry.backupMoved = true;
      }
      if (entry.temporary) {
        await rename(entry.temporary, entry.target);
        entry.temporary = undefined;
        entry.targetWritten = true;
      }
    }
  } catch (error) {
    let rollbackError: unknown;
    for (const entry of [...prepared].reverse()) {
      try {
        if (entry.targetWritten) await rm(entry.target, { force: true });
        if (entry.backup && entry.backupMoved) {
          await rename(entry.backup, entry.target);
          entry.backup = undefined;
        }
        if (entry.temporary) await rm(entry.temporary, { force: true });
      } catch (current) {
        rollbackError ??= current;
      }
    }
    if (rollbackError) throw Error(`Patch transaction failed: ${(error as Error).message}; rollback failed: ${(rollbackError as Error).message}`);
    throw error;
  }

  await Promise.all(prepared.map(async (entry) => {
    if (entry.backup) await rm(entry.backup, { force: true });
    if (entry.temporary) await rm(entry.temporary, { force: true });
  }));

  const result: PatchTransactionResult = { transactionId, status: "committed", changes: prepared.map((entry) => entry.change) };
  return JSON.stringify(result, null, 2);
}
