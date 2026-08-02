import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProviderName } from "./model-context.js";
import { providerDefinition, providerNames } from "./provider-catalog.js";

export type CredentialSource = {
  kind: "override" | "environment" | "helper" | "user_store" | "project_config";
  name: string;
};

export type CredentialResolution = {
  apiKey?: string;
  source?: CredentialSource;
  error?: CredentialError;
};

export type CredentialError = "helper_failed" | "helper_empty" | "store_invalid";

type StoredCredential = { apiKey: string; updatedAt: string };
type CredentialStore = { version: 1; providers: Partial<Record<ProviderName, StoredCredential>> };
type UserCredentialConfig = { apiKeyHelpers?: Partial<Record<ProviderName, string[]>> };

export function credentialConfigDirectory(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.CODEPILOT_CONFIG_DIR?.trim();
  return path.resolve(configured || path.join(os.homedir(), ".codepilot"));
}

export function credentialStorePath(directory = credentialConfigDirectory()) {
  return path.join(directory, "credentials.json");
}

export function userConfigPath(directory = credentialConfigDirectory()) {
  return path.join(directory, "config.json");
}

function isProviderName(value: string): value is ProviderName {
  return providerNames.includes(value as ProviderName);
}

function parseStore(value: unknown): CredentialStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid credential store");
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || !root.providers || typeof root.providers !== "object" || Array.isArray(root.providers)) {
    throw Error("Invalid credential store");
  }
  const providers: CredentialStore["providers"] = {};
  for (const [name, raw] of Object.entries(root.providers as Record<string, unknown>)) {
    if (!isProviderName(name)) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Invalid credential store");
    const record = raw as Record<string, unknown>;
    if (typeof record.apiKey !== "string" || !record.apiKey.trim() || typeof record.updatedAt !== "string" || !record.updatedAt) {
      throw Error("Invalid credential store");
    }
    providers[name] = { apiKey: record.apiKey.trim(), updatedAt: record.updatedAt };
  }
  return { version: 1, providers };
}

async function readStore(directory = credentialConfigDirectory()): Promise<CredentialStore> {
  try {
    return parseStore(JSON.parse(await readFile(credentialStorePath(directory), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, providers: {} };
    throw error;
  }
}

async function atomicWriteStore(directory: string, store: CredentialStore) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);
  const target = credentialStorePath(directory);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
    if (process.platform !== "win32") await chmod(target, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function setStoredCredential(provider: ProviderName, apiKey: string, directory = credentialConfigDirectory()) {
  const normalized = apiKey.trim();
  if (!normalized) throw Error("API key cannot be empty");
  if (/\r|\n/.test(normalized)) throw Error("API key must contain exactly one line");
  const store = await readStore(directory);
  store.providers[provider] = { apiKey: normalized, updatedAt: new Date().toISOString() };
  await atomicWriteStore(directory, store);
}

export async function removeStoredCredential(provider: ProviderName, directory = credentialConfigDirectory()) {
  const store = await readStore(directory);
  const existed = Boolean(store.providers[provider]);
  delete store.providers[provider];
  await atomicWriteStore(directory, store);
  return existed;
}

async function storedCredential(provider: ProviderName, directory: string) {
  const store = await readStore(directory);
  return store.providers[provider];
}

function parseHelpers(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid user configuration");
  const raw = (value as UserCredentialConfig).apiKeyHelpers;
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Invalid apiKeyHelpers configuration");
  const helpers: Partial<Record<ProviderName, string[]>> = {};
  for (const [name, command] of Object.entries(raw)) {
    if (!isProviderName(name)
      || !Array.isArray(command)
      || command.length === 0
      || !command.every((part) => typeof part === "string" && part.trim().length > 0)) {
      throw Error("Invalid apiKeyHelpers configuration");
    }
    helpers[name] = command;
  }
  return helpers;
}

async function readHelpers(directory: string) {
  try {
    return parseHelpers(JSON.parse(await readFile(userConfigPath(directory), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function executeHelper(command: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    execFile(command[0]!, command.slice(1), {
      cwd,
      env,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(error);
      else {
        const value = stdout.trim();
        if (/\r|\n/.test(value)) reject(Error("apiKeyHelper must return exactly one line"));
        else resolve(value);
      }
    });
  });
}

export async function resolveProviderCredential(input: {
  provider: ProviderName;
  override?: string;
  projectApiKey?: string;
  env?: NodeJS.ProcessEnv;
  directory?: string;
}): Promise<CredentialResolution> {
  const env = input.env ?? process.env;
  const directory = input.directory ?? credentialConfigDirectory(env);
  const override = input.override?.trim();
  if (override) return { apiKey: override, source: { kind: "override", name: "runtime override" } };

  const definition = providerDefinition(input.provider);
  const environmentValue = env[definition.apiKeyEnv]?.trim();
  if (environmentValue) {
    return { apiKey: environmentValue, source: { kind: "environment", name: definition.apiKeyEnv } };
  }

  try {
    const helper = (await readHelpers(directory))[input.provider];
    if (helper) {
      try {
        const apiKey = await executeHelper(helper, directory, env);
        if (!apiKey) return { error: "helper_empty" };
        return { apiKey, source: { kind: "helper", name: `${userConfigPath(directory)}:apiKeyHelpers.${input.provider}` } };
      } catch {
        return { error: "helper_failed" };
      }
    }
  } catch {
    return { error: "helper_failed" };
  }

  try {
    const stored = await storedCredential(input.provider, directory);
    if (stored) return { apiKey: stored.apiKey, source: { kind: "user_store", name: credentialStorePath(directory) } };
  } catch {
    return { error: "store_invalid" };
  }

  const projectApiKey = input.projectApiKey?.trim();
  return projectApiKey
    ? { apiKey: projectApiKey, source: { kind: "project_config", name: ".codepilot.json:apiKey" } }
    : {};
}

export async function credentialStatuses(
  directory = credentialConfigDirectory(),
  env: NodeJS.ProcessEnv = process.env,
  providers: readonly ProviderName[] = providerNames,
) {
  return await Promise.all(providers.map(async (provider) => {
    const resolution = await resolveProviderCredential({ provider, directory, env });
    return {
      provider,
      resolution: {
        ...(resolution.source ? { source: resolution.source } : {}),
        ...(resolution.error ? { error: resolution.error } : {}),
      },
    };
  }));
}
