import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { gitSnapshot, remoteIdentity, executionContext } from './git.js';
import { WorkspaceCatalogStore } from './catalog.js';
import { handleCatalogRequest } from './catalog-http.js';
import { createWorkspaceHandler } from './workspace-http.js';
import type { HookProvider } from '../src/hook-types.js';
import { dispatch } from '../runtime/dispatcher.js';
import { observe } from '../runtime/observer.js';
import { historyRows, matchesHistory, executionStats, latestStageRun } from '../src/history.js';
import { withAgentStatus } from '../src/agent-status.js';
import type { HookControlPlaneData } from '../src/hook-types.js';
import { parseOptions } from './options.js';
import type { WorkspaceProject, HistoryFilters } from '../src/workspace-types.js';
import { dump, load } from 'js-yaml';
const filters: HistoryFilters = { agent: 'all', repository: '', branch: '', project: '', session: '', scope: 'owner' };
function fixture(t: {
    after: (fn: () => void) => void;
}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-test-')));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const g = (path: string, ...args: string[]) => execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const repo = (name: string, remote?: string) => { const path = join(root, name); mkdirSync(path); g(path, 'init', '-b', 'main'); g(path, 'config', 'user.name', 'Fixture'); g(path, 'config', 'user.email', 'fixture@example.invalid'); writeFileSync(join(path, 'file'), 'initial'); g(path, 'add', 'file'); g(path, 'commit', '-m', 'Initial'); if (remote)
        g(path, 'remote', 'add', 'origin', remote); return path; };
    return { root, g, repo };
}
function registry(path: string) {
    mkdirSync(join(path, '.hooks-workspace'), { recursive: true });
    writeFileSync(join(path, 'check.cjs'), 'console.log(JSON.stringify({outcome:"passed",effects:[]}))');
    writeFileSync(join(path, '.hooks-workspace/registry.yaml'), dump({ managementVersion: 1, events: [], hooks: [{ id: 'check', label: 'Check', event: 'PreToolUse', order: 10, stage: 'advisory', source: 'check.cjs', enabled: { mode: 'always' }, managed: { enabled: true, blocking: false, dependsOn: [] }, failurePolicy: 'fail-open', canBlock: false, resultFormat: 'neutral' }] }));
}
const input = (cwd: string, session = 'shared') => ({ hook_event_name: 'PreToolUse', cwd, session_id: session, tool_name: 'Read', tool_input: { file_path: 'file' } });
function project(path: string): WorkspaceProject { return { ...gitSnapshot(path), path, id: path, registry: true, explicit: true }; }
test('SSH/HTTPS repository grouping strips credentials; ambiguous/local URLs do not merge', () => {
    assert.equal(remoteIdentity('git@github.com:Org/Example.git'), remoteIdentity('https://token:secret@github.com/Org/Example.git?token=hidden'));
    assert.equal(remoteIdentity('/local/repo'), null);
    assert.notEqual(remoteIdentity('git@github.com:org/fork.git'), remoteIdentity('git@github.com:org/upstream.git'));
    assert.notEqual(remoteIdentity('ssh://git@example.com:2222/repo'), remoteIdentity('ssh://git@example.com/repo'));
});
test('real worktrees group together; branches, detached HEAD and independent clones remain inspectable', t => {
    const f = fixture(t), a = f.repo('main'), work = join(f.root, 'work');
    f.g(a, 'worktree', 'add', '-b', 'feature', work);
    const first = gitSnapshot(a), second = gitSnapshot(work);
    assert.equal(first.repositoryId, second.repositoryId);
    assert.notEqual(first.checkout, second.checkout);
    assert.equal(second.branch, 'feature');
    f.g(a, 'config', 'extensions.worktreeConfig', 'true');
    f.g(work, 'config', '--worktree', 'remote.origin.url', 'git@github.com:example/fork.git');
    assert.equal(gitSnapshot(a).repositoryId, gitSnapshot(work).repositoryId);
    f.g(work, 'checkout', '--detach');
    assert.equal(gitSnapshot(work).detached, true);
    const clone = join(f.root, 'clone');
    f.g(a, 'clone', a, clone);
    f.g(a, 'remote', 'add', 'origin', 'git@github.com:example/repo.git');
    f.g(clone, 'remote', 'set-url', 'origin', 'https://github.com/example/repo.git');
    assert.equal(gitSnapshot(a).repositoryId, gitSnapshot(clone).repositoryId);
    const other = f.repo('other');
    assert.notEqual(gitSnapshot(a).repositoryId, gitSnapshot(other).repositoryId);
});
test('execution snapshots survive branch changes; same branch name does not imply same commit', async (t) => {
    const f = fixture(t), a = f.repo('a');
    registry(a);
    await dispatch(a, 'codex', input(a));
    const before = readFileSync(join(a, '.hooks-workspace/state/event-ledger', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8');
    f.g(a, 'checkout', '-b', 'feature');
    writeFileSync(join(a, 'file'), 'changed');
    f.g(a, 'commit', '-am', 'Changed');
    await dispatch(a, 'claude', input(a));
    const store = new WorkspaceCatalogStore({ projects: [a], discover: false });
    await store.refresh();
    const main = store.history.filter(r => matchesHistory(r, { ...filters, branch: 'main' })), feature = store.history.filter(r => matchesHistory(r, { ...filters, branch: 'feature' }));
    assert.equal(main.length, 3);
    assert.equal(feature.length, 3);
    assert.notEqual(main[0].commit, feature[0].commit);
    assert.equal(JSON.parse(before.split('\n')[0]).context.hookTree.branch, 'main');
    assert.equal(executionStats(store.history).executions, 2);
    assert.equal(executionStats(main).executions, 1);
});
test('cross-repository sessions retain owner, working directory and exact targets; shell text is not guessed', async (t) => {
    const f = fixture(t), a = f.repo('a'), b = f.repo('b');
    registry(a);
    registry(b);
    writeFileSync(join(a,'check.cjs'),'require("node:fs").writeFileSync("stage-cwd",process.cwd());console.log(JSON.stringify({outcome:"passed",effects:[]}))');
    await dispatch(a, 'codex', input(b));
    assert.equal(readFileSync(join(a,'stage-cwd'),'utf8'),a);
    await dispatch(b, 'claude', input(b));
    const store = new WorkspaceCatalogStore({ projects: [a, b], discover: false });
    await store.refresh();
    const owner = store.history.filter(r => matchesHistory(r, { ...filters, project: a }));
    assert.equal(owner.length, 3);
    assert.equal(owner[0].context?.workingTree?.checkout, b);
    assert.equal(owner[0].context?.targets[0].checkout, b);
    assert.equal(store.history.filter(r => matchesHistory(r, { ...filters, scope: 'working', project: b })).length, 6);
    assert.equal(store.history.filter(r => matchesHistory(r, { ...filters, agent: 'claude' })).length, 3);
    assert.equal(store.state.sessions.length, 2);
    assert.equal(store.state.sessions.find(s => s.agent === 'codex')?.projectIds.length, 2);
    assert.equal(executionContext(a, { ...input(a), tool_name: 'Bash', tool_input: { command: `cd ${b} && echo file` } }).targets.length, 0);
});
test('discovery covers both agents, worktrees, absent registries, duplicates and partial failures without inventing liveness', async (t) => {
    const f = fixture(t), a = f.repo('a'), work = join(f.root, 'work');
    f.g(a, 'worktree', 'add', '-b', 'feature', work);
    const store = new WorkspaceCatalogStore({ projects: [], discover: true }, async (agent) => agent === 'codex' ? [{ agent, sessionId: 'one', title: 'Resumed', cwd: work, updatedAt: '2026-02-01' }, { agent, sessionId: 'one', title: 'One', cwd: a, updatedAt: '2026-01-01' }] : Promise.reject(new Error('Unavailable')));
    await store.refresh();
    assert.equal(store.state.projects.length, 2);
    assert.equal(store.state.sessions.length, 1);
    assert.equal(store.state.sessions[0].projectIds.length, 2);
    assert.equal(store.state.sessions[0].activity, 'unknown');
    assert.equal(store.state.errors.length, 1);
    assert.equal(store.history.length, 0);
});
test('legacy records have unknown historical branches; duplicated invocation copies are counted once', t => {
    const f = fixture(t), a = f.repo('a'), p = project(a);
    const trace = { at: '2026-01-01', hookId: 'check', decision: 'passed', durationMs: 5, event: 'PreToolUse' as const, kind: 'completed', message: null, sessionId: 's', stage: null, toolUseId: null, turnId: null };
    const legacy = historyRows(p, [trace]);
    assert.equal(legacy[0].branch, null);
    assert.equal(executionStats(legacy).executions, 0);
    const modern = historyRows(p, [{ ...trace, provider: 'codex', invocationId: 'one', context: executionContext(a, input(a)) }]);
    assert.equal(executionStats([...modern, ...modern]).executions, 1);
    assert.equal(executionStats([...modern, ...modern]).durationMs, 5);
});
test('repository overrides group offline clones without changing checkout save boundaries', async (t) => {
    const f = fixture(t), a = f.repo('a'), b = f.repo('b');
    const map = join(f.root, 'repositories.json');
    writeFileSync(map, JSON.stringify([{ id: 'shared', label: 'Shared', checkouts: [a, b] }]));
    const store = new WorkspaceCatalogStore({ projects: [a, b], discover: false, repositoryMap: map });
    await store.refresh();
    assert.equal(store.state.projects.length, 2);
    assert.equal(new Set(store.state.projects.map(p => p.repositoryId)).size, 1);
    writeFileSync(map, JSON.stringify([{ id: 'a', label: 'A', checkouts: [a] }, { id: 'b', label: 'B', checkouts: [a] }]));
    assert.throws(() => new WorkspaceCatalogStore({ projects: [a], discover: false, repositoryMap: map }), /only one/);
});
test('directory/lifecycle observations enrich sessions without executing stages; symlink state is rejected', async (t) => {
    const f = fixture(t), a = f.repo('a'), b = f.repo('b');
    registry(a);
    observe(a, 'claude', { hook_event_name: 'DirectoryAdded', session_id: 's', cwd: a, directory: b });
    const store = new WorkspaceCatalogStore({ projects: [], discover: true }, async (agent) => agent === 'claude' ? [{ agent, sessionId: 's', title: 'One', cwd: a, updatedAt: null }] : []);
    await store.refresh();
    assert.equal(store.state.projects.length, 2);
    assert.equal(store.history.length, 1);
    assert.equal(store.history[0].kind, 'observed');
    assert.equal(store.state.sessions[0].projectIds.length, 2);
    rmSync(join(a, '.hooks-workspace/state'), { recursive: true });
    symlinkSync(b, join(a, '.hooks-workspace/state'));
    assert.throws(() => observe(a, 'claude', { hook_event_name: 'SessionEnd', cwd: a }), /inside/);
});
test('catalog HTTP denies cross-origin access, unknown sessions and unsafe paths', async (t) => {
    const f = fixture(t), a = f.repo('a');
    registry(a);
    await dispatch(a, 'codex', input(a, 'safe'));
    let reads = 0;
    const store = new WorkspaceCatalogStore({ projects: [a], discover: false }, async () => [], async () => { reads++; return ['fixture transcript']; });
    await store.refresh();
    let port = 0;
    const server = createServer((req, res) => { if (!handleCatalogRequest(req, res, port, store))
        res.writeHead(404).end(); });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    port = (server.address() as {
        port: number;
    }).port;
    t.after(() => server.close());
    const url = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(url + '/api/catalog', { headers: { Origin: 'https://outside.invalid' } })).status, 403);
    assert.equal((await fetch(url + '/api/session?id=../../private')).status, 404);
    assert.equal(reads, 0);
    assert.deepEqual(await (await fetch(url + '/api/session?id=codex:safe')).json(), { messages: ['fixture transcript'] });
    assert.equal(reads, 1);
    const history = await (await fetch(url + '/api/history?agent=claude')).json() as {
        rows: unknown[];
    };
    assert.equal(history.rows.length, 0);
});
test('multi-project HTTP saves isolate registries, reject stale revisions and require explicit checkout IDs', async (t) => {
    const f = fixture(t), a = f.repo('a'), b = f.repo('b');
    for (const path of [a, b]) {
        cpSync('examples/demo', path, { recursive: true });
        const file = join(path, '.codex/hooks/registry.yaml');
        const data = load(readFileSync(file, 'utf8')) as {
            managementVersion: number;
            hooks: {
                canBlock: boolean;
                managed: unknown;
            }[];
        };
        data.managementVersion = 1;
        for (const h of data.hooks)
            h.managed = { enabled: true, blocking: h.canBlock, dependsOn: [] };
        writeFileSync(file, dump(data));
    }
    const rawB = readFileSync(join(b, '.codex/hooks/registry.yaml'), 'utf8');
    const store = new WorkspaceCatalogStore({ projects: [a, b], discover: false });
    await store.refresh();
    let port = 0;
    const mockMonitor = (_p: string, provider: HookProvider) => ({ snapshot: () => ({ provider, loading: false, checkedAt: null, error: null, hooks: {}, providerEvents: {} }), refresh: async () => { }, close: () => { } });
    let handler: ReturnType<typeof createWorkspaceHandler>;
    const server = createServer((req, res) => { if (!handler.handle(req, res))
        res.writeHead(404).end(); });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    port = (server.address() as {
        port: number;
    }).port;
    handler = createWorkspaceHandler(store, port, mockMonitor);
    t.after(() => { handler.close(); server.close(); });
    const url = `http://127.0.0.1:${port}`, id = store.state.projects.find(p => p.path === a)!.id;
    const workspace = await (await fetch(url + '/api/workspace?project=' + id)).json() as {
        data: {
            managementRevision: string;
            hooks: {
                id: string;
                order: number;
                canBlock: boolean;
            }[];
        };
    };
    const body = JSON.stringify({ revision: workspace.data.managementRevision, hooks: workspace.data.hooks.map(h => ({ id: h.id, order: h.order, enabled: false, blocking: h.canBlock, dependsOn: [] })) });
    const patch = (query: string) => fetch(url + '/api/management' + query, { method: 'PATCH', headers: { Origin: url, 'Content-Type': 'application/json', 'X-Hooks-Workspace': '1' }, body });
    assert.equal((await patch('?project=' + id)).status, 200);
    assert.equal((load(readFileSync(join(a, '.codex/hooks/registry.yaml'), 'utf8')) as {
        hooks: {
            managed: {
                enabled: boolean;
            };
        }[];
    }).hooks[0].managed.enabled, false);
    assert.equal(readFileSync(join(b, '.codex/hooks/registry.yaml'), 'utf8'), rawB);
    assert.equal((await patch('?project=' + id)).status, 409);
    assert.equal((await patch('')).status, 400);
    assert.equal((await patch('?project=' + encodeURIComponent(b))).status, 404);
});
test('startup defaults to both-agent discovery, repeated projects restrict roots and no provider is selected', () => {
    assert.equal(parseOptions([], '/tools').discover, true);
    assert.deepEqual(parseOptions(['--project', '/a', '--project', '/b'], '/tools').projects, ['/a', '/b']);
    assert.equal(parseOptions(['--demo'], '/tools').discover, false);
    assert.throws(() => parseOptions(['--provider', 'claude'], '/tools'), /Unknown option/);
});

test('both agent statuses stay visible when one inspection fails; unknown approval never becomes ready',()=>{
  const data:HookControlPlaneData={events:[{id:'Stop',label:'Stop',description:''}],hooks:[],traces:[],loadError:null,stopConfigured:false};
  const result=withAgentStatus(data,[{provider:'claude',providerEvents:{},hooks:{},loading:false,checkedAt:null,error:'Fixture inventory failed'}]);
  assert.ok(result.providerEvents);
  assert.match(result.providerEvents.Stop!.label,/Codex: Checking/);assert.match(result.providerEvents.Stop!.label,/Claude Code: Unavailable/);assert.equal(result.providerEvents.Stop!.ready,false);assert.equal(result.agentEvents!.claude!.Stop!.configured.state,'unknown');
});

test('recent stage runs never combine agents with identical legacy session/turn IDs',()=>{
 const trace={at:'2026-01-01',hookId:'check',decision:'passed',durationMs:1,event:'Stop' as const,kind:'completed',message:null,sessionId:'same',stage:null,toolUseId:null,turnId:'same'};
 const latest=latestStageRun([{...trace,provider:'codex'}, {...trace,at:'2026-02-01',hookId:'other',provider:'claude'}],'Stop',new Set(['check','other']));
 assert.equal(latest!.traces.size,1);assert.equal(latest!.traces.get('other')!.provider,'claude');
 const incomplete=latestStageRun([{...trace,provider:'codex',invocationId:'same'}, {...trace,provider:'claude',invocationId:'same',hookId:'dispatcher'}],'Stop',new Set(['check']));assert.equal(incomplete,null);
});
