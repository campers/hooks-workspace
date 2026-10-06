// Local inventory only. No agent/model turns or user configuration are used.
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { readSessions, readTranscript } from '../server/sessions.js';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'session-discovery-')));
const previous = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
try {
    const codex = join(root, 'codex'), claude = join(root, 'claude'), project = join(root, 'project');
    mkdirSync(codex);
    mkdirSync(claude);
    mkdirSync(project);
    writeFileSync(join(codex, 'config.toml'), '');
    process.env.CODEX_HOME = codex;
    process.env.CLAUDE_CONFIG_DIR = claude;
    const id = '11111111-1111-4111-8111-111111111111';
    const projectDir = join(claude, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, id + '.jsonl'), JSON.stringify({ type: 'user', uuid: '22222222-2222-4222-8222-222222222222', parentUuid: null, isSidechain: false, cwd: project, sessionId: id, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Discovery fixture prompt' } }) + '\n');
    const [codexSessions, claudeSessions] = await Promise.all([readSessions('codex', project), readSessions('claude', project)]);
    assert.equal(codexSessions.length, 0);
    assert.equal(claudeSessions.length, 1);
    assert.equal(claudeSessions[0].sessionId, id);
    assert.equal(claudeSessions[0].cwd, project);
    const messages = await readTranscript('claude', id, project);
    assert.ok(JSON.stringify(messages).includes('Discovery fixture prompt'));
    console.log('Discovery smoke passed: actual Codex app-server active/archived enumeration, Claude SDK all-project inventory and read-only transcript retrieval. No model requests.');
}
finally {
    for (const [key, value] of Object.entries(previous)) {
        if (value === undefined)
            delete process.env[key];
        else
            process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
}
