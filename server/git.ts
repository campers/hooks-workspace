import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { ExecutionContext, GitSnapshot } from '../src/workspace-types.js';
// Run Git against this directory, not a GIT_DIR inherited from an agent shell.
function git(path: string, ...args: string[]): string | null {
    const env = { ...process.env };
    for (const key of Object.keys(env))
        if (key.startsWith('GIT_'))
            delete env[key];
    const r = spawnSync('git', ['--no-optional-locks', '-C', path, ...args], { env, encoding: 'utf8', timeout: 1500, maxBuffer: 256 * 1024 });
    return r.status === 0 ? r.stdout.trim() : null;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
export function canonical(path: string): string { return realpathSync(path); }
// Remote identity is a grouping hint. Never retain credentials or URL queries.
export function remoteIdentity(raw: string): string | null {
    try {
        const scp = raw.match(/^(?:[^/@:]+@)?([^/:]+):(.+)$/);
        const u = new URL(raw.includes('://') ? raw : scp ? `ssh://${scp[1]}/${scp[2]}` : 'invalid:');
        if (!['ssh:', 'https:', 'http:', 'git:'].includes(u.protocol))
            return null;
        let path = u.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
        if (!path || path.includes('..'))
            return null;
        if (u.hostname.toLowerCase() === 'github.com')
            path = path.toLowerCase();
        const port = u.port && !((u.protocol === 'ssh:' && u.port === '22') || (u.protocol === 'git:' && u.port === '9418')) ? `:${u.port}` : '';
        return `${u.hostname.toLowerCase()}${port}/${path}`;
    }
    catch {
        return null;
    }
}
export function gitSnapshot(path: string): GitSnapshot {
    path = canonical(path);
    if (!statSync(path).isDirectory())
        path = dirname(path);
    const root = git(path, 'rev-parse', '--show-toplevel');
    const checkout = root ? canonical(root) : path;
    const common = root ? git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir') : null;
    const remote = root ? remoteIdentity(git(path, 'config', '--file', common ? resolve(common, 'config') : resolve(checkout, '.git/config'), '--get', 'remote.origin.url') ?? '') : null;
    const branch = root ? git(path, 'symbolic-ref', '--quiet', '--short', 'HEAD') : null;
    const commit = root ? git(path, 'rev-parse', '--verify', 'HEAD') : null;
    return { repositoryId: remote ? `remote:${remote}` : `local:${hash(common ? canonical(common) : checkout)}`, repositoryLabel: remote ?? basename(checkout), checkout, git: !!root, branch, commit, detached: !!root && !branch && !!commit };
}
export function worktrees(path: string): string[] {
    const output = git(path, 'worktree', 'list', '--porcelain', '-z');
    return output?.split('\0').filter(line => line.startsWith('worktree ')).map(line => line.slice(9)).filter(existsSync) ?? [];
}
function snapshotTarget(path: string): GitSnapshot | null {
    try {
        // Deleted/new files still belong to the repository of their existing parent.
        while (!existsSync(path) && dirname(path) !== path)
            path = dirname(path);
        return gitSnapshot(path);
    }
    catch {
        return null;
    }
}
export function executionContext(project: string, input: Record<string, unknown>): ExecutionContext {
    const cwd = typeof input.cwd === 'string' ? input.cwd : null;
    const hookTree = gitSnapshot(project);
    const workingTree = cwd ? snapshotTarget(cwd) : null;
    const tool = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input as Record<string, unknown> : {};
    const paths = [tool.file_path, tool.path, tool.workdir, tool.cwd, input.directory, input.new_cwd];
    if (input.tool_name === 'apply_patch' && typeof tool.command === 'string') {
        for (const line of tool.command.split('\n')) {
            const match = line.match(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/);
            if (match)
                paths.push(match[1]);
        }
    }
    const targets = new Map<string, GitSnapshot>();
    for (const path of paths)
        if (typeof path === 'string' && path && cwd) {
            const target = snapshotTarget(resolve(cwd, path));
            if (target)
                targets.set(target.checkout, target);
        }
    return { hookProject: canonical(project), cwd, transcriptPath: typeof input.transcript_path === 'string' ? input.transcript_path : null, agentId: typeof input.agent_id === 'string' ? input.agent_id : null, hookTree, workingTree, targets: [...targets.values()] };
}
