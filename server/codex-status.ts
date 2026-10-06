import { spawn } from 'node:child_process';
import { watchFile, unwatchFile } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { CodexEventStatus, CodexStatusSnapshot, HookDefinition, HookEventId } from '../src/hook-types.js';
import { loadHookControlPlaneData } from './loader.js';

interface Metadata { eventName: string; sourcePath: string; command: string; enabled: boolean; trustStatus: string }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }

export function parseMetadata(value: unknown, project: string): Metadata[] {
  if (!record(value) || !Array.isArray(value.data)) throw new Error('Unexpected hooks/list response; the Codex integration may need updating.');
  const entry = value.data.find((item: unknown): boolean => record(item) && item.cwd === project);
  if (!record(entry) || !Array.isArray(entry.hooks) || !Array.isArray(entry.errors) || !Array.isArray(entry.warnings)) throw new Error('Missing project hook metadata; the Codex integration may need updating.');
  if (entry.errors.length || entry.warnings.length) throw new Error('Codex reported hook configuration errors or warnings. Check the hooks in Codex.');
  return entry.hooks.map((hook: unknown): Metadata => {
    if (!record(hook) || typeof hook.eventName !== 'string' || typeof hook.sourcePath !== 'string' || typeof hook.enabled !== 'boolean' || typeof hook.trustStatus !== 'string' || !['managed', 'trusted', 'untrusted', 'modified'].includes(hook.trustStatus)) throw new Error('Unknown hook metadata format; the Codex integration needs updating.');
    return { eventName: hook.eventName, sourcePath: hook.sourcePath, command: typeof hook.command === 'string' ? hook.command : '', enabled: hook.enabled, trustStatus: hook.trustStatus };
  });
}

export function readCodexHooks(project: string): Promise<Metadata[]> {
  return new Promise((accept, reject): void => {
    const child = spawn('codex', ['app-server', '--stdio'], { cwd: project, stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = createInterface({ input: child.stdout });
    let finished = false;
    const finish = (error: Error | null, result: Metadata[] = []): void => {
      if (finished) return;
      finished = true; clearTimeout(timer); lines.close(); child.kill();
      if (error) reject(error); else accept(result);
    };
    const timer = setTimeout((): void => finish(new Error('Codex hook status timed out after 15 seconds.')), 15000);
    const send = (message: object): void => { child.stdin.write(JSON.stringify(message) + '\n'); };
    child.on('error', (): void => finish(new Error('Could not start Codex. Make sure codex is installed and available on PATH.')));
    child.stdin.on('error', (): void => finish(new Error('Codex closed the status connection.')));
    child.on('exit', (): void => finish(new Error('Codex exited before returning hook status.')));
    lines.on('line', (line): void => {
      try {
        const message: unknown = JSON.parse(line);
        if (!record(message)) return;
        if ((message.id === 1 || message.id === 2) && message.error) throw new Error('Codex rejected the hook status request. The integration may need updating.');
        if (message.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'hooks/list', params: { cwds: [project] } });
        }
        if (message.id === 2) finish(null, parseMetadata(message.result, project));
      } catch (error) { finish(error instanceof Error ? error : new Error('Invalid Codex response.')); }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'hooks_workbench', version: '0.1.0' }, capabilities: { experimentalApi: true } } });
  });
}

// References checked 2026-10-04. Codex's hooks/list supplies enablement separately from trust:
// https://developers.openai.com/codex/app-server (hooks/list)
// https://developers.openai.com/codex/hooks#review-and-trust-hooks
// Non-managed hooks require trust of the current definition; modified hashes need
// review again. Managed hooks are trusted by policy. Neither condition proves a run.
export function mapEventStatus(event: HookEventId, commandCount: number, metadata: Metadata[], project: string): CodexEventStatus | undefined {
  const eventName = event[0].toLowerCase() + event.slice(1);
  const commands = metadata.filter((item) => item.eventName === eventName && resolve(item.sourcePath) === join(project, '.codex/hooks.json') && item.command.trim());
  // Config presence alone cannot establish trust. Missing/partial discovery is unknown.
  if (!commandCount || commands.length !== commandCount) return undefined;
  const enabled = commands.every((command) => command.enabled);
  const trustStatus = commands.some((command) => command.trustStatus === 'modified') ? 'modified'
    : commands.some((command) => command.trustStatus === 'untrusted') ? 'untrusted'
    : commands.every((command) => command.trustStatus === 'managed') ? 'managed' : 'trusted';
  return { enabled, trustStatus, reason: `${commandCount === 1 ? 'Command' : 'All project commands'}: ${enabled ? 'enabled' : 'one or more disabled'}. ${trustStatus === 'managed' ? 'Trusted by managed policy.' : trustStatus === 'modified' ? 'Definition changed; review and trust again in Codex.' : trustStatus === 'untrusted' ? 'Trust required in Codex.' : 'Trusted in Codex.'} This is configuration status, not recorded execution.` };
}

export function mapStatus(hook: HookDefinition, metadata: Metadata[], project: string): CodexStatusSnapshot['hooks'][string] {
  const event = hook.event[0].toLowerCase() + hook.event.slice(1);
  const source = hook.codexSource ?? hook.source;
  const matches = metadata.filter((item): boolean => item.eventName === event && resolve(item.sourcePath) === join(project, '.codex/hooks.json') && item.command.includes(source));
  if (matches.length !== 1) return { label: 'Unknown', enabled: false, reason: 'Cannot uniquely match this check to a Codex command. Update its registry codexSource mapping.' };
  const parent = matches[0];
  const prefix = hook.codexSource ? 'Parent command: ' : '';
  if (parent.trustStatus === 'modified') return { label: 'Trust again', enabled: false, reason: prefix + 'The command changed since approval. Review and trust it in Codex.' };
  if (parent.trustStatus === 'untrusted') return { label: 'Needs trust', enabled: false, reason: prefix + 'This command has not been trusted in Codex.' };
  if (!parent.enabled) return { label: 'Disabled in Codex', enabled: false, reason: prefix + 'This command is switched off in Codex.' };
  if (!hook.enabledNow) return { label: 'Check switched off', enabled: false, reason: hook.managed ? 'This sub-hook is switched off in the project registry.' : 'Codex permits the command, but this check is off in the workbench process environment. An agent may use different environment settings.' };
  return { label: 'Enabled in Codex', enabled: true, reason: prefix + (hook.managed ? 'Trusted and enabled. This sub-hook is enabled in the project registry; execution depends on its trigger and prerequisites.' : 'Trusted and enabled. This check is on in the workbench environment; execution still depends on the agent environment and trigger.') };
}

export function createStatusMonitor(project: string, configPath = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'), reader = readCodexHooks): { snapshot: () => CodexStatusSnapshot; refresh: () => Promise<void>; close: () => void } {
  let state: CodexStatusSnapshot = { checkedAt: null, error: null, loading: true, hooks: {} };
  let running: Promise<void> | null = null;
  let dirty = false;
  let closed = false;
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (running) { dirty = true; return running; }
    state = { ...state, loading: true, hooks: {}, events: {} };
    running = (async (): Promise<void> => {
      try {
        await access(configPath);
        const data = loadHookControlPlaneData(project);
        if (data.loadError) throw new Error(data.loadError);
        const metadata = await reader(project);
        const hooks = Object.fromEntries(data.hooks.map((hook) => [hook.id, mapStatus(hook, metadata, project)]));
        const events = Object.fromEntries(data.events.flatMap(({ id }) => {
          const status = mapEventStatus(id, data.configuredCommands?.[id] ?? 0, metadata, project);
          return status ? [[id, status]] : [];
        }));
        const unmatched = Object.values(hooks).some((hook): boolean => hook.label === 'Unknown');
        state = { checkedAt: new Date().toISOString(), loading: false, hooks, events, error: unmatched ? 'Some checks could not be matched to Codex. Their registry mappings need updating.' : null };
      } catch (error) {
        state = { checkedAt: new Date().toISOString(), loading: false, hooks: {}, events: {}, error: error instanceof Error ? error.message : 'Could not read Codex status.' };
      }
    })().finally((): void => { running = null; if (dirty && !closed) { dirty = false; void refresh(); } });
    return running;
  };
  const paths = [configPath, join(project, '.codex/hooks.json'), join(project, '.codex/hooks/registry.yaml')];
  const changed = (): void => { void refresh(); };
  for (const path of paths) watchFile(path, { interval: 1000, persistent: false }, changed);
  void refresh();
  return { snapshot: (): CodexStatusSnapshot => state, refresh, close: (): void => { closed = true; for (const path of paths) unwatchFile(path, changed); } };
}
