import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMetadata, mapEventStatus, mapStatus } from './codex-status.js';
import { loadHookControlPlaneData } from './loader.js';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/providers/${name}.json`, import.meta.url), 'utf8')) as T;
type Row = Record<string, unknown>;
type Discovery = { data: { hooks: { trustStatus: string }[] }[] };
type Turn = { usage: { input_tokens: number; output_tokens: number }; type: string };
const project = '/fixture/project';

test('real Codex discovery distinguishes configured enablement from missing approval', () => {
  const metadata = parseMetadata(fixture('codex-discovery'), project);
  assert.equal(metadata.length, 2);
  const data = loadHookControlPlaneData(resolve('examples/demo'), {});
  const hook = { ...data.hooks[0], event: 'UserPromptSubmit' as const, source: 'capture.cjs', enabledNow: true };
  assert.equal(mapEventStatus('UserPromptSubmit', 1, metadata, project)?.enabled, true);
  assert.equal(mapEventStatus('UserPromptSubmit', 1, metadata, project)?.trustStatus, 'untrusted');
  assert.equal(mapStatus(hook, metadata, project).enabled, false);
  assert.equal(mapStatus(hook, metadata, project).label, 'Needs trust');
});

test('discovery for a different selected project cannot become this project status', () => {
  assert.throws(() => parseMetadata(fixture('codex-discovery'), '/fixture/other-project'), /Missing project/);
});

test('a future unknown trust value from the captured protocol fails explicitly', () => {
  const response = fixture<Discovery>('codex-discovery');
  response.data[0].hooks[0].trustStatus = 'future-status';
  assert.throws(() => parseMetadata(response, project), /Unknown hook metadata/);
});

test('CLI-generated inputs preserve provider differences instead of inventing identifiers', () => {
  const codex = fixture<Row[]>('codex-inputs');
  const claude = fixture<Row[]>('claude-inputs');
  for (const inputs of [codex, claude]) {
    assert.deepEqual(inputs.map((row) => row.hook_event_name), ['SessionStart', 'UserPromptSubmit']);
    assert.equal(inputs[0].session_id, inputs[1].session_id);
    assert.equal(inputs[1].prompt, 'Fixture prompt blocked before model access.');
    assert.equal(inputs[1].cwd, project);
  }
  assert.equal(codex[1].transcript_path, null);
  assert.equal(typeof codex[1].turn_id, 'string');
  assert.equal(typeof claude[1].transcript_path, 'string');
  assert.equal('turn_id' in claude[1], false);
  assert.equal(typeof claude[1].prompt_id, 'string');
});

test('captured CLI success includes separate evidence of prompt rejection', () => {
  const events = fixture<Row[]>('claude-blocked-turn');
  const result = events.find((row) => row.type === 'result');
  const rejection = events.find((row) => row.subtype === 'informational' && row.prevent_continuation === true);
  assert.ok(result);
  assert.equal(result.subtype, 'success');
  assert.equal(result.is_error, false);
  assert.ok(rejection, 'The same successful CLI result also contains a blocked-prompt notification');
  assert.match(String(rejection.content), /blocked by hook/);
  assert.equal(result.num_turns, 0);
  assert.equal(result.total_cost_usd, 0);
  const codexTurn = fixture<Turn[]>('codex-blocked-turn').find((row) => row.type === 'turn.completed');
  assert.ok(codexTurn);
  assert.equal(codexTurn.usage.input_tokens, 0);
  assert.equal(codexTurn.usage.output_tokens, 0);
  assert.equal(fixture<Row>('provenance').codexTrustBypassedForExecution, true);
});

test('real Codex malformed-config warnings cannot become an empty healthy status', () => {
  assert.throws(() => parseMetadata(fixture('codex-invalid-config'), project), /configuration errors or warnings/);
});

test('all captured artifacts belong to the same reviewed fixture bundle', () => {
  const manifest = fixture<{ fileDigests: Record<string, string> }>('provenance');
  for (const [name, digest] of Object.entries(manifest.fileDigests)) {
    const contents = readFileSync(new URL(`./fixtures/providers/${name}`, import.meta.url));
    assert.equal(createHash('sha256').update(contents).digest('hex'), digest, `${name} was modified without updating capture provenance`);
  }
  assert.equal(Object.keys(manifest.fileDigests).length, 7);
});

test('real CLIs invoke the shared dispatcher and consume its prompt rejection', () => {
  const rows = fixture<Row[]>('dispatcher-runs');
  for (const provider of ['codex', 'claude']) {
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      const stage = rows.find(row => row.provider === provider && row.hookName === event && row.kind === 'completed');
      assert.ok(stage); assert.equal(stage.decision, event === 'UserPromptSubmit' ? 'blocked' : 'passed');
      const parent = rows.find(row => row.invocationId === stage.invocationId && row.hookName === 'dispatcher' && row.kind === 'completed');
      assert.ok(parent); assert.equal(parent.decision, stage.decision);
    }
  }
});

test('all-event native CLI fixtures prove denial, permitted side effects and Stop continuation', () => {
  const captures = fixture<{ provider: string; configEvents: string[]; observedEvents: string[]; version: string; rounds: number; deniedSentinelAbsent: boolean; allowedSentinelPresent: boolean; inputs: Row[]; ledger: Row[] }[]>('native-lifecycle');
  assert.deepEqual(captures.map(capture => capture.provider), ['claude','codex']);
  for (const capture of captures) {
    assert.ok(capture.version); assert.equal(capture.deniedSentinelAbsent,true); assert.equal(capture.allowedSentinelPresent,true); assert.equal(capture.rounds,4);
    assert.deepEqual(new Set(capture.inputs.map(input => input.hook_event_name)), new Set(['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','Stop']));
    assert.equal(capture.configEvents.length,capture.provider==='codex'?8:10);
    assert.ok(capture.observedEvents.includes('SessionEnd'));
    assert.ok(capture.ledger.some(row=>row.kind==='observed'&&row.hookEventName==='SessionEnd'));
    const before = capture.ledger.filter(row => row.hookName === 'PreToolUse' && row.kind === 'completed');
    assert.deepEqual(before.map(row => row.decision), ['blocked','passed']);
    assert.ok(capture.ledger.some(row => row.hookName === 'PostToolUse' && row.decision === 'blocked'));
    const stop = capture.ledger.filter(row => row.hookName === 'Stop' && row.kind === 'completed');
    assert.equal(stop[0].decision,'blocked'); assert.equal(stop.at(-1)?.decision,'passed');
    const started = capture.ledger.filter(row => row.hookName === 'dispatcher' && row.kind === 'started');
    assert.equal(new Set(started.map(row => row.invocationId)).size,started.length);
  }
  const manifest = fixture<{ remoteModelRequests: number; fileDigests: Record<string,string> }>('native-lifecycle-provenance');
  assert.equal(manifest.remoteModelRequests,0);
  for (const [name,digest] of Object.entries(manifest.fileDigests)) assert.equal(createHash('sha256').update(readFileSync(new URL(`./fixtures/providers/${name}`,import.meta.url))).digest('hex'),digest);
});
