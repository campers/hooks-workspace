import { useState, type JSX } from 'react';
import type { HookControlPlaneData, HookDefinition } from './hook-types';
import { Button } from './components/ui/button';

export function HookManagement({ hook, data, onSaved }: { hook: HookDefinition; data: HookControlPlaneData; onSaved: () => void }): JSX.Element | null {
  const settings = hook.managed;
  const siblings = data.hooks.filter((item) => item.event === hook.event).toSorted((a, b) => a.order - b.order);
  const [enabled, setEnabled] = useState(settings?.enabled ?? false);
  const [blocking, setBlocking] = useState(settings?.blocking ?? false);
  const [dependsOn, setDependsOn] = useState(settings?.dependsOn ?? []);
  const [position, setPosition] = useState(siblings.findIndex((item) => item.id === hook.id));
  const [revision, setRevision] = useState(data.managementRevision);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!settings || !data.managementRevision) return null;
  const save = async (): Promise<void> => {
    setBusy(true); setError(''); setSaved(false);
    const ordered = siblings.filter((item) => item.id !== hook.id);
    ordered.splice(position, 0, hook);
    const hooks = data.hooks.map((item) => ({ id: item.id, enabled: item.managed?.enabled ?? item.enabledNow, blocking: item.managed?.blocking ?? item.canBlock, dependsOn: item.managed?.dependsOn ?? [], order: item.event === hook.event ? (ordered.findIndex((other) => other.id === item.id) + 1) * 10 : item.order, ...(item.id === hook.id ? { enabled, blocking, dependsOn } : {}) }));
    try {
      const response = await fetch(`/api/management?provider=${data.provider ?? 'codex'}&project=${encodeURIComponent(data.projectId ?? '')}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-Hooks-Workspace': '1' }, body: JSON.stringify({ revision, hooks }), signal: AbortSignal.timeout(10000) });
      const result = await response.json() as { error?: string; data?: HookControlPlaneData };
      if (!response.ok) throw new Error(result.error ?? 'Could not save settings');
      if (result.data?.managementRevision) setRevision(result.data.managementRevision);
      setSaved(true);
      onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save settings'); }
    finally { setBusy(false); }
  };
  return <section aria-label="Sub-hook settings" className="space-y-3 rounded-md border p-3 text-xs">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <label className="flex items-center gap-2"><input disabled={busy} type="checkbox" checked={enabled} onChange={(event) => { setSaved(false); setEnabled(event.target.checked); }} />Enabled</label>
      {hook.canBlock ? <label className="flex items-center gap-2"><input disabled={busy} type="checkbox" checked={blocking} onChange={(event) => { setSaved(false); setBlocking(event.target.checked); }} />{hook.event === 'Stop' ? 'Requests continuation' : hook.event === 'UserPromptSubmit' ? 'Rejects prompt' : hook.event === 'PostToolUse' ? 'Returns feedback' : 'Blocks tool use'}</label> : null}
      <label className="flex items-center gap-2">Position<select disabled={busy} aria-label="Execution position" className="rounded border bg-background px-2 py-1" value={position} onChange={(event) => { setSaved(false); setPosition(Number(event.target.value)); }}>{siblings.map((item, index) => <option key={item.id} value={index}>{index + 1}</option>)}</select></label>
    </div>
    <p className="text-muted-foreground">Shared registry · Applies to both providers{hook.providers ? ` · This stage: ${hook.providers.join(', ')}` : ''}. Parent approval stays in the agent.</p>
    <details><summary className="cursor-pointer">Prerequisites ({dependsOn.length})</summary>
      <p className="my-2 text-muted-foreground">Must run earlier and pass. A skipped or failed prerequisite skips this hook.</p>
      <div className="space-y-1">{siblings.filter((item) => item.id !== hook.id).map((item) => <label key={item.id} className="flex items-center gap-2"><input disabled={busy} type="checkbox" checked={dependsOn.includes(item.id)} onChange={(event) => { setSaved(false); setDependsOn(event.target.checked ? [...dependsOn, item.id] : dependsOn.filter((id) => id !== item.id)); }} />{item.label}{item.providers ? ` (${item.providers.join(', ')})` : ''}</label>)}</div>
    </details>
    <div className="flex items-center gap-3"><Button size="sm" variant="outline" disabled={busy || revision !== data.managementRevision} onClick={() => { void save(); }}>{busy ? 'Saving…' : 'Save settings'}</Button><span role="status" className="text-muted-foreground">{saved ? 'Saved. Applies to the next invocation.' : 'Applies to the next invocation.'}</span></div>
    {revision !== data.managementRevision ? <div role="alert">Configuration changed. Your unsaved choices are retained. <button className="underline" onClick={() => { setEnabled(settings.enabled); setBlocking(settings.blocking); setDependsOn(settings.dependsOn); setPosition(siblings.findIndex((item) => item.id === hook.id)); setRevision(data.managementRevision); setSaved(false); setError(''); }}>Reload settings</button></div> : null}
    {error ? <p role="alert" className="text-danger">{error}</p> : null}
  </section>;
}
