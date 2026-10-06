import type { HookCallback, HookCallbackMatcher, HookEvent, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { observe, observationEvents } from './observer.js';
import { dispatch } from './dispatcher.js';
import { object } from './protocol.js';

// Optional runtime bridge. Never used by the workbench HTTP server. Register either
// these callbacks or native dispatcher commands for a session, never both.
export function claudeSdkHooks(project: string, registry?: string): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const callback: HookCallback = async (input, toolUseID, { signal }): Promise<SyncHookJSONOutput> => {
    signal.throwIfAborted();
    if (observationEvents.claude.includes(input.hook_event_name)) { observe(project,'claude',input,registry); return {}; }
    const output = await dispatch(project, 'claude', { ...input, tool_use_id: 'tool_use_id' in input ? input.tool_use_id : toolUseID }, registry, { signal, transport: 'sdk-callback' });
    // Decode only the exact native output subset this dispatcher can emit.
    const result: SyncHookJSONOutput = {};
    if (output.decision === 'block') result.decision = 'block';
    if (typeof output.reason === 'string') result.reason = output.reason;
    if (typeof output.systemMessage === 'string') result.systemMessage = output.systemMessage;
    if (output.continue === false) { result.continue = false; if (typeof output.stopReason === 'string') result.stopReason = output.stopReason; }
    const specific = output.hookSpecificOutput;
    if (object(specific)) {
      const context = typeof specific.additionalContext === 'string' ? specific.additionalContext : undefined;
      switch (input.hook_event_name) {
        case 'PreToolUse': result.hookSpecificOutput = { hookEventName: 'PreToolUse', additionalContext: context, ...(specific.permissionDecision === 'deny' ? { permissionDecision: 'deny', permissionDecisionReason: String(specific.permissionDecisionReason) } : {}), ...(object(specific.updatedInput) ? { updatedInput: specific.updatedInput } : {}) }; break;
        case 'PostToolUse': result.hookSpecificOutput = { hookEventName: 'PostToolUse', additionalContext: context }; break;
        case 'SessionStart': result.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext: context }; break;
        case 'UserPromptSubmit': result.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: context }; break;
        default: throw new Error('Unsupported SDK hook output event');
      }
    }
    return result;
  };
  return Object.fromEntries(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', ...observationEvents.claude].map(event => [event, [{ hooks: [callback], timeout: 30 }]]));
}
