import { stateDirectory } from './registry.js';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { HookTokenUsage } from '../src/hook-types.js';

// Contract emitted by hook-side observability/llm_usage.cjs. Daily UTC files,
// rolling elapsed-time windows. Do not derive usage from prompt length or traces.
export function loadTokenUsage(project: string, now = Date.now(), selection?: string): HookTokenUsage {
  const empty = () => ({ hour: 0, day: 0, missingHour: 0, missingDay: 0, recorded: false });
  const result: HookTokenUsage = { codex: empty(), claude: empty(), jev: empty(), checkedAt: new Date(now).toISOString(), error: null };
  try {
    const root = realpathSync(project);
    const contained = (file: string) => {
      const actual = realpathSync(file);
      if (!actual.startsWith(`${root}${sep}`)) throw new Error('Token usage path must stay inside the project.');
      return actual;
    };
    const dir = join(stateDirectory(root, selection), 'llm-usage');
    if (!existsSync(dir)) return result;
    contained(dir);
    const seen = new Set<string>();
    for (const date of new Set([new Date(now).toISOString().slice(0, 10), new Date(now - 86400000).toISOString().slice(0, 10)])) {
      const file = join(dir, `${date}.jsonl`);
      if (!existsSync(file)) continue;
      const actual = contained(file);
      if (statSync(actual).size > 16 * 1024 * 1024) throw new Error('Usage file exceeds the supported size; totals unavailable.');
      for (const line of readFileSync(actual, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { throw new Error('Incomplete or malformed usage record; retry after the writer finishes.'); }
        if (!row || row.schemaVersion !== 1 || !['codex', 'claude', 'jev'].includes(row.provider) || typeof row.id !== 'string' || !row.id || typeof row.at !== 'string') throw new Error('Invalid usage record.');
        const at = Date.parse(row.at);
        if (!Number.isFinite(at)) throw new Error('Invalid usage timestamp.');
        if (at > now) continue;
        const unknown = row.totalTokens === null;
        if (!unknown && ![row.inputTokens, row.outputTokens, row.totalTokens].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid usage token count.');
        const key = `${row.provider}:${row.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const provider = result[row.provider as 'codex' | 'claude' | 'jev'];
        provider.recorded = true;
        if (at < now - 86400000) continue;
        if (unknown) provider.missingDay += 1; else provider.day += row.totalTokens;
        if (at >= now - 3600000) {
          if (unknown) provider.missingHour += 1; else provider.hour += row.totalTokens;
        }
        if (!Number.isSafeInteger(provider.day)) throw new Error('Usage total exceeds safe integer range.');
      }
    }
    return result;
  } catch (error) {
    return { codex: empty(), claude: empty(), jev: empty(), checkedAt: result.checkedAt, error: error instanceof Error ? error.message : 'Cannot read hook usage.' };
  }
}
