import { listSessions, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { codexRpc } from './codex-rpc.js';
import type { HookProvider } from '../src/hook-types.js';
export interface SessionMetadata {
    agent: HookProvider;
    sessionId: string;
    title: string;
    cwd: string | null;
    updatedAt: string | null;
}
const kinds = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
export async function readSessions(agent: HookProvider, cwd: string): Promise<SessionMetadata[]> {
    if (agent === 'claude') {
        const result: SessionMetadata[] = [];
        for (let offset = 0; offset < 20000; offset += 200) {
            const page = await listSessions({ limit: 200, offset, includeProgrammatic: true });
            result.push(...page.map(s => ({ agent, sessionId: s.sessionId, title: s.customTitle ?? s.summary, cwd: s.cwd ?? null, updatedAt: new Date(s.lastModified).toISOString() })));
            if (page.length < 200)
                return result;
        }
        throw new Error('Claude session catalog exceeds 20,000 entries; narrow the configured agent home');
    }
    return codexRpc(cwd, async (call) => {
        const result: SessionMetadata[] = [];
        for (const archived of [false, true]) {
            let cursor: string | null = null;
            const seen = new Set<string>();
            do {
                const page = await call('thread/list', { limit: 200, cursor, archived, sourceKinds: kinds, useStateDbOnly: true }) as {
                    data?: {
                        id: string;
                        name?: string;
                        cwd?: string;
                        updatedAt: number;
                    }[];
                    nextCursor?: string | null;
                };
                if (!Array.isArray(page.data))
                    throw new Error('Unexpected Codex thread catalog');
                for (const s of page.data)
                    if (typeof s.id === 'string')
                        result.push({ agent, sessionId: s.id, title: s.name ?? s.id, cwd: s.cwd ?? null, updatedAt: Number.isFinite(s.updatedAt) ? new Date(s.updatedAt * 1000).toISOString() : null });
                cursor = page.nextCursor ?? null;
                if (cursor && seen.has(cursor))
                    throw new Error('Codex pagination repeated its cursor');
                if (cursor)
                    seen.add(cursor);
                if (result.length > 20000)
                    throw new Error('Codex session catalog exceeds 20,000 entries; narrow CODEX_HOME');
            } while (cursor);
        }
        return result;
    });
}
export async function readTranscript(agent: HookProvider, sessionId: string, cwd: string): Promise<unknown> {
    if (agent === 'claude') {
        const messages = await getSessionMessages(sessionId, { limit: 100, offset: 0 });
        if (!messages.length)
            throw new Error('No persisted transcript available yet');
        return messages;
    }
    return codexRpc(cwd, async (call) => call('thread/turns/list', { threadId: sessionId, limit: 50, itemsView: 'full' }));
}
