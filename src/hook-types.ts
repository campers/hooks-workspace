export type HookProvider = 'codex' | 'claude';
export type Observation<T> = { state: 'known'; value: T; source: string; checkedAt: string } | { state: 'unknown' | 'unsupported'; reason: string };
export type HookEventId = 'PostToolUse' | 'PreToolUse' | 'SessionStart' | 'Stop' | 'UserPromptSubmit';
export type HookStage = 'advisory' | 'blocker' | 'finalizer' | 'prerequisite';
export type HookEnablementMode = 'always' | 'opt-in' | 'opt-out';
export type HookReferenceType = 'documentation' | 'prompt' | 'source' | 'test';

export interface HookReference {
  absolutePath: string;
  content: string;
  focus?: string;
  label: string;
  path: string;
  type: HookReferenceType;
}

export interface HookEventDefinition {
  description: string;
  id: HookEventId;
  label: string;
}

export interface HookDefinition {
  providers?: HookProvider[];
  resultFormat?: 'neutral' | 'native';
  managed?: { enabled: boolean; blocking: boolean; dependsOn: string[] };
  calls: readonly string[];
  canBlock: boolean;
  checks: readonly string[];
  does: string;
  enabledNow: boolean;
  codexSource?: string;
  runtimeStatus?: string;
  runtimeReason?: string;
  enabled: {
    environment?: string;
    mode: HookEnablementMode;
  };
  event: HookEventId;
  failurePolicy: 'fail-open';
  id: string;
  inputs: readonly string[];
  label: string;
  order: number;
  outcomes: readonly string[];
  references: readonly HookReference[];
  rules: readonly string[];
  steps: readonly string[];
  sdlcGates: readonly string[];
  source: string;
  stage: HookStage;
  when: string;
  why: string;
}

export interface HookTraceEvent {
  lifecycleEvent?: string;
  context?: import('./workspace-types').ExecutionContext;
  promptId?: string | null;
  provider?: HookProvider;
  invocationId?: string;
  at: string;
  decision: string;
  durationMs: number | null;
  event: HookEventId | null;
  hookId: string;
  kind: string;
  message: string | null;
  sessionId: string | null;
  stage: HookStage | null;
  toolUseId: string | null;
  turnId: string | null;
}

export interface HookControlPlaneData {
  agentEvents?: Partial<Record<HookProvider, Partial<Record<HookEventId, ProviderEventStatus>>>>;
  projectId?: string;
  provider?: HookProvider;
  registryPath?: string;
  configurationError?: string;
  providerEvents?: Partial<Record<HookEventId, ProviderEventStatus>>;
  events: readonly HookEventDefinition[];
  hooks: readonly HookDefinition[];
  loadError: string | null;
  tokenUsage?: HookTokenUsage;
  stopConfigured: boolean;
  managementRevision?: string;
  masterEvents?: HookEventId[];
  codexEvents?: Partial<Record<HookEventId, CodexEventStatus>>;
  configuredCommands?: Partial<Record<HookEventId, number>>;
  traces: readonly HookTraceEvent[];
}

export interface CodexEventStatus {
  enabled: boolean;
  trustStatus: 'managed' | 'trusted' | 'untrusted' | 'modified';
  reason: string;
}

export interface CodexStatusSnapshot {
  checkedAt: string | null;
  error: string | null;
  loading: boolean;
  events?: Partial<Record<HookEventId, CodexEventStatus>>;
  hooks: Record<string, { label: string; reason: string; enabled: boolean }>;
}

export interface HookTokenUsage {
  checkedAt: string;
  error: string | null;
  codex: ProviderTokenUsage;
  jev: ProviderTokenUsage;
  claude: ProviderTokenUsage;
}
export interface ProviderTokenUsage {
  hour: number;
  day: number;
  missingHour: number;
  missingDay: number;
  recorded: boolean;
}

export interface ProviderEventStatus {
  configured: Observation<boolean>;
  providerEnabled: Observation<boolean>;
  commandApproval: Observation<'trusted' | 'untrusted' | 'modified' | 'managed'>;
  workspaceApproval: Observation<boolean>;
  label: string;
  reason: string;
  ready: boolean;
  commandCount: number;
  inventory: { source: string; command: string }[];
  complete: boolean;
}
export interface ProviderStatusSnapshot extends CodexStatusSnapshot {
  provider: HookProvider;
  providerEvents: Partial<Record<HookEventId, ProviderEventStatus>>;
}
