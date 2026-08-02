import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { buildProjectIndex } from "./project.js";
import { resolveProviderCapabilities, type ProviderCapabilities } from "./provider-catalog.js";

export type DoctorCheck = {
  name: string;
  status: "pass" | "warning" | "fail";
  detail: string;
};

export type DoctorReport = {
  version: 1;
  status: "healthy" | "warning" | "error";
  workspace: string;
  provider: string;
  model: string;
  endpoint: string;
  credentialSource: string;
  capabilities: ProviderCapabilities;
  checks: DoctorCheck[];
};

function run(file: string, args: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(file, args, { cwd, timeout: 10_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

function safeEndpoint(value: string) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "[invalid endpoint]";
  }
}

async function localBinary(root: string, name: string) {
  const suffixes = process.platform === "win32" ? [".cmd", ".exe", ""] : [""];
  for (const suffix of suffixes) {
    const target = path.join(root, "node_modules", ".bin", `${name}${suffix}`);
    try {
      await access(target);
      return target;
    } catch {
      // Check the next platform-specific executable suffix.
    }
  }
  return undefined;
}

export async function diagnose(root: string, config: Config): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const credentialSource = config.providerReplayPath
    ? "provider replay (credential not required)"
    : config.credentialSource
      ? `${config.credentialSource.kind}:${config.credentialSource.name}`
      : "missing";

  if (config.providerReplayPath) {
    checks.push({ name: "credential", status: "pass", detail: credentialSource });
  } else if (!config.apiKey) {
    checks.push({ name: "credential", status: "fail", detail: "No credential is available for the selected provider." });
  } else if (config.projectApiKeyPresent) {
    checks.push({
      name: "credential",
      status: "fail",
      detail: "A plaintext apiKey was loaded from .codepilot.json. Move it to the provider environment variable.",
    });
  } else {
    checks.push({ name: "credential", status: "pass", detail: `${credentialSource} (value hidden)` });
  }
  if (config.projectApiKeyPresent && config.credentialSource?.kind !== "project_config") {
    checks.push({
      name: "project credential",
      status: "fail",
      detail: "Remove the plaintext apiKey from .codepilot.json even though a safer credential source currently takes precedence.",
    });
  }

  try {
    const endpoint = new URL(config.baseUrl);
    const local = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "::1";
    checks.push({
      name: "endpoint",
      status: endpoint.protocol === "https:" || local ? "pass" : "warning",
      detail: safeEndpoint(config.baseUrl),
    });
  } catch {
    checks.push({ name: "endpoint", status: "fail", detail: "Provider base URL is invalid." });
  }

  checks.push({ name: "node", status: "pass", detail: `${process.version} (${process.execPath})` });

  try {
    const result = await run("git", ["rev-parse", "--show-toplevel"], root);
    checks.push({ name: "git", status: "pass", detail: result.stdout.trim() });
  } catch {
    checks.push({ name: "git", status: "warning", detail: "Workspace is not inside a usable Git repository." });
  }

  for (const binary of ["typescript-language-server", "pyright-langserver"] as const) {
    const target = await localBinary(root, binary);
    checks.push({
      name: binary,
      status: target ? "pass" : "warning",
      detail: target ?? `Not found under ${path.join(root, "node_modules", ".bin")}`,
    });
  }

  try {
    const index = await buildProjectIndex(root);
    checks.push({
      name: "verification",
      status: index.checkCommands.length ? "pass" : "warning",
      detail: index.checkCommands.join(", ") || "No project verification commands detected.",
    });
  } catch (error) {
    checks.push({ name: "verification", status: "warning", detail: `Could not inspect project checks: ${(error as Error).name}` });
  }

  checks.push({
    name: "context",
    status: "pass",
    detail: `window=${config.contextWindowTokens}, input=${config.contextBudgetTokens}, output=${config.maxOutputTokens}, safety=${config.contextSafetyMarginTokens}`,
  });

  const status = checks.some((check) => check.status === "fail")
    ? "error"
    : checks.some((check) => check.status === "warning")
      ? "warning"
      : "healthy";
  return {
    version: 1,
    status,
    workspace: root,
    provider: config.provider,
    model: config.model,
    endpoint: safeEndpoint(config.baseUrl),
    credentialSource,
    capabilities: resolveProviderCapabilities(config.provider, config.model),
    checks,
  };
}

export function formatDoctorReport(report: DoctorReport) {
  const checkLines = report.checks.map((check) =>
    `[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`,
  );
  return [
    `CodePilot doctor: ${report.status}`,
    `Workspace: ${report.workspace}`,
    `Provider: ${report.provider}/${report.model}`,
    `Endpoint: ${report.endpoint}`,
    `Credential: ${report.credentialSource}`,
    `Capabilities: ${JSON.stringify(report.capabilities)}`,
    "",
    ...checkLines,
  ].join("\n");
}
