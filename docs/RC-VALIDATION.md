# v0.3.0-rc.1 Validation Record

Validated on 2026-08-03. This record contains no credentials, prompts, response text, or Provider endpoints.

## Automated release gates

- Local `npm run release:check`: passed after release hardening with 135 tests, a clean build, and an isolated global installation.
- GitHub CI #26: passed all six Linux, Windows, and macOS jobs on Node.js 20 and 24 for scoped-package commit `f6e66e7`.
- npm dry-run package: `@ruthlessz/codepilot@0.3.0-rc.1`, 145 files, approximately 162 KB compressed.
- Clean isolated global installation: passed on Windows; the CI matrix repeats it on Node.js 24 for every supported operating system.
- GitHub Release #3: published `v0.3.0-rc.1` successfully from commit `13f0783` and created the matching prerelease and tarball asset.
- Public registry verification: `@ruthlessz/codepilot@next` resolved to `0.3.0-rc.1`; a fresh isolated global install passed both `codepilot --version` and `codepilot --help`.

## Live DeepSeek contract smoke

The standard 128-output-token smoke matrix passed against `deepseek-v4-pro`:

- text completion and normalized usage;
- streamed completion plus exact offline replay;
- required tool call with streamed arguments;
- cancellation with an observed `AbortError`.

The redacted local report is intentionally ignored by Git under `.codepilot/runs/provider-smoke-v0.3.0-rc.1.json`.

## Real-project trials

### CodePilot self-audit

- Mode: headless PLAN, live DeepSeek, read-only tools.
- Result: completed with no source edits.
- Finding: a constrained four-file assessment could consume the complete configured tool-call budget through broad and repeated reads.
- Action: added explicit tool-convergence guidance and a deterministic final synthesis opportunity when the tool budget is exhausted.

### WikiTok frontend

- Workspace: an existing React/Vite frontend with pre-existing tracked and untracked user changes.
- Mode: headless PLAN, live DeepSeek, no Shell permission.
- Result: completed under an eight-tool-call limit with a concrete localization consistency assessment.
- Safety result: the run artifact contained a zero-byte patch and the existing user changes were preserved.
- Action: headless patch capture now compares temporary Git trees created at run start and completion, excluding `.codepilot/**` and leaving the real index untouched.

### CodePilot CLI safety fix

- Workspace: an isolated Git worktree on `trial/build-mode-invalid-mode` with write access, protected release/configuration paths, and a narrow Shell allowlist.
- Mode: headless BUILD, live DeepSeek, persistent user-store credential, automatic verification enabled.
- Task result: the agent produced the core invalid-`--mode` check and regression tests, but did not complete autonomously. Three resumable runs consumed 50 model steps and 55 tool calls before step or input-token budgets stopped them.
- Safety result: denied Shell commands failed closed, the main worktree remained untouched, protected files were not modified by the agent, and every incomplete run emitted a structured result plus patch artifact.
- Review result: independent review caught an invalid `const` change and the uncovered bare `--mode` case. The final reviewed patch rejects invalid and missing values while preserving omitted, `plan`, and `build` behavior.
- Verification: focused CLI tests passed 10/10, the isolated full suite passed 139/139, TypeScript typecheck passed, the production build passed, and `git diff --check` passed.
- Findings: tool use did not converge quickly; permission-denied Shell variants were retried instead of switching to an allowed command; targeted verification invoked the full test runner and exceeded its 120-second timeout; tests that expect no credential were affected by the new persistent user credential until the test config directory was isolated.
- Release decision: this is a successful safety and recovery exercise, but not yet a successful autonomous Build-mode gate. Address the convergence, verification targeting/timeout, and test credential-isolation findings before stable promotion.

### Build-loop P0 follow-up

- Targeted tests: `scripts/run-tests.mjs` now validates and honors explicit test-file arguments instead of always discovering the full suite.
- Credential isolation: every standard test run receives a temporary user configuration directory and no inherited OpenAI, DeepSeek, or Anthropic API-key variables; the directory is removed after the child process closes.
- Verification timeout: automatic checks use the independent `verificationTimeoutMs` setting and `--verification-timeout-ms <ms>` override, with a five-minute default per command.
- Convergence: permission denials now prohibit wrapper/equivalent retries; a tool is removed from the model-visible set after its second denial, while trusted automatic verification retains access. Long read-only exploration receives a bounded convergence notice.
- Verification: focused P0 tests passed 63/63 and the standard credential-isolated suite passed 145/145 without a live Provider request.
- Release gate: `npm run release:check` passed typecheck, 145 tests, production build, and isolated global package installation in 164 seconds.
- Release decision: the known P0 findings from the first Build trial are implemented and locally verified. The autonomous Build-mode gate remains open until a new live trial completes without manual repair.

### Autonomous Build-mode gate

- Task: validate `autoVerify` and bound `maxVerificationAttempts` in project configuration, with focused regression tests.
- Comparison run: the first post-P0 attempt followed the exact Shell allowlist and ran genuinely targeted tests, but exhausted 24 model steps immediately after additional manual tests; automatic verification did not start.
- Kernel correction: CodePilot now reserves the final model step for tool-free completion, moves the read-only convergence notice earlier, and hands a successful manual check directly to automatic verification.
- Fresh run result: `completed` with exit code 0, one automatic-verification attempt, and `verificationStatus: passed`; no manual code repair or resume prompt was used.
- Metrics: 24 model steps, 29 tool calls, 263,261 input tokens, 4,726 output tokens, and 267 seconds total runtime.
- Automatic checks: both changed files passed LSP diagnostics, the focused runtime-config test passed, and `npm run typecheck`, `npm run test`, and `npm run build` all passed.
- Integrated release gate: after merging the kernel and generated patch, `npm run release:check` passed typecheck, 149 tests, production build, and isolated global installation in 168 seconds.
- Finalization compatibility: a raw DeepSeek DSML tool-intent string observed when tools were intentionally hidden is now prohibited by the finalization prompt and normalized to safe natural-language output as a narrow fallback.
- Release decision: the reviewed autonomous Build-mode gate is passed. A non-trivial remote MCP trial remains required before stable promotion.

### Remote MCP gate

- CI baseline: the six post-Build hardening commits were pushed through commit `c8be8a3`; the `ci.yml` workflow and the `main` branch checks both reported passing.
- Workspace: a disposable initialized Git repository with no project source code or inherited MCP permissions.
- Transport: public HTTPS Streamable HTTP with no authentication; CodePilot negotiated legacy MCP `2025-11-25` compatibility and discovered three tools.
- First finding: the version-negotiation probe was capped at one second even when the configured MCP request timeout was longer, causing a valid remote endpoint to fail before normal request timing applied.
- Correction: the negotiation probe now uses the configured request timeout capped at ten seconds. A delayed modern-protocol regression test proves that first-request latency above one second is accepted without removing the upper bound.
- Direct runtime result: the remote documentation-structure tool returned 3,495 characters for the official MCP TypeScript SDK repository.
- Agent result: live `deepseek-v4-pro` selected the exact permitted remote tool once and completed with exit code 0 in 8.3 seconds; two model steps, one tool call, 6,983 total tokens, no local tools, no source edits, and a zero-byte patch artifact.
- Integrated release gate: `npm run release:check` passed typecheck, 150 tests, production build, and isolated global installation in 172 seconds.
- Release decision: the non-trivial remote MCP discovery, invocation, permission, Provider-selection, and headless-artifact path is passed.

## Remaining external gates

- npm Trusted Publishing is deferred until the maintainer can complete npm's passkey authentication from a local, non-remote session. The validated bootstrap-token release path remains active and does not block RC testing.
- After Trusted Publishing is configured for `@ruthlessz/codepilot`, `RuthlessZhang/CodePilot`, and `release.yml`, verify one token-free prerelease before deleting and revoking the bootstrap token.
- Publish and install `v0.3.0-rc.2` from a clean tagged commit, then repeat the public-package smoke and one external real-project trial before promoting a stable `v0.3.0`.
