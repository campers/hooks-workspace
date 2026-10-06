import type { HookControlPlaneData, HookEventId, HookProvider, ProviderEventStatus, ProviderStatusSnapshot } from './hook-types';

function unavailable(reason: string): ProviderEventStatus {
  return { configured: { state:'unknown',reason }, providerEnabled: { state:'unknown',reason }, commandApproval: { state:'unknown',reason }, workspaceApproval: { state:'unknown',reason }, label:reason === 'Checking configuration' ? 'Checking…' : 'Unavailable',reason,ready:false,commandCount:0,inventory:[],complete:false };
}
export function withAgentStatus(data: HookControlPlaneData, snapshots: ProviderStatusSnapshot[]): HookControlPlaneData {
  const agentEvents: Record<HookProvider, Partial<Record<HookEventId,ProviderEventStatus>>> = { codex:{},claude:{} };
  const providerEvents: Partial<Record<HookEventId,ProviderEventStatus>> = {};
  for (const event of data.events) {
    for (const agent of ['codex','claude'] as const) {
      const snapshot = snapshots.find(s=>s.provider===agent);
      agentEvents[agent][event.id] = snapshot?.providerEvents[event.id] ?? unavailable(snapshot?.error ?? 'Checking configuration');
    }
    const entries = (['codex','claude'] as const).map(agent=>({agent,value:agentEvents[agent][event.id]!}));
    providerEvents[event.id] = { ...entries[0].value, configured:{state:'unknown',reason:'See per-agent configuration'},providerEnabled:{state:'unknown',reason:'See per-agent enablement'},commandApproval:{state:'unsupported',reason:'Approval is agent-specific'},workspaceApproval:{state:'unknown',reason:'Live workspace approval is unavailable'}, label:entries.map(s=>`${s.agent==='claude'?'Claude Code':'Codex'}: ${s.value.label}`).join(' · '), reason:entries.map(s=>`${s.agent}: ${s.value.reason}`).join('\n'), ready:entries.every(s=>s.value.ready),commandCount:entries.reduce((sum,s)=>sum+s.value.commandCount,0),inventory:entries.flatMap(s=>s.value.inventory),complete:entries.every(s=>s.value.complete) };
  }
  return { ...data,providerEvents,agentEvents,hooks:data.hooks.map(h=>({...h,runtimeStatus:h.enabledNow?'On':'Off',runtimeReason:snapshots.map(s=>`${s.provider}: ${s.hooks[h.id]?.reason??s.error??'Checking configuration'}`).join('\n')})) };
}
