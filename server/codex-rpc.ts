import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
export async function codexRpc<T>(cwd: string, read: (call: (method: string, params: object) => Promise<unknown>) => Promise<T>): Promise<T> {
    const child = spawn('codex', ['app-server', '--stdio'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    const lines = createInterface({ input: child.stdout });
    let id = 0;
    const pending = new Map<number, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
    }>();
    let failure: Error | null = null;
    const fail = (error: Error) => { failure = error; for (const p of pending.values())
        p.reject(error); pending.clear(); };
    child.on('error', () => fail(new Error('Codex is unavailable on PATH')));
    child.on('exit', () => fail(new Error('Codex session discovery exited')));
    child.stdin.on('error', () => fail(new Error('Codex discovery connection closed')));
    const timer = setTimeout(() => { fail(new Error('Codex session discovery timed out')); child.kill(); }, 20000);
    lines.on('line', line => {
        try {
            if (line.length > 4 * 1024 * 1024)
                throw new Error('Codex response exceeds discovery limit');
            const m = JSON.parse(line);
            const p = pending.get(m.id);
            if (!p)
                return;
            pending.delete(m.id);
            if (m.error)
                p.reject(new Error('Codex rejected ' + (m.error.message ?? 'the session request')));
            else
                p.resolve(m.result);
        }
        catch {
            fail(new Error('Invalid Codex discovery response'));
        }
    });
    const call = (method: string, params: object) => new Promise<unknown>((resolve, reject) => {
        if (failure) {
            reject(failure);
            return;
        }
        const requestId = ++id;
        pending.set(requestId, { resolve, reject });
        child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n');
    });
    try {
        await call('initialize', { clientInfo: { name: 'hooks_workspace_sessions', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
        return await read(call);
    }
    finally {
        clearTimeout(timer);
        lines.close();
        child.kill();
    }
}
