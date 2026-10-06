# Project contract

## Capabilities

- Run independently with this repository's dependencies and build.
- Discover local agent sessions by default. Repeat `--project` to restrict configuration roots; use `--demo` for the bundled example.
- Display hook graphs, definitions, source references and recorded runs.
- Read each selected checkout's registry, referenced files, hook configuration, event ledger and optional token usage records.
- Read Codex enablement/trust metadata and partial Claude settings inventory without changing approval or starting an agent turn.
- Save enablement, blocking mode, order and prerequisites for registries with `managementVersion: 1`.
- Reject stale revisions, invalid dependencies and finalizers ordered before checks.
- Restrict reference reads and registry writes to the selected project, including symlink targets.
- Show actionable errors for missing or invalid registries, and unknown status when metadata is unavailable.

## Runtime boundary

The separate dispatcher executes stages when invoked by the agent. The server binds to loopback and serves an inventory of local projects, sessions and recorded executions. Repository grouping never merges checkout registries. Registry writes require a known checkout ID; caller-supplied filesystem paths cannot choose a save target. It does not install or execute hooks, load project environment files, or provide remote hosting or authentication. Other registries remain read-only.

Saved controls apply when the selected project's compatible runner next reads its registry. Parent approval belongs to each agent. Both agent configurations are inspected together. Claude per-command trust is unsupported; workspace approval is unknown unless observed. Configuration status and recorded execution are distinct evidence.

## UI

Use the same execution order for desktop graphs and mobile lists across every lifecycle event. Keep related labels, statuses and controls on compact rows. Size cards to their content and preserve readable failure feedback.

## Validation

Run `pnpm check` for TypeScript, isolated filesystem/HTTP tests and the production build. Run `pnpm test:browser` for demo rendering, settings persistence and reload, recorded runs, source viewing, mobile width, refresh and error states. Browser checks create two disposable Git checkouts; no external project is required.

Preferred registry: `.hooks-workspace/registry.yaml`; legacy `.codex/hooks/registry.yaml` is supported. Select explicitly with `--registry` if both exist. Loader, saves, dispatcher, history and usage share that selection. Provider switching changes inspection; stage settings are shared.
