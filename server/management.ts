import { readStages } from '../runtime/registry.js';
import { resolveRegistry } from './registry.js';
import { readFileSync, realpathSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { load, dump } from 'js-yaml';

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function registryRevision(raw: string): string { return createHash('sha256').update(raw).digest('hex'); }
export function saveManagement(project: string, input: unknown, selection?: string): void {
  if (!record(input) || typeof input.revision !== 'string' || !Array.isArray(input.hooks)) throw new Error('Invalid settings request');
  const root = realpathSync(project);
  const file = resolveRegistry(root, selection);
  if (!file.startsWith(root + sep)) throw new Error('Registry must stay inside the project');
  const raw = readFileSync(file, 'utf8');
  if (registryRevision(raw) !== input.revision) throw new Error('Configuration changed. Reload before saving.');
  const registry: unknown = load(raw);
  if (!record(registry) || registry.managementVersion !== 1 || !Array.isArray(registry.hooks)) throw new Error('This project does not support managed hooks');
  const hooks = registry.hooks;
  if (hooks.length !== input.hooks.length || !hooks.every(record)) throw new Error('Hook list does not match the project');
  const seen = new Set<string>();
  for (const patch of input.hooks) {
    if (!record(patch) || typeof patch.id !== 'string' || seen.has(patch.id) || typeof patch.enabled !== 'boolean' || typeof patch.blocking !== 'boolean' || !Number.isInteger(patch.order) || !Array.isArray(patch.dependsOn) || !patch.dependsOn.every((id: unknown) => typeof id === 'string')) throw new Error('Invalid hook settings');
    const hook = hooks.find((item) => item.id === patch.id);
    if (!hook || (patch.blocking && !hook.canBlock)) throw new Error('Unsupported hook or blocking setting');
    seen.add(patch.id);
    hook.order = patch.order;
    hook.managed = { enabled: patch.enabled, blocking: patch.blocking, dependsOn: patch.dependsOn };
  }
  for (const hook of hooks) {
    const managed = hook.managed;
    if (!record(managed) || !Array.isArray(managed.dependsOn)) throw new Error('Missing managed settings');
    if (hooks.some((other) => other !== hook && other.event === hook.event && other.order === hook.order)) throw new Error('Each stage needs a distinct position');
    for (const id of managed.dependsOn) {
      const dependency = hooks.find((other) => other.id === id);
      if (!dependency || dependency.event !== hook.event || Number(dependency.order) >= Number(hook.order)) throw new Error('Prerequisites must belong to this event and run earlier');
    }
    if (hook.stage === 'finalizer' && hooks.some((other) => other.event === hook.event && other.stage !== 'finalizer' && Number(other.order) > Number(hook.order))) throw new Error('Finalizers must run after all checks');
  }
  readStages(dump(registry));
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, dump(registry, { lineWidth: 120, noRefs: true }), { flag: 'wx', mode: 0o600 });
    if (registryRevision(readFileSync(file, 'utf8')) !== input.revision) throw new Error('Configuration changed. Reload before saving.');
    renameSync(temporary, file);
  } finally { try { unlinkSync(temporary); } catch { /* Renamed successfully. */ } }
}
