import { existsSync, realpathSync } from 'node:fs';
import { resolve, sep, dirname, join } from 'node:path';

export function containedPath(project: string, path: string): string {
  const root = realpathSync(project);
  const actual = realpathSync(resolve(root, path));
  if (!actual.startsWith(root + sep)) throw new Error('Hook files must stay inside the repository (inside the project)');
  return actual;
}
export function resolveRegistry(project: string, selection?: string): string {
  if (selection) return containedPath(project, selection);
  const candidates = ['.hooks-workspace/registry.yaml', '.codex/hooks/registry.yaml'].filter(path => existsSync(resolve(project, path)));
  if (candidates.length > 1) throw new Error('Both registries exist. Select one with --registry; no automatic migration is performed.');
  if (!candidates.length) throw new Error('No registry found. Expected .hooks-workspace/registry.yaml or .codex/hooks/registry.yaml');
  return containedPath(project, candidates[0]);
}
export function stateDirectory(project: string, selection?: string): string {
  if (!selection && !existsSync(resolve(project, '.hooks-workspace/registry.yaml')) && !existsSync(resolve(project, '.codex/hooks/registry.yaml'))) return resolve(project, '.codex/hooks/state');
  return join(dirname(resolveRegistry(project, selection)), 'state');
}
