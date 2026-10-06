import type { HookProvider, HookTraceEvent } from './hook-types';
export interface GitSnapshot {
    repositoryId: string;
    repositoryLabel: string;
    checkout: string;
    git: boolean;
    branch: string | null;
    commit: string | null;
    detached: boolean;
}
export interface ExecutionContext {
    hookProject: string;
    cwd: string | null;
    transcriptPath: string | null;
    agentId: string | null;
    hookTree: GitSnapshot;
    workingTree: GitSnapshot | null;
    targets: GitSnapshot[];
}
export interface WorkspaceProject extends GitSnapshot {
    id: string;
    path: string;
    registry: boolean;
    explicit: boolean;
}
export interface WorkspaceSession {
    id: string;
    agent: HookProvider;
    sessionId: string;
    title: string;
    cwd: string | null;
    updatedAt: string | null;
    projectIds: string[];
    activity: 'unknown' | 'observed';
}
export interface WorkspaceCatalog {
    projects: WorkspaceProject[];
    sessions: WorkspaceSession[];
    errors: string[];
    checkedAt: string | null;
    loading: boolean;
    discovery: boolean;
}
export interface HistoryRow extends HookTraceEvent {
    id: string;
    projectId: string;
    projectPath: string;
    repositoryId: string;
    repositoryLabel: string;
    checkout: string;
    branch: string | null;
    commit: string | null;
    detached: boolean;
    sessionKey: string | null;
}
export interface HistoryFilters {
    agent: 'all' | HookProvider;
    repository: string;
    branch: string;
    project: string;
    session: string;
    scope: 'owner' | 'working' | 'target';
}
