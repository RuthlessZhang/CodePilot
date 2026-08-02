# Changelog

All notable changes to CodePilot are documented in this file.

## [Unreleased]

### Added

- Model-aware context profiles with explicit output and safety reserves, tool-schema accounting, named system-section reporting, and age-aware tool-result pruning.
- Layered project memory with a concise index, on-demand topic retrieval, legacy migration, and approved `memory_read`/`memory_write` tools.

### Changed

- The default working input cap is now 128K tokens where the selected model window allows it; explicit project budgets are clamped to the usable input window.
- OpenAI-compatible and Anthropic requests now use the configured maximum output-token limit.

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
