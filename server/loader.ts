import { readStages } from '../runtime/registry.js';
import { resolveRegistry, stateDirectory } from './registry.js';
import { registryRevision } from './management.js';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { load } from 'js-yaml';
import type { ExecutionContext, GitSnapshot } from '../src/workspace-types.js';

function validTree(value: unknown): value is GitSnapshot {
  return isRecord(value) && ['repositoryId', 'repositoryLabel', 'checkout'].every(key => typeof value[key] === 'string') && typeof value.git === 'boolean' && typeof value.detached === 'boolean' && (value.branch === null || typeof value.branch === 'string') && (value.commit === null || typeof value.commit === 'string');
}
function validContext(value: unknown): value is ExecutionContext {
  return isRecord(value) && typeof value.hookProject === 'string' && (value.cwd === null || typeof value.cwd === 'string') && validTree(value.hookTree) && (value.workingTree === null || validTree(value.workingTree)) && Array.isArray(value.targets) && value.targets.every(validTree);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import type {
  HookControlPlaneData,
  HookDefinition,
  HookEnablementMode,
  HookEventDefinition,
  HookEventId,
  HookReference,
  HookReferenceType,
  HookStage,
  HookTraceEvent,
} from '../src/hook-types.js';

const EVENT_IDS = new Set<HookEventId>(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
const STAGES = new Set<HookStage>(['prerequisite', 'blocker', 'advisory', 'finalizer']);
const ENABLEMENT_MODES = new Set<HookEnablementMode>(['always', 'opt-in', 'opt-out']);
const REFERENCE_TYPES = new Set<HookReferenceType>(['documentation', 'prompt', 'source', 'test']);
const TRACE_LIMIT = 300;

function enabledNow(mode: HookEnablementMode, environment: string | undefined, environmentValues: NodeJS.ProcessEnv): boolean {
  if (mode === 'always') return true;
  const value = (environment ? environmentValues[environment] : undefined)?.toLowerCase() ?? '';
  if (mode === 'opt-in') return value === '1' || value === 'true';
  return value !== '0' && value !== 'false';
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Hook registry field ${key} must be a string`);
  return value;
}

function stringList(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`Hook registry field ${key} must be a string list`);
  }
  return value;
}

function optionalStringList(record: Record<string, unknown>, key: string): readonly string[] {
  if (record[key] === undefined) return [];
  return stringList(record, key);
}

function parseEvent(value: unknown): HookEventDefinition {
  if (!isRecord(value)) throw new Error('Hook event definition must be an object');
  const id = requiredString(value, 'id');
  if (!EVENT_IDS.has(id as HookEventId)) throw new Error(`Unknown hook event ${id}`);
  return {
    id: id as HookEventId,
    label: requiredString(value, 'label'),
    description: requiredString(value, 'description'),
  };
}

function projectPath(root: string, path: string): string {
  const absoluteRoot = realpathSync(root);
  const absolutePath = realpathSync(resolve(root, path));
  if (absolutePath !== absoluteRoot && !absolutePath.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Hook file must stay inside the repository: ${path}`);
  }
  return absolutePath;
}

function readReference(root: string, value: unknown): HookReference {
  if (!isRecord(value)) throw new Error('Hook reference must be an object');
  const type = requiredString(value, 'type');
  if (!REFERENCE_TYPES.has(type as HookReferenceType)) throw new Error(`Unknown hook reference type ${type}`);
  const path = requiredString(value, 'path');
  const absolutePath = projectPath(root, path);
  return {
    absolutePath,
    content: readFileSync(absolutePath, 'utf8'),
    ...(typeof value.focus === 'string' ? { focus: value.focus } : {}),
    label: requiredString(value, 'label'),
    path,
    type: type as HookReferenceType,
  };
}

function parseHook(value: unknown, root: string, environmentValues: NodeJS.ProcessEnv): HookDefinition {
  if (!isRecord(value)) throw new Error('Hook definition must be an object');
  const event = requiredString(value, 'event');
  const stage = requiredString(value, 'stage');
  if (!EVENT_IDS.has(event as HookEventId)) throw new Error(`Unknown hook event ${event}`);
  if (!STAGES.has(stage as HookStage)) throw new Error(`Unknown hook stage ${stage}`);
  if (!isRecord(value.enabled)) throw new Error('Hook enabled field must be an object');
  const mode = requiredString(value.enabled, 'mode');
  if (!ENABLEMENT_MODES.has(mode as HookEnablementMode)) throw new Error(`Unknown enablement mode ${mode}`);
  const order = value.order;
  if (typeof order !== 'number' || !Number.isFinite(order)) throw new Error('Hook order must be a number');
  if (typeof value.canBlock !== 'boolean') throw new Error('Hook canBlock must be boolean');
  if (value.failurePolicy !== 'fail-open') throw new Error('Hook failurePolicy must be fail-open');

  if (value.managed !== undefined && (!isRecord(value.managed) || typeof value.managed.enabled !== 'boolean' || typeof value.managed.blocking !== 'boolean' || !Array.isArray(value.managed.dependsOn) || !value.managed.dependsOn.every((id: unknown) => typeof id === 'string'))) throw new Error('Invalid managed hook settings');
  const source = requiredString(value, 'source');
  const additionalReferences = value.references === undefined ? [] : value.references;
  if (!Array.isArray(additionalReferences)) throw new Error('Hook references must be a list');

  return {
    ...(Array.isArray(value.providers) && value.providers.every(p => p === 'codex' || p === 'claude') ? { providers: value.providers as ('codex' | 'claude')[] } : {}),
    ...(typeof value.resultFormat === 'string' ? { resultFormat: value.resultFormat as 'neutral' | 'native' } : {}),
    id: requiredString(value, 'id'),
    inputs: stringList(value, 'inputs'),
    checks: optionalStringList(value, 'checks'),
    label: requiredString(value, 'label'),
    event: event as HookEventId,
    stage: stage as HookStage,
    order,
    outcomes: stringList(value, 'outcomes'),
    references: [
      readReference(root, {
        ...(typeof value.sourceFocus === 'string' ? { focus: value.sourceFocus } : {}),
        label: 'Implementation',
        path: source,
        type: 'source',
      }),
      ...additionalReferences.map((reference) => readReference(root, reference)),
    ],
    rules: stringList(value, 'rules'),
    enabled: {
      mode: mode as HookEnablementMode,
      ...(typeof value.enabled.environment === 'string' ? { environment: value.enabled.environment } : {}),
    },
    when: requiredString(value, 'when'),
    does: requiredString(value, 'does'),
    ...(isRecord(value.managed) ? { managed: { enabled: value.managed.enabled === true, blocking: value.managed.blocking === true, dependsOn: Array.isArray(value.managed.dependsOn) ? value.managed.dependsOn.filter((id): id is string => typeof id === 'string') : [] } } : {}),
    enabledNow: isRecord(value.managed) ? value.managed.enabled === true : enabledNow(mode as HookEnablementMode, typeof value.enabled.environment === 'string' ? value.enabled.environment : undefined, environmentValues),
    calls: stringList(value, 'calls'),
    canBlock: value.canBlock,
    failurePolicy: 'fail-open',
    source,
    ...(typeof value.codexSource === 'string' ? { codexSource: value.codexSource } : {}),
    sdlcGates: stringList(value, 'sdlcGates'),
    steps: stringList(value, 'steps'),
    why: requiredString(value, 'why'),
  };
}

function parseRegistry(raw: string, root: string, environmentValues: NodeJS.ProcessEnv): Pick<HookControlPlaneData, 'events' | 'hooks'> {
  const parsed: unknown = load(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.events) || !Array.isArray(parsed.hooks)) {
    throw new Error('Hook registry must contain events and hooks lists');
  }
  readStages(raw);
  const events = parsed.events.map(parseEvent);
  const hooks = parsed.hooks.map((hook) => parseHook(hook, root, environmentValues));
  const hookIds = hooks.map((hook) => hook.id);
  if (new Set(hookIds).size !== hookIds.length) throw new Error('Hook IDs must be unique');
  return { events, hooks };
}

export function parseTraceLine(line: string): HookTraceEvent | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || typeof value.hookName !== 'string' || typeof value.at !== 'string') return null;
    const event = typeof value.hookEventName === 'string' && EVENT_IDS.has(value.hookEventName as HookEventId)
      ? value.hookEventName as HookEventId
      : null;
    const stage = typeof value.stage === 'string' && STAGES.has(value.stage as HookStage)
      ? value.stage as HookStage
      : null;
    return {
      ...(validContext(value.context) ? { context: value.context } : {}),
      promptId: typeof value.promptId === 'string' ? value.promptId : null,
      lifecycleEvent: typeof value.hookEventName === 'string' ? value.hookEventName : undefined,
      provider: value.provider === 'claude' ? 'claude' : value.provider === 'codex' ? 'codex' : undefined,
      invocationId: typeof value.invocationId === 'string' ? value.invocationId : undefined,
      at: value.at,
      decision: typeof value.decision === 'string' ? value.decision : 'unknown',
      durationMs: typeof value.durationMs === 'number' ? value.durationMs : null,
      event,
      hookId: value.hookName,
      kind: typeof value.kind === 'string' ? value.kind : 'unknown',
      message: typeof value.message === 'string' ? value.message : null,
      sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
      stage,
      toolUseId: typeof value.toolUseId === 'string' ? value.toolUseId : null,
      turnId: typeof value.turnId === 'string' ? value.turnId : null,
    };
  } catch {
    return null;
  }
}

export function readRecentTraces(root: string, selection?: string): readonly HookTraceEvent[] {
  const ledgerDir = join(stateDirectory(root, selection), 'event-ledger');
  if (!existsSync(ledgerDir)) return [];
  const files = readdirSync(projectPath(root, ledgerDir))
    .filter((fileName) => fileName.endsWith('.jsonl'))
    .toSorted()
    .slice(-7);
  const traces = files.flatMap((fileName) => readFileSync(projectPath(root, join(ledgerDir, fileName)), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(parseTraceLine)
    .filter((trace): trace is HookTraceEvent => trace !== null));
  return traces.slice(-TRACE_LIMIT).toReversed();
}

function configuredCommands(root: string, provider: 'codex' | 'claude'): { counts: Partial<Record<HookEventId, number>>; masters: HookEventId[] } {
  const configPath = join(root, provider === 'codex' ? '.codex/hooks.json' : '.claude/settings.json');
  if (!existsSync(configPath)) return { counts: {}, masters: [] };
  const config: unknown = JSON.parse(readFileSync(projectPath(root, configPath), 'utf8'));
  if (provider === 'claude' && isRecord(config) && config.hooks === undefined) return { counts: {}, masters: [] };
  if (!isRecord(config) || !isRecord(config.hooks)) throw new Error('Invalid hooks.json: expected a hooks object');
  const counts: Partial<Record<HookEventId, number>> = {};
  const masters: HookEventId[] = [];
  for (const event of EVENT_IDS) {
    const entries = config.hooks[event];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) throw new Error(`Invalid hooks.json: ${event} must be a list`);
    if (entries.length === 1 && isRecord(entries[0]) && Array.isArray(entries[0].hooks) && entries[0].hooks.length === 1 && isRecord(entries[0].hooks[0]) && typeof entries[0].hooks[0].command === 'string' && (entries[0].hooks[0].command.includes('/.codex/hooks/master_hook.cjs') || entries[0].hooks[0].command.includes('dispatch-hook.ts'))) masters.push(event);
    counts[event] = entries.reduce((count: number, entry: unknown): number => count + (
      isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks.filter((hook: unknown): boolean =>
        isRecord(hook) && hook.type === 'command' && typeof hook.command === 'string' && hook.command.trim().length > 0
      ).length : 0
    ), 0);
  }
  return { counts, masters };
}

export function loadHookControlPlaneData(root: string, environmentValues: NodeJS.ProcessEnv = process.env, selection?: string, provider: 'codex' | 'claude' = 'codex'): HookControlPlaneData {
  try {
    const raw = readFileSync(resolveRegistry(root, selection), 'utf8');
    const registry = parseRegistry(raw, root, environmentValues);
    const parsed: unknown = load(raw);
    let configurationError: string | undefined;
    let commands: ReturnType<typeof configuredCommands> | undefined;
    try { commands = configuredCommands(root, provider); } catch (error) {
      if (provider !== 'claude') throw error;
      configurationError = error instanceof Error ? error.message : String(error);
    }
    return {
      ...registry,
      provider, registryPath: resolveRegistry(root, selection),
      ...(isRecord(parsed) && parsed.managementVersion === 1 ? { managementRevision: registryRevision(raw) } : {}),
      loadError: null,
      stopConfigured: (commands?.counts.Stop ?? 0) > 0,
      configurationError,
      configuredCommands: commands?.counts,
      masterEvents: commands?.masters,
      traces: readRecentTraces(root, selection),
    };
  } catch (error) {
    return {
      events: [],
      hooks: [],
      loadError: error instanceof Error ? error.message : String(error),
      stopConfigured: false,
      traces: [],
    };
  }
}
