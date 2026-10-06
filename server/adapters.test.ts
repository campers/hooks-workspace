import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { dispatch } from '../runtime/dispatcher.js';
import { decodeInvocation, parseResult, encodeEffects, validateEffect } from '../runtime/protocol.js';
import { resolveRegistry } from './registry.js';
import { readClaudeSettings, readProviderStatus } from './providers.js';
import { saveManagement, registryRevision } from './management.js';
import { loadHookControlPlaneData } from './loader.js';
import { loadTokenUsage } from './usage.js';
import type { ExecutionContext } from '../src/workspace-types.js';
import type { HookProvider, HookEventId } from '../src/hook-types.js';

function fixture(t: { after: (fn: () => void) => void }) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'adapter-test-')));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(join(project, '.hooks-workspace'));
  const file = join(project, '.hooks-workspace/registry.yaml');
  const stage = (id: string, event: HookEventId = 'PreToolUse', order = 10, extras = {}) => ({ id, event, order, stage: 'blocker', source: `${id}.cjs`, enabled: { mode: 'always' }, managed: { enabled: true, blocking: true, dependsOn: [] }, failurePolicy: 'fail-open', canBlock: true, resultFormat: 'neutral', ...extras });
  const set = (hooks: unknown[]) => writeFileSync(file, dump({ version: 1, managementVersion: 1, events: [], hooks }));
  const script = (id: string, result: unknown, extra = '') => writeFileSync(join(project, `${id}.cjs`), `${extra}\nconsole.log(${JSON.stringify(JSON.stringify(result))});`);
  const input = (event: HookEventId = 'PreToolUse', extra = {}) => ({ hook_event_name: event, cwd: project, session_id: 'session', tool_name: 'Bash', tool_input: { command: 'write sentinel' }, ...extra });
  const traces = () => readFileSync(join(project, '.hooks-workspace/state/event-ledger', new Date().toISOString().slice(0,10) + '.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  return { project, file, stage, set, script, input, traces };
}
for (const provider of ['codex', 'claude'] as const) {
  test(`${provider}: captured native input retains provider identifiers and nullable transcript`, () => {
    const inputs = JSON.parse(readFileSync(new URL(`./fixtures/providers/${provider}-inputs.json`, import.meta.url), 'utf8'));
    for (const input of inputs) {
      const invocation = decodeInvocation(provider, input);
      assert.equal(invocation.native, input);
      assert.equal(invocation.permissionMode, input.permission_mode ?? null);
      assert.equal(invocation.turnId, input.turn_id ?? null);
      assert.equal(invocation.promptId, input.prompt_id ?? null);
      assert.equal(invocation.transcriptPath, input.transcript_path ?? null);
    }
  });
  for (const [event, action, expected] of [
    ['SessionStart', 'context', { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'fixture message' } }],
    ['UserPromptSubmit', 'rejectPrompt', { decision: 'block', reason: 'fixture message' }],
    ['PreToolUse', 'denyTool', { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'fixture message' } }],
    ['PostToolUse', 'feedback', { decision: 'block', reason: 'fixture message' }],
    ['Stop', 'continueStop', { decision: 'block', reason: 'fixture message' }],
  ] as const) {
    test(`${provider}: ${event} dispatch executes stage and emits native ${action}`, async t => {
      const f = fixture(t); f.set([f.stage('check', event)]);
      f.script('check', { outcome: action === 'context' ? 'passed' : 'failed', effects: [{ action, message: 'fixture message' }] }, "require('node:fs').writeFileSync('stage-ran', 'yes');");
      assert.deepEqual(await dispatch(f.project, provider, f.input(event)), expected);
      assert.equal(readFileSync(join(f.project, 'stage-ran'), 'utf8'), 'yes');
      assert.equal(f.traces()[1].provider, provider);
      assert.equal(f.traces()[1].decision, action === 'context' ? 'passed' : 'blocked');
    });
  }
  test(`${provider}: normal pass never grants tool permission`, async t => {
    const f = fixture(t); f.set([f.stage('pass')]); f.script('pass', { outcome: 'passed', effects: [] });
    assert.deepEqual(await dispatch(f.project, provider, f.input()), {});
  });
  test(`${provider}: deny short-circuits checks but executes finalizers`, async t => {
    const f = fixture(t); f.set([f.stage('deny'), f.stage('later', 'PreToolUse', 20), f.stage('finish', 'PreToolUse', 30, { stage: 'finalizer' })]);
    f.script('deny', { outcome: 'failed', effects: [{ action: 'denyTool', message: 'No' }] });
    f.script('later', { outcome: 'passed', effects: [] }, "require('node:fs').writeFileSync('bad-sentinel', 'ran');");
    f.script('finish', { outcome: 'passed', effects: [] }, "require('node:fs').writeFileSync('finished', 'yes');");
    await dispatch(f.project, provider, f.input());
    assert.equal(existsSync(join(f.project, 'bad-sentinel')), false); assert.equal(existsSync(join(f.project, 'finished')), true);
    assert.equal(f.traces().find(row => row.hookName === 'later')?.message, 'short-circuited');
  });
  test(`${provider}: Stop loop guard suppresses repeat continuation`, async t => {
    const f = fixture(t); f.set([f.stage('stop', 'Stop')]); f.script('stop', { outcome: 'failed', effects: [{ action: 'continueStop', message: 'Again' }] });
    assert.deepEqual(await dispatch(f.project, provider, f.input('Stop', { stop_hook_active: true })), {});
    assert.match(String(f.traces()[1].message), /loop guard/);
  });
}
test('advisory failure and provider-restricted prerequisites never count as passed', async t => {
  const f = fixture(t);
  for (const extras of [{ providers: ['codex'] }, { managed: { enabled: true, blocking: false, dependsOn: [] } }, { managed: { enabled: false, blocking: true, dependsOn: [] } }]) {
    f.set([f.stage('prerequisite', 'PreToolUse', 10, extras), f.stage('dependent', 'PreToolUse', 20, { managed: { enabled: true, blocking: true, dependsOn: ['prerequisite'] } })]);
    f.script('prerequisite', { outcome: 'failed', effects: [{ action: 'denyTool', message: 'Failed' }] });
    f.script('dependent', { outcome: 'passed', effects: [] }, "require('node:fs').writeFileSync('dependent-ran', 'yes');");
    assert.deepEqual(await dispatch(f.project, 'claude', f.input()), {});
    assert.equal(existsSync(join(f.project, 'dependent-ran')), false);
  }
});
test('malformed, unsupported output and timeouts fail open, skip dependents and run finalizers', async t => {
  const f = fixture(t);
  for (const source of ["console.log('malformed')", "console.log(JSON.stringify({continue:false}))", "setInterval(()=>{}, 1000)"]) {
    f.set([f.stage('bad', 'PreToolUse', 10, { resultFormat: 'native', timeoutMs: 100 }), f.stage('dependent', 'PreToolUse', 20, { managed: { enabled: true, blocking: true, dependsOn: ['bad'] } }), f.stage('finish', 'PreToolUse', 30, { stage: 'finalizer' })]);
    writeFileSync(join(f.project, 'bad.cjs'), source);
    f.script('finish', { outcome: 'passed', effects: [] });
    assert.deepEqual(await dispatch(f.project, 'codex', f.input()), {});
  }
  assert.equal(f.traces().filter(row => row.hookName === 'bad' && row.kind === 'error').length, 3);
  assert.equal(f.traces().filter(row => row.hookName === 'dependent' && row.kind === 'skipped').length, 3);
});
test('rewrites require explicit registry opt-in; Claude rewrite does not autoapprove', async t => {
  const f = fixture(t); f.script('rewrite', { outcome: 'passed', effects: [{ action: 'rewriteToolInput', input: { command: 'safe' } }] });
  f.set([f.stage('rewrite')]); assert.deepEqual(await dispatch(f.project, 'codex', f.input()), {});
  f.set([f.stage('rewrite', 'PreToolUse', 10, { allowInputRewrite: true })]);
  assert.deepEqual(await dispatch(f.project, 'claude', f.input()), { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'safe' } } });
  assert.deepEqual(await dispatch(f.project, 'codex', f.input()), { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'safe' }, permissionDecision: 'allow' } });
});
test('native permission allow and cross-provider PostToolUse semantics cannot silently pass', () => {
  assert.throws(() => parseResult('{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}', decodeInvocation('claude', { hook_event_name: 'PreToolUse' })), /Permission/);
  assert.throws(() => parseResult('{"decision":"block","reason":"redact"}', decodeInvocation('claude', { hook_event_name: 'PostToolUse' }), 'native', 'codex'), /different provider semantics/);
  assert.throws(() => validateEffect({ action: 'denyTool', message: 'no' }, decodeInvocation('codex', { hook_event_name: 'Stop' })), /not supported/);
});
test('exit 2 becomes event-specific denial; ordinary nonzero exits fail open', async t => {
  const f = fixture(t); f.set([f.stage('exit', 'PreToolUse', 10, { resultFormat: 'native' })]);
  writeFileSync(join(f.project, 'exit.cjs'), "console.error('Denied fixture');process.exit(2)");
  assert.deepEqual(await dispatch(f.project, 'claude', f.input()), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Denied fixture' } });
  writeFileSync(join(f.project, 'exit.cjs'), 'process.exit(1)');
  assert.deepEqual(await dispatch(f.project, 'claude', f.input()), {});
});
test('concurrent invocations use distinct ledger identities and preserve every row', async t => {
  const f = fixture(t); f.set([f.stage('pass')]); f.script('pass', { outcome: 'passed', effects: [] });
  await Promise.all([dispatch(f.project, 'codex', f.input()), dispatch(f.project, 'claude', f.input())]);
  const rows = f.traces(); assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map(row => row.invocationId)).size, 2);
  for (const provider of ['codex', 'claude']) assert.equal(rows.filter(row => row.provider === provider).length, 3);
});
test('registry selection is explicit when neutral and legacy files coexist; saves affect selected file only', t => {
  const f = fixture(t); f.set([f.stage('pass')]);
  mkdirSync(join(f.project, '.codex/hooks'), { recursive: true }); const legacy = join(f.project, '.codex/hooks/registry.yaml'); writeFileSync(legacy, readFileSync(f.file));
  assert.throws(() => resolveRegistry(f.project), /Both registries/);
  const raw = readFileSync(f.file, 'utf8');
  saveManagement(f.project, { revision: registryRevision(raw), hooks: [{ id: 'pass', enabled: false, blocking: true, order: 10, dependsOn: [] }] }, '.hooks-workspace/registry.yaml');
  assert.equal((load(readFileSync(f.file, 'utf8')) as { hooks: { managed: { enabled: boolean } }[] }).hooks[0].managed.enabled, false);
  assert.equal(readFileSync(legacy, 'utf8'), raw);
});
test('dispatcher retains explicit hook owner across working directories and rejects external state/source symlinks', async t => {
  const f = fixture(t); const outside = fixture(t); f.set([f.stage('pass')]); outside.script('pass', { outcome: 'passed', effects: [] });
  assert.deepEqual(await dispatch(f.project, 'claude', f.input('PreToolUse', { cwd: outside.project })), {});
  assert.equal((f.traces()[0].context as ExecutionContext).workingTree?.checkout, outside.project);
  symlinkSync(join(outside.project, 'pass.cjs'), join(f.project, 'pass.cjs'));
  assert.deepEqual(await dispatch(f.project, 'claude', f.input()), {});
  assert.equal(f.traces()[1].kind, 'error');
  rmSync(join(f.project, '.hooks-workspace/state'), { recursive: true });
  symlinkSync(outside.project, join(f.project, '.hooks-workspace/state'));
  await assert.rejects(dispatch(f.project, 'claude', f.input()), /inside/);
});
test('Claude settings inventory retains all sources, global disable and unsupported command trust', async t => {
  const f = fixture(t); f.set([]); const user = fixture(t);
  mkdirSync(join(f.project, '.claude')); const hook = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node dispatch-hook.ts' }] }] } };
  writeFileSync(join(user.project, 'settings.json'), JSON.stringify(hook)); writeFileSync(join(f.project, '.claude/settings.json'), JSON.stringify(hook));
  writeFileSync(join(f.project, '.claude/settings.local.json'), JSON.stringify({ disableAllHooks: true }));
  assert.equal(readClaudeSettings(f.project, user.project).commands.length, 2);
  const status = await readProviderStatus(f.project, 'claude', undefined, user.project);
  assert.equal(status.error, null); assert.equal(status.providerEvents.Stop?.ready, false);
  assert.equal(status.providerEvents.Stop?.commandApproval.state, 'unsupported');
  assert.equal(status.providerEvents.Stop?.workspaceApproval.state, 'unknown');
  assert.deepEqual(status.providerEvents.Stop?.providerEnabled.state, 'known');
  assert.equal(status.providerEvents.Stop?.complete, false);
  writeFileSync(join(f.project, '.claude/settings.local.json'), '{');
  const failed = await readProviderStatus(f.project, 'claude', undefined, user.project); assert.ok(failed.error); assert.deepEqual(failed.providerEvents, {});
});
test('neutral state reports Claude tokens independently and retains unknown call counts', t => {
  const f = fixture(t); f.set([]); const dir = join(f.project, '.hooks-workspace/state/llm-usage'); mkdirSync(dir, { recursive: true });
  const now = Date.now(); const row = { schemaVersion: 1, id: 'one', at: new Date(now).toISOString(), provider: 'claude', inputTokens: 20, outputTokens: 10, totalTokens: 30 };
  writeFileSync(join(dir, new Date(now).toISOString().slice(0,10) + '.jsonl'), [row, { ...row, id: 'two', totalTokens: null }].map(row => JSON.stringify(row)).join('\n'));
  const usage = loadTokenUsage(f.project, now); assert.equal(usage.claude.hour, 30); assert.equal(usage.claude.missingHour, 1); assert.equal(usage.codex.recorded, false);
});

test('Claude SDK bridge uses the same dispatcher and refuses aborted callbacks', async t => {
  const { claudeSdkHooks } = await import('../runtime/claude-sdk.js');
  const f = fixture(t); f.set([f.stage('deny')]); f.script('deny', { outcome: 'failed', effects: [{ action: 'denyTool', message: 'SDK fixture denial' }] });
  const callback = claudeSdkHooks(f.project).PreToolUse![0].hooks[0];
  const input = { hook_event_name: 'PreToolUse' as const, cwd: f.project, session_id: 'sdk-session', transcript_path: '/fixture/transcript', tool_name: 'Bash', tool_input: {}, tool_use_id: 'sdk-tool' };
  assert.deepEqual(await callback(input, 'sdk-tool', { signal: new AbortController().signal }), { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: undefined, permissionDecision: 'deny', permissionDecisionReason: 'SDK fixture denial' } });
  const controller = new AbortController(); controller.abort(new Error('Callback aborted'));
  await assert.rejects(callback(input, 'sdk-tool', { signal: controller.signal }), /aborted/);
});

test('rewritten input is visible to later stages without changing invocation identity', async t => {
  const f = fixture(t); f.set([f.stage('rewrite','PreToolUse',10,{allowInputRewrite:true}), f.stage('verify','PreToolUse',20)]);
  f.script('rewrite',{outcome:'passed',effects:[{action:'rewriteToolInput',input:{command:'changed'}}]});
  writeFileSync(join(f.project,'verify.cjs'), "let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{const input=JSON.parse(raw);require('node:fs').writeFileSync('seen-input',JSON.stringify(input));console.log('{}')})");
  // An empty native result is valid for the second stage.
  f.set([f.stage('rewrite','PreToolUse',10,{allowInputRewrite:true}), f.stage('verify','PreToolUse',20,{resultFormat:'native'})]);
  await dispatch(f.project,'claude',f.input());
  const seen = JSON.parse(readFileSync(join(f.project,'seen-input'),'utf8')); assert.equal(seen.tool_input.command,'changed'); assert.equal(seen.session_id,'session');
});
test('command identity rejects misleading substrings, wrong registries and compound shell scripts', async t => {
  const { referencesSource, isDispatcher } = await import('./command-identity.js');
  const f = fixture(t); f.set([]);
  assert.equal(referencesSource('node other-check.cjs','check.cjs',f.project),false);
  assert.equal(referencesSource('node check.cjs; node other.cjs','check.cjs',f.project),false);
  const script = new URL('../scripts/dispatch-hook.ts',import.meta.url).pathname;
  const command = `node ${script} --project ${f.project} --provider claude --registry ${f.file}`;
  assert.equal(isDispatcher(command,f.project,'claude',f.file),true);
  assert.equal(isDispatcher(command.replace(f.file,join(f.project,'missing.yaml')),f.project,'claude',f.file),false);
  assert.equal(isDispatcher(command,f.project,'codex',f.file),false);
});
test('Claude configuration failures preserve registry definitions and shared save revision', t => {
  const f = fixture(t); const demo = loadHookControlPlaneData(new URL('../examples/demo',import.meta.url).pathname,{});
  const hook = demo.hooks[0]; f.script('check',{});
  f.set([{ ...hook, source: 'check.cjs', references: [], managed:{enabled:true,blocking:true,dependsOn:[]}}]);
  mkdirSync(join(f.project,'.claude')); writeFileSync(join(f.project,'.claude/settings.json'),'{');
  const data = loadHookControlPlaneData(f.project,{},undefined,'claude');
  assert.equal(data.loadError,null); assert.ok(data.configurationError); assert.equal(data.hooks.length,1); assert.ok(data.managementRevision);
});

test('saves reject prerequisites that can never share a provider', t => {
  const f = fixture(t); f.set([f.stage('a','PreToolUse',10,{providers:['codex']}),f.stage('b','PreToolUse',20,{providers:['claude']})]);
  const raw=readFileSync(f.file,'utf8');
  assert.throws(()=>saveManagement(f.project,{revision:registryRevision(raw),hooks:[{id:'a',enabled:true,blocking:true,order:10,dependsOn:[]},{id:'b',enabled:true,blocking:true,order:20,dependsOn:['a']}]}),/shared provider/);
  assert.equal(readFileSync(f.file,'utf8'),raw);
});
test('project subdirectory invocations retain the selected registry and canonical boundary', async t => {
  const f=fixture(t);f.set([f.stage('pass')]);f.script('pass',{outcome:'passed',effects:[]});mkdirSync(join(f.project,'nested'));
  assert.deepEqual(await dispatch(f.project,'claude',f.input('PreToolUse',{cwd:join(f.project,'nested')})),{});
  assert.equal(f.traces()[1].transport,'native-command');assert.equal(f.traces()[1].providerVersion,null);
  assert.deepEqual(f.traces()[1].effectSummary,{requested:[],applied:[],nativeDecision:{decision:null,permissionDecision:null,endProcessing:false}});
});

test('SDK cancellation kills an active stage and records an incomplete aborted invocation', async t => {
  const { claudeSdkHooks }=await import('../runtime/claude-sdk.js');const f=fixture(t);f.set([f.stage('slow')]);
  writeFileSync(join(f.project,'slow.cjs'),"setTimeout(()=>{require('node:fs').writeFileSync('cancelled-sentinel','bad');console.log('{}')},150)");
  const controller=new AbortController();const callback=claudeSdkHooks(f.project).PreToolUse![0].hooks[0];
  const pending=callback({hook_event_name:'PreToolUse',cwd:f.project,session_id:'sdk',transcript_path:'/fixture/transcript',tool_name:'Bash',tool_input:{},tool_use_id:'tool'},'tool',{signal:controller.signal});
  setTimeout(()=>controller.abort(new Error('Fixture cancellation')),30);
  await assert.rejects(pending,/Fixture cancellation/);await new Promise(done=>setTimeout(done,180));
  assert.equal(existsSync(join(f.project,'cancelled-sentinel')),false);
  assert.equal(f.traces().at(-1)?.kind,'aborted');assert.ok(f.traces().every(row=>row.transport==='sdk-callback'));
});
