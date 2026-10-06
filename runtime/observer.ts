import { appendFileSync, constants, openSync, closeSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stateDirectory, containedPath } from '../server/registry.js';
import { executionContext } from '../server/git.js';
import type { HookProvider } from '../src/hook-types.js';
export const observationEvents = { codex: ['SessionEnd', 'SubagentStart', 'SubagentStop'], claude: ['SessionEnd', 'SubagentStart', 'SubagentStop', 'CwdChanged', 'DirectoryAdded'] };
export function observe(project: string, provider: HookProvider, input: Record<string, unknown>, registry?: string): void {
    if (typeof input.hook_event_name !== 'string' || !observationEvents[provider].includes(input.hook_event_name))
        throw new Error('Unsupported observation event');
    project = realpathSync(project);
    const state = stateDirectory(project, registry);
    for (const path of [state, join(state, 'event-ledger')]) {
        if (!existsSync(path))
            mkdirSync(path, { mode: 0o700 });
        containedPath(project, path);
    }
    const ledger = join(state, 'event-ledger', new Date().toISOString().slice(0, 10) + '.jsonl');
    const fd = openSync(ledger, constants.O_APPEND | constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
        appendFileSync(fd, JSON.stringify({ schemaVersion: 2, at: new Date().toISOString(), provider, invocationId: randomUUID(), hookName: 'dispatcher', kind: 'observed', decision: 'observed', hookEventName: input.hook_event_name, sessionId: typeof input.session_id === 'string' ? input.session_id : null, context: executionContext(project, input) }) + '\n');
    }
    finally {
        closeSync(fd);
    }
}
