import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AnyRuntimeEvent } from "./runtime-events.js";

const payloadKey = /^(?:command|content|new_text|old_text|patch|prompt|query)$/i;

function isSecretKey(key: string) {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return [
    "authorization",
    "cookie",
    "credential",
    "credentials",
    "password",
    "token",
    "accesstoken",
    "refreshtoken",
    "authtoken",
  ].includes(normalized) || normalized.endsWith("apikey") || normalized.endsWith("secret");
}

function fingerprint(value: string) {
  return {
    redacted: true,
    length: value.length,
    sha256: createHash("sha256").update(value).digest("hex"),
  };
}

function sanitize(value: unknown, key = "", depth = 0): unknown {
  if (isSecretKey(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (payloadKey.test(key) || value.length > 2_000) return fingerprint(value);
    return value;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value === undefined) return undefined;
  if (depth >= 8) return "[MAX_DEPTH]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, key, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([childKey, child]) => [childKey, sanitize(child, childKey, depth + 1)]),
    );
  }
  return String(value);
}

export function toAuditRecord(event: AnyRuntimeEvent) {
  return sanitize(event) as Record<string, unknown>;
}

export class JsonlRuntimeAudit {
  readonly file: string;

  constructor(root: string, relativePath = ".codepilot/audit/runtime.jsonl") {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, relativePath);
    if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
      throw Error("Runtime audit path escapes workspace");
    }
    this.file = resolved;
  }

  async record(event: AnyRuntimeEvent) {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(toAuditRecord(event))}\n`, "utf8");
  }
}
