import type { McpJsonRpcResponse, McpTransport } from "./mcp-transport.js";

export const MCP_PROTOCOL_VERSION = "2025-11-25";

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rpcResult(response: McpJsonRpcResponse) {
  if (response.error) throw Error(`MCP server returned JSON-RPC error ${response.error.code}`);
  return response.result;
}

export class McpClient {
  private nextId = 1;
  private initializePromise?: Promise<void>;
  private closed = false;

  constructor(private transport: McpTransport, private requestTimeoutMs = 30_000) {}

  async initialize(signal?: AbortSignal) {
    if (this.initializePromise) return await this.initializePromise;
    this.initializePromise = this.initializeInternal(signal);
    try {
      await this.initializePromise;
    } catch (error) {
      this.initializePromise = undefined;
      throw error;
    }
  }

  async listTools(signal?: AbortSignal) {
    await this.initialize(signal);
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const result = await this.request("tools/list", cursor ? { cursor } : {}, signal);
      if (!record(result) || !Array.isArray(result.tools)) throw Error("MCP tools/list returned an invalid result");
      for (const value of result.tools) {
        if (!record(value) || typeof value.name !== "string" || !value.name.trim()) {
          throw Error("MCP tools/list returned an invalid tool definition");
        }
        tools.push({
          name: value.name,
          ...(typeof value.description === "string" ? { description: value.description } : {}),
          ...(value.inputSchema !== undefined ? { inputSchema: value.inputSchema } : {}),
          ...(record(value.annotations) ? { annotations: value.annotations } : {}),
        });
      }
      if (tools.length > 128) throw Error("MCP server exposed more than 128 tools");
      cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) return tools;
    }
    throw Error("MCP tools/list exceeded the pagination limit");
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    await this.initialize(signal);
    try {
      return await this.request("tools/call", { name, arguments: args }, signal);
    } catch (error) {
      if ((error as Error).name === "TimeoutError") {
        const timeout = new Error(`${(error as Error).message}; remote side-effect outcome is unknown`);
        timeout.name = "TimeoutError";
        throw timeout;
      }
      throw error;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.transport.close();
  }

  private async initializeInternal(signal?: AbortSignal) {
    const result = await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "codepilot", version: "0.2.0" },
    }, signal);
    if (!record(result) || typeof result.protocolVersion !== "string") {
      throw Error("MCP initialize returned an invalid result");
    }
    this.transport.setProtocolVersion?.(result.protocolVersion);
    await this.notify("notifications/initialized", {}, signal);
  }

  private async request(method: string, params: unknown, parentSignal?: AbortSignal) {
    if (this.closed) throw Error("MCP client is closed");
    const controller = new AbortController();
    const onAbort = () => controller.abort(parentSignal?.reason);
    if (parentSignal?.aborted) controller.abort(parentSignal.reason);
    else parentSignal?.addEventListener("abort", onAbort, { once: true });
    const timeoutError = new Error(`MCP request timed out after ${this.requestTimeoutMs}ms`);
    timeoutError.name = "TimeoutError";
    const timeout = setTimeout(() => controller.abort(timeoutError), this.requestTimeoutMs);
    try {
      const response = await this.transport.request({
        jsonrpc: "2.0",
        id: this.nextId++,
        method,
        params,
      }, controller.signal);
      return rpcResult(response);
    } finally {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", onAbort);
    }
  }

  private async notify(method: string, params: unknown, signal?: AbortSignal) {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutError = new Error(`MCP notification timed out after ${this.requestTimeoutMs}ms`);
    timeoutError.name = "TimeoutError";
    const timeout = setTimeout(() => controller.abort(timeoutError), this.requestTimeoutMs);
    try {
      await this.transport.notify({ jsonrpc: "2.0", method, params }, controller.signal);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
