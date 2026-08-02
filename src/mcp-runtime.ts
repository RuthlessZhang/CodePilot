import { createHash } from "node:crypto";
import path from "node:path";
import { McpClient, type McpToolDefinition } from "./mcp-client.js";
import type { McpConfiguration, McpServerConfig } from "./mcp-config.js";
import { StdioMcpTransport, StreamableHttpMcpTransport } from "./mcp-transport.js";
import type { Tool } from "./types.js";

export type McpServerStatus = {
  name: string;
  transport: "stdio" | "http" | "config";
  state: "connected" | "failed";
  toolCount: number;
  detail: string;
};

const inheritedEnvironment = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL",
];

function stdioEnvironment(mapping: Record<string, string>, source: NodeJS.ProcessEnv = process.env) {
  const env: NodeJS.ProcessEnv = {};
  for (const name of inheritedEnvironment) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  for (const [childName, hostName] of Object.entries(mapping)) {
    if (source[hostName] !== undefined) env[childName] = source[hostName];
  }
  return env;
}

function transportFor(root: string, server: McpServerConfig) {
  if (server.transport === "http") {
    return new StreamableHttpMcpTransport({
      url: server.url,
      bearerTokenEnv: server.bearerTokenEnv,
    });
  }
  return new StdioMcpTransport({
    command: server.command,
    args: server.args,
    cwd: server.cwd ? path.resolve(root, server.cwd) : root,
    env: stdioEnvironment(server.env),
  });
}

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

export class McpRuntime {
  constructor(
    readonly tools: Tool[],
    readonly statuses: McpServerStatus[],
    private clients: McpClient[],
  ) {}

  async dispose() {
    await Promise.allSettled(this.clients.map((client) => client.close()));
  }
}

export async function connectMcpServers(root: string, config: McpConfiguration, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const tools: Tool[] = [];
  const statuses: McpServerStatus[] = config.issues.map((detail) => ({
    name: "configuration",
    transport: "config",
    state: "failed",
    toolCount: 0,
    detail,
  }));
  const clients: McpClient[] = [];
  const startupClients = new Set<McpClient>();
  const names = new Set<string>();
  let definitionChars = 0;
  let results: Awaited<ReturnType<typeof connectServer>>[];
  const connectServer = async (server: McpServerConfig) => {
    let client: McpClient | undefined;
    try {
      const activeClient = new McpClient(transportFor(root, server), config.requestTimeoutMs);
      client = activeClient;
      startupClients.add(activeClient);
      const definitions = await activeClient.listTools(signal);
      const serverTools = definitions.map((definition) => mcpTool(server, definition, activeClient, config.toolOutputMaxChars));
      return { server, client: activeClient, serverTools, status: {
        name: server.name,
        transport: server.transport,
        state: "connected" as const,
        toolCount: serverTools.length,
        detail: `${serverTools.length} tool(s) discovered`,
      } };
    } catch (error) {
      await client?.close();
      if (client) startupClients.delete(client);
      if (signal?.aborted) throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("MCP startup cancelled", "AbortError");
      return { server, status: {
        name: server.name,
        transport: server.transport,
        state: "failed" as const,
        toolCount: 0,
        detail: (error as Error).message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 500),
      } };
    }
  };
  try {
    results = await Promise.all(config.servers.map(connectServer));
  } catch (error) {
    await Promise.allSettled([...startupClients].map((client) => client.close()));
    throw error;
  }
  for (const result of results) {
    if (!result.client || !result.serverTools) {
      statuses.push(result.status);
      continue;
    }
    const collision = result.serverTools.find((tool) => names.has(tool.definition.name));
    const serverDefinitionChars = result.serverTools.reduce(
      (total, tool) => total + JSON.stringify(tool.definition).length,
      0,
    );
    if (collision || tools.length + result.serverTools.length > 128 || definitionChars + serverDefinitionChars > 256_000) {
      await result.client.close();
      statuses.push({
        name: result.server.name,
        transport: result.server.transport,
        state: "failed",
        toolCount: 0,
        detail: collision
          ? `MCP tool name collision: ${collision.definition.name}`
          : tools.length + result.serverTools.length > 128
            ? "Total MCP tool limit of 128 exceeded"
            : "Total MCP tool definition limit of 256,000 characters exceeded",
      });
      continue;
    }
    for (const tool of result.serverTools) names.add(tool.definition.name);
    definitionChars += serverDefinitionChars;
    tools.push(...result.serverTools);
    clients.push(result.client);
    statuses.push(result.status);
  }
  return new McpRuntime(tools, statuses, clients);
}

export function formatMcpStatuses(statuses: readonly McpServerStatus[]) {
  if (!statuses.length) return "No MCP servers configured in the user-level CodePilot config.";
  return statuses.map((status) =>
    `[${status.state.toUpperCase()}] ${status.name} (${status.transport}): ${status.detail}`,
  ).join("\n");
}
