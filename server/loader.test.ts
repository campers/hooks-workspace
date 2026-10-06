import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadHookControlPlaneData } from './loader.js';

function fixture(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'hooks-fixture-'));
  t.after((): void => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.codex/hooks'), { recursive: true });
  writeFileSync(join(root, 'review.cjs'), '// Project-specific hook source');
  writeRegistry(root);
  return root;
}
function writeRegistry(root: string, source = 'review.cjs'): void {
  writeFileSync(join(root, '.codex/hooks/registry.yaml'), JSON.stringify({ events: [{ id: 'Stop', label: 'Stop', description: 'Before finishing' }], hooks: [{ id: 'custom-check', event: 'Stop', stage: 'blocker', order: 1, enabled: { mode: 'opt-in', environment: 'MY_PROJECT_CHECK' }, source, label: 'Project review', when: 'Before finishing', does: 'Review work', why: 'Catch defects', calls: [], inputs: [], rules: [], outcomes: [], steps: [], sdlcGates: [], canBlock: true, failurePolicy: 'fail-open' }] }));
}
test('an unrelated project can show its hook source without history or installed hook configuration', (t): void => {
  const root = fixture(t);
  const data = loadHookControlPlaneData(root, {});
  assert.equal(data.loadError, null);
  assert.equal(data.hooks[0]?.label, 'Project review');
  assert.equal(data.hooks[0]?.references[0]?.content, '// Project-specific hook source');
  assert.deepEqual(data.traces, []);
  assert.equal(data.stopConfigured, false);
});
test('project-specific environment switches determine the displayed enablement', (t): void => {
  const root = fixture(t);
  assert.equal(loadHookControlPlaneData(root, {}).hooks[0]?.enabledNow, false);
  assert.equal(loadHookControlPlaneData(root, { MY_PROJECT_CHECK: 'true' }).hooks[0]?.enabledNow, true);
});
test('recorded runs retain project session and decision while malformed log lines are ignored', (t): void => {
  const root = fixture(t);
  const ledger = join(root, '.codex/hooks/state/event-ledger');
  mkdirSync(ledger, { recursive: true });
  writeFileSync(join(ledger, '2026-09-23.jsonl'), 'bad json\n' + JSON.stringify({ at: '2026-09-23T09:00:00Z', hookName: 'custom-check', hookEventName: 'Stop', decision: 'blocked', sessionId: 'project-session', turnId: 'turn-1', message: 'Review is missing' }) + '\n');
  const data = loadHookControlPlaneData(root, {});
  assert.equal(data.traces.length, 1);
  assert.equal(data.traces[0]?.decision, 'blocked');
  assert.equal(data.traces[0]?.sessionId, 'project-session');
});
test('a project with no registry gets an actionable error instead of invented hook definitions', (t): void => {
  const root = fixture(t);
  rmSync(join(root, '.codex/hooks/registry.yaml'));
  const data = loadHookControlPlaneData(root, {});
  assert.match(data.loadError ?? '', /registry.yaml/);
  assert.equal(data.hooks.length, 0);
});
test('invalid registry structure is reported', (t): void => {
  const root = fixture(t);
  writeFileSync(join(root, '.codex/hooks/registry.yaml'), 'hooks: wrong');
  assert.match(loadHookControlPlaneData(root, {}).loadError ?? '', /events and hooks/);
});
test('a reference cannot traverse outside the selected project', (t): void => {
  const root = fixture(t);
  const outside = join(root, '../' + root.split('/').at(-1) + '-secret.txt');
  writeFileSync(outside, 'private');
  t.after((): void => rmSync(outside, { force: true }));
  writeRegistry(root, '../' + outside.split('/').at(-1));
  assert.match(loadHookControlPlaneData(root, {}).loadError ?? '', /inside the repository/);
});
test('a symlink reference cannot expose files outside the selected project', (t): void => {
  const root = fixture(t);
  const outside = mkdtempSync(join(tmpdir(), 'hooks-private-'));
  t.after((): void => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'secret.txt'), 'private');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'linked.txt'));
  writeRegistry(root, 'linked.txt');
  const data = loadHookControlPlaneData(root, {});
  assert.match(data.loadError ?? '', /inside the repository/);
  assert.equal(data.hooks.length, 0);
});
test('bundled demo loads without another project or external services', (): void => {
  const data = loadHookControlPlaneData(resolve('examples/demo'), {});
  assert.equal(data.loadError, null);
  assert.equal(data.hooks[0]?.id, 'demo-review');
  assert.equal(data.traces[0]?.decision, 'passed');
});
test('Stop configuration accepts another project runner and ignores unrelated command text', (t): void => {
  const root = fixture(t);
  const configPath = join(root, '.codex/hooks.json');
  writeFileSync(configPath, JSON.stringify({ description: '.codex/hooks/unregistered-runner.cjs', hooks: {} }));
  assert.equal(loadHookControlPlaneData(root, {}).stopConfigured, false);
  writeFileSync(configPath, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node tooling/finish.cjs' }] }] } }));
  assert.equal(loadHookControlPlaneData(root, {}).stopConfigured, true);
});
for (const file of ['.codex/hooks/registry.yaml', '.codex/hooks.json', '.codex/hooks/state/event-ledger/2026-09-23.jsonl']) {
  test(`project reads reject an external symlink at ${file}`, (t): void => {
    const root = fixture(t);
    const outside = mkdtempSync(join(tmpdir(), 'hooks-external-'));
    t.after((): void => rmSync(outside, { recursive: true, force: true }));
    writeFileSync(join(outside, 'data'), '{}');
    const target = join(root, file);
    mkdirSync(join(target, '..'), { recursive: true });
    rmSync(target, { force: true });
    symlinkSync(join(outside, 'data'), target);
    assert.match(loadHookControlPlaneData(root, {}).loadError ?? '', /inside the repository/);
  });
}


test('entry status counts configured commands for every lifecycle event independently', (t): void => {
  const root = fixture(t);
  const command = { type: 'command', command: 'node hook.cjs' };
  writeFileSync(join(root, '.codex/hooks.json'), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [command] }],
    UserPromptSubmit: [{ hooks: [command, command] }],
    PreToolUse: [{ hooks: [command] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: ' ' }] }],
    Stop: [{ hooks: [command] }],
  } }));
  const data = loadHookControlPlaneData(root, {});
  assert.equal(data.loadError, null);
  assert.deepEqual(data.configuredCommands, { SessionStart: 1, UserPromptSubmit: 2, PreToolUse: 1, PostToolUse: 0, Stop: 1 });
});
