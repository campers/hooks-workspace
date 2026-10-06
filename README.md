# Hooks workspace

## Setup

Requires Node.js 22.12+ and pnpm. Install `codex` and/or `claude` separately.

```sh
pnpm install
pnpm dev
```

Open http://127.0.0.1:4317. Local Codex and Claude sessions are discovered automatically.

Add the workspace's `bin` folder to `PATH` in `~/.zshrc` or `~/.bashrc`:

```sh
export PATH="/path/to/hooks-workspace/bin:$PATH"
```

Open a new terminal, then run `hooks` from any directory. Options are forwarded; relative project paths resolve from the directory where you run it:

```sh
hooks
hooks --project . --project ../another-project --port 4318
```

```sh
pnpm dev --project /path/to/project-a --project /path/to/project-b
pnpm dev --demo
# Optional: --port 4318, --registry relative/path/registry.yaml, --no-discovery
```

## Usage

1. Open **Executions**; filter by agent, repository, branch, checkout or session.
2. Choose repository/branch/session grouping, session/repository grouping or timeline.
3. Open **Hook settings**, select a configuration checkout, event and stage.
4. Change enablement, blocking, position or prerequisites; select **Save settings**.
5. Use **Recent run** for the stage chain, or **View transcript** for a discovered session.

Both agents are inspected together. Saves update only the selected checkout registry and apply on the next dispatcher invocation. Drafts survive view and checkout switches. Parent approval remains in the agent.

To register the dispatcher, preview configuration:

```sh
pnpm --silent config --project /path/to/project --provider codex
pnpm --silent config --project /path/to/project --provider claude
```

Merge the generated `hooks` entries into `.codex/hooks.json` or `.claude/settings.json`. Review existing handlers to avoid registering the dispatcher twice. Approve the parent through the selected agent. The preview command does not write configuration or change approval.

For a built app:

```sh
pnpm build
pnpm start --project /path/to/project
```

## Features

- Five events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and Stop.
- Desktop graph and mobile list; stage controls, source viewer and command inventory.
- Separate configured, provider-enabled, command-approval and workspace-approval observations.
- Ordered dispatcher stages, prerequisites, blocking mode and finalizers.
- Agent, repository, branch, checkout and session execution filters.
- Worktree and clone grouping; per-execution branch and commit snapshots.
- Read-only session catalog and on-demand transcript preview.
- Codex, Claude and Jev hook-token totals for the configuration checkout.
- Native command adapters and an optional Claude SDK callback bridge.

## Repository and session grouping

- No startup agent selection. `--project` can repeat and restricts configuration roots; linked worktrees are included. `--no-discovery` reads only project ledgers. `--demo` uses the bundled example.
- Codex inventory includes saved interactive, exec, app-server and subagent sources, plus archived sessions. Claude inventory includes locally persisted sessions across projects. Configured `CODEX_HOME` and `CLAUDE_CONFIG_DIR` are respected.
- Session identity is agent + session ID. A session can belong to several repositories. Cross-agent parent relationships are not inferred.
- Linked worktrees share Git's common directory. Independent clones group by normalized origin address; forks remain separate. Missing/ambiguous remotes stay local unless mapped explicitly.
- Record hook owner, working repository, explicit tool targets, branch and commit at invocation time. Shell commands are not parsed to guess affected repositories. Detached HEAD and unknown historical branches remain separate.
- **Project role** selects hook configuration, working repository or tool target. Totals deduplicate agent + invocation ID. Legacy rows remain visible without invented invocation counts.
- Session metadata refreshes every 30 seconds; checkout metadata and recent ledgers every 5 seconds. Saved sessions and observed hooks do not prove current process liveness. Ephemeral sessions need recorded hooks; remote/custom-store sessions require a separate collector.
- History currently covers the latest seven ledger files and 300 rows per checkout. Transcript preview shows the first 100 Claude messages or 50 Codex turns. Transcript formats and experimental Codex pagination may change.

For offline clones or remote aliases, pass `--repository-map /path/to/repositories.json`:

```json
[{"id":"example-app","label":"Example app","checkouts":["/path/to/clone-a","/path/to/clone-b"]}]
```

This local mapping groups history; it does not combine registries or grant execution permissions. Raw remote credentials, transcript contents and personal session titles are not written into repository fixtures.

## Registry and runtime

Preferred registry: `.hooks-workspace/registry.yaml`. Legacy `.codex/hooks/registry.yaml` remains supported. If both exist, `--registry` is required. Nothing is migrated automatically. Start with the catalog in `examples/demo/.codex/hooks/registry.yaml`; add `managementVersion: 1` and `managed: { enabled: true, blocking: false, dependsOn: [] }` to make controls writable.

Additional stage fields:

| Field | Meaning |
|---|---|
| `providers: [codex, claude]` | Optional provider restriction; unavailable prerequisites skip dependents |
| `resultFormat: neutral` | Recommended portable output format; default is `native` |
| `nativeProvider: codex` | Declares the native output dialect; legacy registries default to Codex |
| `allowInputRewrite: true` | Explicitly permits tool input rewrites; Codex rewrites emit native `allow` |
| `timeoutMs: 5000` | Per-stage timeout, 1–30000ms; total invocation budget is 25 seconds |

Stages run as Node.js `.cjs`, `.mjs` or `.js` scripts. Stdin contains the native payload plus `hooks_workspace` invocation identity. A portable result is:

```json
{"outcome":"passed","effects":[{"action":"context","message":"Stage context."}]}
```

Effects: `context`, `warning`, `rejectPrompt`, `denyTool`, `rewriteToolInput`, `feedback`, `continueStop`, `endProcessing`. Effects must match the lifecycle event and provider. Normal passes emit `{}` and never approve tool permissions. Unsupported effects and script errors fail open and are recorded as errors. A failed, disabled, skipped or errored prerequisite does not pass. Blocking effects stop later checks; finalizers still run if their prerequisites passed. Advisory mode suppresses blocking effects. `stop_hook_active` suppresses repeat continuation.

PostToolUse feedback uses the provider’s native presentation. The captured Bash journey retained the original tool-output marker for both CLIs and supplied the feedback to the next model request. A block is not a portable result-redaction operation. It cannot undo tool side effects. Cross-provider native PostToolUse blocks are rejected; use an explicit neutral feedback effect. Permission `allow`, `ask`, `defer`, arbitrary output replacement and `suppressOutput` are not portable pass results. Claude tool failures use a separate PostToolUseFailure event, outside this five-event implementation.

The HTTP server inspects configuration and saves registry controls; it never executes hooks. `pnpm dispatch` is a separate runtime entrypoint invoked by the agent. An optional `claudeSdkHooks(project, registry)` export in `runtime/claude-sdk.ts` provides typed callbacks. Use callbacks or native commands for a session, not both. SDK cancellation rejects the callback; native command errors retain fail-open behavior. Claude session discovery uses the Agent SDK on the server. The Codex SDK remains a development dependency. Neither SDK is bundled into the browser.

## Discovery and evidence

- Codex: `codex app-server` → `hooks/list`; configured command enablement and definition trust. Workspace approval and actual matcher execution remain unverified.
- Claude: user, project and local settings inventory. Managed policy, plugins, CLI overrides and live session state remain unknown. Per-command trust is unsupported; no “Trusted” badge is invented.
- Independent native handlers may execute concurrently. Graph arrows describe registry stages inside the dispatcher.
- Configured enablement, environment switches and recorded execution remain separate. The agent environment may differ from the workbench environment.

Native configuration previews also register observational SessionEnd/SubagentStart/SubagentStop events, plus Claude CwdChanged/DirectoryAdded. These record context without running stages or blocking. Update existing registrations to collect them.

State is beside the selected registry under `state/event-ledger/` and `state/llm-usage/`. Execution history uses provider and invocation IDs; legacy untagged records appear under Codex. Usage reads daily UTC JSONL files with `schemaVersion: 1`, unique provider-scoped `id`, `at`, `provider`, `inputTokens`, `outputTokens` and `totalTokens`. Totals cover hook LLM calls, not agent turns. `—` means no recorded usage; `+` marks missing counts. Cached and reasoning tokens must not be counted twice by the caller. Malformed records produce unavailable totals.

References, scripts, registries and state writes must resolve inside their hook-owning project, including symlinks. Saves are atomic and reject stale revisions or invalid execution order. The server binds to loopback, checks request host/origin, and loads no project `.env` files.

## Validation

```sh
pnpm check
pnpm test:browser
pnpm test:discovery
# Manual isolated CLI captures; rejecting loopback model endpoint:
pnpm fixtures:capture
# Full native lifecycle journey with a scripted local model API:
pnpm test:native
```

Unit tests cover both adapters and all five dispatcher events. Real CLI captures prove SessionStart and UserPromptSubmit without model requests. A separate scripted loopback model journey proves all five native events, denied/allowed side effects and Stop continuation for both CLIs. Interactive workspace approval and a live SDK agent session remain unverified. Browser checks cover both agents, repository/branch/checkout/session filters, grouping, all stage tabs, desktop/mobile, per-checkout saves, retained drafts, transcript dialogs and status recovery. Screenshots stay in ignored `test-results/`.

See [adapter design](docs/provider-adapters-design.md) and [project contract](docs/project-contract.md). Licensed under [Apache 2.0](LICENSE).
