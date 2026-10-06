import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkspaceCatalogStore } from './catalog.js';
import { matchesHistory } from '../src/history.js';
import type { HistoryFilters } from '../src/workspace-types.js';
export function localRequest(req: IncomingMessage, port: number): boolean {
    const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
    return hosts.includes(req.headers.host ?? '') && (!req.headers.origin || hosts.map(h => `http://${h}`).includes(req.headers.origin));
}
export function handleCatalogRequest(req: IncomingMessage, res: ServerResponse, port: number, store: WorkspaceCatalogStore): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!['/api/catalog', '/api/history', '/api/session'].includes(url.pathname))
        return false;
    if (!localRequest(req, port)) {
        res.writeHead(403).end('Local access only');
        return true;
    }
    if (req.method !== 'GET') {
        res.writeHead(405).end();
        return true;
    }
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify(value)); };
    if (url.pathname === '/api/catalog') {
        if (url.searchParams.has('refresh'))
            void store.refresh(true);
        send(200, store.state);
    }
    else if (url.pathname === '/api/history') {
        const agent = url.searchParams.get('agent') ?? 'all';
        const scope = url.searchParams.get('scope') ?? 'owner';
        if (!['all', 'codex', 'claude'].includes(agent) || !['owner', 'working', 'target'].includes(scope)) {
            send(400, { error: 'Unknown history filter' });
            return true;
        }
        const f: HistoryFilters = { agent: agent as HistoryFilters['agent'], scope: scope as HistoryFilters['scope'], repository: url.searchParams.get('repository') ?? '', branch: url.searchParams.get('branch') ?? '', project: url.searchParams.get('checkout') ?? '', session: url.searchParams.get('session') ?? '' };
        send(200, { rows: store.history.filter(row => matchesHistory(row, f)), checkedAt: store.state.checkedAt });
    }
    else {
        const id = url.searchParams.get('id') ?? '';
        void store.transcript(id).then(messages => send(200, { messages }), error => send(404, { error: error instanceof Error ? error.message : 'Transcript unavailable' }));
    }
    return true;
}
