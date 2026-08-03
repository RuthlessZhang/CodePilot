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

## Remaining external gates

- After the first publication, configure npm Trusted Publishing for `@ruthlessz/codepilot`, `RuthlessZhang/CodePilot`, and `release.yml`, then delete the bootstrap token.
- Before promotion to stable, run at least one build-mode trial and one non-trivial remote MCP trial in trusted test workspaces.
