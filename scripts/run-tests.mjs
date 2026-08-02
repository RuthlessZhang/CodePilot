import { readdir } from "node:fs/promises";
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

const files = await testFiles(testRoot);
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

const child = spawn(process.execPath, [...arguments_, ...files], {
  cwd: repositoryRoot,
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) console.error(`Test runner terminated by ${signal}`);
  process.exitCode = code ?? 1;
});
