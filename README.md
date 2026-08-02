# CodePilot

CodePilot is a small, auditable terminal coding agent written in TypeScript. It supports OpenAI-compatible APIs, Anthropic, and DeepSeek, with tool calling, workspace file operations, shell execution, approval gates, project instructions, project memory, session restore, plan/build modes, git inspection, diff previews, and undo snapshots.

## Quick Start

```powershell
npm install
npm run build
$env:DEEPSEEK_API_KEY="..."
npm run dev -- --provider deepseek
```

One-shot task:

```powershell
npm run dev -- --provider deepseek "Analyze this project structure"
```

Use CodePilot on another project:

```powershell
cd D:\your-project
node C:\Users\18355\Documents\Codex\CodePilot\dist\cli.js --provider deepseek
```

Or specify the workspace explicitly from any directory. CodePilot refuses filesystem roots and Windows system directories as workspaces:

```powershell
node C:\Users\18355\Documents\Codex\CodePilot\dist\cli.js --provider deepseek --cwd C:\Users\18355\codepilot-wikitok-test\frontend
```

Resume the latest session in a workspace with `--resume` (or `--continue`), or choose an exact ID shown by `/sessions`:

```powershell
node C:\Users\18355\Documents\Codex\CodePilot\dist\cli.js --provider deepseek --cwd C:\Users\18355\codepilot-wikitok-test\frontend --resume
node C:\Users\18355\Documents\Codex\CodePilot\dist\cli.js --provider deepseek --cwd C:\Users\18355\codepilot-wikitok-test\frontend --session 01234567-89ab-cdef-0123-456789abcdef
```

## Providers

OpenAI:

```powershell
$env:OPENAI_API_KEY="..."
npm run dev -- --provider openai
```

DeepSeek:

```powershell
$env:DEEPSEEK_API_KEY="..."
npm run dev -- --provider deepseek
npm run dev -- --provider deepseek --model deepseek-v4-flash
```

Anthropic:

```powershell
$env:ANTHROPIC_API_KEY="..."
npm run dev -- --provider anthropic
```

CodePilot also reads `.codepilot.json` for `provider`, `model`, `baseUrl`, runtime limits, context and memory budgets, verification, provider retry, Shell limits, permissions, runtime auditing, and protected paths. Keep API keys in environment variables. The context-specific settings are documented under [Context Window Management](#context-window-management).

Provider requests retry transient network failures, timeouts, malformed protocol responses, HTTP 408/425/429, and selected 5xx responses with bounded exponential backoff. `Retry-After` is honored up to 30 seconds. Client errors such as HTTP 400 are not retried, and `Ctrl+C` cancels both an active request and a pending retry delay. Defaults can be adjusted per project:

```json
{
  "providerMaxRetries": 2,
  "providerRequestTimeoutMs": 120000
}
```

Interactive OpenAI-compatible, DeepSeek, and Anthropic requests stream text to the terminal while incrementally assembling tool calls. CodePilot normalizes provider usage into input, output, total, cache-read, cache-write, and reasoning-token counters. Non-streaming headless calls still collect usage when the provider returns it. A stream may be retried before its first semantic event; after text or a tool-call delta has been emitted, failures are surfaced without retrying so output cannot be duplicated.

DeepSeek V4 reasoning content is retained internally and returned with assistant tool-call messages so thinking-mode tool continuations remain protocol-correct. It is never rendered as normal assistant text. DeepSeek rejects forced `tool_choice` while thinking mode is enabled, so CodePilot disables thinking only for requests that explicitly force tool selection; ordinary agent requests keep the model's default thinking mode.

### Run Token Budgets

Every CLI run has independent input, output, and total Provider token limits. Before a request, CodePilot checks the packed input estimate and lowers that request's output limit to the remaining run allowance. If a Provider omits usage, the same transparent `characters / 4` estimator used by context packing is used for accounting and `usageEstimatedSteps` is incremented. A final answer may complete at the limit, but a tool call is never executed when there is no budget left for its continuation.

```json
{
  "maxRunInputTokens": 2000000,
  "maxRunOutputTokens": 100000,
  "maxRunTotalTokens": 2100000
}
```

The matching one-shot flags are `--max-run-input-tokens`, `--max-run-output-tokens`, and `--max-run-total-tokens`. In an interactive session, `/usage` shows the most recent run's counters.

### Provider Record and Replay

Record provider interactions from a real run, then replay them offline without an API key:

```powershell
npm run dev -- --headless `
  --provider deepseek `
  --record-provider .codepilot/replays/fix-parser.jsonl `
  "Fix the parser regression"

npm run dev -- --headless `
  --provider deepseek `
  --replay-provider .codepilot/replays/fix-parser.jsonl `
  "Fix the parser regression"
```

The same paths can be configured as `providerRecordPath` or `providerReplayPath` in `.codepilot.json`; the modes are mutually exclusive. Replay is strict and ordered: every packed system prompt, message list, tool definition, forced tool choice, and newly recorded per-request output cap must match, otherwise the run fails immediately with a replay mismatch. Stream events, normalized usage, final responses, and provider failures are recorded and reproduced, enabling deterministic rendering, timeout, and outage scenarios. Older response-only traces remain readable.

Trace files never contain API keys, HTTP headers, system prompts, user messages, or tool definitions—the request side contains hashes and counts only. Successful model output and tool-call arguments are stored in full because replay needs them, so traces may still contain generated code or sensitive output. Keep them under the ignored `.codepilot/replays/` directory and review before sharing.

### Live Provider Smoke Matrix

P2.4 adds an opt-in contract test against the real OpenAI, Anthropic, and DeepSeek APIs. It is disabled unless `CODEPILOT_LIVE_SMOKE=1` is set, because each selected provider makes four billable requests. The matrix checks plain text plus usage, streamed text plus exact offline replay, a streamed forced tool call, and cancellation after streaming begins.

```powershell
$env:CODEPILOT_LIVE_SMOKE="1"
$env:CODEPILOT_SMOKE_PROVIDERS="openai,anthropic,deepseek"
$env:OPENAI_API_KEY="..."
$env:ANTHROPIC_API_KEY="..."
$env:DEEPSEEK_API_KEY="..."
npm run smoke:providers
```

When `CODEPILOT_SMOKE_PROVIDERS` is omitted, only providers with a configured API key are selected. Use `all` to require all three. Models and endpoints can be overridden with the existing provider variables (`OPENAI_MODEL`, `OPENAI_BASE_URL`, and the equivalent `ANTHROPIC_*` and `DEEPSEEK_*` variables). `CODEPILOT_SMOKE_TIMEOUT_MS` defaults to 60000, `CODEPILOT_SMOKE_MAX_OUTPUT_TOKENS` defaults to 128, and `CODEPILOT_SMOKE_REPORT` can select a workspace-contained report path.

The command exits nonzero if any contract fails and writes an atomic JSON report under `.codepilot/runs/`. Reports and progress logs omit API keys, endpoints, prompts, response text, tool arguments, and provider error messages; they retain only model identifiers, timings, token counts, event counts, response hashes, and error class names. Temporary record/replay traces are deleted after validation.

`permissions` is a project-local policy layer. It supports exact tool names and `shell:<glob>` command rules; the most specific matching shell rule wins. It takes precedence over the older risk-level `autoApprove` setting:

```json
{
  "permissions": {
    "todo_write": "allow",
    "apply_patch": "ask",
    "shell:npm run *": "allow",
    "shell:git status": "allow",
    "shell:git push *": "deny"
  }
}
```

## Interactive Commands

```text
/help                 Show commands
/workspace            Show the active workspace root
/session              Show the active session ID
/sessions             List saved sessions for this workspace
/mode                 Show current mode
/mode plan            Read-only planning mode
/mode build           Editing and command mode
/init [--force]       Create or regenerate AGENTS.md
/index                Build .codepilot/index.json
/check                Run detected verification commands
/remember [topic:] <note> Save a durable topic memory
/memory [query]       Show the memory index and relevant topics
/rules [query]        Show all instructions or rules selected for a query
/context              Show context budget report
/usage                Show usage for the last agent run
/compact              Summarize old messages and keep recent context
/todo                 Show current task list
/undo                 Restore files changed by the previous agent run
/status               Show git status --short
/diff                 Show git diff
/clear                Clear in-memory conversation
/exit                 Exit CodePilot
```

Plan mode blocks write and execute tools. Build mode allows them after approval.

## Execution Feedback

CodePilot prints each tool lifecycle event (`[tool:start]`, `[tool:completed]`, or `[tool:failed]`). Shell, Git status, and Git diff output is streamed as it arrives. Shell results include exit code, duration, timeout, and truncation metadata. Defaults are a 120-second timeout and a 1 MB captured-output limit, configurable with `shellTimeoutMs` and `shellMaxOutputChars`; an individual `shell` call may set `timeout_ms`. Cancellation and timeout terminate the spawned process tree. Run long-lived development servers such as `npm run dev` in a separate terminal.

Press `Ctrl+C` while an agent task is running to cancel the active model request or Shell command. In interactive mode, CodePilot returns to the prompt after cancellation; pressing `Ctrl+C` while idle exits the CLI.

### Crash Recovery

During an active run, CodePilot atomically updates `.codepilot/runs/checkpoints/<session-id>.json` before model calls, tool execution, and verification. Checkpoints contain only IDs, phase names, counters, timestamps, and tool names—never prompts, tool arguments, model text, code, or credentials. User messages, assistant tool requests, and each tool result are persisted independently instead of waiting for the whole tool batch.

After an unclean process exit, resume the affected session with `--resume` or `--session <id>`. If a tool was active but no durable result exists, CodePilot adds a synthetic tool result marking its outcome as unknown and instructing the next model turn to inspect the workspace. It does not automatically replay the tool. Consistent session history is retained, the stale checkpoint is cleared, and the CLI prints a `[recovery]` notice. Normal completion and safe pre-tool cancellation remove the checkpoint automatically.

## Automatic Verification

In build mode, CodePilot tracks successful `apply_patch`, `write_file`, and `replace_text` calls. Before the first edit to a code file, it captures an LSP diagnostic baseline. When the model tries to finish after changing TypeScript, JavaScript, or Python, CodePilot automatically:

1. runs LSP diagnostics and blocks only errors introduced by the current task;
2. selects related TypeScript/JavaScript or Python tests from the actual committed paths;
3. runs targeted tests before up to three detected full-project check commands;
4. parses common pytest and TypeScript failures into structured file, line, test, code, and message records;
5. sends failures back into the same agent task for a focused repair;
6. stops on success, repeated identical failure, the retry limit, cancellation, or the agent step limit;
7. writes a machine-readable report to `.codepilot/runs/<run-id>.json`.

Automatic Shell checks still use normal CodePilot permissions. A denied or unavailable required check is reported as `skipped`, never as `passed`.

```json
{
  "autoVerify": true,
  "maxVerificationAttempts": 3
}
```

## Headless Tasks

`--headless` runs one task without interactive prompts and prints one compact JSON result to stdout. It also saves a formatted result and Git patch under `.codepilot/runs/` by default:

```powershell
node C:\Users\18355\Documents\Codex\CodePilot\dist\cli.js `
  --headless `
  --provider deepseek `
  --cwd C:\work\repository `
  --max-runtime-ms 900000 `
  --max-steps 60 `
  --max-tool-calls 200 `
  --max-run-input-tokens 2000000 `
  --max-run-output-tokens 100000 `
  --max-run-total-tokens 2100000 `
  --output .codepilot\runs\result.json `
  --patch-output .codepilot\runs\prediction.patch `
  "Fix the reported parser regression"
```

Stable statuses and exit codes are `completed` (0), `failed` (1), `budget_exceeded` (2), `incomplete` (3), `timeout` (124), and `cancelled` (130). The result records task timing, session ID, model steps, tool calls, model/tool duration, normalized provider token usage, context compactions, verification attempts and status, provider execution mode and trace path, artifact paths, patch size, and SHA-256. Budget failures include a machine-readable `budgetExceeded` object with the exhausted budget kind and limit.

Headless permissions fail closed: an `ask` decision is denied instead of waiting for stdin. Configure explicit `allow` rules or `autoApprove` only inside a trusted isolated workspace. Final patch capture includes tracked changes and up to 100 untracked files, excludes `.codepilot/**`, and does not modify the Git index.

## Instructions and Memory

CodePilot loads stable project instructions into named system-context sections from:

```text
AGENTS.md
CLAUDE.md
.codepilot/memory.md
.codepilot/memory/<topic>.md
```

CodePilot also reads `.codepilot/rules/*.md`, but those rule files are selected on demand. Each agent turn scores rule files against the current user request using file names, headings, content keywords, and small built-in synonym groups. Only the most relevant rules are injected into the model context.

For a new task, CodePilot also performs a lightweight local code-context selection: it ranks workspace files using task keywords, then injects up to four relevant excerpts (at most 10,000 characters in total). This is deterministic and local; the agent can still use `glob`, `grep`, and line-ranged `read_file` to inspect more code as needed.

## Language Intelligence

The read-only `lsp` tool provides semantic code navigation and validation for TypeScript, JavaScript, and Python. It automatically uses TypeScript Language Server for TS/JS files and Pyright for Python files. Supported operations are `documentSymbols`, `workspaceSymbols`, `definition`, `references`, `hover`, and `diagnostics`; input and rendered output positions are 1-based. Diagnostic severity is rendered as `error`, `warning`, `information`, or `hint`. Language servers are started on demand, reused by workspace and language, updated with document versions, and closed when CodePilot exits (or after 60 seconds idle).

Before an edit task starts, CodePilot also builds a pre-edit impact analysis from the code graph. It identifies matching target symbols, syntactic callers, direct and transitive reverse importers, local dependencies, related tests, suggested targeted checks, and a recommended edit order. The read-only `impact_analysis` tool can refresh or deepen this analysis during a task. Dynamic dispatch and runtime dependency injection remain explicit uncertainty boundaries and should be confirmed with LSP or search.

Instruction files can import workspace files with `@path`:

```md
Use the public API rules in @README.md.
Follow migration notes in @docs/migrations.md.
```

Memory v2 keeps a concise index in `.codepilot/memory.md` and durable notes in topic files. Legacy single-file memory is migrated to `.codepilot/memory/general.md` on the next write. The index is always available; only topic files relevant to the current request are injected.

Save and query durable project memory:

```text
/remember architecture: Keep provider adapters behind one interface.
/remember commands: Run npm test before release.
/memory
/memory provider architecture
/rules
/rules testing
```

The agent can also call the read-only `memory_read` tool or request an approved `memory_write`. It is instructed to store only durable architecture decisions, commands, debugging lessons, and user preferences—not transient task progress. Use `AGENTS.md` or `.codepilot/rules/*.md` for stable team rules.

## File References

Mention files with `@path` to inject their content into the prompt:

```text
Explain @src/agent.ts
Compare @src/agent.ts and @src/tools.ts
Use @README.md to update the project guide
```

CodePilot reads up to 8 referenced files per prompt and truncates very large files.

## Project Index and Checks

Build a project index:

```text
/index
```

This writes `.codepilot/index.json` with detected stack, package scripts, important files, source roots, suggested check commands, and code-graph counts. It also writes `.codepilot/code-graph.json`. The graph uses the TypeScript compiler AST for TypeScript/JavaScript and structural extraction for Python to record symbols, local imports, reverse importers, and calls. During a task, CodePilot incrementally caches this graph, invalidates it after edits, and uses relationships to select relevant initial context.

Run detected checks:

```text
/check
```

For Node projects, CodePilot prefers `npm run typecheck`, `npm run test`, `npm run build`, and `npm run lint` when those scripts exist. It also detects basic Python, Rust, and Go projects.

## Context Window Management

CodePilot estimates token usage with a transparent approximation:

```text
tokens ~= characters / 4
```

Before each model call, CodePilot packs:

```text
system instructions
project index
session summary
AGENTS.md / CLAUDE.md / memory
rules selected from .codepilot/rules/*.md
recent conversation messages
tool results
tool definitions
```

The input budget is model-aware:

```text
effective input budget = min(contextBudgetTokens,
  contextWindowTokens - maxOutputTokens - contextSafetyMarginTokens)
```

Known models use local context profiles; unknown model names use conservative provider fallbacks. The default working input cap is `128000` estimated tokens even when the model window is larger. Explicit project settings override the detected profile and are clamped to a valid window. For example:

```json
{
  "contextBudgetTokens": 128000,
  "maxOutputTokens": 8192,
  "contextSafetyMarginTokens": 4096,
  "toolResultMaxTokens": 1200,
  "oldToolResultMaxTokens": 160,
  "memoryIndexMaxTokens": 800,
  "memoryTopicMaxTokens": 800,
  "memoryTopicLimit": 3
}
```

`contextWindowTokens` can be set when using a model that has no built-in profile. Tool definitions are counted before message packing. Older tool results are compacted more aggressively than the two most recent results, and named system sections expose their individual token costs in `/context` and runtime events.

When history exceeds the budget, CodePilot automatically compacts omitted older messages into:

```text
.codepilot/sessions/<session-id>.summary.md
```

Compaction uses `deepseek-v4-flash` through `DEEPSEEK_API_KEY` to produce structured Markdown summaries. If the key is missing or the API call fails, CodePilot falls back to a local mechanical summary so the session can continue.
Summaries are isolated per session so resuming or compacting one task cannot leak its compressed context into another. When an older workspace is resumed, the legacy `.codepilot/session-summary.md` is moved once into that resumed session.

Useful commands:

```text
/context
/compact
```

`/context` prints the current estimated budget report. `/compact` manually summarizes old messages while keeping recent context.

## Execution Layer

For multi-step coding work, CodePilot can maintain an explicit task list in:

```text
.codepilot/todos.json
```

The model can use `todo_write` to set items to `pending`, `in_progress`, or `completed`. You can inspect the current list with:

```text
/todo
```

For code edits, CodePilot prefers the auditable `apply_patch` tool over whole-file writes. The patch format is:

```text
*** Begin Patch
*** Update File: src/example.ts
@@
-old text
+new text
*** End Patch
```

It also supports:

```text
*** Add File: path
*** Delete File: path
```

Patch updates require the old text to match exactly once, which keeps edits deliberate and reviewable. Multi-file patches are transactional: CodePilot validates every operation first, stages new contents beside their destinations, commits the complete set, and restores all original files if any commit step fails.

`read_file` records the SHA-256 version it observed without adding hash noise to the model-visible file content. Later `apply_patch` and `write_file` calls use that version as an optimistic-concurrency precondition, so an external edit made after the read is rejected instead of overwritten. `apply_patch` also accepts explicit `expected_hashes` preconditions.

Successful write tools return a structured transaction result containing the transaction ID, actual committed paths, operations, and before/after hashes. Automatic verification consumes these committed paths rather than inferring changes from the model request.

## Safety Model

- Read tools are auto-approved by default.
- Write and execute tools ask for approval unless configured in `autoApprove`.
- `.codepilot.json` can override this per tool or per shell-command pattern with `allow`, `ask`, or `deny`.
- Explicit `deny` rules block the action without showing an approval prompt.
- Write approvals show a compact diff preview before asking.
- Patch approvals show the proposed patch before asking.
- Shell approvals warn when a command looks destructive or high risk.
- `y` approves once.
- `a` approves the risk category for the current process.
- File tools are restricted to the current workspace.
- Text writes use same-directory staging and atomic replacement with rollback.
- Files changed after CodePilot read them are not silently overwritten.
- Write tools snapshot original file content before changing files.
- `/undo` restores the previous agent run's file state.

## Runtime Kernel and Hooks

The Agent kernel accepts either the existing `Tool[]` input or a `ToolRegistry`. The registry provides deterministic registration, duplicate-name protection, lookup, removal, and disposal, creating a stable boundary for future plugin and MCP tools without changing the Agent loop.

`RuntimeEventBus` exposes ordered, versioned lifecycle events with a per-run ID, session ID, timestamp, and sequence number. Current events cover runs, context preparation, model requests, tool authorization and execution, edit preparation and commit, verification outcomes, and repair attempts.

Hooks are ordered and fail-isolated:

- a hook may return `{ deny: "reason" }` to add a restriction;
- a hook cannot grant permission or bypass plan mode and the normal permission policy;
- hook exceptions and timeouts are reported through `onHookError` without failing the Agent task;
- caller cancellation is propagated through the hook `AbortSignal`;
- `edit.preparing` can protect generated files or sensitive directories before a write starts.

The CLI enables a local JSONL audit by default at `.codepilot/audit/runtime.jsonl`. Prompt text, patches, file contents, and replacement text are stored only as length plus SHA-256; API keys, authorization headers, cookies, credentials, passwords, secrets, and tokens are replaced with `[REDACTED]`. The audit path is restricted to the active workspace.

Project configuration can disable or relocate the audit and add path-protection Hooks without loading executable code:

```json
{
  "runtimeAudit": true,
  "runtimeAuditPath": ".codepilot/audit/runtime.jsonl",
  "runtimeHookTimeoutMs": 5000,
  "protectedPaths": [
    "generated/**",
    "vendor/**",
    "docs/published/*.md"
  ]
}
```

`protectedPaths` applies to direct file edits and every file block inside an `apply_patch` transaction. A matching write is rejected before tool execution and still cannot bypass plan mode or normal permission checks.

```ts
const runtimeEvents = new RuntimeEventBus({
  hooks: [{
    name: "protect-generated",
    events: ["edit.preparing"],
    handle(event) {
      if (event.name === "edit.preparing" && event.data.args.path === "generated.ts") {
        return { deny: "generated files are protected" };
      }
    },
  }],
  onEvent: (event) => console.log(event.sequence, event.name),
});

const agent = new Agent({ ...options, runtimeEvents });
```

## Built-in Tools

- `read_file`
- `list_files`
- `search`
- `glob` (native file-pattern matching)
- `grep` (literal or regex search, glob filter, context lines)
- `lsp` (TypeScript/JavaScript/Python symbols, definitions, references, hover, diagnostics)
- `todo_read`
- `todo_write`
- `memory_read` (index plus query-relevant topic memory)
- `memory_write` (approved durable topic memory)
- `project_index`
- `impact_analysis` (pre-edit targets, callers, dependents, tests, checks, and edit plan)
- `code_graph` (symbol/call search and per-file import relationships)
- `git_status`
- `git_diff`
- `apply_patch`
- `write_file`
- `replace_text`
- `shell`

Run verification:

```powershell
npm test
npm run typecheck
```

License: MIT.
