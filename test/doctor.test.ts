import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { assertSafeCredentialPolicy, loadConfig } from "../src/config.js";
import { diagnose, formatDoctorReport } from "../src/doctor.js";

test("doctor reports effective capabilities and credential source without exposing values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-doctor-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  const config = await loadConfig(root, {
    provider: "deepseek",
    apiKey: "super-secret-key",
    baseUrl: "https://user:password@example.invalid/v1?token=secret-query",
  });
  const report = await diagnose(root, config);
  const formatted = formatDoctorReport(report);

  assert.equal(report.provider, "deepseek");
  assert.equal(report.capabilities.reasoningToolContinuation, true);
  assert.equal(report.credentialSource, "override:runtime override");
  assert.doesNotMatch(JSON.stringify(report), /super-secret-key|password|secret-query|user@/);
  assert.doesNotMatch(formatted, /super-secret-key|password|secret-query|user@/);
  assert.match(formatted, /Credential: override:runtime override/);
});

test("doctor rejects plaintext project credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-doctor-key-"));
  await writeFile(path.join(root, ".codepilot.json"), JSON.stringify({ provider: "deepseek", apiKey: "project-secret" }));
  const previous = process.env.DEEPSEEK_API_KEY;
  try {
    delete process.env.DEEPSEEK_API_KEY;
    const config = await loadConfig(root);
    const report = await diagnose(root, config);
    assert.equal(report.status, "error");
    assert.equal(report.checks.find((check) => check.name === "credential")?.status, "fail");
    assert.doesNotMatch(JSON.stringify(report), /project-secret/);
    assert.throws(() => assertSafeCredentialPolicy(config), /Plaintext apiKey/);
  } finally {
    previous === undefined
      ? delete process.env.DEEPSEEK_API_KEY
      : (process.env.DEEPSEEK_API_KEY = previous);
  }
});

test("doctor remains available when the selected provider has no credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codepilot-doctor-missing-"));
  const previous = process.env.OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;
    const report = await diagnose(root, await loadConfig(root, { provider: "openai" }));
    assert.equal(report.status, "error");
    assert.equal(report.credentialSource, "missing");
    assert.match(formatDoctorReport(report), /No credential is available/);
  } finally {
    previous === undefined
      ? delete process.env.OPENAI_API_KEY
      : (process.env.OPENAI_API_KEY = previous);
  }
});
