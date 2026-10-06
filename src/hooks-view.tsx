import { latestStageRun } from './history';
import { HookManagement } from './hook-management';
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';

import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeChange,
} from '@xyflow/react';
import {
  Activity,
  CheckCircle2,
  CircleSlash2,
  ExternalLink,
  ShieldAlert,
  CircleHelp,
  Ban,
} from 'lucide-react';

import { Tooltip } from 'radix-ui';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

import type {
  CodexEventStatus, ProviderEventStatus,
  HookControlPlaneData,
  HookDefinition,
  HookEventId,
  HookReference,
  HookStage,
  HookTraceEvent,
} from './hook-types';

type HookViewMode = 'definition' | 'trace';

interface HookGraphNodeData extends Record<string, unknown> {
  blockLabel: string | null;
  reason: string;
  disabled: boolean;
  label: string;
  status: string;
  subtitle: string;
  tone: string;
}

type HookGraphNode = Node<HookGraphNodeData, 'hook'>;
type HookFlowNode = HookGraphNode | Node<Record<string, unknown>>;

export const HOOK_CONTROL_LABELS = {
  beforeToolUse: 'Before tool use',
  ifItFails: 'If it fails',
  masterConnected: 'Master hook configured',
  openImplementation: 'Open implementation',
  openInVsCode: 'Open in VS Code',
  showDisabled: 'Show off hooks',
} as const;

const EVENT_ENDPOINTS: Readonly<Record<HookEventId, { end: string; start: string }>> = {
  SessionStart: { start: 'Task starts', end: 'Task is ready' },
  UserPromptSubmit: { start: 'Message submitted', end: 'Agent receives guidance' },
  PreToolUse: { start: 'Tool requested', end: 'Tool may run' },
  PostToolUse: { start: 'Tool completed', end: 'Agent continues' },
  Stop: { start: 'Stop requested', end: 'Agent may stop' },
};

interface HookRun {
  at: string;
  traces: ReadonlyMap<string, HookTraceEvent>;
}


function stageTone(stage: HookStage): string {
  if (stage === 'blocker') return 'border-danger/45 bg-danger/6';
  if (stage === 'finalizer') return 'border-success/45 bg-success/6';
  if (stage === 'advisory') return 'border-warning/45 bg-warning/6';
  return 'border-info/45 bg-info/6';
}

function decisionTone(decision: string): string {
  if (decision === 'blocked' || decision === 'deny') return 'border-danger/50 bg-danger/8';
  if (decision === 'passed' || decision === 'allowed') return 'border-success/50 bg-success/8';
  if (decision === 'fail_open') return 'border-warning/50 bg-warning/8';
  if (decision === 'disabled' || decision === 'not_reached') return 'border-border bg-muted/40';
  return 'border-info/45 bg-info/6';
}

function nodeSubtitle(hook: HookDefinition, trace: HookTraceEvent | undefined, mode: HookViewMode): string {
  if (mode === 'trace') return trace ? trace.decision.replaceAll('_', ' ') : 'No result recorded';
  return hook.does;
}

function traceStatus(trace: HookTraceEvent | undefined): string {
  if (!trace) return 'No result';
  if (trace.kind === 'skipped') return 'Skipped';
  if (trace.kind === 'error') return 'Error';
  if (trace.kind === 'started') return 'Started';
  return trace.decision === 'passed' ? 'Ran' : trace.decision === 'blocked' ? 'Blocked' : trace.decision === 'failed' ? 'Failed' : trace.decision;
}

function StatusIcon({ status, reason }: { status: string; reason?: string }): JSX.Element {
  const active = status === 'Enabled in Codex' || status === 'On' || status === 'Ran';
  const unknown = status === 'Unknown' || status === 'Checking…' || status === 'No result' || status.includes('unverified') || status === 'Started';
  const Icon = active ? CheckCircle2 : unknown ? CircleHelp : CircleSlash2;
  return (
    <Tooltip.Provider delayDuration={150}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span tabIndex={0} role="img" aria-label={status} className={cn('nodrag inline-flex shrink-0 rounded focus-visible:outline-2 focus-visible:outline-ring', active ? 'text-success' : unknown ? 'text-warning' : 'text-muted-foreground')}>
            <Icon className="size-4" aria-hidden="true" />
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal><Tooltip.Content side="top" sideOffset={6} className="z-50 max-w-80 rounded-md border bg-card px-3 py-2 text-xs text-foreground shadow-md">{reason ? `${status}. ${reason}` : status}</Tooltip.Content></Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

function blockLabel(hook: HookDefinition): string | null {
  return (hook.managed?.blocking ?? hook.canBlock) ? hook.event === 'Stop' ? 'Requests continuation' : hook.event === 'UserPromptSubmit' ? 'Rejects prompt' : hook.event === 'PostToolUse' ? 'Returns feedback' : 'Blocks tool use' : null;
}

function HookNode({ data, selected }: NodeProps<HookGraphNode>): JSX.Element {
  return (
    <div className={cn(
      'relative w-[440px] rounded-lg border px-4 py-3 text-left shadow-sm',
      data.tone,
      data.disabled && 'border-dashed opacity-60',
      selected && 'ring-2 ring-ring/45',
    )}>
      <Handle className="!size-1.5 !border-0 !bg-muted-foreground/50" id="pass-in" isConnectable={false} position={Position.Top} type="target" />
      <Handle className="!size-1.5 !border-0 !bg-muted-foreground/50" id="pass-out" isConnectable={false} position={Position.Bottom} type="source" />
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold leading-5 text-foreground">{data.label}</div>
        <StatusIcon status={data.status} reason={data.reason} />
      </div>
      <div className="mt-1.5 line-clamp-2 text-xs leading-4 text-muted-foreground">{data.subtitle}</div>
      {data.blockLabel ? <div className="mt-1 flex items-center gap-1 text-[0.68rem] font-medium text-danger"><Ban className="size-3" aria-hidden="true" />{data.blockLabel}</div> : null}
    </div>
  );
}

const HOOK_NODE_TYPES = { hook: HookNode };

// The server derives both fields from Codex, independently of sub-hook switches.
// Trust semantics: https://developers.openai.com/codex/hooks#review-and-trust-hooks
function EventStart({ eventId, commandCount, commandStatus, isMaster, providerStatus }: { eventId: HookEventId; commandCount: number | undefined; commandStatus?: CodexEventStatus; isMaster?: boolean; providerStatus?: ProviderEventStatus }): JSX.Element {
  const configured = commandCount !== undefined && commandCount > 0;
  const ready = providerStatus ? providerStatus.ready : configured && commandStatus?.enabled === true && (commandStatus.trustStatus === 'trusted' || commandStatus.trustStatus === 'managed');
  const trustLabel = !commandStatus ? 'Unknown' : commandStatus.trustStatus === 'modified' ? 'Modified' : commandStatus.trustStatus === 'untrusted' ? 'Untrusted' : 'Trusted';
  const label = providerStatus ? providerStatus.label : commandCount === undefined ? 'Configuration unknown' : !configured ? 'No command in hooks.json'
    : `${isMaster ? 'Master hook' : `${commandCount} ${commandCount === 1 ? 'command' : 'commands'} in hooks.json`} · ${!commandStatus ? 'Unknown' : commandStatus.enabled ? 'Enabled' : 'Disabled'} · ${trustLabel}`;
  return <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
    <div>{EVENT_ENDPOINTS[eventId].start}</div>
    <Tooltip.Provider delayDuration={150}><Tooltip.Root><Tooltip.Trigger asChild>
    <div tabIndex={0} aria-label={label} data-testid="event-command-status" data-ready={ready} className={cn('flex items-center justify-center gap-1.5 text-[11px] font-normal', ready ? 'text-success' : configured ? 'text-warning' : 'text-danger')}>
      {ready ? <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" /> : <ShieldAlert className="size-3.5 shrink-0" aria-hidden="true" />}
      <span>{label}</span>
    </div>
    </Tooltip.Trigger><Tooltip.Portal><Tooltip.Content side="top" sideOffset={6} className="z-50 max-w-80 rounded-md border bg-card px-3 py-2 text-xs text-foreground shadow-md">{providerStatus?.reason ?? commandStatus?.reason ?? 'Provider status has not been confirmed.'}</Tooltip.Content></Tooltip.Portal></Tooltip.Root></Tooltip.Provider>
  </div>;
}

function buildGraph(input: {
  eventId: HookEventId;
  hooks: readonly HookDefinition[];
  latestTraces: ReadonlyMap<string, HookTraceEvent>;
  mode: HookViewMode;
  heights: Readonly<Record<string, number>>;
  commandCount: number | undefined;
  commandStatus?: CodexEventStatus;
  isMaster?: boolean;
  providerStatus?: ProviderEventStatus;
}): { edges: Edge[]; nodes: HookFlowNode[] } {
  const hooks = input.hooks.toSorted((left, right) => left.order - right.order);
  const mainX = 250;
  const connectorGap = 20;
  let nextY = (input.heights.event ?? 34) + connectorGap;
  const endpoints = EVENT_ENDPOINTS[input.eventId];
  const nodes: HookFlowNode[] = [{
    id: 'event',
    data: { label: <EventStart eventId={input.eventId} commandCount={input.commandCount} commandStatus={input.commandStatus} isMaster={input.isMaster} providerStatus={input.providerStatus} /> },
    position: { x: 250, y: 0 },
    sourcePosition: Position.Bottom,
    selectable: false,
    style: {
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 10,
      color: 'var(--foreground)',
      fontSize: 13,
      fontWeight: 600,
      padding: 6,
      width: 440,
    },
  }];
  const edges: Edge[] = [];

  hooks.forEach((hook, index) => {
    const trace = input.latestTraces.get(hook.id);
    const tone = input.mode === 'trace' && trace ? decisionTone(trace.decision) : stageTone(hook.stage);
    const y = nextY;
    nextY += (input.heights[hook.id] ?? 90) + connectorGap;
    nodes.push({
      id: hook.id,
      type: 'hook',
      data: {
        blockLabel: blockLabel(hook),
        reason: input.mode === 'definition' ? hook.runtimeReason ?? '' : '',
        disabled: input.mode === 'definition' && !hook.enabledNow,
        label: hook.label,
        status: input.mode === 'trace' ? traceStatus(trace) : hook.runtimeStatus ?? (hook.enabledNow ? 'On' : 'Off'),
        subtitle: nodeSubtitle(hook, trace, input.mode),
        tone,
      },
      position: { x: mainX, y },
    });
    const previousId = index === 0 ? 'event' : hooks[index - 1]?.id;
    if (previousId) {
      edges.push({
        id: `${previousId}-${hook.id}`,
        source: previousId,
        sourceHandle: index === 0 ? undefined : 'pass-out',
        target: hook.id,
        targetHandle: 'pass-in',
        type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: 'var(--muted-foreground)' },
      });
    }

  });

  const finalY = nextY;
  nodes.push({
    id: 'allowed',
    data: { label: endpoints.end },
    position: { x: 395, y: finalY },
    targetPosition: Position.Top,
    selectable: false,
    style: {
      background: 'color-mix(in oklab, var(--success) 8%, var(--card))',
      border: '1px solid color-mix(in oklab, var(--success) 45%, var(--border))',
      borderRadius: 10,
      color: 'var(--foreground)',
      fontSize: 13,
      fontWeight: 600,
      padding: 6,
      width: 150,
    },
  });
  if (hooks.length > 0) {
    edges.push({
      id: `${hooks.at(-1)?.id}-allowed`,
      source: hooks.at(-1)?.id ?? 'event',
      sourceHandle: 'pass-out',
      target: 'allowed',
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { stroke: 'var(--success)' },
    });
  }

  return { edges, nodes };
}

function formatTraceTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

const EVENT_ONLY_CONDITIONS: Readonly<Partial<Record<HookEventId, string>>> = {
  SessionStart: 'An agent session starts',
  UserPromptSubmit: 'A new user prompt is submitted',
  Stop: 'The agent attempts to stop',
};

function hasSpecialCondition(hook: HookDefinition): boolean {
  return EVENT_ONLY_CONDITIONS[hook.event] !== hook.when;
}

function nextOutcome(hook: HookDefinition): string {
  if (hook.managed && !hook.managed.blocking && hook.canBlock) return 'Reports findings without blocking. The next check runs.';
  if (hook.managed?.blocking ?? hook.canBlock) return 'If it finds work that must be done, the agent continues with those instructions. Otherwise the next check runs.';
  if (hook.stage === 'advisory') return 'It may add a reminder, then the agent continues.';
  if (hook.stage === 'finalizer') return 'When it finishes, the agent may complete the lifecycle event.';
  return 'When it finishes, the next hook runs.';
}

const REFERENCE_TYPE_LABELS: Readonly<Record<HookReference['type'], string>> = {
  documentation: 'Guide',
  prompt: 'Prompt',
  source: 'Code',
  test: 'Tests',
};

function DetailList({ items }: { items: readonly string[] }): JSX.Element {
  return (
    <ul className="mt-2 space-y-2 text-sm leading-6">
      {items.map((item) => (
        <li className="flex gap-2.5" key={item}>
          <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden="true" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

const CODE_KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete',
  'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import',
  'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'static', 'throw', 'true', 'try',
  'typeof', 'undefined', 'var', 'while', 'yield',
]);

function syntaxTokenClass(token: string): string {
  if (token.startsWith('//') || token.startsWith('#')) return 'text-emerald-700 dark:text-emerald-400';
  if (token.startsWith('"') || token.startsWith("'") || token.startsWith('`')) return 'text-amber-700 dark:text-amber-300';
  if (/^\d+(?:\.\d+)?$/.test(token)) return 'text-violet-700 dark:text-violet-300';
  if (CODE_KEYWORDS.has(token)) return 'font-semibold text-blue-700 dark:text-blue-300';
  return 'text-foreground';
}

function HighlightedLine({ line }: { line: string }): JSX.Element {
  const tokens = line.split(/(\/\/.*$|#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g);
  return (
    <>
      {tokens.map((token, index) => (
        <span className={syntaxTokenClass(token)} data-syntax-token={CODE_KEYWORDS.has(token) ? 'keyword' : undefined} key={`${index}-${token}`}>{token}</span>
      ))}
    </>
  );
}

function HighlightedSource({ content, startLine }: { content: string; startLine: number }): JSX.Element {
  return (
    <div className="w-max min-w-full py-3 font-mono text-xs leading-5" data-testid="hook-source-viewer">
      {content.split('\n').map((line, index) => (
        <div className="flex min-h-5" key={`${startLine + index}-${line}`}>
          <span className="sticky left-0 w-14 shrink-0 select-none border-r border-border/70 bg-muted/80 pr-3 text-right text-muted-foreground/70">{startLine + index}</span>
          <code className="whitespace-pre px-4"><HighlightedLine line={line} /></code>
        </div>
      ))}
    </div>
  );
}

function ReferenceViewer({ onClose, reference }: {
  onClose: () => void;
  reference: HookReference | null;
}): JSX.Element {
  const [showFullFile, setShowFullFile] = useState(false);
  const focusedContent = useMemo(() => {
    if (!reference?.focus || showFullFile) return { content: reference?.content ?? '', startLine: 1 };
    const lines = reference.content.split('\n');
    const focusLine = lines.findIndex((line) => line.includes(reference.focus ?? ''));
    if (focusLine < 0) return { content: reference.content, startLine: 1 };
    const startLine = Math.max(0, focusLine - 8);
    return { content: lines.slice(startLine, focusLine + 64).join('\n'), startLine: startLine + 1 };
  }, [reference, showFullFile]);
  const vscodeHref = reference
    ? encodeURI(`vscode://file${reference.absolutePath}:${focusedContent.startLine}`)
    : '#';

  useEffect(() => setShowFullFile(false), [reference]);

  return (
    <Dialog onOpenChange={(open) => { if (!open) onClose(); }} open={reference !== null}>
      <DialogContent className="flex h-[92vh] w-[92vw] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-[92vw]">
        {reference ? (
          <>
            <DialogHeader className="border-b border-border px-6 py-4 text-left">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{REFERENCE_TYPE_LABELS[reference.type]}</Badge>
                <code className="min-w-0 truncate text-xs text-muted-foreground">{reference.path}</code>
              </div>
              <div className="flex flex-wrap items-end justify-between gap-4 pr-8">
                <div>
                  <DialogTitle className="pt-2">{reference.label}</DialogTitle>
                  <DialogDescription className="mt-2">
                    {reference.focus && !showFullFile
                      ? `Showing the part used by this hook, starting near line ${focusedContent.startLine}.`
                      : 'This is the exact file used to define, run or verify this hook.'}
                  </DialogDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  {reference.focus ? (
                    <Button onClick={() => setShowFullFile((current) => !current)} size="sm" type="button" variant="outline">
                      {showFullFile ? 'Show relevant part' : 'Show full file'}
                    </Button>
                  ) : null}
                  <Button asChild size="sm" variant="outline">
                    <a href={vscodeHref}><ExternalLink aria-hidden="true" />{HOOK_CONTROL_LABELS.openInVsCode}</a>
                  </Button>
                </div>
              </div>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-auto bg-muted/25">
              <HighlightedSource content={focusedContent.content} startLine={focusedContent.startLine} />
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function HookInspector({ hook, traces, data, onSaved }: { hook: HookDefinition; traces: readonly HookTraceEvent[]; data: HookControlPlaneData; onSaved: () => void }): JSX.Element {
  const [selectedReference, setSelectedReference] = useState<HookReference | null>(null);
  const hookTraces = traces.filter((trace) => trace.hookId === hook.id).slice(0, 8);
  return (
    <div className="space-y-6">
      <ReferenceViewer onClose={() => setSelectedReference(null)} reference={selectedReference} />
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusIcon status={hook.runtimeStatus ?? (hook.enabledNow ? 'On' : 'Off')} reason={hook.runtimeReason} />
          {blockLabel(hook) ? <Badge className="border-danger/30 bg-danger/8 text-danger" variant="outline">{blockLabel(hook)}</Badge> : null}
        </div>
        <h2 className="mt-3 text-xl font-semibold tracking-tight">{hook.label}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{hook.does}</p>

      </div>

      <HookManagement key={hook.id} hook={hook} data={data} onSaved={onSaved} />
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Why it exists</h3>
        <p className="mt-2 text-sm leading-6">{hook.why}</p>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">How it works</h3>
        <ol className="mt-2 space-y-2 text-sm leading-6">
          {hook.steps.map((step, index) => <li className="flex gap-2.5" key={step}><span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[0.68rem] font-semibold text-muted-foreground">{index + 1}</span><span>{step}</span></li>)}
        </ol>
      </div>

      <div className="border-t border-border pt-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Exact rules</h3>
        <DetailList items={hook.rules} />
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Information it reads</h3>
        <DetailList items={hook.inputs} />
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Possible results</h3>
        <DetailList items={hook.outcomes} />
      </div>

      {hook.checks.length > 0 ? <div><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Checks included</h3><ul className="mt-2 grid gap-2 text-sm leading-5">{hook.checks.map((check) => <li className="flex gap-2" key={check}><span className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/60" aria-hidden="true" /><span>{check}</span></li>)}</ul></div> : null}

      {hasSpecialCondition(hook) ? <div><h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Only runs when</h3><p className="mt-2 text-sm leading-6">{hook.when}</p></div> : null}

      {hook.canBlock ? <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What happens next</h3>
        <p className="mt-2 text-sm leading-6">{nextOutcome(hook)}</p>
      </div> : null}

      <div className="border-t border-border pt-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Files and prompts</h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">Open the exact code, prompt, tests or guide without leaving this page.</p>
        <div className="mt-3 divide-y divide-border rounded-lg border border-border">
          {hook.references.map((reference) => (
            <button
              aria-label={reference.type === 'source' && reference.label === 'Implementation' ? HOOK_CONTROL_LABELS.openImplementation : `Open ${reference.label}`}
              className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:outline-none"
              key={`${reference.type}-${reference.path}`}
              onClick={() => setSelectedReference(reference)}
              type="button"
            >
              <Badge className="w-14 justify-center" variant="secondary">{REFERENCE_TYPE_LABELS[reference.type]}</Badge>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{reference.label}</span>
                <code className="mt-0.5 block truncate text-[0.68rem] text-muted-foreground">{reference.path}</code>
              </span>
              <ExternalLink className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>

      <div className="border-t border-border pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent runs</h3>
        {hookTraces.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No recent result was recorded for this hook.</p> : (
          <ol className="mt-2 space-y-2">
            {hookTraces.map((trace, index) => (
              <li className="rounded-lg border border-border bg-muted/25 px-3 py-2.5" key={`${trace.at}-${index}`}>
                <div className="flex items-center justify-between gap-3 text-xs"><span className="font-medium capitalize">{trace.decision.replaceAll('_', ' ')}</span><time className="text-muted-foreground">{formatTraceTime(trace.at)}</time></div>
                {trace.message ? <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">{trace.message}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </div>

      <details className="border-t border-border pt-4 text-sm">
        <summary className="cursor-pointer font-medium text-muted-foreground hover:text-foreground">Configuration</summary>
        <div className="mt-4 space-y-4 text-xs leading-5 text-muted-foreground">
          <div><div className="font-semibold uppercase tracking-wide">Status rule</div><div className="mt-1">{hook.enabled.mode === 'always' ? 'Always on' : `${hook.enabled.mode === 'opt-in' ? 'Off unless enabled' : 'On unless disabled'} with ${hook.enabled.environment}`}</div></div>
          {hook.calls.length > 0 ? <div><div className="font-semibold uppercase tracking-wide">Uses</div><div className="mt-1 flex flex-wrap gap-1.5">{hook.calls.map((call) => <Badge key={call} variant="secondary">{call}</Badge>)}</div></div> : null}
          <div><div className="font-semibold uppercase tracking-wide">SDLC links</div><div className="mt-1 flex flex-wrap gap-1.5">{hook.sdlcGates.map((gate) => <Badge key={gate} variant="outline">{gate}</Badge>)}</div></div>
        </div>
      </details>
    </div>
  );
}

export function HooksControlPlaneView({ data, onSaved }: { data: HookControlPlaneData; onSaved: () => void }): JSX.Element {
  const [selectedEventId, setEventId] = useState<HookEventId>('Stop');
  const eventId = data.events.some((event) => event.id === selectedEventId)
    ? selectedEventId
    : data.events[0]?.id ?? 'Stop';
  const [mode, setMode] = useState<HookViewMode>('definition');
  const [showDisabled, setShowDisabled] = useState(true);
  const allEventHooks = useMemo(() => data.hooks.filter((hook) => hook.event === eventId).toSorted((left, right) => left.order - right.order), [data.hooks, eventId]);
  const eventHooks = useMemo(() => allEventHooks
    .filter((hook) => showDisabled || hook.enabledNow || hook.runtimeStatus === 'Unknown' || hook.runtimeStatus === 'Checking…'), [allEventHooks, showDisabled]);
  const [selectedHookId, setSelectedHookId] = useState<string>(() => eventHooks[0]?.id ?? '');
  const latestRun = useMemo(() => latestStageRun(data.traces, eventId, new Set(allEventHooks.map((hook) => hook.id))), [allEventHooks, data.traces, eventId]);
  const [nodeHeights, setNodeHeights] = useState<Record<string, number>>({});
  const onNodesChange = useCallback((changes: NodeChange[]): void => {
    setNodeHeights((current) => {
      let next = current;
      for (const change of changes) {
        if (change.type !== 'dimensions' || !change.dimensions) continue;
        const height = change.dimensions.height;
        if (height <= 0 || current[change.id] === height) continue;
        if (next === current) next = { ...current };
        next[change.id] = height;
      }
      return next;
    });
  }, []);
  const commandStatus = data.codexEvents?.[eventId];
  const agentStatuses = data.agentEvents ? Object.entries(data.agentEvents).map(([agent,events]) => ({agent,status:events?.[eventId]})) : [];
  const providerStatus = data.providerEvents?.[eventId];
  const isMaster = data.masterEvents?.includes(eventId);
  const graph = useMemo(() => buildGraph({ eventId, hooks: eventHooks, latestTraces: latestRun?.traces ?? new Map(), mode, heights: nodeHeights, commandStatus, isMaster, providerStatus, commandCount: data.configuredCommands ? data.configuredCommands[eventId] ?? 0 : undefined }), [eventHooks, eventId, latestRun, mode, nodeHeights, data.configuredCommands, commandStatus, isMaster, providerStatus]);

  useEffect(() => {
    if (!eventHooks.some((hook) => hook.id === selectedHookId)) setSelectedHookId(eventHooks[0]?.id ?? '');
  }, [eventHooks, selectedHookId]);

  const selectedHook = eventHooks.find((hook) => hook.id === selectedHookId) ?? eventHooks[0];
  const selectedEvent = data.events.find((event) => event.id === eventId);


  if (data.loadError) {
    return <section className="flex flex-1 items-center justify-center p-8"><div className="max-w-xl rounded-xl border border-danger/30 bg-danger/6 p-5"><h2 className="font-semibold">Hook registry could not be loaded</h2><p className="mt-2 text-sm text-muted-foreground">{data.loadError}</p></div></section>;
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background" aria-label="Hook control plane">
      <div className="border-b border-border px-4 py-2 lg:px-6">
        <div className="flex flex-wrap items-center gap-2">
          {data.events.map((event) => (
            <Button key={event.id} onClick={() => setEventId(event.id)} size="sm" type="button" variant={eventId === event.id ? 'secondary' : 'ghost'}>{event.label}</Button>
          ))}
          <div className="ml-auto flex h-9 items-center rounded-md border border-input bg-muted/30 p-0.5">
            <button aria-pressed={mode === 'definition'} className={cn('h-8 rounded px-2.5 text-xs font-medium', mode === 'definition' ? 'bg-card shadow-sm' : 'text-muted-foreground')} onClick={() => setMode('definition')} type="button">How it works</button>
            <button title={latestRun ? `Run recorded ${formatTraceTime(latestRun.at)}` : undefined} aria-pressed={mode === 'trace'} className={cn('h-8 rounded px-2.5 text-xs font-medium', mode === 'trace' ? 'bg-card shadow-sm' : 'text-muted-foreground')} onClick={() => setMode('trace')} type="button">Recent run</button>
          </div>
          <label className="ml-2 flex items-center gap-2 text-xs text-muted-foreground"><input checked={showDisabled} className="size-4 accent-primary" onChange={(event) => setShowDisabled(event.target.checked)} type="checkbox" />{HOOK_CONTROL_LABELS.showDisabled}</label>
        </div>

      </div>

      {agentStatuses.map(({agent,status}) => status ? <details key={agent} className="border-b px-4 py-1 text-xs text-muted-foreground"><summary className="cursor-pointer">{agent==='claude'?'Claude Code':'Codex'} command inventory ({status.commandCount}) · {status.complete?'Discovery':'Partial file inventory'}</summary><ul>{status.inventory.map((item,i)=><li className="break-all" key={i}>{item.source}: <code>{item.command}</code></li>)}</ul><p>{status.reason}</p></details> : null)}
      {providerStatus && !agentStatuses.length ? <details className="border-b px-4 py-1 text-xs text-muted-foreground"><summary className="cursor-pointer">Command inventory ({providerStatus.commandCount}) · {providerStatus.complete ? 'Codex discovery' : 'Partial file inventory'} · Registry stages run in order inside the dispatcher</summary><ul className="space-y-1 py-2">{providerStatus.inventory.map((item, index) => <li key={index} className="break-all">{item.source}: <code>{item.command}</code></li>)}</ul><p>Independent native handlers may run concurrently. Workspace approval and observed execution are separate.</p></details> : null}
      <div
        className={cn('grid min-h-0 flex-1', mode === 'trace' && !latestRun ? 'lg:grid-cols-1' : 'lg:grid-cols-3')}
        data-testid="hook-workspace-grid"
      >
        <div
          className={cn(
            'relative min-h-0 border-b border-border bg-muted/15 lg:min-h-0 lg:border-b-0 lg:border-r',
            !(mode === 'trace' && !latestRun) && 'lg:col-span-2',
          )}
          data-testid="hook-graph-pane"
        >
          {mode === 'trace' && !latestRun ? (
            <div className="flex h-full min-h-80 items-center justify-center p-8 text-center"><div className="max-w-sm"><Activity className="mx-auto size-5 text-muted-foreground" aria-hidden="true" /><h2 className="mt-3 text-sm font-semibold">No recent run recorded</h2><p className="mt-1.5 text-sm leading-6 text-muted-foreground">There is no complete recorded run for {selectedEvent?.label.toLowerCase() ?? 'this event'} yet. Use “How it works” to inspect the configured chain.</p></div></div>
          ) : eventHooks.length === 0 ? (
            <div className="flex h-full min-h-80 items-center justify-center text-sm text-muted-foreground"><CircleSlash2 className="mr-2 size-4" aria-hidden="true" />No stages match this view.</div>
          ) : (
            <>
            <ol className="space-y-3 p-4 lg:hidden">
              <li className="text-sm"><EventStart eventId={eventId} commandStatus={commandStatus} isMaster={isMaster} providerStatus={providerStatus} commandCount={data.configuredCommands ? data.configuredCommands[eventId] ?? 0 : undefined} /></li>
              {eventHooks.map((hook, index) => {
                const trace = latestRun?.traces.get(hook.id);
                const tone = mode === 'trace' && trace ? decisionTone(trace.decision) : stageTone(hook.stage);
                return (
                  <li key={hook.id}>
                    <button
                      className={cn('w-full rounded-lg border p-4 text-left shadow-sm', tone, !hook.enabledNow && mode === 'definition' && 'border-dashed opacity-60', selectedHook?.id === hook.id && 'ring-2 ring-ring/45')}
                      onClick={() => setSelectedHookId(hook.id)}
                      type="button"
                    >
                      <div className="flex items-center justify-between gap-3"><div className="text-sm font-semibold">{hook.label}</div><StatusIcon status={mode === 'trace' ? traceStatus(trace) : hook.runtimeStatus ?? (hook.enabledNow ? 'On' : 'Off')} reason={mode === 'trace' ? trace?.message ?? undefined : hook.runtimeReason} /></div>
                      <div className="mt-1 text-xs text-muted-foreground">{nodeSubtitle(hook, trace, mode)}</div>
                    </button>
                    {index < eventHooks.length - 1 ? <div className="ml-6 h-3 w-px bg-border" aria-hidden="true" /> : null}
                  </li>
                );
              })}
            </ol>
            <div className="hidden h-full lg:block">
            <ReactFlow
              defaultViewport={{ x: 60, y: 24, zoom: 0.78 }}
              edges={graph.edges}
              key={`${eventId}-${mode}-${showDisabled}`}
              maxZoom={1.2}
              minZoom={0.5}
              nodes={graph.nodes}
              onNodesChange={onNodesChange}
              nodeTypes={HOOK_NODE_TYPES}
              nodesConnectable={false}
              nodesDraggable={false}
              onNodeClick={(_, node) => {
                if (eventHooks.some((hook) => hook.id === node.id)) setSelectedHookId(node.id);
              }}
              panOnScroll
              proOptions={{ hideAttribution: true }}
              zoomOnDoubleClick={false}
            >
              <Background color="var(--border)" gap={22} size={1} />
              <Controls position="bottom-left" showInteractive={false} />
            </ReactFlow>
            </div>
            </>
          )}
        </div>

        {mode === 'trace' && !latestRun ? null : <aside className="min-h-0 overflow-y-auto bg-card p-5" aria-label="Selected hook">
          {selectedHook ? <HookInspector hook={selectedHook} key={selectedHook.id} traces={data.traces} data={data} onSaved={onSaved} /> : <p className="text-sm text-muted-foreground">Select a hook stage.</p>}
        </aside>}
      </div>
    </section>
  );
}
