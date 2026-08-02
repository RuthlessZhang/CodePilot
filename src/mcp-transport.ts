import {
  StreamableHTTPClientTransport,
  type AuthProvider,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import type { McpServerConfig } from "./mcp-config.js";

const inheritedEnvironment = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "TMPDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL",
];
const maxHttpResponseBytes = 5_000_000;

async function limitedMcpFetch(url: string | URL, init?: RequestInit) {
  const response = await fetch(url, init);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxHttpResponseBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw Error("MCP HTTP response exceeded the 5,000,000 byte size limit");
  }
  if (!response.body) return response;

  const isLongLivedSse = (init?.method ?? "GET").toUpperCase() === "GET"
    && response.headers.get("content-type")?.toLowerCase().includes("text/event-stream");
  let bytes = 0;
  let previous1 = -1;
  let previous2 = -1;
  let previous3 = -1;
  const limitedBody = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (isLongLivedSse) {
        for (const byte of chunk) {
          bytes++;
          const boundary = (previous1 === 10 && byte === 10)
            || (previous3 === 13 && previous2 === 10 && previous1 === 13 && byte === 10);
          previous3 = previous2;
          previous2 = previous1;
          previous1 = byte;
          if (boundary) bytes = 0;
          else if (bytes > maxHttpResponseBytes) throw Error("MCP HTTP SSE event exceeded the 5,000,000 byte size limit");
        }
      } else {
        bytes += chunk.byteLength;
        if (bytes > maxHttpResponseBytes) throw Error("MCP HTTP response exceeded the 5,000,000 byte size limit");
      }
      controller.enqueue(chunk);
    },
  }));
  return new Response(limitedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
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

export function stdioEnvironment(mapping: Record<string, string>, source: NodeJS.ProcessEnv = process.env) {
  const env: Record<string, string> = {};
  for (const name of inheritedEnvironment) {
    if (source[name] !== undefined) env[name] = source[name];
  }
  for (const [childName, hostName] of Object.entries(mapping)) {
    if (source[hostName] !== undefined) env[childName] = source[hostName];
  }
  return env;
}

export function createMcpTransport(root: string, server: McpServerConfig): Transport {
  if (server.transport === "http") {
    let authProvider: AuthProvider | undefined;
    if (server.bearerTokenEnv) {
      const environmentName = server.bearerTokenEnv;
      authProvider = {
        async token() {
          const token = process.env[environmentName]?.trim();
          if (!token) throw Error(`MCP bearer token environment variable is not set: ${environmentName}`);
          return token;
        },
      };
    }
    return new StreamableHTTPClientTransport(validateMcpHttpUrl(server.url), {
      ...(authProvider ? { authProvider } : {}),
      requestInit: { redirect: "error" },
      fetch: limitedMcpFetch,
      onInsufficientScope: "throw",
    });
  }

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: server.cwd ? path.resolve(root, server.cwd) : root,
    env: stdioEnvironment(server.env),
    stderr: "pipe",
    maxBufferSize: 5_000_000,
  });
  transport.stderr?.on("data", () => undefined);
  return transport;
}
