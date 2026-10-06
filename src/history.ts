import type { HookTraceEvent } from './hook-types';
import type { HistoryFilters, HistoryRow, WorkspaceProject } from './workspace-types';
export const sessionKey = (agent: string, id: string) => `${agent}:${id}`;
export function latestStageRun(traces: readonly HookTraceEvent[], event: string, hookIds: ReadonlySet<string>): { at: string; traces: ReadonlyMap<string,HookTraceEvent> } | null {
    const completed = new Set(traces.filter(t=>t.invocationId && t.hookId==='dispatcher' && t.kind==='completed').map(t=>`${t.provider??'codex'}:${t.invocationId}`));
    const groups = new Map<string,HookTraceEvent[]>();
    for (const trace of traces) {
        const agent = trace.provider ?? 'codex';
        if (trace.invocationId && !completed.has(`${agent}:${trace.invocationId}`)) continue;
        if (trace.event !== event || !hookIds.has(trace.hookId)) continue;
        const key = `${agent}:${trace.invocationId ?? [trace.sessionId??'unknown',trace.turnId??'unknown',trace.toolUseId??'unknown'].join(':')}`;
        const group = groups.get(key) ?? []; group.push(trace); groups.set(key,group);
    }
    const latest = [...groups.values()].map(group=>group.toSorted((a,b)=>b.at.localeCompare(a.at))).sort((a,b)=>b[0].at.localeCompare(a[0].at))[0];
    if (!latest) return null;
    const results = new Map<string,HookTraceEvent>();
    for (const trace of latest) if (!results.has(trace.hookId)) results.set(trace.hookId,trace);
    return {at:latest[0].at,traces:results};
}
export function historyRows(project: WorkspaceProject, traces: readonly HookTraceEvent[]): HistoryRow[] {
    return traces.map((trace, index) => {
        const tree = trace.context?.hookTree;
        const agent = trace.provider ?? 'codex';
        return { ...trace, provider: agent, id: trace.invocationId ? `${agent}:${trace.invocationId}:${trace.hookId}:${trace.kind}` : `${project.id}:${trace.at}:${trace.hookId}:${index}`, projectId: project.id, projectPath: project.path, repositoryId: tree?.repositoryId ?? project.repositoryId, repositoryLabel: tree?.repositoryLabel ?? project.repositoryLabel, checkout: tree?.checkout ?? project.path,
            // Current checkout metadata cannot establish a historical branch.
            branch: tree?.branch ?? null, commit: tree?.commit ?? null, detached: tree?.detached ?? false, sessionKey: trace.sessionId ? sessionKey(agent, trace.sessionId) : null };
    });
}
export function dedupeHistory(rows: HistoryRow[]): HistoryRow[] {
    return [...new Map(rows.map(row => [row.id, row])).values()].sort((a, b) => b.at.localeCompare(a.at));
}
export function branchKey(branch: string | null, detached: boolean): string { return branch ?? (detached ? '__detached' : '__unknown'); }
export function attributionTrees(row: HistoryRow, scope: HistoryFilters['scope']) {
    return scope === 'working' ? row.context?.workingTree ? [row.context.workingTree] : [] : scope === 'target' ? row.context?.targets ?? [] : [{ repositoryId: row.repositoryId, repositoryLabel: row.repositoryLabel, checkout: row.checkout, branch: row.branch, detached: row.detached }];
}
export function matchesHistory(row: HistoryRow, f: HistoryFilters): boolean {
    if (f.agent !== 'all' && row.provider !== f.agent || f.session && row.sessionKey !== f.session)
        return false;
    const trees = attributionTrees(row, f.scope);
    return trees.some(tree => (!f.repository || tree.repositoryId === f.repository) && (!f.project || tree.checkout === f.project) && (!f.branch || branchKey(tree.branch, tree.detached) === f.branch));
}
export function executionStats(rows: HistoryRow[]): {
    executions: number;
    blocked: number;
    errors: number;
    pending: number;
    durationMs: number;
} {
    const invocations = new Map<string, HistoryRow[]>();
    for (const row of dedupeHistory(rows)) {
        // Legacy entries lack a reliable invocation envelope; keep them visible without inventing executions.
        if (!row.invocationId)
            continue;
        const key = `${row.provider}:${row.invocationId}`;
        invocations.set(key, [...invocations.get(key) ?? [], row]);
    }
    const result = { executions: invocations.size, blocked: 0, errors: 0, pending: 0, durationMs: 0 };
    for (const group of invocations.values()) {
        if (group.some(row => row.decision === 'blocked'))
            result.blocked++;
        if (group.some(row => row.kind === 'error' || row.kind === 'aborted'))
            result.errors++;
        if (!group.some(row => row.hookId === 'dispatcher' && ['completed', 'aborted', 'observed'].includes(row.kind)))
            result.pending++;
        result.durationMs += group.filter(row => row.hookId !== 'dispatcher' && row.durationMs !== null).reduce((total, row) => total + (row.durationMs ?? 0), 0);
    }
    return result;
}
