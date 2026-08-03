import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { loadMcpConfiguration, validateMcpHttpUrl, type McpConfiguration } from "../src/mcp-config.js";
import { McpClient } from "../src/mcp-client.js";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { connectMcpServers, formatMcpStatuses } from "../src/mcp-runtime.js";
import { ToolRegistry } from "../src/tool-registry.js";

const stdioServerSource = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "server/discover") {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  } else if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "mock-stdio", version: "1.0.0" }
    }});
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "check_env", description: "Check environment isolation", inputSchema: { type: "object" } },
      { name: "slow", description: "Wait before returning", inputSchema: { type: "object" } }
    ] }});
  } else if (message.method === "tools/call") {
    if (message.params.name === "echo") {
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(message.params.arguments.text) }] } });
    } else if (message.params.name === "check_env") {
      const text = "VISIBLE=" + (process.env.VISIBLE_TOKEN || "missing") + ";DEEPSEEK=" + (process.env.DEEPSEEK_API_KEY || "missing");
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } });
    } else if (message.params.name === "slow") {
      setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "late" }] } }), 2000);
    }
  }
});
`;

const dynamicStdioServerSource = String.raw`
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let expanded = false;
let invalid = false;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "server/discover") {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  } else if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "dynamic-mock", version: "1.0.0" }
    }});
  } else if (message.method === "tools/list") {
    const tools = [{ name: "enable", description: "Enable another tool", inputSchema: { type: "object" } }];
    if (expanded) tools.push({
      name: "dynamic",
      description: "Added at runtime",
      inputSchema: invalid ? { type: "object", description: "x".repeat(65000) } : { type: "object" }
    });
    send({ jsonrpc: "2.0", id: message.id, result: { tools } });
  } else if (message.method === "tools/call") {
    if (message.params.name === "enable") {
      expanded = true;
      send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "enabled" }] } });
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    } else if (message.params.name === "dynamic") {
      if (message.params.arguments.invalidate) {
        invalid = true;
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "invalidating" }] } });
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      } else {
        send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "dynamic result" }] } });
      }
    }
  }
});
`;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

function runCli(args: string[], credentialDirectory: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, CODEPILOT_CONFIG_DIR: credentialDirectory },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function configuration(servers: McpConfiguration["servers"], overrides: Partial<McpConfiguration> = {}): McpConfiguration {
  return {
    servers,
    issues: [],
    requestTimeoutMs: 3_000,
    toolOutputMaxChars: 200_000,
    ...overrides,
  };
}

test("marks timed-out MCP tool side effects as unknown and never retries the call", async () => {
  let toolCalls = 0;
  let clientVersion: string | undefined;
  const transport: Transport = {
    async start() {},
    async send(message: JSONRPCMessage) {
      if (!("id" in message) || !("method" in message)) return;
      if (message.method === "server/discover") {
        queueMicrotask(() => transport.onmessage?.({
          jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" },
        }));
      } else if (message.method === "initialize") {
        clientVersion = (message.params as { clientInfo?: { version?: string } }).clientInfo?.version;
        queueMicrotask(() => transport.onmessage?.({
          jsonrpc: "2.0", id: message.id, result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "timeout-test", version: "1.0.0" },
          },
        }));
      } else if (message.method === "tools/call") {
        toolCalls++;
      }
    },
    async close() { transport.onclose?.(); },
  };
  const client = new McpClient(transport, 20);
  await assert.rejects(
    client.callTool("side_effect", {}),
    (error: Error) => error.name === "TimeoutError" && /side-effect outcome is unknown/.test(error.message),
  );
  assert.equal(toolCalls, 1);
  assert.equal(clientVersion, packageVersion);
});

test("negotiates the modern MCP 2026 protocol through the official client", async () => {
  const methods: string[] = [];
  const transport: Transport = {
    async start() {},
    async send(message: JSONRPCMessage) {
      if (!("id" in message) || !("method" in message)) return;
      methods.push(message.method);
      if (message.method === "server/discover") {
        queueMicrotask(() => transport.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "private",
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
          },
        }));
      } else if (message.method === "tools/list") {
        queueMicrotask(() => transport.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "private",
            tools: [{ name: "modern", description: "Modern tool", inputSchema: { type: "object" } }],
          },
        }));
      }
    },
    async close() { transport.onclose?.(); },
  };
  const client = new McpClient(transport, 1_000);
  try {
    assert.deepEqual((await client.listTools()).map((tool) => tool.name), ["modern"]);
    assert.equal(client.protocolVersion(), "2026-07-28");
    assert.deepEqual(methods, ["server/discover", "tools/list"]);
  } finally {
    await client.close();
  }
});

test("allows realistic first-request latency during MCP version negotiation", async () => {
  const transport: Transport = {
    async start() {},
    async send(message: JSONRPCMessage) {
      if (!("id" in message) || !("method" in message)) return;
      if (message.method === "server/discover") {
        setTimeout(() => transport.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "private",
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
          },
        }), 1_200);
      } else if (message.method === "tools/list") {
        queueMicrotask(() => transport.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "private",
            tools: [{ name: "remote", inputSchema: { type: "object" } }],
          },
        }));
      }
    },
    async close() { transport.onclose?.(); },
  };
  const client = new McpClient(transport, 3_000);
  try {
    assert.deepEqual((await client.listTools()).map((tool) => tool.name), ["remote"]);
  } finally {
    await client.close();
  }
});

test("MCP status CLI discovers tools without requiring a model credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-mcp-cli-workspace-"));
  const directory = await mkdtemp(path.join(os.tmpdir(), "codepilot-mcp-cli-config-"));
  const script = path.join(root, "mock-mcp.cjs");
  await writeFile(script, stdioServerSource);
  await writeFile(path.join(directory, "config.json"), JSON.stringify({
    mcpServers: {
      cli: { transport: "stdio", command: process.execPath, args: [script] },
    },
  }));

  const result = await runCli(["mcp", "status", "--cwd", root], directory);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\[CONNECTED\] cli \(stdio\): 3 tool\(s\) discovered/);
});

test("discovers and calls stdio MCP tools with cancellation, output caps, and explicit environment forwarding", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-mcp-stdio-"));
  const script = path.join(root, "mock-mcp.cjs");
  await writeFile(script, stdioServerSource);
  const previousVisible = process.env.HOST_VISIBLE_TOKEN;
  const previousDeepSeek = process.env.DEEPSEEK_API_KEY;
  process.env.HOST_VISIBLE_TOKEN = "visible-value";
  process.env.DEEPSEEK_API_KEY = "must-not-reach-mcp";

  const runtime = await connectMcpServers(root, configuration([{
    name: "local",
    transport: "stdio",
    command: process.execPath,
    args: [script],
    env: { VISIBLE_TOKEN: "HOST_VISIBLE_TOKEN" },
  }], { toolOutputMaxChars: 40 }));
  try {
    assert.match(formatMcpStatuses(runtime.statuses), /CONNECTED.*local.*3 tool\(s\)/);
    assert.deepEqual(runtime.tools.map((tool) => tool.definition.name), [
      "mcp_local_echo", "mcp_local_check_env", "mcp_local_slow",
    ]);
    assert.ok(runtime.tools.every((tool) => tool.risk === "execute"));

    const environment = runtime.tools.find((tool) => tool.definition.name === "mcp_local_check_env")!;
    assert.equal(await environment.execute({}), "VISIBLE=visible-value;DEEPSEEK=missing");

    const echo = runtime.tools.find((tool) => tool.definition.name === "mcp_local_echo")!;
    const longOutput = await echo.execute({ text: "x".repeat(100) });
    assert.match(longOutput, /^x{40}\n\[MCP output truncated; original length 100\]$/);

    const slow = runtime.tools.find((tool) => tool.definition.name === "mcp_local_slow")!;
    const controller = new AbortController();
    const pending = slow.execute({}, { signal: controller.signal });
    controller.abort(new DOMException("cancel MCP tool", "AbortError"));
    await assert.rejects(pending, (error: Error) => error.name === "AbortError");
  } finally {
    await runtime.dispose();
    previousVisible === undefined
      ? delete process.env.HOST_VISIBLE_TOKEN
      : (process.env.HOST_VISIBLE_TOKEN = previousVisible);
    previousDeepSeek === undefined
      ? delete process.env.DEEPSEEK_API_KEY
      : (process.env.DEEPSEEK_API_KEY = previousDeepSeek);
  }
});

test("updates the live ToolRegistry after an MCP tools-list change notification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-mcp-dynamic-"));
  const script = path.join(root, "dynamic-mcp.cjs");
  await writeFile(script, dynamicStdioServerSource);
  const registry = new ToolRegistry();
  const runtime = await connectMcpServers(root, configuration([{
    name: "dynamic_server",
    transport: "stdio",
    command: process.execPath,
    args: [script],
    env: {},
  }]), undefined, registry);
  try {
    assert.equal(registry.has("mcp_dynamic_server_enable"), true);
    assert.equal(registry.has("mcp_dynamic_server_dynamic"), false);
    assert.equal(await registry.get("mcp_dynamic_server_enable")!.execute({}), "enabled");

    const deadline = Date.now() + 3_000;
    while (!registry.has("mcp_dynamic_server_dynamic") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(registry.has("mcp_dynamic_server_dynamic"), true);
    assert.equal(await registry.get("mcp_dynamic_server_dynamic")!.execute({}), "dynamic result");
    assert.match(runtime.statuses[0]!.detail, /list updated dynamically/);

    assert.equal(await registry.get("mcp_dynamic_server_dynamic")!.execute({ invalidate: true }), "invalidating");
    const rejectionDeadline = Date.now() + 3_000;
    while (!/rejected tool-list update/.test(runtime.statuses[0]!.detail) && Date.now() < rejectionDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(runtime.statuses[0]!.detail, /rejected tool-list update.*schema exceeded/);
    assert.equal(await registry.get("mcp_dynamic_server_dynamic")!.execute({}), "dynamic result");
  } finally {
    await runtime.dispose();
  }
  assert.equal(registry.has("mcp_dynamic_server_enable"), false);
  assert.equal(registry.has("mcp_dynamic_server_dynamic"), false);
});

test("connects to a Streamable HTTP MCP server with session and environment-backed Bearer authentication", async () => {
  const requests: Array<{ method: string; authorization?: string; session?: string; protocol?: string }> = [];
  let deleted = false;
  const server = createServer((request, response) => {
    if (request.method === "DELETE") {
      deleted = true;
      response.writeHead(200).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const message = JSON.parse(body);
      requests.push({
        method: message.method,
        authorization: request.headers.authorization,
        session: request.headers["mcp-session-id"] as string | undefined,
        protocol: request.headers["mcp-protocol-version"] as string | undefined,
      });
      if (message.method === "server/discover") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" },
        }));
      } else if (message.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-123" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "mock-http", version: "1.0.0" },
        }}));
      } else if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
      } else if (message.method === "tools/list") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }] },
        })}\n\n`);
      } else if (message.method === "tools/call") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "pong" }] },
        }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const previousToken = process.env.CODEPILOT_TEST_MCP_TOKEN;
  process.env.CODEPILOT_TEST_MCP_TOKEN = "remote-secret-token";
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-mcp-http-"));
  const runtime = await connectMcpServers(root, configuration([{
    name: "remote",
    transport: "http",
    url: `http://127.0.0.1:${port}/mcp`,
    bearerTokenEnv: "CODEPILOT_TEST_MCP_TOKEN",
  }]));
  try {
    assert.equal(runtime.statuses[0]?.state, "connected");
    assert.equal(await runtime.tools[0]!.execute({}), "pong");
    assert.ok(requests.every((request) => request.authorization === "Bearer remote-secret-token"));
    assert.equal(requests.find((request) => request.method === "initialize")?.protocol, undefined);
    assert.ok(requests.filter((request) => !["server/discover", "initialize"].includes(request.method)).every((request) =>
      request.session === "session-123" && request.protocol === "2025-11-25",
    ));
    assert.doesNotMatch(JSON.stringify(runtime.statuses), /remote-secret-token/);
  } finally {
    await runtime.dispose();
    assert.equal(deleted, true);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    previousToken === undefined
      ? delete process.env.CODEPILOT_TEST_MCP_TOKEN
      : (process.env.CODEPILOT_TEST_MCP_TOKEN = previousToken);
  }
});

test("rejects an oversized MCP HTTP response before parsing it", async () => {
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const message = JSON.parse(body);
      if (message.method === "server/discover") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }));
      } else if (message.method === "initialize") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "oversized", version: "1.0.0" },
        }}));
      } else if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
      } else if (message.method === "tools/list") {
        response.writeHead(200, { "content-type": "application/json", "content-length": "5000001" });
        response.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-mcp-http-limit-"));
  try {
    const runtime = await connectMcpServers(root, configuration([{
      name: "oversized",
      transport: "http",
      url: `http://127.0.0.1:${port}/mcp`,
    }]));
    try {
      assert.equal(runtime.statuses[0]?.state, "failed");
      assert.match(runtime.statuses[0]!.detail, /5,000,000 byte size limit/);
    } finally {
      await runtime.dispose();
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("loads only validated user-level MCP configuration and rejects insecure remote URLs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codepilot-mcp-config-"));
  await writeFile(path.join(directory, "config.json"), JSON.stringify({
    mcpRequestTimeoutMs: 5,
    mcpToolOutputMaxChars: 5_000_000,
    mcpServers: {
      valid: { transport: "stdio", command: process.execPath, args: ["server.cjs"], env: { TOKEN: "HOST_TOKEN" } },
      insecure: { transport: "http", url: "http://example.com/mcp" },
      disabled: { enabled: false, transport: "stdio", command: "ignored" },
    },
  }));
  const config = await loadMcpConfiguration(directory);
  assert.deepEqual(config.servers.map((server) => server.name), ["valid"]);
  assert.equal(config.requestTimeoutMs, 1_000);
  assert.equal(config.toolOutputMaxChars, 1_000_000);
  assert.match(config.issues.join("\n"), /Remote MCP URLs must use HTTPS/);
  assert.throws(() => validateMcpHttpUrl("https://user:password@example.com/mcp"), /must not contain credentials/);
  assert.throws(() => validateMcpHttpUrl("https://example.com/mcp?access_token=secret"), /credential-like query/);

  const project = await mkdtemp(path.join(os.tmpdir(), "codepilot-mcp-project-"));
  const isolatedUserDirectory = await mkdtemp(path.join(os.tmpdir(), "codepilot-mcp-user-"));
  await writeFile(path.join(project, ".codepilot.json"), JSON.stringify({
    mcpServers: { untrusted: { transport: "stdio", command: process.execPath, args: ["malicious.cjs"] } },
  }));
  await mkdir(isolatedUserDirectory, { recursive: true });
  assert.deepEqual((await loadMcpConfiguration(isolatedUserDirectory)).servers, []);
  await assert.doesNotReject(readFile(path.join(project, ".codepilot.json")));
});
