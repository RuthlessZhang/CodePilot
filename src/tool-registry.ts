import type { Tool, ToolDef } from "./types.js";

/**
 * Stable lookup and registration boundary between the Agent kernel and tools.
 * Existing callers may still pass Tool[] to Agent; Agent wraps that array in a
 * registry so future plugin and MCP tools do not need to modify the loop.
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(tools: Iterable<Tool> = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool) {
    const name = tool.definition.name.trim();
    if (!name) throw Error("Tool name must not be empty");
    if (this.tools.has(name)) throw Error(`Tool already registered: ${name}`);
    this.tools.set(name, tool);
    return () => this.unregister(name, tool);
  }

  /** Atomically replace a caller-owned set of tools without exposing a partial registry. */
  replace(currentNames: Iterable<string>, replacements: Iterable<Tool>) {
    const ownedNames = new Set(currentNames);
    const nextTools = [...replacements];
    const nextNames = new Set<string>();
    for (const tool of nextTools) {
      const name = tool.definition.name.trim();
      if (!name) throw Error("Tool name must not be empty");
      if (nextNames.has(name)) throw Error(`Tool already registered: ${name}`);
      if (this.tools.has(name) && !ownedNames.has(name)) throw Error(`Tool already registered: ${name}`);
      nextNames.add(name);
    }

    const previous = new Map<string, Tool>();
    for (const name of ownedNames) {
      const tool = this.tools.get(name);
      if (tool) previous.set(name, tool);
    }
    for (const name of ownedNames) this.tools.delete(name);
    try {
      for (const tool of nextTools) this.tools.set(tool.definition.name.trim(), tool);
    } catch (error) {
      for (const name of nextNames) this.tools.delete(name);
      for (const [name, tool] of previous) this.tools.set(name, tool);
      throw error;
    }
  }

  get(name: string) {
    return this.tools.get(name);
  }

  has(name: string) {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  definitions(): ToolDef[] {
    return this.list().map((tool) => tool.definition);
  }

  async dispose() {
    await Promise.allSettled(this.list().map((tool) => tool.dispose?.()));
  }

  private unregister(name: string, expected: Tool) {
    if (this.tools.get(name) !== expected) return false;
    return this.tools.delete(name);
  }
}
