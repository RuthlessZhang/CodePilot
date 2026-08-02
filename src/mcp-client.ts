import {
  Client,
  SdkError,
  SdkErrorCode,
  type Tool as OfficialMcpTool,
  type Transport,
} from "@modelcontextprotocol/client";

export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
};

export type McpToolsChanged = (error: Error | null, tools: McpToolDefinition[] | null) => void;

function definition(tool: OfficialMcpTool): McpToolDefinition {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    ...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {}),
  };
}

function timeoutWithUnknownSideEffect(error: unknown) {
  if (!(error instanceof SdkError) || error.code !== SdkErrorCode.RequestTimeout) return error;
  const timeout = new Error(`${error.message}; remote side-effect outcome is unknown`);
  timeout.name = "TimeoutError";
  return timeout;
}

/**
 * Small CodePilot adapter around the official MCP TypeScript client. Protocol
 * negotiation, Streamable HTTP sessions, SSE and list-changed subscriptions
 * remain owned by the SDK; this adapter retains CodePilot's timeout and safety
 * semantics.
 */
export class McpClient {
  private readonly client: Client;
  private connectPromise?: Promise<void>;
  private closed = false;

  constructor(
    private readonly transport: Transport,
    private readonly requestTimeoutMs = 30_000,
    onToolsChanged?: McpToolsChanged,
  ) {
    this.client = new Client(
      { name: "codepilot", version: "0.2.0" },
      {
        versionNegotiation: {
          mode: "auto",
          probe: { timeoutMs: Math.min(requestTimeoutMs, 1_000), maxRetries: 0 },
        },
        inputRequired: { autoFulfill: false },
        listMaxPages: 20,
        ...(onToolsChanged ? {
          listChanged: {
            tools: {
              autoRefresh: true,
              debounceMs: 100,
              onChanged: (error, tools) => onToolsChanged(
                error,
                tools?.map(definition) ?? null,
              ),
            },
          },
        } : {}),
      },
    );
  }

  async initialize(signal?: AbortSignal) {
    if (this.connectPromise) return await this.connectPromise;
    if (this.closed) throw Error("MCP client is closed");
    this.connectPromise = this.client.connect(this.transport, {
      signal,
      timeout: this.requestTimeoutMs,
      maxTotalTimeout: this.requestTimeoutMs,
    });
    try {
      await this.connectPromise;
    } catch (error) {
      this.connectPromise = undefined;
      throw error;
    }
  }

  async listTools(signal?: AbortSignal) {
    await this.initialize(signal);
    const result = await this.client.listTools(undefined, {
      signal,
      timeout: this.requestTimeoutMs,
      maxTotalTimeout: this.requestTimeoutMs,
      cacheMode: "refresh",
    });
    if (result.tools.length > 128) throw Error("MCP server exposed more than 128 tools");
    return result.tools.map(definition);
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    await this.initialize(signal);
    try {
      return await this.client.callTool(
        { name, arguments: args },
        {
          signal,
          timeout: this.requestTimeoutMs,
          maxTotalTimeout: this.requestTimeoutMs,
        },
      );
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException("MCP tool call cancelled", "AbortError");
      }
      throw timeoutWithUnknownSideEffect(error);
    }
  }

  protocolVersion() {
    return this.client.getNegotiatedProtocolVersion();
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const terminable = this.transport as Transport & { terminateSession?: () => Promise<void> };
    try {
      if (terminable.terminateSession) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            terminable.terminateSession(),
            new Promise<void>((resolve) => { timeout = setTimeout(resolve, 2_000); }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
    } catch {
      // Remote session cleanup is best-effort; local resources must still close.
    } finally {
      await this.client.close();
    }
  }
}
