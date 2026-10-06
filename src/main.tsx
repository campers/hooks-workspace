import { StrictMode, Suspense, lazy, useEffect, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
const HooksControlPlaneView = lazy(() => import('./hooks-view').then(m => ({ default: m.HooksControlPlaneView })));
import { Executions } from './executions';
import { TokenUsage } from './token-usage';
import { withAgentStatus } from './agent-status';
import type { HookControlPlaneData } from './hook-types';
import type { HistoryRow, WorkspaceCatalog } from './workspace-types';
interface WorkspaceResponse {
    project: string;
    data: HookControlPlaneData;
}
function App(): JSX.Element {
    const [catalog, setCatalog] = useState<WorkspaceCatalog | null>(null);
    const [rows, setRows] = useState<HistoryRow[]>([]);
    const [project, setProject] = useState('');
    const [tab, setTab] = useState('executions');
    const [openedHooks, setOpenedHooks] = useState(false);
    const [revision, setRevision] = useState(0);
    const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
    const [views, setViews] = useState<Record<string, HookControlPlaneData>>({});
    const [catalogError, setCatalogError] = useState('');
    const [checkoutError, setCheckoutError] = useState('');
    useEffect(() => {
        const controller = new AbortController();
        let busy = false;
        const poll = async () => {
            if (busy)
                return;
            busy = true;
            try {
                const [c, h] = await Promise.all(['/api/catalog', '/api/history'].map(async (url) => { const r = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]) }); if (!r.ok)
                    throw new Error(`Workspace unavailable (${r.status})`); return r.json(); }));
                if (controller.signal.aborted)
                    return;
                setCatalog(c);
                setRows(h.rows);
                setCatalogError('');
                setProject(current => current || c.projects.find((p: {
                    explicit: boolean;
                }) => p.explicit)?.id || c.projects[0]?.id || '');
            }
            catch (e) {
                if (!controller.signal.aborted)
                    setCatalogError(e instanceof Error ? e.message : 'Discovery unavailable');
            }
            finally {
                busy = false;
            }
        };
        void poll();
        const timer = setInterval(() => void poll(), 5000);
        return () => { controller.abort(); clearInterval(timer); };
    }, [revision]);
    useEffect(() => {
        if (!project)
            return;
        const controller = new AbortController();
        let busy = false;
        const poll = async () => {
            if (busy)
                return;
            busy = true;
            try {
                const query = `project=${encodeURIComponent(project)}`;
                const responses = await Promise.all([`/api/workspace?${query}`, `/api/provider-status?${query}&provider=codex`, `/api/provider-status?${query}&provider=claude`].map(async (url) => { const r = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) }); if (!r.ok)
                    throw new Error(`Checkout unavailable (${r.status})`); return r.json(); }));
                if (!controller.signal.aborted) {
                    setCheckoutError('');
                    setWorkspace(responses[0]);
                    setViews(previous => ({ ...previous, [project]: withAgentStatus(responses[0].data, responses.slice(1)) }));
                }
            }
            catch (e) {
                if (!controller.signal.aborted)
                    setCheckoutError(e instanceof Error ? e.message : 'Checkout unavailable');
            }
            finally {
                busy = false;
            }
        };
        void poll();
        const timer = setInterval(() => void poll(), 5000);
        return () => { controller.abort(); clearInterval(timer); };
    }, [project, revision]);
    const error = catalogError || (tab==='hooks'?checkoutError:'');
    const current = workspace?.data.projectId === project ? workspace : null;
    return <main className="flex min-h-screen flex-col lg:h-screen lg:overflow-hidden">
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card px-4 py-2">
      <h1 className="text-base font-semibold">Hooks workspace</h1>
      <nav className="flex gap-1" aria-label="Workspace view">{['executions', 'hooks'].map(t => <button aria-pressed={tab === t} className="rounded border px-3 py-1 text-sm capitalize" key={t} onClick={() => { setTab(t); if (t === 'hooks')
        setOpenedHooks(true); }}>{t === 'hooks' ? 'Hook settings' : 'Executions'}</button>)}</nav>
      {tab === 'hooks' ? <label className="flex min-w-0 items-center gap-2 text-xs">Configuration checkout<select aria-label="Configuration checkout" className="max-w-80 min-w-0 rounded border bg-background px-2 py-1" value={project} onChange={e => setProject(e.target.value)}>{catalog?.projects.map(p => <option key={p.id} value={p.id}>{p.repositoryLabel} · {p.branch ?? (p.detached ? 'Detached HEAD' : 'Unknown')} · {p.path}</option>)}</select></label> : <span className="text-xs text-muted-foreground">{catalog?.projects.length ?? 0} checkouts · {catalog?.sessions.length ?? 0} sessions</span>}
      {tab === 'hooks' ? <TokenUsage usage={current?.data.tokenUsage}/> : null}
      <button className="ml-auto rounded border px-3 py-1 text-sm" onClick={() => { void fetch('/api/catalog?refresh=1'); setRevision(r => r + 1); }}>Reload</button>
      <span className="text-xs text-muted-foreground" role="status">{catalog?.loading ? 'Discovering…' : 'Refreshes automatically'}</span>
    </header>
    {error ? <p role="alert" className="break-words px-4 py-2 text-sm text-danger">{error}</p> : null}
    {catalog?.errors.length ? <details className="border-b px-4 py-1 text-xs text-muted-foreground"><summary>Discovery incomplete ({catalog.errors.length})</summary><ul>{catalog.errors.map((e, i) => <li className="break-words" key={i}>{e}</li>)}</ul></details> : null}
    {catalog ? <div hidden={tab !== 'executions'} className={tab === 'executions' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}><Executions catalog={catalog} rows={rows}/></div> : null}
    {openedHooks ? Object.entries(views).map(([id, data]) => <div key={id} hidden={tab !== 'hooks' || project !== id} className={tab === 'hooks' && project === id ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}><Suspense fallback={<p className="p-4 text-sm">Reading hook settings…</p>}><HooksControlPlaneView data={data} onSaved={() => setRevision(r => r + 1)}/></Suspense></div>) : null}
    {(!catalog || tab === 'hooks' && !views[project] || catalog && !catalog.loading && !catalog.projects.length) ? <p className="p-4 text-sm text-muted-foreground">{catalog && !catalog.loading && !catalog.projects.length ? 'No local projects discovered. Pass --project to add a checkout, or --demo.' : 'Reading workspace…'}</p> : null}
  </main>;
}
const root = document.getElementById('root');
if (!root)
    throw new Error('Missing application root');
createRoot(root).render(<StrictMode><App /></StrictMode>);
