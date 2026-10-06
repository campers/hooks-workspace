import { readFileSync, mkdirSync, appendFileSync, realpathSync, existsSync, constants, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readStages, type Stage } from './registry.js';
import { resolveRegistry, containedPath, stateDirectory } from '../server/registry.js';
import { registryRevision } from '../server/management.js';
import { decodeInvocation, encodeEffects, object, parseResult, validateEffect, type Effect } from './protocol.js';
import type { HookProvider } from '../src/hook-types.js';
import { executionContext } from '../server/git.js';

function enabled(stage: Stage): boolean {
  if (stage.managed) return stage.managed.enabled;
  const value = (stage.enabled.environment ? process.env[stage.enabled.environment] : '')?.toLowerCase();
  return stage.enabled.mode === 'always' || (stage.enabled.mode === 'opt-in' ? value === '1' || value === 'true' : value !== '0' && value !== 'false');
}
function execute(source: string, project: string, input: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [source], { cwd: project, stdio: ['pipe', 'pipe', 'pipe'], env: process.env, detached: process.platform !== 'win32' });
    let stdout = ''; let stderr = ''; let error: Error | undefined;
    const terminate = (message: string) => { error = new Error(message); if (child.pid && process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } else child.kill('SIGKILL'); };
    const abort = () => terminate('SDK callback aborted');
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => terminate('Stage timed out'), timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 1024 * 1024) terminate('Stage output too large'); });
    child.stderr.on('data', chunk => { stderr += chunk; if (Buffer.byteLength(stderr) > 1024 * 1024) terminate('Stage error output too large'); });
    child.on('error', cause => { error = cause; });
    child.stdin.on('error', () => { /* A stage may exit without consuming all input. */ });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve({ stdout, stderr, code }); });
    child.stdin.end(JSON.stringify(input));
  });
}
export async function dispatch(project: string, provider: HookProvider, input: unknown, selection?: string, options: { signal?: AbortSignal; transport?: 'native-command' | 'sdk-callback' } = {}): Promise<Record<string, unknown>> {
  options.signal?.throwIfAborted();
  const deadline = Date.now() + 25000;
  project = realpathSync(project);
  const invocation = decodeInvocation(provider, input);
  // The caller selects the hook owner. A session may work in another checkout;
  // this never changes the registry, stage source or state write boundary.
  const context = executionContext(project, invocation.native);
  const file = resolveRegistry(project, selection);
  const raw = readFileSync(file, 'utf8');
  const stages = readStages(raw).filter(s => s.event === invocation.event).toSorted((a,b) => a.order - b.order);
  const revision = registryRevision(raw); const invocationId = randomUUID();
  const state = stateDirectory(project, selection);
  // Check ancestors before creating directories, preventing state symlinks outside the project.
  for (const path of [state, join(state, 'event-ledger')]) { if (existsSync(path)) containedPath(project, path); else { mkdirSync(path, { mode: 0o700 }); containedPath(project, path); } }
  const ledger = join(state, 'event-ledger', new Date().toISOString().slice(0,10) + '.jsonl');
  if (existsSync(ledger)) containedPath(project, ledger);
  const record = (hookName: string, kind: string, decision: string, stage?: Stage, durationMs?: number, message?: string, effectSummary?: { requested: string[]; applied: string[]; nativeDecision?: unknown }) => {
    const descriptor = openSync(ledger, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { appendFileSync(descriptor, JSON.stringify({ schemaVersion: 2, context, at: new Date().toISOString(), provider, providerVersion: null, versionReason: 'Live executable version not supplied by native hook payload', transport: options.transport ?? 'native-command', effectSummary, invocationId, registryRevision: revision, hookName, hookEventName: invocation.event, sessionId: invocation.sessionId, turnId: invocation.turnId, promptId: invocation.promptId, toolUseId: invocation.toolUseId, stage: stage?.stage, kind, decision, durationMs, message }) + '\n'); }
    finally { closeSync(descriptor); }
  };
  record('dispatcher', 'started', 'started');
  const outcomes = new Map<string, string>(); let blocked = false; let stageInput = invocation.native; const effects: Effect[] = [];
  for (const stage of stages) {
    options.signal?.throwIfAborted();
    const skip = Date.now() >= deadline ? 'invocation-deadline' : !enabled(stage) ? 'disabled' : stage.providers && !stage.providers.includes(provider) ? 'unsupported-provider' : (stage.managed?.dependsOn ?? []).some(id => outcomes.get(id) !== 'passed') ? 'unmet-prerequisite' : blocked && stage.stage !== 'finalizer' ? 'short-circuited' : null;
    if (skip) { outcomes.set(stage.id, 'skipped'); record(stage.id, 'skipped', 'skipped', stage, 0, skip); continue; }
    const started = Date.now();
    try {
      const source = containedPath(project, stage.source);
      if (!/\.(cjs|mjs|js)$/.test(source)) throw new Error('Stage source must be a Node.js script');
      const response = await execute(source, project, { ...stageInput, hooks_workspace: { provider, invocationId, revision } }, Math.min(stage.timeoutMs ?? 5000, Math.max(1, deadline - Date.now())), options.signal);
      let result;
      if (response.code === 2) {
        const dialect = stage.nativeProvider ?? (file.includes('/.codex/hooks/') ? 'codex' : provider);
        if (invocation.event === 'PostToolUse' && dialect !== provider) throw new Error('Cross-provider PostToolUse exit 2 has incompatible result semantics');
        const message = response.stderr.trim() || 'Stage blocked';
        const action = invocation.event === 'Stop' ? 'continueStop' : invocation.event === 'UserPromptSubmit' ? 'rejectPrompt' : invocation.event === 'PreToolUse' ? 'denyTool' : invocation.event === 'PostToolUse' ? 'feedback' : null;
        if (!action) throw new Error('Exit 2 is unsupported for this event');
        result = { outcome: 'failed' as const, effects: [{ action, message } as Effect] };
      } else if (response.code !== 0) throw new Error(`Stage exited ${response.code}`);
      else result = parseResult(response.stdout, invocation, stage.resultFormat, stage.nativeProvider ?? (file.includes('/.codex/hooks/') ? 'codex' : provider));
      for (const effect of result.effects) validateEffect(effect, invocation, stage.allowInputRewrite === true);
      const blocking = stage.managed?.blocking ?? stage.canBlock;
      const accepted = result.effects.filter(effect => {
        if (blocked && effect.action === 'rewriteToolInput') return false;
        if (effect.action === 'continueStop' && invocation.stopHookActive) return false;
        return ['context', 'warning'].includes(effect.action) || blocking;
      });
      effects.push(...accepted);
      const rewrite = accepted.filter(effect => effect.action === 'rewriteToolInput').at(-1);
      if (rewrite && 'input' in rewrite) stageInput = { ...stageInput, tool_input: rewrite.input };
      const native = encodeEffects(invocation, accepted);
      const nativeDecision = { decision: native.decision ?? null, permissionDecision: object(native.hookSpecificOutput) ? native.hookSpecificOutput.permissionDecision ?? null : null, endProcessing: native.continue === false };
      const effectiveBlock = accepted.some(effect => ['rejectPrompt','denyTool','feedback','continueStop','endProcessing'].includes(effect.action));
      blocked ||= effectiveBlock;
      outcomes.set(stage.id, result.outcome);
      record(stage.id, 'completed', effectiveBlock ? 'blocked' : result.outcome, stage, Date.now() - started, result.effects.length !== accepted.length ? 'Blocking effect suppressed by advisory setting or Stop loop guard' : undefined, { requested: result.effects.map(effect => effect.action), applied: accepted.map(effect => effect.action), nativeDecision });
    } catch (error) {
      if (options.signal?.aborted) {
        record(stage.id, 'error', 'error', stage, Date.now() - started, 'SDK callback aborted');
        record('dispatcher', 'aborted', 'aborted');
        options.signal.throwIfAborted();
      }
      outcomes.set(stage.id, 'error'); record(stage.id, 'error', 'error', stage, Date.now() - started, error instanceof Error ? error.message : String(error));
    }
  }
  record('dispatcher', 'completed', blocked ? 'blocked' : 'passed');
  return encodeEffects(invocation, effects);
}
