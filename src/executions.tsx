import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Dialog } from 'radix-ui';
import { attributionTrees, branchKey, executionStats, matchesHistory } from './history';
import type { HistoryFilters, HistoryRow, WorkspaceCatalog } from './workspace-types';
const branchLabel = (key: string) => key === '__unknown' ? 'Unknown' : key === '__detached' ? 'Detached HEAD' : key;
function Select({ label, value, onChange, options, all }: {
    label: string;
    value: string;
    onChange: (v: string) => void;
    options: [
        string,
        string
    ][];
    all?: string;
}): JSX.Element {
    return <label className="flex min-w-0 items-center gap-2 text-xs">{label}<select aria-label={label} value={value} onChange={e => onChange(e.target.value)} className="max-w-52 min-w-0 rounded border bg-background px-2 py-1.5">{all ? <option value="">{all}</option> : null}{options.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>;
}
export function Executions({ catalog, rows }: {
    catalog: WorkspaceCatalog;
    rows: HistoryRow[];
}): JSX.Element {
    const [filters, setFilters] = useState<HistoryFilters>({ agent: 'all', repository: '', branch: '', project: '', session: '', scope: 'owner' });
    const [group, setGroup] = useState('repository');
    const [transcript, setTranscript] = useState<{
        title: string;
        body: string;
    } | null>(null);
    const [busy, setBusy] = useState(false);
    const request = useRef<AbortController | null>(null);
    useEffect(() => () => request.current?.abort(), []);
    const closeTranscript = () => { request.current?.abort(); setTranscript(null); setBusy(false); };
    const set = (key: keyof HistoryFilters, value: string) => setFilters(f => ({ ...f, [key]: value, ...(key === 'repository' || key === 'scope' ? { branch: '', project: '', session: '' } : key === 'agent' ? { session: '' } : {}) }));
    const trees = useMemo(() => rows.flatMap(r => attributionTrees(r, filters.scope)), [rows, filters.scope]);
    const repositories = [...new Map([...catalog.projects, ...trees].map(p => [p.repositoryId, p.repositoryLabel])).entries()];
    const scopedTrees = trees.filter(p => !filters.repository || p.repositoryId === filters.repository);
    const branches = [...new Set(scopedTrees.map(p => branchKey(p.branch, p.detached)))].sort().map(b => [b, branchLabel(b)] as [
        string,
        string
    ]);
    const checkouts = [...new Set([...scopedTrees.map(p => p.checkout), ...catalog.projects.filter(p => !filters.repository || p.repositoryId === filters.repository).map(p => p.path)])].map(p => [p, p] as [
        string,
        string
    ]);
    const filtered = useMemo(() => rows.filter(r => matchesHistory(r, filters)), [rows, filters]);
    const stats = useMemo(() => executionStats(filtered), [filtered]);
    const groups = new Map<string, {
        title: string;
        items: HistoryRow[];
    }>();
    for (const row of filtered) {
        const session = row.sessionKey ?? 'Unknown session';
        const tree = attributionTrees(row, filters.scope).find(t => (!filters.repository || t.repositoryId === filters.repository) && (!filters.branch || branchKey(t.branch, t.detached) === filters.branch) && (!filters.project || t.checkout === filters.project))!;
        const title = group === 'timeline' ? 'Timeline' : group === 'session' ? `${session} · ${tree.repositoryLabel}` : `${tree.repositoryLabel} · ${branchLabel(branchKey(tree.branch, tree.detached))} · ${session}`;
        const key = group === 'timeline' ? 'timeline' : `${tree.repositoryId}:${group === 'repository' ? branchKey(tree.branch, tree.detached) : ''}:${session}`;
        const entry = groups.get(key) ?? { title, items: [] };
        entry.items.push(row);
        groups.set(key, entry);
    }
    const matchedSessions = new Set(filtered.map(r => r.sessionKey));
    const sessions = catalog.sessions.filter(s => (filters.agent === 'all' || s.agent === filters.agent) && (!filters.repository || s.projectIds.some(id => catalog.projects.find(p => p.id === id)?.repositoryId === filters.repository) || matchedSessions.has(s.id)) && (!filters.project || s.projectIds.some(id => catalog.projects.find(p => p.id === id)?.checkout === filters.project) || matchedSessions.has(s.id)) && (!filters.branch || matchedSessions.has(s.id)) && (!filters.session || s.id === filters.session));
    const openTranscript = async (id: string, title: string) => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setBusy(true);
        setTranscript({ title, body: 'Reading transcript…' });
        try {
            const response = await fetch(`/api/session?id=${encodeURIComponent(id)}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]) });
            const data = await response.json();
            if (!response.ok)
                throw new Error(data.error ?? 'Transcript unavailable');
            if (!controller.signal.aborted)
                setTranscript({ title, body: JSON.stringify(data.messages, null, 2) });
        }
        catch (e) {
            if (!controller.signal.aborted)
                setTranscript({ title, body: e instanceof Error ? e.message : 'Transcript unavailable' });
        }
        finally {
            if (request.current === controller)
                setBusy(false);
        }
    };
    return <section aria-label="Hook executions" className="min-h-0 flex-1 overflow-auto">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
      <Select label="Agent" value={filters.agent} onChange={v => set('agent', v)} options={[["all", "All agents"], ["codex", "Codex"], ["claude", "Claude Code"]]}/>
      <Select label="Repository" value={filters.repository} onChange={v => set('repository', v)} options={repositories} all="All repositories"/>
      <Select label="Branch" value={filters.branch} onChange={v => set('branch', v)} options={branches} all="All branches"/>
      <Select label="Checkout" value={filters.project} onChange={v => set('project', v)} options={checkouts} all="All checkouts"/>
      <Select label="Session" value={filters.session} onChange={v => set('session', v)} options={sessions.map(s => [s.id, `${s.agent}: ${s.title}`])} all="All sessions"/>
      <Select label="Project role" value={filters.scope} onChange={v => set('scope', v)} options={[["owner", "Hook configuration"], ["working", "Working repository"], ["target", "Tool target"]]}/>
      <Select label="Group by" value={group} onChange={setGroup} options={[["repository", "Repository → Branch → Session"], ["session", "Session → Repository"], ["timeline", "Timeline"]]}/>
    </div>
    <p className="flex flex-wrap gap-x-4 gap-y-1 border-b px-4 py-2 text-xs" data-testid="execution-stats"><span>{stats.executions} invocations</span><span className="text-muted-foreground">Recent ledger: 7 files / 300 rows per checkout</span><span>{stats.blocked} blocked</span><span>{stats.errors} with errors</span><span>{stats.pending} incomplete</span><span>{stats.durationMs} ms recorded stage time</span></p>
    {filtered.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No hook executions recorded for these filters. Session discovery does not prove hooks ran.</p> : null}
    <div className="space-y-3 p-4">{[...groups].map(([key, { title, items }]) => <section key={key} className="rounded border" aria-label={title}>
      <h2 className="break-all border-b bg-muted/25 px-3 py-2 text-xs font-semibold">{title}</h2>
      <ul>{items.map(row => <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b px-3 py-2 text-xs last:border-b-0" data-testid="execution-row">
        <time>{new Date(row.at).toLocaleString()}</time><span>{row.provider === 'claude' ? 'Claude Code' : 'Codex'}</span><strong>{row.hookId}</strong><span>{row.event ?? row.lifecycleEvent ?? 'Unknown event'}</span><span>{row.kind} · {row.decision}</span>{row.context?.agentId ? <span>Subagent {row.context.agentId}</span> : null}<span className="min-w-0 break-all text-muted-foreground" title={row.checkout}>{row.checkout}</span>{row.commit ? <code title={row.commit}>{row.commit.slice(0, 8)}</code> : null}{row.context?.workingTree?.checkout && row.context.workingTree.checkout !== row.checkout ? <span className="break-all">Working in {row.context.workingTree.checkout}</span> : null}{row.context?.targets.map(t => <span className="break-all" key={t.checkout}>Target: {t.repositoryLabel} · {t.branch ?? 'Unknown'}</span>)}{row.message ? <span className="break-words text-muted-foreground">{row.message}</span> : null}
      </li>)}</ul>
    </section>)}</div>
    <details className="mx-4 mb-4 rounded border" open={filtered.length === 0}><summary className="cursor-pointer px-3 py-2 text-sm">Discovered sessions ({sessions.length}) · Running state unverified</summary><ul>{sessions.map(s => <li className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-xs" key={s.id}><span>{s.agent === 'claude' ? 'Claude Code' : 'Codex'}</span><strong className="break-words">{s.title}</strong><span className="break-all text-muted-foreground">{s.cwd ?? 'Directory unknown'}</span><span>{s.activity === 'observed' ? 'Hooks recorded' : 'No recorded hooks'}</span><button disabled={busy} className="underline" onClick={() => void openTranscript(s.id, s.title)}>View transcript</button></li>)}</ul></details>
    <Dialog.Root open={!!transcript} onOpenChange={open => { if (!open)
        closeTranscript(); }}><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-black/30"/><Dialog.Content aria-label="Session transcript" className="fixed inset-4 z-50 flex flex-col rounded border bg-card p-4"><div className="flex items-center justify-between gap-3"><Dialog.Title className="min-w-0 truncate text-sm font-semibold">{transcript?.title}</Dialog.Title><Dialog.Close asChild><button className="rounded border px-3 py-1 text-sm">Close transcript</button></Dialog.Close></div><Dialog.Description className="py-2 text-xs text-muted-foreground">Read-only transcript · First page · May lag live activity</Dialog.Description><pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all text-xs">{transcript?.body}</pre></Dialog.Content></Dialog.Portal></Dialog.Root>
  </section>;
}
