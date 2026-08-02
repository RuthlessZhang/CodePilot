import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type McpJsonRpcId = string | number;
export type McpJsonRpcRequest = { jsonrpc: "2.0"; id: McpJsonRpcId; method: string; params?: unknown };
export type McpJsonRpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown };
export type McpJsonRpcResponse = {
  jsonrpc: "2.0";
  id: McpJsonRpcId | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export interface McpTransport {
  request(message: McpJsonRpcRequest, signal: AbortSignal): Promise<McpJsonRpcResponse>;
  notify(message: McpJsonRpcNotification, signal?: AbortSignal): Promise<void>;
  setProtocolVersion?(version: string): void;
  close(): Promise<void>;
}

export function validateMcpHttpUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error("MCP HTTP URL is invalid");
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw Error("Remote MCP URLs must use HTTPS; HTTP is allowed only for localhost");
  }
  if (url.username || url.password || url.hash) throw Error("MCP HTTP URL must not contain credentials or a fragment");
  for (const name of url.searchParams.keys()) {
    if (/(?:token|key|secret|auth|password|credential)/i.test(name)) {
      throw Error("MCP HTTP URL must not contain credential-like query parameters");
    }
  }
  return url;
}

function abortError(reason?: unknown) {
  if (reason instanceof Error) return reason;
  return new DOMException(typeof reason === "string" ? reason : "Operation cancelled", "AbortError");
}

function response(value: unknown): value is McpJsonRpcResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.jsonrpc === "2.0" && (typeof candidate.id === "string" || typeof candidate.id === "number" || candidate.id === null);
}

type Pending = {
  resolve(value: McpJsonRpcResponse): void;
  reject(error: Error): void;
  cleanup(): void;
};

export class StdioMcpTransport implements McpTransport {
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<void>;
  private stdoutBuffer = "";
  private pending = new Map<McpJsonRpcId, Pending>();
  private closed = false;

  constructor(private options: {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    maxMessageChars?: number;
  }) {}

  async request(message: McpJsonRpcRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.start();
    signal.throwIfAborted();
    return await new Promise<McpJsonRpcResponse>((resolve, reject) => {
      const onAbort = () => {
        this.pending.delete(message.id);
        void this.write({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: message.id, reason: "CodePilot request cancelled" },
        }).catch(() => undefined);
        reject(abortError(signal.reason));
      };
      const pending: Pending = {
        resolve,
        reject,
        cleanup: () => signal.removeEventListener("abort", onAbort),
      };
      this.pending.set(message.id, pending);
      signal.addEventListener("abort", onAbort, { once: true });
      void this.write(message).catch((error) => {
        if (this.pending.delete(message.id)) {
          pending.cleanup();
          reject(error as Error);
        }
      });
    });
  }

  async notify(message: McpJsonRpcNotification, signal?: AbortSignal) {
    signal?.throwIfAborted();
    await this.start();
    signal?.throwIfAborted();
    await this.write(message);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.fail(Error("MCP stdio transport closed"));
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.kill();
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  private async start() {
    if (this.closed) throw Error("MCP stdio transport is closed");
    if (this.startPromise) return await this.startPromise;
    this.startPromise = new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.command, this.options.args, {
        cwd: this.options.cwd,
        env: this.options.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
      child.stderr.resume();
      child.once("spawn", resolve);
      child.once("error", (error) => {
        reject(error);
        this.fail(error);
      });
      child.once("exit", (code, signal) => {
        this.fail(Error(`MCP stdio server exited (${signal ?? code ?? "unknown"})`));
      });
    });
    return await this.startPromise;
  }

  private onStdout(chunk: string) {
    this.stdoutBuffer += chunk;
    const limit = this.options.maxMessageChars ?? 5_000_000;
    if (this.stdoutBuffer.length > limit && !this.stdoutBuffer.includes("\n")) {
      this.fail(Error("MCP stdio message exceeded the size limit"));
      void this.close();
      return;
    }
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      if (line.length > limit) {
        this.fail(Error("MCP stdio message exceeded the size limit"));
        void this.close();
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.fail(Error("MCP stdio server emitted invalid JSON on stdout"));
        void this.close();
        return;
      }
      if (response(message)) {
        const pending = message.id === null ? undefined : this.pending.get(message.id);
        if (pending && message.id !== null) {
          this.pending.delete(message.id);
          pending.cleanup();
          pending.resolve(message);
        }
      } else if (message && typeof message === "object" && "id" in message && "method" in message) {
        const request = message as { id: McpJsonRpcId; method: string };
        void this.write({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `Client method not supported: ${request.method}` },
        }).catch(() => undefined);
      }
    }
  }

  private write(message: object) {
    if (this.closed || !this.child?.stdin.writable) return Promise.reject(Error("MCP stdio transport is not writable"));
    return new Promise<void>((resolve, reject) => {
      this.child!.stdin.write(`${JSON.stringify(message)}\n`, "utf8", (error) => error ? reject(error) : resolve());
    });
  }

  private fail(error: Error) {
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function readLimited(response: Response, maxChars: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
    if (text.length > maxChars) {
      await reader.cancel();
      throw Error("MCP HTTP response exceeded the size limit");
    }
  }
}

function parseSseEvent(event: string, id: McpJsonRpcId) {
  const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
  if (!data) return undefined;
  try {
    const parsed = JSON.parse(data);
    if (response(parsed) && parsed.id === id) return parsed;
  } catch {
    throw Error("MCP HTTP server emitted invalid SSE JSON");
  }
  return undefined;
}

async function readSseResponse(responseValue: Response, id: McpJsonRpcId, maxChars: number) {
  if (!responseValue.body) throw Error("MCP HTTP SSE response had no body");
  const reader = responseValue.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let totalChars = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      totalChars += value?.byteLength ?? 0;
      if (totalChars > maxChars) throw Error("MCP HTTP response exceeded the size limit");
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary) break;
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const parsed = parseSseEvent(event, id);
        if (parsed) return parsed;
      }
      if (done) {
        const parsed = parseSseEvent(buffer, id);
        if (parsed) return parsed;
        throw Error("MCP HTTP response did not contain the requested JSON-RPC response");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export class StreamableHttpMcpTransport implements McpTransport {
  private sessionId?: string;
  private protocolVersion = "2025-11-25";
  private closed = false;

  constructor(private options: {
    url: string;
    bearerTokenEnv?: string;
    env?: NodeJS.ProcessEnv;
    maxResponseChars?: number;
  }) {
    this.options.url = validateMcpHttpUrl(options.url).toString();
  }

  setProtocolVersion(version: string) {
    this.protocolVersion = version;
  }

  async request(message: McpJsonRpcRequest, signal: AbortSignal) {
    const result = await this.post(message, signal);
    if (!result) throw Error("MCP HTTP server returned no JSON-RPC response");
    if (result.id !== message.id) throw Error("MCP HTTP response ID did not match the request");
    return result;
  }

  async notify(message: McpJsonRpcNotification, signal?: AbortSignal) {
    const controller = signal ? undefined : new AbortController();
    await this.post(message, signal ?? controller!.signal, true);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.sessionId) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      await fetch(this.options.url, {
        method: "DELETE",
        headers: this.headers(),
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      // Session cleanup is best-effort.
    } finally {
      clearTimeout(timeout);
    }
  }

  private headers(includeProtocolVersion = true) {
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    if (includeProtocolVersion) headers["MCP-Protocol-Version"] = this.protocolVersion;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    if (this.options.bearerTokenEnv) {
      const token = (this.options.env ?? process.env)[this.options.bearerTokenEnv]?.trim();
      if (!token) throw Error(`MCP bearer token environment variable is not set: ${this.options.bearerTokenEnv}`);
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private async post(message: McpJsonRpcRequest | McpJsonRpcNotification, signal: AbortSignal, notification = false) {
    if (this.closed) throw Error("MCP HTTP transport is closed");
    signal.throwIfAborted();
    const responseValue = await fetch(this.options.url, {
      method: "POST",
      headers: this.headers(message.method !== "initialize"),
      body: JSON.stringify(message),
      redirect: "error",
      signal,
    });
    const sessionId = responseValue.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    if (!responseValue.ok) {
      if (responseValue.status === 401) throw Error("MCP HTTP server requires authorization");
      throw Error(`MCP HTTP server returned status ${responseValue.status}`);
    }
    if (notification || responseValue.status === 202 || !responseValue.body) {
      await responseValue.body?.cancel();
      return undefined;
    }
    const contentType = responseValue.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType.includes("text/event-stream")) {
      return await readSseResponse(
        responseValue,
        (message as McpJsonRpcRequest).id,
        this.options.maxResponseChars ?? 5_000_000,
      );
    }
    const text = await readLimited(responseValue, this.options.maxResponseChars ?? 5_000_000);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw Error("MCP HTTP server returned invalid JSON");
    }
    if (!response(parsed)) throw Error("MCP HTTP server returned an invalid JSON-RPC response");
    return parsed;
  }
}
