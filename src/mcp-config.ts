import { readFile } from "node:fs/promises";
import { credentialConfigDirectory, userConfigPath } from "./credentials.js";
import { validateMcpHttpUrl } from "./mcp-transport.js";

export { validateMcpHttpUrl } from "./mcp-transport.js";

export type McpStdioServerConfig = {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
};

export type McpHttpServerConfig = {
  name: string;
  transport: "http";
  url: string;
  bearerTokenEnv?: string;
};

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export type McpConfiguration = {
  servers: McpServerConfig[];
  issues: string[];
  requestTimeoutMs: number;
  toolOutputMaxChars: number;
};

const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;
const serverName = /^[A-Za-z0-9_-]{1,32}$/;

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseEnvironment(value: unknown) {
  if (value === undefined) return {};
  if (!record(value)) throw Error("env must map child variable names to host variable names");
  const result: Record<string, string> = {};
  for (const [childName, hostName] of Object.entries(value)) {
    if (!environmentName.test(childName) || typeof hostName !== "string" || !environmentName.test(hostName)) {
      throw Error("env must map valid child variable names to valid host variable names");
    }
    result[childName] = hostName;
  }
  return result;
}

function parseServer(name: string, value: unknown): McpServerConfig | undefined {
  if (!serverName.test(name)) throw Error("server names must use 1-32 letters, numbers, underscores, or hyphens");
  if (!record(value)) throw Error("server configuration must be an object");
  if (value.enabled === false) return undefined;
  if (value.transport === "stdio") {
    if (typeof value.command !== "string" || !value.command.trim()) throw Error("stdio command is required");
    if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every((item) => typeof item === "string"))) {
      throw Error("stdio args must be an array of strings");
    }
    if (value.cwd !== undefined && (typeof value.cwd !== "string" || !value.cwd.trim())) {
      throw Error("stdio cwd must be a non-empty string");
    }
    return {
      name,
      transport: "stdio",
      command: value.command.trim(),
      args: (value.args as string[] | undefined) ?? [],
      ...(typeof value.cwd === "string" ? { cwd: value.cwd.trim() } : {}),
      env: parseEnvironment(value.env),
    };
  }
  if (value.transport === "http") {
    if (typeof value.url !== "string") throw Error("HTTP URL is required");
    if (value.headers !== undefined) throw Error("static HTTP headers are not supported; use bearerTokenEnv for authentication");
    if (value.oauth !== undefined) throw Error("OAuth configuration is not supported in this release");
    const url = validateMcpHttpUrl(value.url.trim());
    if (value.bearerTokenEnv !== undefined
      && (typeof value.bearerTokenEnv !== "string" || !environmentName.test(value.bearerTokenEnv))) {
      throw Error("bearerTokenEnv must be an environment variable name");
    }
    return {
      name,
      transport: "http",
      url: url.toString(),
      ...(typeof value.bearerTokenEnv === "string" ? { bearerTokenEnv: value.bearerTokenEnv } : {}),
    };
  }
  throw Error("transport must be stdio or http");
}

export async function loadMcpConfiguration(directory = credentialConfigDirectory()): Promise<McpConfiguration> {
  const fallback: McpConfiguration = {
    servers: [],
    issues: [],
    requestTimeoutMs: 30_000,
    toolOutputMaxChars: 200_000,
  };
  let root: unknown;
  try {
    root = JSON.parse(await readFile(userConfigPath(directory), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    return { ...fallback, issues: ["User MCP configuration is unreadable or invalid JSON."] };
  }
  if (!record(root)) return { ...fallback, issues: ["User MCP configuration root must be an object."] };

  const requestTimeoutMs = boundedInteger(root.mcpRequestTimeoutMs, fallback.requestTimeoutMs, 1_000, 120_000);
  const toolOutputMaxChars = boundedInteger(root.mcpToolOutputMaxChars, fallback.toolOutputMaxChars, 1_000, 1_000_000);
  if (root.mcpServers === undefined) return { ...fallback, requestTimeoutMs, toolOutputMaxChars };
  if (!record(root.mcpServers)) {
    return { ...fallback, requestTimeoutMs, toolOutputMaxChars, issues: ["mcpServers must be an object."] };
  }

  const servers: McpServerConfig[] = [];
  const issues: string[] = [];
  for (const [name, value] of Object.entries(root.mcpServers).slice(0, 16)) {
    try {
      const server = parseServer(name, value);
      if (server) servers.push(server);
    } catch (error) {
      issues.push(`MCP server ${name}: ${(error as Error).message}`);
    }
  }
  if (Object.keys(root.mcpServers).length > 16) issues.push("At most 16 MCP servers may be enabled.");
  return { servers, issues, requestTimeoutMs, toolOutputMaxChars };
}
