import { stdin, stdout } from "node:process";
import type { ProviderName } from "./model-context.js";
import { credentialStatuses, removeStoredCredential, setStoredCredential } from "./credentials.js";
import { providerDefinition, providerNames } from "./provider-catalog.js";

function providerName(value: string | undefined): ProviderName {
  if (value && providerNames.includes(value as ProviderName)) return value as ProviderName;
  throw Error(`Provider must be one of: ${providerNames.join(", ")}`);
}

function normalizeSecret(value: string) {
  const normalized = value.trim();
  if (/\r|\n/.test(normalized)) throw Error("API key input must contain exactly one line");
  return normalized;
}

function readPipedSecret(input: NodeJS.ReadStream) {
  return new Promise<string>((resolve, reject) => {
    let value = "";
    input.setEncoding("utf8");
    input.on("data", (chunk) => { value += chunk; });
    input.once("end", () => {
      try {
        resolve(normalizeSecret(value));
      } catch (error) {
        reject(error);
      }
    });
    input.once("error", reject);
    input.resume();
  });
}

function readInteractiveSecret(input: NodeJS.ReadStream, output: NodeJS.WriteStream, prompt: string) {
  return new Promise<string>((resolve, reject) => {
    let value = "";
    let settled = false;
    const wasRaw = input.isRaw;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write("\n");
      if (error) reject(error);
      else resolve(normalizeSecret(value));
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (settled) return;
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0003") {
          const error = new Error("Credential input cancelled");
          error.name = "AbortError";
          finish(error);
          return;
        }
        if (character === "\b" || character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    output.write(prompt);
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.on("data", onData);
    input.resume();
  });
}

export async function readSecret(
  input: NodeJS.ReadStream = stdin,
  output: NodeJS.WriteStream = stdout,
  prompt = "API key: ",
) {
  return input.isTTY
    ? await readInteractiveSecret(input, output, prompt)
    : await readPipedSecret(input);
}

function authHelp() {
  return `Usage:
  codepilot auth set <provider>      Store a user-level API key (input is hidden)
  codepilot auth status [provider]   Show credential sources without values
  codepilot auth remove <provider>   Remove the stored user-level API key

Providers: ${providerNames.join(", ")}`;
}

export async function runAuthCommand(args: string[]) {
  const action = args[0];
  if (!action || action === "help" || action === "--help" || action === "-h") {
    console.log(authHelp());
    return;
  }
  if (action === "set") {
    if (args.length !== 2) throw Error("Usage: codepilot auth set <provider>");
    const provider = providerName(args[1]);
    const apiKey = await readSecret(stdin, stdout, `Enter ${provider} API key: `);
    if (!apiKey) throw Error("API key cannot be empty");
    await setStoredCredential(provider, apiKey);
    console.log(`Stored ${provider} credential in the user-level CodePilot credential store.`);
    if (process.env[providerDefinition(provider).apiKeyEnv]?.trim()) {
      console.log(`${providerDefinition(provider).apiKeyEnv} is currently set and takes precedence over the stored credential.`);
    }
    return;
  }
  if (action === "remove") {
    if (args.length !== 2) throw Error("Usage: codepilot auth remove <provider>");
    const provider = providerName(args[1]);
    const removed = await removeStoredCredential(provider);
    console.log(removed ? `Removed stored ${provider} credential.` : `No stored ${provider} credential was present.`);
    return;
  }
  if (action === "status") {
    if (args.length > 2) throw Error("Usage: codepilot auth status [provider]");
    const selected = args[1] ? providerName(args[1]) : undefined;
    const statuses = await credentialStatuses(undefined, process.env, selected ? [selected] : providerNames);
    console.log(statuses
      .map(({ provider, resolution }) => {
        if (resolution.source) return `${provider}: configured (${resolution.source.kind}:${resolution.source.name})`;
        if (resolution.error) return `${provider}: unavailable (${resolution.error})`;
        return `${provider}: not configured`;
      })
      .join("\n"));
    return;
  }
  throw Error(`Unknown auth command: ${action}\n${authHelp()}`);
}
