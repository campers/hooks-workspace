import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rename, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createStatusMonitor, mapEventStatus, mapStatus, parseMetadata } from './codex-status.js';
import { loadHookControlPlaneData } from './loader.js';

const project = resolve('examples/demo');
const hook = loadHookControlPlaneData(project, {}).hooks[0];
const metadata = (trustStatus = 'trusted', enabled = true): Parameters<typeof mapStatus>[1] => [{
  eventName: hook.event[0].toLowerCase() + hook.event.slice(1), sourcePath: join(project, '.codex/hooks.json'), command: `node ${hook.source}`, enabled, trustStatus,
}];

test('untrusted, modified and disabled parent commands cannot appear active', (): void => {
  const child = { ...hook, enabledNow: true, codexSource: hook.source, source: 'internal-check.ts' };
  assert.equal(mapStatus(child, metadata('untrusted'), project).label, 'Needs trust');
  assert.equal(mapStatus(child, metadata('modified'), project).label, 'Trust again');
  assert.equal(mapStatus(child, metadata('trusted', false), project).label, 'Disabled in Codex');
  assert.equal(mapStatus(child, metadata(), project).enabled, true);
  assert.equal(mapStatus({ ...child, enabledNow: false }, metadata(), project).label, 'Check switched off');
  assert.equal(mapStatus(child, [], project).label, 'Unknown');
  assert.equal(mapStatus(child, [...metadata(), ...metadata()], project).label, 'Unknown');
});

test('changed Codex response formats and configuration errors are explicit failures', (): void => {
  assert.throws(() => parseMetadata({}, project), /updating/);
  assert.throws(() => parseMetadata({ data: [{ cwd: project, hooks: [], errors: ['bad config'], warnings: [] }] }, project), /configuration/);
  assert.throws(() => parseMetadata({ data: [{ cwd: project, hooks: metadata('new-status'), errors: [], warnings: [] }] }, project), /updating/);
  assert.equal(parseMetadata({ data: [{ cwd: project, hooks: metadata(), errors: [], warnings: [] }] }, project).length, 1);
});

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 7000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Watcher did not update'); await delay(50); }
}

test('config replacement refreshes trust automatically; read failures clear prior status and recover', async (t): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), 'hook-status-'));
  const config = join(directory, 'config.toml');
  await writeFile(config, '# initial');
  let trusted = true;
  let calls = 0;
  const monitor = createStatusMonitor(project, config, async () => { calls += 1; return metadata(trusted ? 'trusted' : 'untrusted'); });
  t.after(async (): Promise<void> => { monitor.close(); await rm(directory, { recursive: true, force: true }); });
  await until(() => !monitor.snapshot().loading);
  const before = calls;
  trusted = false;
  await writeFile(join(directory, 'replacement'), '# replacement');
  await rename(join(directory, 'replacement'), config);
  await until(() => calls > before && !monitor.snapshot().loading);
  assert.equal(monitor.snapshot().hooks[hook.id].label, 'Needs trust');
  await unlink(config);
  await until(() => !!monitor.snapshot().error && Object.keys(monitor.snapshot().hooks).length === 0);
  await writeFile(config, '# restored');
  await until(() => !monitor.snapshot().loading && !!monitor.snapshot().hooks[hook.id]);
  assert.equal(monitor.snapshot().hooks[hook.id].label, 'Needs trust');
});


test('event enablement and trust stay independent across all trust states', () => {
  for (const trust of ['trusted', 'managed', 'untrusted', 'modified'] as const) {
    for (const enabled of [true, false]) {
      const status = mapEventStatus(hook.event, 1, metadata(trust, enabled), project);
      assert.equal(status?.enabled, enabled);
      assert.equal(status?.trustStatus, trust);
    }
  }
  // A disabled sub-hook must not alter the event command's status.
  assert.equal(mapEventStatus(hook.event, 1, metadata(), project)?.enabled, true);
  assert.equal(mapStatus({ ...hook, enabledNow: false }, metadata(), project).enabled, false);
});

test('event summaries require complete discovery and check every project command', () => {
  assert.equal(mapEventStatus(hook.event, 1, [], project), undefined);
  assert.equal(mapEventStatus(hook.event, 0, metadata(), project), undefined);
  assert.equal(mapEventStatus(hook.event, 2, metadata(), project), undefined);
  const second = { ...metadata('untrusted', false)[0], command: 'node second.cjs' };
  assert.deepEqual(mapEventStatus(hook.event, 2, [...metadata(), second], project)?.trustStatus, 'untrusted');
  assert.equal(mapEventStatus(hook.event, 2, [...metadata(), second], project)?.enabled, false);
  assert.equal(mapEventStatus(hook.event, 1, [{ ...metadata()[0], sourcePath: '/other/hooks.json' }], project), undefined);
  assert.equal(mapEventStatus(hook.event, 1, [{ ...metadata()[0], eventName: 'other' }], project), undefined);
});
