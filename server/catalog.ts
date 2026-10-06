import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical, gitSnapshot, worktrees } from './git.js';
import { readSessions, readTranscript, type SessionMetadata } from './sessions.js';
import { readRecentTraces } from './loader.js';
import { historyRows, dedupeHistory, sessionKey } from '../src/history.js';
import type { HistoryRow, WorkspaceCatalog, WorkspaceProject, WorkspaceSession } from '../src/workspace-types.js';
import type { HookProvider } from '../src/hook-types.js';
export interface CatalogOptions {
    projects: string[];
    discover: boolean;
    registry?: string;
    repositoryMap?: string;
}
interface RepositoryMapping {
    id: string;
    label: string;
    checkouts: string[];
}
export class WorkspaceCatalogStore {
    state: WorkspaceCatalog = { projects: [], sessions: [], errors: [], checkedAt: null, loading: true, discovery: true };
    history: HistoryRow[] = [];
    private running: Promise<void> | null = null;
    private mappings: RepositoryMapping[];
    private metadata: SessionMetadata[] = [];
    private discoveryErrors: string[] = [];
    private scannedAt = 0;
    constructor(readonly options: CatalogOptions, private sessionReader = readSessions, private transcriptReader = readTranscript) {
        this.mappings = options.repositoryMap ? JSON.parse(readFileSync(options.repositoryMap, 'utf8')) : [];
        if (!Array.isArray(this.mappings) || this.mappings.some(m => !m || typeof m.id !== 'string' || !m.id || typeof m.label !== 'string' || !Array.isArray(m.checkouts) || m.checkouts.some(c => typeof c !== 'string')))
            throw new Error('Repository map must be a JSON array of { id, label, checkouts }');
        const paths = this.mappings.flatMap(m => m.checkouts.map(c => canonical(resolve(c))));
        if (new Set(paths).size !== paths.length)
            throw new Error('A checkout can belong to only one repository mapping');
        this.mappings = this.mappings.map(m => ({ ...m, checkouts: m.checkouts.map(c => canonical(resolve(c))) }));
    }
    project(id: string | null): WorkspaceProject | undefined { return this.state.projects.find(p => p.id === id) ?? (id ? undefined : this.state.projects.find(p => p.explicit) ?? this.state.projects[0]); }
    registry(project: WorkspaceProject): string | undefined { return project.explicit ? this.options.registry : undefined; }
    private mapTree<T extends {
        checkout: string;
        repositoryId: string;
        repositoryLabel: string;
    }>(tree: T): T {
        const m = this.mappings.find(m => m.checkouts.includes(tree.checkout));
        return m ? { ...tree, repositoryId: `mapped:${m.id}`, repositoryLabel: m.label } : tree;
    }
    refresh(forceDiscovery = false): Promise<void> {
        if (this.running)
            return this.running;
        if (forceDiscovery) this.scannedAt = 0;
        this.running = this.reload().catch(e => { this.state = { ...this.state, loading: false, errors: [e instanceof Error ? e.message : 'Catalog refresh failed'] }; }).finally(() => { this.running = null; });
        return this.running;
    }
    private async reload(): Promise<void> {
        const errors: string[] = [];
        if (this.options.discover && Date.now() - this.scannedAt > 30000) {
            const results = await Promise.allSettled((['codex', 'claude'] as const).map(agent => this.sessionReader(agent, process.cwd())));
            this.discoveryErrors = [];
            results.forEach((result, i) => {
                const agent = i === 0 ? 'codex' : 'claude';
                if (result.status === 'fulfilled')
                    this.metadata = [...this.metadata.filter(s => s.agent !== agent), ...result.value];
                else
                    this.discoveryErrors.push(`${agent}: ${result.reason instanceof Error ? result.reason.message : 'Discovery failed'} (previous metadata retained)`);
            });
            this.scannedAt = Date.now();
        }
        const metadata = this.metadata;
        errors.push(...this.discoveryErrors);
        const explicit = new Set(this.options.projects.map(canonical));
        const candidates = new Set([...explicit, ...(explicit.size ? [] : metadata.flatMap(s => s.cwd && existsSync(s.cwd) ? [s.cwd] : []))]);
        const projects = new Map<string, WorkspaceProject>();
        const inspected = new Set<string>();
        const add = (path: string) => {
            try {
                path = canonical(path);
                if (inspected.has(path))
                    return;
                inspected.add(path);
                const tree = this.mapTree(gitSnapshot(path));
                const selected = explicit.has(path);
                const root = selected ? path : tree.checkout;
                const id = createHash('sha256').update(root).digest('hex').slice(0, 24);
                const registry = !!(selected && this.options.registry) || ['.hooks-workspace/registry.yaml', '.codex/hooks/registry.yaml'].some(p => existsSync(join(root, p)));
                if (!projects.has(root))
                    projects.set(root, { ...tree, id, path: root, explicit: selected, registry });
                else if (selected)
                    projects.get(root)!.explicit = true;
            }
            catch {
                errors.push(`Could not inspect checkout: ${basename(path)}`);
            }
        };
        for (const path of candidates)
            add(path);
        for (const p of [...projects.values()])
            for (const path of worktrees(p.path))
                add(path);
        const rows: HistoryRow[] = [];
        // Targets from recorded hooks discover repositories absent from session launch metadata.
        for (const p of projects.values()) {
            try {
                const traces = readRecentTraces(p.path, this.registry(p)).map(t => {
                    if (!t.context)
                        return t;
                    const c = t.context;
                    return { ...t, context: { ...c, hookTree: this.mapTree(c.hookTree), workingTree: c.workingTree ? this.mapTree(c.workingTree) : null, targets: c.targets.map(tree => this.mapTree(tree)) } };
                });
                rows.push(...historyRows(p, traces));
                for (const t of traces)
                    for (const tree of [t.context?.workingTree, ...t.context?.targets ?? []])
                        if (!explicit.size && tree && existsSync(tree.checkout))
                            add(tree.checkout);
            }
            catch (e) {
                if (p.registry)
                    errors.push(`${basename(p.path)} history: ${e instanceof Error ? e.message : 'Unavailable'}`);
            }
        }
        const sessions = new Map<string, WorkspaceSession>();
        for (const s of metadata) {
            const id = sessionKey(s.agent, s.sessionId);
            const existing = sessions.get(id);
            let project: WorkspaceProject | undefined;
            try {
                if (s.cwd && existsSync(s.cwd)) {
                    const cwd = canonical(s.cwd);
                    project = [...projects.values()].filter(p => cwd === p.path || cwd.startsWith(p.path + '/')).sort((a, b) => b.path.length - a.path.length)[0];
                }
            }
            catch { /* A checkout can disappear during discovery. */ }
            if (explicit.size && !project && !existing)
                continue;
            const membership = [...new Set([...(existing?.projectIds ?? []), ...project ? [project.id] : []])];
            const latest = existing && (existing.updatedAt ?? '') > (s.updatedAt ?? '') ? existing : s;
            sessions.set(id, { ...latest, id, projectIds: membership, activity: 'unknown' });
        }
        for (const row of rows)
            if (row.sessionKey && row.sessionId && row.provider) {
                let s = sessions.get(row.sessionKey);
                if (!s) {
                    s = { id: row.sessionKey, agent: row.provider, sessionId: row.sessionId, title: row.sessionId, cwd: row.context?.cwd ?? null, updatedAt: row.at, projectIds: [], activity: 'observed' };
                    sessions.set(s.id, s);
                }
                const memberships = [row.checkout, row.context?.workingTree?.checkout, ...row.context?.targets.map(t => t.checkout) ?? []];
                for (const path of memberships) {
                    const p = path ? projects.get(path) : undefined;
                    if (p && !s.projectIds.includes(p.id))
                        s.projectIds.push(p.id);
                }
                if ((s.updatedAt ?? '') < row.at)
                    s.updatedAt = row.at;
                s.activity = 'observed';
            }
        this.history = dedupeHistory(rows);
        this.state = { projects: [...projects.values()].sort((a, b) => a.repositoryLabel.localeCompare(b.repositoryLabel) || a.path.localeCompare(b.path)), sessions: [...sessions.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')), errors, checkedAt: new Date().toISOString(), loading: false, discovery: this.options.discover };
    }
    async transcript(id: string): Promise<unknown> {
        const session = this.state.sessions.find(s => s.id === id);
        if (!session)
            throw new Error('Unknown session');
        // Only session IDs from discovery/recorded hooks are accepted; never accept a path from HTTP.
        if (!/^[a-zA-Z0-9_-]+$/.test(session.sessionId))
            throw new Error('Invalid session identifier');
        return this.transcriptReader(session.agent, session.sessionId, session.cwd && existsSync(session.cwd) ? session.cwd : process.cwd());
    }
}
