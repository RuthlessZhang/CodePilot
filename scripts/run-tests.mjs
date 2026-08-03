import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = path.join(repositoryRoot, "test");

async function testFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await testFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(absolute);
  }
  return files;
}

async function selectedTestFiles(requested) {
  if (!requested.length) return await testFiles(testRoot);

  const files = [];
  for (const value of requested) {
    const absolute = path.resolve(repositoryRoot, value);
    const relative = path.relative(testRoot, absolute);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw Error(`Requested test must be under ${testRoot}: ${value}`);
    }
    const details = await stat(absolute).catch(() => undefined);
    if (!details?.isFile() || !absolute.endsWith(".test.ts")) {
      throw Error(`Requested test is not an existing .test.ts file: ${value}`);
    }
    files.push(absolute);
  }
  return [...new Set(files)];
}

const requested = process.argv.slice(2).filter((value) => value !== "--");
const files = await selectedTestFiles(requested);
if (!files.length) throw Error("No test files found");

const arguments_ = ["--test", "--test-concurrency=1", "--import", "tsx"];
if (process.env.GITHUB_ACTIONS === "true") {
  arguments_.push(
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=./scripts/github-actions-test-reporter.mjs",
    "--test-reporter-destination=stdout",
  );
}

const credentialDirectory = await mkdtemp(path.join(os.tmpdir(), "codepilot-test-config-"));
const env = { ...process.env, CODEPILOT_CONFIG_DIR: credentialDirectory };
delete env.OPENAI_API_KEY;
delete env.DEEPSEEK_API_KEY;
delete env.ANTHROPIC_API_KEY;

const child = spawn(process.execPath, [...arguments_, ...files], {
  cwd: repositoryRoot,
  env,
  stdio: "inherit",
  windowsHide: true,
});

let settled = false;
async function finish(code, signal, error) {
  if (settled) return;
  settled = true;
  await rm(credentialDirectory, { recursive: true, force: true });
  if (error) console.error(error);
  if (signal) console.error(`Test runner terminated by ${signal}`);
  process.exitCode = code ?? 1;
}

child.once("error", (error) => void finish(1, undefined, error));
child.once("close", (code, signal) => void finish(code, signal));
