# Changelog

All notable changes to CodePilot are documented in this file.

## [Unreleased]

## [0.3.0-rc.1] - 2026-08-03

### Added

- Release-candidate npm metadata, clean global-install verification, macOS CI coverage, and a tag-gated npm/GitHub release workflow with provenance.
- Credential-free top-level `--help`, `--version`, `init`, and `doctor` CLI entry points for first-run setup and diagnostics.
- Model-aware context profiles with explicit output and safety reserves, tool-schema accounting, named system-section reporting, and age-aware tool-result pruning.
- Layered project memory with a concise index, on-demand topic retrieval, legacy migration, and approved `memory_read`/`memory_write` tools.
- Credential-safe provider request recording and strict offline replay for deterministic real-model regression tests and failure injection.
- Headless metrics for model/tool duration, context compactions, verification attempts, and live/record/replay execution provenance.
- Streaming OpenAI-compatible, DeepSeek, and Anthropic responses with incremental tool-call assembly and deterministic event replay.
- Normalized provider token, cache, and reasoning usage in runtime events and headless run metrics.
- Run-level input, output, and total Provider token budgets with per-request output caps, estimated-usage markers, `/usage`, and structured headless failure details.
- Privacy-safe atomic run checkpoints, per-tool message durability, and side-effect-aware interrupted-session recovery without automatic tool replay.
- Opt-in live Provider smoke matrix covering text, streaming, normalized usage, forced tool calls, cancellation, and exact offline replay with redacted reports.
- Central Provider capability catalog plus credential-safe `--doctor` and `/doctor` diagnostics.
- Manually dispatched, concurrency-locked DeepSeek smoke workflow with protected environment secrets and short-lived redacted artifacts.
- User-level Provider credential lifecycle with hidden `auth set`, metadata-only `auth status`, `auth remove`, atomic local storage, and shell-free `apiKeyHelper` support.
- MCP client core with isolated stdio subprocesses, basic Streamable HTTP, session handling, environment-backed Bearer authentication, tool discovery, and ToolRegistry integration.
- Official MCP TypeScript SDK v2 integration with automatic modern/legacy protocol negotiation, Streamable HTTP event streams, reconnection, and live tool-list updates.

### Changed

- The release workflow now disables dependency caching and documents a one-time npm token bootstrap followed by token-free Trusted Publishing through GitHub Actions OIDC.
- Headless patch artifacts now diff against a run-start Git snapshot, isolating Agent changes from a user's pre-existing dirty worktree without mutating the real Git index.
- Tool-call exhaustion now rejects excess tools with a finalization nudge, allowing one best-effort synthesis turn while repeated over-budget calls still fail closed.
- Agent guidance now explicitly avoids redundant tool calls and requires synthesis once enough evidence is available.
- TypeScript diagnostics now reopen stale LSP documents and fall back to the project TypeScript compiler when an upstream server returns no semantic diagnostics.
- Windows command timeouts terminate the complete process tree, and the test runner uses deterministic cross-platform discovery and bounded concurrency.
- The default working input cap is now 128K tokens where the selected model window allows it; explicit project budgets are clamped to the usable input window.
- OpenAI-compatible and Anthropic requests now use the configured maximum output-token limit.
- Provider retries stop after the first streamed semantic event to prevent duplicated output.
- Provider requests can require automatic or named tool selection across OpenAI-compatible, DeepSeek, and Anthropic protocols.
- DeepSeek V4 reasoning content is preserved across tool continuations, while explicitly forced tool selection uses non-thinking mode for API compatibility.
- Plaintext Provider API keys in `.codepilot.json` are rejected during normal execution.
- Provider calls and DeepSeek context compaction now share one credential precedence chain: runtime override, environment, user helper, then user store.
- MCP tools share the normal execution permission, cancellation, audit, lifecycle, and context-budget paths; executable server definitions are restricted to user-level configuration.
- MCP tool-list changes now replace each server's live registry entries atomically; invalid, oversized, or colliding updates preserve the last valid tool set.

## [0.2.0] - 2026-08-02

### Added

- Auditable multi-step coding agent with OpenAI-compatible, DeepSeek, and Anthropic providers.
- Transactional file editing, optimistic concurrency checks, rollback, and undo.
- TypeScript, JavaScript, and Python language intelligence through LSP, code graphs, and impact analysis.
- Automatic targeted verification, repair loops, headless execution, runtime budgets, and patch artifacts.
- Tool permission policies, protected-path hooks, redacted runtime audit logs, and deterministic tool registration.
- Per-session persistence and isolated compaction summaries.
- Streaming Shell execution with configurable timeout and output limits.

### Changed

- Windows Shell cancellation now terminates the active process promptly before falling back to `taskkill`.
- Resuming the latest session preserves its original session identity.
