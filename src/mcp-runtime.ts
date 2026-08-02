import { createHash } from "node:crypto";
import { McpClient, type McpToolDefinition, type McpToolsChanged } from "./mcp-client.js";
import type { McpConfiguration, McpServerConfig } from "./mcp-config.js";
import { createMcpTransport } from "./mcp-transport.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { Tool } from "./types.js";

export type McpServerStatus = {
  name: string;
  transport: "stdio" | "http" | "config";
  state: "connected" | "failed";
  toolCount: number;
  detail: string;
};

type ServerState = {
  server: McpServerConfig;
  client: McpClient;
  tools: Tool[];
  status: McpServerStatus;
};

function portableToolName(server: string, tool: string) {
  const normalized = `mcp_${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
  if (normalized.length <= 64) return normalized;
  const suffix = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 10);
  return `${normalized.slice(0, 53)}_${suffix}`;
}

function schema(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 64_000) throw Error("MCP tool schema exceeded 64,000 characters");
  return value;
}

function renderContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
  const block = value as Record<string, unknown>;
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "resource_link") {
    return `[MCP resource link: ${String(block.name ?? "resource")} ${String(block.uri ?? "")}]`;
  }
  if (block.type === "resource" && block.resource && typeof block.resource === "object") {
    const resource = block.resource as Record<string, unknown>;
    if (typeof resource.text === "string") return resource.text;
    return `[MCP embedded resource: ${String(resource.uri ?? "unknown")}]`;
  }
  if (block.type === "image" || block.type === "audio") {
    const bytes = typeof block.data === "string" ? Math.floor(block.data.length * 0.75) : 0;
    return `[MCP ${block.type}: ${String(block.mimeType ?? "unknown")}, approximately ${bytes} bytes]`;
  }
  return JSON.stringify(value);
}

function renderToolResult(value: unknown, maxChars: number) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("MCP tools/call returned an invalid result");
  const result = value as Record<string, unknown>;
  const blocks = Array.isArray(result.content) ? result.content.map(renderContent) : [];
  if (result.structuredContent !== undefined) blocks.push(JSON.stringify(result.structuredContent));
  let output = blocks.filter(Boolean).join("\n\n") || "(MCP tool returned no content)";
  if (output.length > maxChars) output = `${output.slice(0, maxChars)}\n[MCP output truncated; original length ${output.length}]`;
  if (result.isError === true) throw Error(`MCP tool reported an error: ${output}`);
  return output;
}

function mcpTool(server: McpServerConfig, definition: McpToolDefinition, client: McpClient, maxOutputChars: number): Tool {
  return {
    risk: "execute",
    definition: {
      name: portableToolName(server.name, definition.name),
      description: `[MCP ${server.name}/${definition.name}] ${(definition.description ?? "Remote MCP tool").slice(0, 1_000)}`,
      inputSchema: schema(definition.inputSchema),
    },
    async execute(args, context) {
      return renderToolResult(await client.callTool(definition.name, args, context?.signal), maxOutputChars);
    },
  };
}

function definitionChars(tools: readonly Tool[]) {
  return tools.reduce((total, tool) => total + JSON.stringify(tool.definition).length, 0);
}

function redactedMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}

export class McpRuntime {
  private disposed = false;

  constructor(
    readonly statuses: McpServerStatus[],
    private readonly states: Map<string, ServerState>,
    private readonly maxOutputChars: number,
    private readonly registry?: ToolRegistry,
  ) {}

  get tools() {
    return [...this.states.values()].flatMap((state) => state.tools);
  }

  refresh(serverName: string, error: Error | null, definitions: McpToolDefinition[] | null) {
    if (this.disposed) return;
    const state = this.states.get(serverName);
    if (!state) return;
    if (error || !definitions) {
      state.status.detail = `${state.tools.length} tool(s) active; refresh failed: ${redactedMessage(error ?? Error("empty tool list"))}`;
      return;
    }
    try {
      if (definitions.length > 128) throw Error("MCP server exposed more than 128 tools");
      const replacements = definitions.map((item) => mcpTool(state.server, item, state.client, this.maxOutputChars));
      const replacementNames = new Set<string>();
      for (const tool of replacements) {
        if (replacementNames.has(tool.definition.name)) throw Error(`MCP tool name collision: ${tool.definition.name}`);
        replacementNames.add(tool.definition.name);
      }

      const otherTools = [...this.states.values()]
        .filter((candidate) => candidate !== state)
        .flatMap((candidate) => candidate.tools);
      const otherNames = new Set(otherTools.map((tool) => tool.definition.name));
      const collision = replacements.find((tool) => otherNames.has(tool.definition.name));
      if (collision) throw Error(`MCP tool name collision: ${collision.definition.name}`);
      if (otherTools.length + replacements.length > 128) throw Error("Total MCP tool limit of 128 exceeded");
      if (definitionChars(otherTools) + definitionChars(replacements) > 256_000) {
        throw Error("Total MCP tool definition limit of 256,000 characters exceeded");
      }

      this.registry?.replace(state.tools.map((tool) => tool.definition.name), replacements);
      state.tools = replacements;
      state.status.toolCount = replacements.length;
      state.status.detail = `${replacements.length} tool(s) active; list updated dynamically`;
    } catch (refreshError) {
      state.status.detail = `${state.tools.length} tool(s) active; rejected tool-list update: ${redactedMessage(refreshError)}`;
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.registry) {
      for (const state of this.states.values()) {
        this.registry.replace(state.tools.map((tool) => tool.definition.name), []);
      }
    }
    await Promise.allSettled([...this.states.values()].map((state) => state.client.close()));
  }
}

export async function connectMcpServers(
  root: string,
  config: McpConfiguration,
  signal?: AbortSignal,
  registry?: ToolRegistry,
) {
  signal?.throwIfAborted();
  const statuses: McpServerStatus[] = config.issues.map((detail) => ({
    name: "configuration",
    transport: "config",
    state: "failed",
    toolCount: 0,
    detail,
  }));
  const startupClients = new Set<McpClient>();

  type Connected = {
    server: McpServerConfig;
    client?: McpClient;
    serverTools?: Tool[];
    status: McpServerStatus;
    activate?: (handler: McpToolsChanged) => void;
  };
  const connectServer = async (server: McpServerConfig): Promise<Connected> => {
    let client: McpClient | undefined;
    const queuedChanges: Parameters<McpToolsChanged>[] = [];
    let activeHandler: McpToolsChanged | undefined;
    const onChanged: McpToolsChanged = (...change) => {
      if (activeHandler) activeHandler(...change);
      else queuedChanges.push(change);
    };
    try {
      const activeClient = new McpClient(createMcpTransport(root, server), config.requestTimeoutMs, onChanged);
      client = activeClient;
      startupClients.add(activeClient);
      const definitions = await activeClient.listTools(signal);
      const serverTools = definitions.map((item) => mcpTool(server, item, activeClient, config.toolOutputMaxChars));
      const protocol = activeClient.protocolVersion();
      return {
        server,
        client: activeClient,
        serverTools,
        status: {
          name: server.name,
          transport: server.transport,
          state: "connected",
          toolCount: serverTools.length,
          detail: `${serverTools.length} tool(s) discovered${protocol ? `; protocol ${protocol}` : ""}`,
        },
        activate(handler) {
          activeHandler = handler;
          for (const change of queuedChanges.splice(0)) handler(...change);
        },
      };
    } catch (error) {
      await client?.close();
      if (client) startupClients.delete(client);
      if (signal?.aborted) throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("MCP startup cancelled", "AbortError");
      return {
        server,
        status: {
          name: server.name,
          transport: server.transport,
          state: "failed",
          toolCount: 0,
          detail: redactedMessage(error),
        },
      };
    }
  };

  let results: Connected[];
  try {
    results = await Promise.all(config.servers.map(connectServer));
  } catch (error) {
    await Promise.allSettled([...startupClients].map((client) => client.close()));
    throw error;
  }

  const states = new Map<string, ServerState>();
  const names = new Set<string>();
  let totalDefinitionChars = 0;
  for (const result of results) {
    if (!result.client || !result.serverTools) {
      statuses.push(result.status);
      continue;
    }
    const localNames = new Set<string>();
    const collision = result.serverTools.find((tool) => {
      const name = tool.definition.name;
      if (names.has(name) || localNames.has(name) || (registry?.has(name) ?? false)) return true;
      localNames.add(name);
      return false;
    });
    const serverDefinitionChars = definitionChars(result.serverTools);
    const issue = collision
      ? `MCP tool name collision: ${collision.definition.name}`
      : [...states.values()].reduce((count, state) => count + state.tools.length, 0) + result.serverTools.length > 128
        ? "Total MCP tool limit of 128 exceeded"
        : totalDefinitionChars + serverDefinitionChars > 256_000
          ? "Total MCP tool definition limit of 256,000 characters exceeded"
          : undefined;
    if (issue) {
      await result.client.close();
      statuses.push({ ...result.status, state: "failed", toolCount: 0, detail: issue });
      continue;
    }
    try {
      registry?.replace([], result.serverTools);
    } catch (error) {
      await result.client.close();
      statuses.push({ ...result.status, state: "failed", toolCount: 0, detail: redactedMessage(error) });
      continue;
    }
    for (const name of localNames) names.add(name);
    totalDefinitionChars += serverDefinitionChars;
    const state = { server: result.server, client: result.client, tools: result.serverTools, status: result.status };
    states.set(result.server.name, state);
    statuses.push(result.status);
  }

  const runtime = new McpRuntime(statuses, states, config.toolOutputMaxChars, registry);
  for (const result of results) {
    if (states.has(result.server.name)) {
      result.activate?.((error, tools) => runtime.refresh(result.server.name, error, tools));
    }
  }
  return runtime;
}

export function formatMcpStatuses(statuses: readonly McpServerStatus[]) {
  if (!statuses.length) return "No MCP servers configured in the user-level CodePilot config.";
  return statuses.map((status) =>
    `[${status.state.toUpperCase()}] ${status.name} (${status.transport}): ${status.detail}`,
  ).join("\n");
}
