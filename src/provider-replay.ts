import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Provider, ProviderCompletion, ProviderCompletionInput, ProviderStreamEvent } from "./types.js";

export type ProviderExecutionMode = "live" | "record" | "replay";

type RequestFingerprint = {
  sha256: string;
  systemSha256: string;
  messagesSha256: string;
  toolsSha256: string;
  messageCount: number;
  toolCount: number;
};

type RecordedOutcome =
  | { kind: "success"; response: ProviderCompletion }
  | { kind: "error"; error: { name: string; message: string } };

export type ProviderInteractionRecord = {
  version: 1;
  sequence: number;
  recordedAt: string;
  durationMs: number;
  request: RequestFingerprint;
  events?: ProviderStreamEvent[];
  outcome: RecordedOutcome;
};

export class ProviderReplayMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderReplayMismatchError";
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function sha256(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function fingerprintProviderInput(input: ProviderCompletionInput): RequestFingerprint {
  const request = { system: input.system, messages: input.messages, tools: input.tools };
  return {
    sha256: sha256(request),
    systemSha256: sha256(input.system),
    messagesSha256: sha256(input.messages),
    toolsSha256: sha256(input.tools),
    messageCount: input.messages.length,
    toolCount: input.tools.length,
  };
}

export function resolveProviderTracePath(root: string, value: string) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, value);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw Error("Provider trace path escapes workspace");
  }
  return resolved;
}

function asError(value: unknown) {
  return value instanceof Error ? value : new Error(String(value));
}

function parseRecords(content: string) {
  const records: ProviderInteractionRecord[] = [];
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ProviderInteractionRecord;
      if (
        parsed.version !== 1
        || !Number.isInteger(parsed.sequence)
        || parsed.sequence < 1
        || !parsed.request?.sha256
        || !["success", "error"].includes(parsed.outcome?.kind)
      ) throw Error("unsupported record");
      records.push(parsed);
    } catch (error) {
      throw Error(`Invalid provider replay record at line ${index + 1}: ${asError(error).message}`);
    }
  }
  return records;
}

async function recordsFromFile(file: string) {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Error(`Provider replay file not found: ${file}`);
    throw error;
  }
  const records = parseRecords(content);
  if (!records.length) throw Error(`Provider replay file has no records: ${file}`);
  return records;
}

async function lastRecordedSequence(file: string) {
  try {
    const records = parseRecords(await readFile(file, "utf8"));
    return records.reduce((maximum, record) => Math.max(maximum, record.sequence), 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export class RecordingProvider implements Provider {
  readonly file: string;
  private writeQueue = Promise.resolve();
  private sequence: Promise<number>;

  constructor(root: string, tracePath: string, private delegate: Provider) {
    this.file = resolveProviderTracePath(root, tracePath);
    this.sequence = lastRecordedSequence(this.file);
  }

  async complete(input: ProviderCompletionInput) {
    input.signal?.throwIfAborted();
    const sequence = await (this.sequence = this.sequence.then((value) => value + 1));
    const started = Date.now();
    const events: ProviderStreamEvent[] = [];
    let outcome: RecordedOutcome;
    try {
      const response = await this.delegate.complete({
        ...input,
        ...(input.onEvent ? {
          onEvent: (event: ProviderStreamEvent) => {
            events.push(event);
            input.onEvent?.(event);
          },
        } : {}),
      });
      outcome = { kind: "success", response };
    } catch (error) {
      const failure = asError(error);
      outcome = { kind: "error", error: { name: failure.name, message: failure.message } };
    }
    const record: ProviderInteractionRecord = {
      version: 1,
      sequence,
      recordedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      request: fingerprintProviderInput(input),
      ...(events.length ? { events } : {}),
      outcome,
    };
    await this.append(record);
    if (outcome.kind === "error") {
      const error = new Error(outcome.error.message);
      error.name = outcome.error.name;
      throw error;
    }
    return outcome.response;
  }

  private async append(record: ProviderInteractionRecord) {
    const operation = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await appendFile(this.file, `${JSON.stringify(record)}\n`, "utf8");
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }
}

export class ReplayProvider implements Provider {
  readonly file: string;
  private cursor = 0;
  private records?: Promise<ProviderInteractionRecord[]>;

  constructor(root: string, tracePath: string) {
    this.file = resolveProviderTracePath(root, tracePath);
  }

  async complete(input: ProviderCompletionInput) {
    input.signal?.throwIfAborted();
    const records = await (this.records ??= recordsFromFile(this.file));
    const record = records[this.cursor];
    if (!record) {
      throw new ProviderReplayMismatchError(`Provider replay exhausted after ${this.cursor} interaction(s)`);
    }
    const actual = fingerprintProviderInput(input);
    if (actual.sha256 !== record.request.sha256) {
      throw new ProviderReplayMismatchError(
        `Provider replay mismatch at interaction ${this.cursor + 1}: expected ${record.request.sha256}, received ${actual.sha256}`,
      );
    }
    for (const event of record.events ?? []) input.onEvent?.(structuredClone(event));
    this.cursor++;
    if (record.outcome.kind === "error") {
      const error = new Error(record.outcome.error.message);
      error.name = record.outcome.error.name;
      throw error;
    }
    return structuredClone(record.outcome.response);
  }

  getProgress() {
    return { consumed: this.cursor };
  }
}
