import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

type UndoEntry = {
  path: string;
  existed: boolean;
  content: string;
};

type UndoState = {
  createdAt: string;
  entries: UndoEntry[];
};

function resolveInRoot(root: string, relativePath: string) {
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw Error("Undo path escapes workspace");
  }
  return resolved;
}

export class UndoManager {
  private entries = new Map<string, UndoEntry>();

  constructor(private root: string) {}

  private get file() {
    return path.join(this.root, ".codepilot", "undo", "latest.json");
  }

  async snapshot(absPath: string) {
    const relativePath = path.relative(this.root, absPath);
    resolveInRoot(this.root, relativePath);
    if (this.entries.has(relativePath)) return;

    let content = "";
    let existed = true;
    try {
      content = await readFile(absPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      existed = false;
    }

    this.entries.set(relativePath, { path: relativePath, existed, content });
    await this.save();
  }

  async undo() {
    const state = JSON.parse(await readFile(this.file, "utf8")) as UndoState;
    for (const entry of [...state.entries].reverse()) {
      const target = resolveInRoot(this.root, entry.path);
      if (entry.existed) {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, entry.content);
      } else {
        await rm(target, { force: true });
      }
    }
    await this.clear();
    return state.entries.length;
  }

  async clear() {
    this.entries.clear();
    await rm(this.file, { force: true });
  }

  private async save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    const state: UndoState = {
      createdAt: new Date().toISOString(),
      entries: [...this.entries.values()],
    };
    await writeFile(this.file, JSON.stringify(state, null, 2));
  }
}
