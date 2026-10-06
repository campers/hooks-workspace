import { referencesSource, isDispatcher } from './command-identity.js';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readCodexHooks } from './codex-status.js';
import { loadHookControlPlaneData } from './loader.js';
import type { HookProvider, HookEventId, Observation, ProviderEventStatus, ProviderStatusSnapshot } from '../src/hook-types.js';

export const PROVIDER_CAPABILITIES = {
  codex: { commandTrust: true, nativeAsk: false, endProcessing: false, postToolEffect: 'native-feedback', events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'] },
  claude: { commandTrust: false, nativeAsk: true, endProcessing: true, postToolEffect: 'append-feedback', events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'] },
} as const;
const events = PROVIDER_CAPABILITIES.codex.events;
const unknown = (reason: string): Observation<never> => ({ state: 'unknown', reason });
const unsupported = (reason: string): Observation<never> => ({ state: 'unsupported', reason });
function known<T>(value: T, source: string, checkedAt: string): Observation<T> { return { state: 'known', value, source, checkedAt }; }
interface Command { event: string; source: string; command: string; enabled: boolean; trust?: 'trusted' | 'untrusted' | 'modified' | 'managed' }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

// File inventory only: never infer the effective live session from settings files.
export function readClaudeSettings(project: string, userDirectory = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')): { commands: Command[]; disabled: boolean; sources: string[] } {
  const sources = [join(userDirectory, 'settings.json'), join(project, '.claude/settings.json'), join(project, '.claude/settings.local.json')];
  const commands: Command[] = [];
  let disabled = false;
  for (const source of sources) {
    if (!existsSync(source)) continue;
    const settings: unknown = JSON.parse(readFileSync(source, 'utf8'));
    if (!object(settings)) throw new Error(`Invalid Claude settings: ${source}`);
    if (settings.disableAllHooks !== undefined && typeof settings.disableAllHooks !== 'boolean') throw new Error(`Invalid disableAllHooks: ${source}`);
    if (typeof settings.disableAllHooks === 'boolean') disabled = settings.disableAllHooks;
    if (settings.hooks === undefined) continue;
    if (!object(settings.hooks)) throw new Error(`Invalid Claude hooks: ${source}`);
    for (const event of events) {
      const entries = settings.hooks[event];
      if (entries === undefined) continue;
      if (!Array.isArray(entries)) throw new Error(`Invalid ${event} hooks: ${source}`);
      for (const entry of entries) {
        if (!object(entry) || !Array.isArray(entry.hooks)) throw new Error(`Invalid ${event} matcher: ${source}`);
        for (const hook of entry.hooks) {
          if (!object(hook) || typeof hook.type !== 'string') throw new Error(`Invalid handler: ${source}`);
          if (hook.type !== 'command') continue;
          if (typeof hook.command !== 'string' || !hook.command.trim()) throw new Error(`Invalid command: ${source}`);
          commands.push({ event, source, command: hook.command, enabled: !disabled });
        }
      }
    }
  }
  return { commands, disabled, sources };
}

export async function readProviderStatus(project: string, provider: HookProvider, selection?: string, claudeDirectory?: string): Promise<ProviderStatusSnapshot> {
  const checkedAt = new Date().toISOString();
  const base: ProviderStatusSnapshot = { provider, checkedAt, loading: false, error: null, hooks: {}, providerEvents: {} };
  try {
    project = realpathSync(project);
    const data = loadHookControlPlaneData(project, process.env, selection, provider);
    if (data.loadError) throw new Error(data.loadError);
    let commands: Command[];
    let disabled = false;
    if (provider === 'codex') {
      commands = (await readCodexHooks(project)).map(item => ({ event: item.eventName[0].toUpperCase() + item.eventName.slice(1), source: item.sourcePath, command: item.command, enabled: item.enabled, trust: item.trustStatus as Command['trust'] }));
    } else {
      const inventory = readClaudeSettings(project, claudeDirectory);
      commands = inventory.commands; disabled = inventory.disabled;
    }
    for (const event of events) {
      const found = commands.filter(item => item.event === event && item.command.trim());
      const trust = found.some(c => c.trust === 'modified') ? 'modified' : found.some(c => c.trust === 'untrusted') ? 'untrusted' : found.every(c => c.trust === 'managed') ? 'managed' : 'trusted';
      const ready = provider === 'codex' && found.length > 0 && found.every(c => c.enabled) && (trust === 'trusted' || trust === 'managed');
      const label = provider === 'claude' ? disabled ? 'Hooks disabled in settings' : found.length ? 'Configured · Session unverified' : 'No command in inspected settings'
        : !found.length ? 'No command found' : !found.every(c => c.enabled) ? 'Disabled in Codex' : trust === 'modified' ? 'Trust again' : trust === 'untrusted' ? 'Needs trust' : 'Enabled in Codex';
      const lifecycleNote = event === 'PostToolUse' ? (provider === 'claude' ? ' PostToolUse covers successful tools; PostToolUseFailure is a separate unsupported event. Feedback is appended; tool side effects remain.' : ' Feedback uses Codex native result presentation and is not a verified output-redaction operation; tool side effects remain.') : '';
      const reason = lifecycleNote + (provider === 'claude' ? 'User, project and local settings inspected. Managed policy, plugins and live session approval are not available through this file inventory. Claude has no per-command trust API. Configuration does not prove execution.' : 'Codex command enablement and definition trust inspected through hooks/list. Workspace approval and runtime matching are unverified. Configuration does not prove execution.');
      const status: ProviderEventStatus = {
        configured: provider === 'claude' && !found.length ? unknown('No command in inspected files; live inventory is incomplete') : known(found.length > 0, provider === 'codex' ? 'hooks/list' : 'settings files', checkedAt),
        providerEnabled: provider === 'claude' ? disabled ? known(false, 'disableAllHooks', checkedAt) : unknown('Effective session settings and managed policy unavailable') : found.length ? known(found.every(c => c.enabled), 'hooks/list', checkedAt) : unknown('No command'),
        commandApproval: provider === 'claude' ? unsupported('Claude does not expose per-command trust') : found.length ? known(trust, 'hooks/list', checkedAt) : unknown('No command'),
        workspaceApproval: unknown('The workbench cannot inspect current session workspace approval'),
        label, reason, ready, commandCount: found.length, inventory: found.map(({ source, command }) => ({ source, command })), complete: provider === 'codex',
      };
      base.providerEvents[event as HookEventId] = status;
      if (provider === 'codex' && found.length) {
        base.events ??= {}; base.events[event as HookEventId] = { enabled: found.every(command => command.enabled), trustStatus: trust, reason };
      }
    }
    for (const hook of data.hooks) {
      const parent = base.providerEvents[hook.event]!;
      const applicable = !hook.providers || hook.providers.includes(provider);
      const parents = commands.filter(command => command.event === hook.event && (referencesSource(command.command, hook.codexSource ?? hook.source, project) || isDispatcher(command.command, project, provider, data.registryPath)));
      base.hooks[hook.id] = !applicable ? { label: 'Unsupported provider', enabled: false, reason: `This stage is restricted to ${hook.providers?.join(', ')}.` }
        : !hook.enabledNow ? { label: 'Check switched off', enabled: false, reason: 'Saved sub-hook setting; parent approval is separate.' }
        : parents.length !== 1 ? { label: 'Unknown', enabled: false, reason: 'Cannot uniquely identify this stage’s parent command. Independent native commands do not prove dispatcher enablement.' }
        : { label: parent.label, enabled: hook.enabledNow, reason: parent.reason };
    }
  } catch (error) { base.error = error instanceof Error ? error.message : String(error); }
  return base;
}
export function createProviderMonitor(project: string, provider: HookProvider, selection?: string) {
  let state: ProviderStatusSnapshot = { provider, checkedAt: null, loading: true, error: null, hooks: {}, providerEvents: {} };
  let running: Promise<void> | undefined; let closed = false;
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (running) return running;
    state = { ...state, loading: true };
    running = readProviderStatus(project, provider, selection).then(next => { if (!closed) state = next; }).finally(() => { running = undefined; });
    return running;
  };
  // Lazy discovery avoids starting a second CLI unless that provider is selected.
  return { snapshot: () => state, refresh, close: () => { closed = true; } };
}
