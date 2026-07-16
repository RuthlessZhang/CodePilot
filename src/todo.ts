import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoItem = {
  content: string;
  status: TodoStatus;
};

type TodoState = {
  updatedAt: string;
  items: TodoItem[];
};

const statuses = new Set<TodoStatus>(["pending", "in_progress", "completed"]);

function todoFile(root: string) {
  return path.join(root, ".codepilot", "todos.json");
}

export function normalizeTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) throw Error("todos must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw Error(`todo ${index} must be an object`);
    const record = item as Record<string, unknown>;
    if (typeof record.content !== "string" || !record.content.trim()) {
      throw Error(`todo ${index} requires non-empty content`);
    }
    if (typeof record.status !== "string" || !statuses.has(record.status as TodoStatus)) {
      throw Error(`todo ${index} has invalid status`);
    }
    return {
      content: record.content.trim(),
      status: record.status as TodoStatus,
    };
  });
}

export async function writeTodos(root: string, items: TodoItem[]) {
  const state: TodoState = {
    updatedAt: new Date().toISOString(),
    items,
  };
  await mkdir(path.dirname(todoFile(root)), { recursive: true });
  await writeFile(todoFile(root), JSON.stringify(state, null, 2));
  return summarizeTodos(items);
}

export async function readTodos(root: string) {
  try {
    const state = JSON.parse(await readFile(todoFile(root), "utf8")) as TodoState;
    return Array.isArray(state.items) ? normalizeTodos(state.items) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export function summarizeTodos(items: TodoItem[]) {
  if (!items.length) return "(no todos)";
  return items
    .map((item, index) => `${index + 1}. [${item.status}] ${item.content}`)
    .join("\n");
}
