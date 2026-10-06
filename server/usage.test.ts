import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTokenUsage } from './usage.js';
const now = Date.parse('2026-10-04T00:30:00Z');
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'hook-usage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, '.codex/hooks/state/llm-usage');
  mkdirSync(dir, { recursive: true });
  return { root, dir };
}
const row = (id: string, at: number, provider = 'codex', totalTokens: number | null = 30) => ({ schemaVersion: 1, id, at: new Date(at).toISOString(), provider, inputTokens: totalTokens === null ? null : 20, outputTokens: totalTokens === null ? null : 10, totalTokens });
test('rolling windows cross UTC dates, include exact boundaries and deduplicate call IDs', (t) => {
  const f = fixture(t);
  const a = row('a', now - 3600000);
  writeFileSync(join(f.dir, '2026-10-03.jsonl'), [a, a, row('b', now - 86400000), row('old', now - 86400001)].map((value) => JSON.stringify(value)).join('\n') + '\n');
  writeFileSync(join(f.dir, '2026-10-04.jsonl'), [row('j', now, 'jev', 100), row('missing', now, 'jev', null), row('future', now + 1)].map((value) => JSON.stringify(value)).join('\n') + '\n');
  const result = loadTokenUsage(f.root, now);
  assert.equal(result.error, null);
  assert.deepEqual(result.codex, { hour: 30, day: 60, missingHour: 0, missingDay: 0, recorded: true });
  assert.deepEqual(result.jev, { hour: 100, day: 100, missingHour: 1, missingDay: 1, recorded: true });
});
test('no telemetry is unknown; malformed data and external symlinks cannot yield false totals', (t) => {
  const f = fixture(t);
  assert.equal(loadTokenUsage(f.root, now).codex.recorded, false);
  const file = join(f.dir, '2026-10-04.jsonl');
  for (const content of ['{', JSON.stringify({ ...row('bad', now), totalTokens: -1 })]) {
    writeFileSync(file, content);
    const result = loadTokenUsage(f.root, now);
    assert.ok(result.error);
    assert.equal(result.codex.recorded, false);
  }
  rmSync(file);
  const external = fixture(t);
  const target = join(external.dir, 'outside.jsonl');
  writeFileSync(target, JSON.stringify(row('outside', now)));
  symlinkSync(target, file);
  assert.match(loadTokenUsage(f.root, now).error ?? '', /inside the project/);
});
