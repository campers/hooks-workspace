import { Tooltip } from 'radix-ui';
import type { HookTokenUsage } from './hook-types';

export function TokenUsage({ usage }: { usage?: HookTokenUsage }) {
  return <Tooltip.Provider delayDuration={150}><Tooltip.Root><Tooltip.Trigger asChild>
    <div tabIndex={0} aria-label="Recorded hook LLM tokens in the last hour" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded text-xs tabular-nums focus-visible:outline-2 focus-visible:outline-ring" data-testid="hook-token-usage">
      <span className="text-muted-foreground">Tokens · 1h</span>
      {(['codex', 'claude', 'jev'] as const).map((provider) => {
        const data = usage?.[provider];
        const known = data?.recorded && !usage?.error;
        return <span key={provider} className="whitespace-nowrap" data-provider={provider}>
          {provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : 'Jev'} <span className="font-medium">{known ? `${data.hour > 1000 ? `${Math.round(data.hour / 1000)}k` : data.hour.toLocaleString()}${data.missingHour ? '+' : ''}` : '—'}</span>
        </span>;
      })}
    </div>
  </Tooltip.Trigger><Tooltip.Portal><Tooltip.Content side="bottom" align="end" sideOffset={8} collisionPadding={12} className="z-50 max-w-80 rounded-md border bg-card px-3 py-2 text-xs shadow-md">
    {usage?.error ?? 'Provider-reported input + output tokens for this project’s hook LLM calls over the last hour. Codex totals include cached input and reasoning without counting them twice. Recording starts with this instrumentation; earlier calls cannot be recovered. — means no recorded usage. + means some calls lack token counts.'}
    {usage && !usage.error && (usage.codex.missingHour + (usage.claude?.missingHour ?? 0) + usage.jev.missingHour > 0) ? <div className="mt-1">Calls without usage in 1h: Codex {usage.codex.missingHour}; Jev {usage.jev.missingHour}.</div> : null}
  </Tooltip.Content></Tooltip.Portal></Tooltip.Root></Tooltip.Provider>;
}
