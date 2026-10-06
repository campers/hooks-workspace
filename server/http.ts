import { loadTokenUsage } from './usage.js';
import { saveManagement } from './management.js';
import type { CodexStatusSnapshot, HookProvider, ProviderStatusSnapshot } from '../src/hook-types.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadHookControlPlaneData } from './loader.js';

export function handleWorkspaceRequest(req: IncomingMessage, res: ServerResponse, project: string, port: number, status?: { snapshot: () => CodexStatusSnapshot; refresh: () => Promise<void> }, options?: { provider: HookProvider; registry?: string; projectId?: string; monitors: Record<HookProvider, { snapshot: () => ProviderStatusSnapshot; refresh: () => Promise<void> }> }): boolean {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const origin = req.headers.origin;
  if (!allowedHosts.includes(req.headers.host ?? '') || (origin && !allowedHosts.map((host) => `http://${host}`).includes(origin))) {
    res.writeHead(403).end('Local access only');
    return true;
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  const requestUrl = new URL(req.url ?? '/', 'http://localhost');
  const requested = requestUrl.pathname === '/api/codex-status' ? 'codex' : requestUrl.searchParams.get('provider') ?? options?.provider ?? 'codex';
  if (requested !== 'codex' && requested !== 'claude') { res.writeHead(400).end('Unknown provider'); return true; }
  const provider: HookProvider = requested;
  const monitor = options?.monitors[provider] ?? status;
  const path = req.url?.split('?')[0];
  if (path === '/api/management') {
    if (req.method !== 'PATCH') { res.writeHead(405).end(); return true; }
    if (!origin || req.headers['x-hooks-workspace'] !== '1' || req.headers['content-type'] !== 'application/json') { res.writeHead(403).end('Same-origin JSON request required'); return true; }
    let body = '';
    let rejected = false;
    req.on('data', (chunk: Buffer): void => {
      if (rejected) return;
      body += chunk.toString();
      if (body.length > 65536 && !rejected) { rejected = true; res.writeHead(413).end('Request too large'); }
    });
    req.on('end', (): void => {
      if (rejected) return;
      try { saveManagement(project, JSON.parse(body), options?.registry); void monitor?.refresh(); res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ project, provider, data: { projectId: options?.projectId, ...loadHookControlPlaneData(project, process.env, options?.registry, provider), tokenUsage: loadTokenUsage(project, Date.now(), options?.registry) } })); }
      catch (error) { res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Could not save hook settings' })); }
    });
    return true;
  }
  if (path !== '/api/workspace' && path !== '/api/codex-status' && path !== '/api/provider-status') return false;
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' }).end('Read-only workspace');
    return true;
  }
  if (path === '/api/codex-status' || path === '/api/provider-status') {
    if (!monitor) { res.writeHead(503).end('Codex status unavailable'); return true; }
    const snapshot = monitor.snapshot();
    if (options || req.url?.includes('refresh=1')) void monitor.refresh();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(snapshot));
    return true;
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ project, provider, data: { projectId: options?.projectId, ...loadHookControlPlaneData(project, process.env, options?.registry, provider), tokenUsage: loadTokenUsage(project, Date.now(), options?.registry) } }));
  return true;
}
