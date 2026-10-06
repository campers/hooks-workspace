import { load } from 'js-yaml';
import { object } from './protocol.js';
import type { HookProvider } from '../src/hook-types.js';
export interface Stage { id: string; event: string; order: number; stage: string; source: string; canBlock: boolean; failurePolicy: string; enabled: { mode: string; environment?: string }; managed?: { enabled: boolean; blocking: boolean; dependsOn: string[] }; providers?: HookProvider[]; resultFormat?: 'neutral' | 'native'; nativeProvider?: HookProvider; allowInputRewrite?: boolean; timeoutMs?: number }
export function readStages(raw: string): Stage[] {
  const registry: unknown = load(raw);
  if (!object(registry) || !Array.isArray(registry.hooks)) throw new Error('Invalid registry');
  const ids = new Set<string>();
  for (const stage of registry.hooks) {
    if (!object(stage) || (typeof stage.id !== 'string' || !stage.id) || (ids.has(stage.id) || stage.id === 'dispatcher') || (typeof stage.source !== 'string' || !stage.source) || !['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop'].includes(String(stage.event)) || !Number.isSafeInteger(stage.order) || stage.failurePolicy !== 'fail-open' || !['prerequisite', 'blocker', 'advisory', 'finalizer'].includes(String(stage.stage)) || !object(stage.enabled) || !['always', 'opt-in', 'opt-out'].includes(String(stage.enabled.mode)) || typeof stage.canBlock !== 'boolean') throw new Error('Invalid stage definition');
    ids.add(stage.id);
    if (stage.enabled.environment !== undefined && typeof stage.enabled.environment !== 'string') throw new Error('Invalid environment switch');
    if (stage.allowInputRewrite !== undefined && typeof stage.allowInputRewrite !== 'boolean') throw new Error('Invalid input rewrite capability');
    if (stage.providers !== undefined && (!Array.isArray(stage.providers) || !stage.providers.every(p => p === 'codex' || p === 'claude'))) throw new Error('Invalid provider restriction');
    if (stage.resultFormat !== undefined && !['neutral', 'native'].includes(String(stage.resultFormat))) throw new Error('Invalid result format');
    if (stage.nativeProvider !== undefined && !['codex', 'claude'].includes(String(stage.nativeProvider))) throw new Error('Invalid native provider');
    if (stage.timeoutMs !== undefined && (!Number.isSafeInteger(stage.timeoutMs) || Number(stage.timeoutMs) < 1 || Number(stage.timeoutMs) > 30000)) throw new Error('Stage timeout must be 1–30000ms');
    if (stage.managed !== undefined && (!object(stage.managed) || typeof stage.managed.enabled !== 'boolean' || typeof stage.managed.blocking !== 'boolean' || !Array.isArray(stage.managed.dependsOn) || !stage.managed.dependsOn.every(id => typeof id === 'string') || (stage.managed.blocking && !stage.canBlock))) throw new Error('Invalid managed settings');
  }
  const stages = registry.hooks as unknown as Stage[];
  for (const stage of stages) {
    if (stages.some(s => s !== stage && s.event === stage.event && s.order === stage.order)) throw new Error('Duplicate execution position');
    for (const id of stage.managed?.dependsOn ?? []) {
      const dependency = stages.find(s => s.id === id);
      if (dependency && !(stage.providers ?? ['codex','claude']).some(provider => (dependency.providers ?? ['codex','claude']).includes(provider))) throw new Error('Prerequisites need at least one shared provider');
      if (!dependency || dependency.event !== stage.event || dependency.order >= stage.order) throw new Error('Prerequisites must run earlier in the same event');
    }
    if (stage.stage === 'finalizer' && stages.some(s => s.event === stage.event && s.stage !== 'finalizer' && s.order > stage.order)) throw new Error('Finalizers must run after checks');
  }
  return stages;
}
