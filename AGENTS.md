# Hooks workspace

## Product direction

This workbench is intended to manage project sub-hooks without routine use of the Codex settings UI. Keep a master dispatcher as the Codex entrypoint for each supported lifecycle event. The workbench should manage sub-hook enablement, execution order and dependencies, and whether a stage can block progress. Codex remains the authority for trusting and enabling the parent command.

## Current implementation

The application reads Codex trust and manages sub-hook switches, blocking mode, order and prerequisites for registries with `managementVersion: 1`. Saves update only the target registry, use a revision check and apply on the next invocation. It never changes Codex trust or executes hooks itself.

Managed registries describe sub-hooks behind project-owned parent dispatchers. The selected project's runner must consume the saved switches, order, prerequisites and blocking mode. A prerequisite must run earlier in the same event and return passed; skipped, disabled and failed prerequisites skip dependents. Finalizers remain after checks. This repository does not include or execute a dispatcher.
For future control changes, persist changes to configuration that the runner actually consumes. Validate dependency order and blocking/finalizer behavior together, and verify the resulting execution in recorded runs. Graph arrows must accurately represent execution, not imply unsupported dependencies. Preserve fail-open handling of hook errors.

## UI and validation

**Minimize wasted vertical space throughout the UI.** Place related labels, status indicators and controls on the same horizontal row whenever they fit. Do not add a second line for metadata that can sit beside the title; wrap only when the available width requires it. Cards must size to their content, without fixed heights or empty reserved rows. Position chain nodes from measured rendered heights with only a small connector gap; changing text, wrapping or hiding rows must close the space automatically. Preserve legibility and accessible targets rather than shrinking text to fit. Verify both short and wrapped content in the browser.

Apply shared UI corrections across every lifecycle tab and both desktop and mobile views. Entry-node configuration status belongs on the same row for every event; derive it from that event’s configuration, never assume every event has a master dispatcher.

Keep the chain compact: short titles, brief descriptions, status icons with accessible hover/focus explanations. Distinguish configured enablement, unknown status and recorded execution. A trusted parent command does not prove a sub-hook ran; environment switches may differ between this server and the agent.

Run `pnpm check` for code changes and verify changed UI in a browser. Maintain the current capabilities and limitations in README.md.
