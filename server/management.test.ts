import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { registryRevision, saveManagement } from './management.js';

function fixture(t: { after: (fn: () => void) => void }): { root: string; file: string; revision: string } {
 const root = mkdtempSync(join(tmpdir(), 'managed-hooks-'));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 mkdirSync(join(root, '.codex/hooks'), { recursive: true });
 const file = join(root, '.codex/hooks/registry.yaml');
 const raw = JSON.stringify({ managementVersion: 1, hooks: [
  { id: 'a', event: 'Stop', order: 10, stage: 'prerequisite', canBlock: false },
  { id: 'b', event: 'Stop', order: 20, stage: 'blocker', canBlock: true },
  { id: 'c', event: 'Stop', order: 30, stage: 'finalizer', canBlock: false },
 ].map(hook => ({ ...hook, source: hook.id + '.cjs', enabled: { mode: 'always' }, failurePolicy: 'fail-open' })) });
 writeFileSync(file, raw); return { root, file, revision: registryRevision(raw) };
}
function patches(): { id: string; order: number; enabled: boolean; blocking: boolean; dependsOn: string[] }[] {
 return ['a', 'b', 'c'].map((id, index) => ({ id, order: (index + 1) * 10, enabled: id !== 'b', blocking: false, dependsOn: id === 'b' ? ['a'] : [] }));
}
test('saved switches and prerequisites persist, and a stale browser cannot overwrite them', (t) => {
 const f = fixture(t); saveManagement(f.root, { revision: f.revision, hooks: patches() });
 const saved = load(readFileSync(f.file, 'utf8')) as { hooks: { managed: { enabled: boolean; dependsOn: string[] } }[] };
 assert.equal(saved.hooks[1].managed.enabled, false); assert.deepEqual(saved.hooks[1].managed.dependsOn, ['a']);
 assert.throws(() => saveManagement(f.root, { revision: f.revision, hooks: patches() }), /Configuration changed/);
});
test('invalid dependencies, premature finalizers and unsupported blocking leave the file unchanged', (t) => {
 const f = fixture(t); const before = readFileSync(f.file, 'utf8');
 for (const kind of ['dependency', 'finalizer', 'blocking', 'duplicate']) {
  const hooks = patches();
  if (kind === 'dependency') hooks[0].dependsOn = ['b'];
  if (kind === 'finalizer') hooks[2].order = 5;
  if (kind === 'blocking') hooks[0].blocking = true;
  if (kind === 'duplicate') hooks[0].id = 'b';
  assert.throws(() => saveManagement(f.root, { revision: f.revision, hooks }));
  assert.equal(readFileSync(f.file, 'utf8'), before);
 }
});
test('managed writes cannot escape the project through a registry symlink', (t) => {
 const f = fixture(t); const other = fixture(t); rmSync(f.file); symlinkSync(other.file, f.file);
 assert.throws(() => saveManagement(f.root, { revision: other.revision, hooks: patches() }), /inside/);
});
