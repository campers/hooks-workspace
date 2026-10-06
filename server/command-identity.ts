import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
// Deliberately reject compound shell syntax rather than guessing parent identity.
export function commandArguments(command: string): string[] | null {
  const tokens: string[] = []; let token = ''; let quote = ''; let active = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) { if (char === quote) quote = ''; else if (char === '\\' && quote === '"') token += command[++i] ?? ''; else token += char; active = true; }
    else if (char === '"' || char === "'") { quote = char; active = true; }
    else if (/\s/.test(char)) { if (active) { tokens.push(token); token = ''; active = false; } }
    else if (';&|><`$()'.includes(char)) return null;
    else if (char === '\\') { token += command[++i] ?? ''; active = true; }
    else { token += char; active = true; }
  }
  if (quote) return null;
  if (active) tokens.push(token);
  return tokens;
}
export function referencesSource(command: string, source: string, project: string): boolean {
  const tokens = commandArguments(command);
  return !!tokens?.some(token => !token.startsWith('-') && resolve(project, token) === resolve(project, source));
}
export function isDispatcher(command: string, project: string, provider: string, registry?: string): boolean {
  const tokens = commandArguments(command);
  if (!tokens || !tokens.some(token => resolve(project, token) === fileURLToPath(new URL('../scripts/dispatch-hook.ts', import.meta.url)))) return false;
  if (registry) {
    const index = tokens.indexOf('--registry');
    if (index >= 0 && tokens[index + 1]) { try { if (realpathSync(resolve(project, tokens[index + 1])) !== registry) return false; } catch { return false; } }
    else if (registry !== resolve(project, '.hooks-workspace/registry.yaml') && registry !== resolve(project, '.codex/hooks/registry.yaml')) return false;
  }
  return tokens[tokens.indexOf('--project') + 1] === project && tokens[tokens.indexOf('--provider') + 1] === provider && tokens.includes('--project') && tokens.includes('--provider');
}
