import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type LspOperation = "documentSymbols" | "workspaceSymbols" | "definition" | "references" | "hover" | "diagnostics";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

function cancellationError() {
  const error = new Error("Operation cancelled");
  error.name = "AbortError";
  return error;
}

function resolveWorkspaceFile(root: string, value: string) {
  const resolved = path.resolve(root, value);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw Error("Path escapes workspace");
  return resolved;
}

class LspClient {
  private child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private notificationListeners = new Map<string, Set<(params: unknown) => void>>();
  private stderr = "";
  private alive = true;

  constructor(command: string, root: string) {
    this.child = process.platform === "win32"
      ? spawn(`"${command}" --stdio`, { cwd: root, shell: true, windowsHide: true }) as ChildProcessWithoutNullStreams
      : spawn(command, ["--stdio"], { cwd: root, windowsHide: true });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.onData(chunk);
      } catch (error) {
        this.failAll(error instanceof Error ? error : Error(String(error)));
        this.child.kill();
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-4000);
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("exit", (code) => {
      this.alive = false;
      if (this.pending.size) this.failAll(Error(`Language server exited with code ${code}.${this.stderr ? ` ${this.stderr.trim()}` : ""}`));
    });
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const length = /Content-Length:\s*(\d+)/i.exec(header)?.[1];
      if (!length) throw Error("Invalid LSP response header");
      const bodyLength = Number(length);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + bodyLength) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + bodyLength).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + bodyLength);
      this.handle(JSON.parse(body));
    }
  }

  private handle(message: Record<string, unknown>) {
    if (typeof message.id === "number" && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(Error(`LSP error: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
      return;
    }

    if (message.id === undefined && typeof message.method === "string") {
      for (const listener of this.notificationListeners.get(message.method) ?? []) listener(message.params);
      return;
    }

    if (typeof message.id === "number" && typeof message.method === "string") {
      let result: unknown = null;
      if (message.method === "workspace/configuration") {
        const items = (message.params as { items?: unknown[] } | undefined)?.items ?? [];
        result = items.map(() => ({}));
      } else if (message.method === "workspace/workspaceFolders") {
        result = [];
      }
      this.send({ jsonrpc: "2.0", id: message.id, result });
    }
  }

  private send(message: unknown) {
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request(method: string, params: unknown, timeoutMs = 20000) {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`LSP request timed out: ${method}${this.stderr ? ` (${this.stderr.trim()})` : ""}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  onNotification(method: string, listener: (params: unknown) => void) {
    const listeners = this.notificationListeners.get(method) ?? new Set<(params: unknown) => void>();
    listeners.add(listener);
    this.notificationListeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.notificationListeners.delete(method);
    };
  }

  bindSignal(signal?: AbortSignal) {
    if (!signal) return () => {};
    const abort = () => {
      this.failAll(cancellationError());
      this.kill();
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return () => signal.removeEventListener("abort", abort);
  }

  isAlive() {
    return this.alive;
  }

  async close() {
    if (!this.alive || this.child.killed) return;
    try {
      await this.request("shutdown", null, 3000);
      this.notify("exit", null);
    } catch {
      // The process is force-closed below if graceful shutdown is unavailable.
    }
    this.kill();
  }

  kill() {
    this.alive = false;
    this.child.kill();
  }

  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function serverFor(file: string) {
  const extension = path.extname(file).toLowerCase();
  const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const bin = (name: string) => path.join(moduleRoot, "node_modules", ".bin", `${name}${process.platform === "win32" ? ".cmd" : ""}`);
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    return { command: bin("typescript-language-server"), languageId: extension.includes("x") ? (extension === ".tsx" ? "typescriptreact" : "javascriptreact") : extension.startsWith(".t") ? "typescript" : "javascript" };
  }
  if (extension === ".py") return { command: bin("pyright-langserver"), languageId: "python" };
  throw Error(`No LSP server configured for ${extension || "files without an extension"}`);
}

function normalizeResult(value: unknown, root: string, key = ""): unknown {
  if (typeof value === "string" && (key === "uri" || key === "targetUri") && value.startsWith("file:")) {
    return path.relative(root, fileURLToPath(value));
  }
  if (key === "severity" && typeof value === "number") {
    return ({ 1: "error", 2: "warning", 3: "information", 4: "hint" } as Record<number, string>)[value] ?? value;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeResult(item, root));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.line === "number" && typeof record.character === "number") {
    return { line: record.line + 1, character: record.character + 1 };
  }
  return Object.fromEntries(Object.entries(record).map(([name, item]) => [name, normalizeResult(item, root, name)]));
}

function hasDiagnostics(value: unknown) {
  return Array.isArray((value as { diagnostics?: unknown } | undefined)?.diagnostics)
    && ((value as { diagnostics: unknown[] }).diagnostics.length > 0);
}

function waitForDiagnostics(client: LspClient, uri: string, expectedVersion: number, signal?: AbortSignal, timeoutMs = 8000) {
  const sameDocument = (candidate: unknown) => {
    if (typeof candidate !== "string") return false;
    try {
      const expectedPath = path.normalize(fileURLToPath(uri));
      const candidatePath = path.normalize(fileURLToPath(candidate));
      return process.platform === "win32"
        ? expectedPath.toLowerCase() === candidatePath.toLowerCase()
        : expectedPath === candidatePath;
    } catch {
      return candidate === uri;
    }
  };
  return new Promise<unknown>((resolve, reject) => {
    let latest: unknown = { uri, diagnostics: [] };
    let settleTimer: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let finished = false;
    let unsubscribe = () => {};
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      if (deadline) clearTimeout(deadline);
      if (settleTimer) clearTimeout(settleTimer);
      signal?.removeEventListener("abort", abort);
      unsubscribe();
      if (error) reject(error);
      else resolve(latest);
    };
    const abort = () => finish(cancellationError());
    unsubscribe = client.onNotification("textDocument/publishDiagnostics", (params) => {
      const diagnosticParams = params as { uri?: unknown; version?: unknown } | undefined;
      if (!sameDocument(diagnosticParams?.uri)) return;
      if (typeof diagnosticParams?.version === "number" && diagnosticParams.version < expectedVersion) return;
      latest = params;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, 1_500);
    });
    deadline = setTimeout(finish, timeoutMs);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

type PoolEntry = {
  client: LspClient;
  initialized: Promise<unknown>;
  documentVersions: Map<string, number>;
  idleTimer?: NodeJS.Timeout;
};

const lspPool = new Map<string, PoolEntry>();
const LSP_IDLE_TIMEOUT_MS = 60_000;

function serverKey(root: string, command: string) {
  const normalizedRoot = path.resolve(root);
  return `${process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot}\0${command}`;
}

function initializeClient(client: LspClient, root: string) {
  const rootUri = pathToFileURL(root).href;
  return client.request("initialize", {
    processId: process.pid,
    rootUri,
    capabilities: {
      workspace: { configuration: true, workspaceFolders: true, symbol: {} },
      textDocument: { documentSymbol: {}, definition: {}, references: {}, hover: {}, publishDiagnostics: { relatedInformation: true } },
    },
    workspaceFolders: [{ uri: rootUri, name: path.basename(root) }],
  }).then((result) => {
    client.notify("initialized", {});
    return result;
  });
}

function touchPoolEntry(key: string, entry: PoolEntry) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (lspPool.get(key) !== entry) return;
    lspPool.delete(key);
    void entry.client.close();
  }, LSP_IDLE_TIMEOUT_MS);
  entry.idleTimer.unref();
}

function getPoolEntry(root: string, command: string) {
  const key = serverKey(root, command);
  let entry = lspPool.get(key);
  if (!entry?.client.isAlive()) {
    if (entry?.idleTimer) clearTimeout(entry.idleTimer);
    const client = new LspClient(command, root);
    entry = {
      client,
      initialized: initializeClient(client, root),
      documentVersions: new Map(),
    };
    lspPool.set(key, entry);
    void entry.initialized.catch(() => {
      if (lspPool.get(key) === entry) lspPool.delete(key);
      if (entry?.idleTimer) clearTimeout(entry.idleTimer);
      client.kill();
    });
  }
  touchPoolEntry(key, entry);
  return { key, entry };
}

export function activeLspServerCount(root?: string) {
  if (!root) return lspPool.size;
  const prefix = `${process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root)}\0`;
  return [...lspPool.keys()].filter((key) => key.startsWith(prefix)).length;
}

export async function closeLspServers(root?: string) {
  const prefix = root
    ? `${process.platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root)}\0`
    : undefined;
  const matches = [...lspPool.entries()].filter(([key]) => !prefix || key.startsWith(prefix));
  for (const [key, entry] of matches) {
    lspPool.delete(key);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
  }
  await Promise.allSettled(matches.map(([, entry]) => entry.client.close()));
}

export async function queryLsp(
  root: string,
  input: { operation: LspOperation; path: string; line?: number; character?: number; includeDeclaration?: boolean; query?: string },
  signal?: AbortSignal,
) {
  const target = resolveWorkspaceFile(root, input.path);
  const content = await readFile(target, "utf8");
  const server = serverFor(target);
  const { key, entry } = getPoolEntry(root, server.command);
  const client = entry.client;
  const unbindSignal = client.bindSignal(signal);
  const uri = pathToFileURL(target).href;
  try {
    signal?.throwIfAborted();
    await entry.initialized;
    const version = (entry.documentVersions.get(uri) ?? 0) + 1;
    entry.documentVersions.set(uri, version);
    const diagnosticsPromise = input.operation === "diagnostics"
      ? waitForDiagnostics(client, uri, version, signal)
      : undefined;
    if (version === 1) {
      client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: server.languageId, version, text: content },
      });
    } else {
      client.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    }

    const textDocument = { uri };
    const position = {
      line: Math.max(0, (input.line ?? 1) - 1),
      character: Math.max(0, (input.character ?? 1) - 1),
    };
    let result: unknown;
    if (input.operation === "diagnostics") {
      result = await diagnosticsPromise;
      if (version > 1 && !hasDiagnostics(result)) {
        const retryVersion = version + 1;
        entry.documentVersions.set(uri, retryVersion);
        const retry = waitForDiagnostics(client, uri, retryVersion, signal);
        client.notify("textDocument/didChange", {
          textDocument: { uri, version: retryVersion },
          contentChanges: [{ text: content }],
        });
        result = await retry;
      }
    } else if (input.operation === "workspaceSymbols") {
      result = await client.request("workspace/symbol", { query: input.query ?? "" });
    } else if (input.operation === "documentSymbols") {
      result = await client.request("textDocument/documentSymbol", { textDocument });
    } else if (input.operation === "definition") {
      result = await client.request("textDocument/definition", { textDocument, position });
    } else if (input.operation === "references") {
      result = await client.request("textDocument/references", {
        textDocument,
        position,
        context: { includeDeclaration: input.includeDeclaration ?? true },
      });
    } else {
      result = await client.request("textDocument/hover", { textDocument, position });
    }
    const rendered = JSON.stringify(normalizeResult(result, root), null, 2);
    return rendered.length > 30000 ? `${rendered.slice(0, 30000)}\n[truncated]` : rendered || "No result";
  } finally {
    unbindSignal();
    if (client.isAlive()) touchPoolEntry(key, entry);
    else {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      if (lspPool.get(key) === entry) lspPool.delete(key);
    }
  }
}
