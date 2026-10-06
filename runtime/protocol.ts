import type { HookEventId, HookProvider } from '../src/hook-types.js';
export interface Invocation { provider: HookProvider; event: HookEventId; sessionId: string | null; turnId: string | null; promptId: string | null; toolUseId: string | null; toolName: string | null; permissionMode: string | null; transcriptPath: string | null; stopHookActive: boolean; native: Record<string, unknown> }
export type Effect = { action: 'context' | 'warning' | 'rejectPrompt' | 'denyTool' | 'feedback' | 'continueStop' | 'endProcessing'; message: string } | { action: 'rewriteToolInput'; input: Record<string, unknown> };
export interface StageResult { outcome: 'passed' | 'failed'; effects: Effect[] }
export function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
const events = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
export function decodeInvocation(provider: HookProvider, value: unknown): Invocation {
  if (!object(value) || typeof value.hook_event_name !== 'string' || !events.has(value.hook_event_name)) throw new Error('Unsupported hook input event');
  const string = (key: string) => typeof value[key] === 'string' ? value[key] as string : null;
  return { provider, event: value.hook_event_name as HookEventId, sessionId: string('session_id'), turnId: string('turn_id'), promptId: string('prompt_id'), toolUseId: string('tool_use_id'), toolName: string('tool_name'), permissionMode: string('permission_mode'), transcriptPath: string('transcript_path'), stopHookActive: value.stop_hook_active === true, native: value };
}
export function validateEffect(effect: Effect, invocation: Invocation, allowRewrite = false): void {
  const event = invocation.event;
  if ((effect.action === 'rejectPrompt' && event !== 'UserPromptSubmit') || (['denyTool', 'rewriteToolInput'].includes(effect.action) && event !== 'PreToolUse') || (effect.action === 'feedback' && event !== 'PostToolUse') || (effect.action === 'continueStop' && event !== 'Stop')) throw new Error(`${effect.action} is not supported for ${event}`);
  if (effect.action === 'rewriteToolInput' && !allowRewrite) throw new Error('Input rewrite requires allowInputRewrite: true in the registry');
  if (effect.action === 'endProcessing' && invocation.provider !== 'claude') throw new Error('Codex does not support endProcessing');
  if (effect.action === 'context' && event === 'Stop') throw new Error('Stop does not support additional context');
}
export function parseResult(raw: string, invocation: Invocation, format: 'neutral' | 'native' = 'native', nativeProvider: HookProvider = invocation.provider): StageResult {
  if (!raw.trim()) return { outcome: 'passed', effects: [] };
  const value: unknown = JSON.parse(raw);
  if (!object(value)) throw new Error('Stage output must be a JSON object');
  if (format === 'neutral') {
    if ((value.outcome !== 'passed' && value.outcome !== 'failed') || !Array.isArray(value.effects)) throw new Error('Invalid neutral stage result');
    const actions = new Set(['context', 'warning', 'rejectPrompt', 'denyTool', 'feedback', 'continueStop', 'endProcessing', 'rewriteToolInput']);
    for (const effect of value.effects) {
      if (!object(effect) || typeof effect.action !== 'string' || !actions.has(effect.action) || (effect.action === 'rewriteToolInput' ? !object(effect.input) : typeof effect.message !== 'string')) throw new Error('Invalid stage effect');
    }
    return value as unknown as StageResult;
  }
  const effects: Effect[] = [];
  const allowed = new Set(['hookSpecificOutput', 'decision', 'reason', 'systemMessage', 'continue', 'stopReason', 'suppressOutput']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('Unknown native output fields; use a neutral result or extend the adapter');
  if (typeof value.systemMessage === 'string') effects.push({ action: 'warning', message: value.systemMessage });
  if (value.continue === false) {
    if (nativeProvider !== 'claude') throw new Error('Codex does not support continue:false');
    effects.push({ action: 'endProcessing', message: typeof value.stopReason === 'string' ? value.stopReason : 'Stopped by hook' });
  }
  if (value.suppressOutput !== undefined) throw new Error('suppressOutput has no shared equivalent');
  if (value.decision !== undefined && value.decision !== 'block') throw new Error('Unsupported native decision');
  if (value.decision === 'block') {
    const message = typeof value.reason === 'string' ? value.reason : 'Blocked by hook';
    const action = invocation.event === 'Stop' ? 'continueStop' : invocation.event === 'UserPromptSubmit' ? 'rejectPrompt' : invocation.event === 'PostToolUse' ? 'feedback' : null;
    if (!action) throw new Error('Top-level block is unsupported for this event');
    if (invocation.event === 'PostToolUse' && nativeProvider !== invocation.provider) throw new Error('PostToolUse block has different provider semantics; use an explicit neutral feedback effect');
    effects.push({ action, message });
  }
  if (value.hookSpecificOutput !== undefined) {
    const output = value.hookSpecificOutput;
    if (!object(output) || output.hookEventName !== invocation.event) throw new Error('Native output event does not match input');
    if (Object.keys(output).some(key => !['hookEventName', 'additionalContext', 'permissionDecision', 'permissionDecisionReason', 'updatedInput'].includes(key))) throw new Error('Unsupported native hookSpecificOutput field');
    if (typeof output.additionalContext === 'string') effects.push({ action: 'context', message: output.additionalContext });
    if (output.permissionDecision === 'deny') effects.push({ action: 'denyTool', message: typeof output.permissionDecisionReason === 'string' ? output.permissionDecisionReason : 'Denied by hook' });
    else if (output.permissionDecision !== undefined) throw new Error('Permission allow/ask/defer is not a shared pass result; native permission changes are rejected');
    if (object(output.updatedInput)) effects.push({ action: 'rewriteToolInput', input: output.updatedInput });
    else if (output.updatedInput !== undefined) throw new Error('updatedInput must be an object');
  }
  return { outcome: effects.some(e => ['rejectPrompt', 'denyTool', 'feedback', 'continueStop', 'endProcessing'].includes(e.action)) ? 'failed' : 'passed', effects };
}
export function encodeEffects(invocation: Invocation, effects: Effect[]): Record<string, unknown> {
  if (!effects.length) return {};
  const result: Record<string, unknown> = {};
  const contexts = effects.filter(e => e.action === 'context').map(e => 'message' in e ? e.message : '');
  const warnings = effects.filter(e => e.action === 'warning').map(e => 'message' in e ? e.message : '');
  if (warnings.length) result.systemMessage = warnings.join('\n');
  const specific: Record<string, unknown> = { hookEventName: invocation.event };
  if (contexts.length) specific.additionalContext = contexts.join('\n');
  const deny = effects.find(e => e.action === 'denyTool');
  const rewrite = effects.filter(e => e.action === 'rewriteToolInput').at(-1);
  if (deny && 'message' in deny) { specific.permissionDecision = 'deny'; specific.permissionDecisionReason = deny.message; }
  else if (rewrite && 'input' in rewrite) {
    // Codex requires allow for a rewrite: never emit it from a normal passing stage.
    specific.updatedInput = rewrite.input;
    if (invocation.provider === 'codex') specific.permissionDecision = 'allow';
  }
  if (Object.keys(specific).length > 1) result.hookSpecificOutput = specific;
  const blocks = effects.filter(e => ['rejectPrompt', 'feedback', 'continueStop'].includes(e.action));
  if (blocks.length) { result.decision = 'block'; result.reason = blocks.map(e => 'message' in e ? e.message : '').join('\n'); }
  const end = effects.find(e => e.action === 'endProcessing');
  if (end && 'message' in end) { result.continue = false; result.stopReason = end.message; }
  return result;
}
