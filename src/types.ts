import type { AgentConfig, RuleConfig } from "./config.ts";

export type JsonObject = Record<string, unknown>;
export type SubjectType = "issue" | "pull_request" | "repository";

export interface Subject {
  type: SubjectType;
  number: number;
  title: string;
  body: string;
  url?: string;
}

export interface WebhookContext {
  deliveryId: string;
  event: string;
  action: string;
  payload: JsonObject;
  repository: string;
  installationId: number;
  subject: Subject;
}

export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface RunRecord {
  id: string;
  deliveryId: string;
  ruleName: string;
  ruleSnapshot: RuleConfig | null;
  agentName: string;
  runtimeName: string;
  runtimeType: "opencode" | "hermes";
  repository: string;
  installationId: number;
  subjectType: SubjectType;
  subjectNumber: number;
  conversationKey: string | null;
  workflowId: string | null;
  workflowType: string | null;
  sessionPolicy: "fresh" | "conversation" | "workflow";
  oncePerSubject: boolean;
  status: RunStatus;
  attempt: number;
  maxAttempts: number;
  retryBackoffSeconds: number;
  availableAt: number;
  workspacePath: string | null;
  branch: string | null;
  runtimeSessionId: string | null;
  agentCapabilityHash: string | null;
  parentRunId: string | null;
  configHash: string;
  promptPath: string;
  promptHash: string;
  promptSnapshot: string;
  instructionsSnapshot: string;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  resolvedAt: number | null;
  lastError: string | null;
  responsePath: string | null;
  usage: JsonObject | null;
}

export type WorkflowStatus = "active" | "waiting" | "completed";

export interface WorkflowRecord {
  id: string;
  type: string;
  repository: string;
  installationId: number;
  originSubjectType: SubjectType;
  originSubjectNumber: number;
  status: WorkflowStatus;
  workspacePath: string | null;
  branch: string | null;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  turns: number;
  dependencyCycle: number;
  quarantined: boolean;
  quarantineRunId: string | null;
  quarantineReason: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export type DependencyStatus = "creating" | "pending" | "resolved" | "failed" | "abandoned";

export interface DependencyRecord {
  id: string;
  parentWorkflowId: string;
  parentRepository: string;
  targetRepository: string;
  targetIssueNumber: number | null;
  targetIssueUrl: string | null;
  targetIssueClosedAt: number | null;
  targetPrNumber: number | null;
  targetPrUrl: string | null;
  targetPrMergedAt: number | null;
  mergeCommitSha: string | null;
  cycle: number;
  resumeDispatchedAt: number | null;
  requestKey: string;
  title: string;
  body: string;
  status: DependencyStatus;
  error: string | null;
  createdByRunId: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
}

export interface PreparedRun {
  run: RunRecord;
  rule: RuleConfig;
  agent: AgentConfig;
  context: WebhookContext;
  workspacePath: string;
  branch: string | null;
  prompt: string;
  promptPath: string;
  promptHash: string;
  existingRuntimeSessionId: string | null;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  [key: string]: unknown;
}

export interface RuntimeResult {
  sessionId: string;
  response: string;
  usage?: Usage;
}

export interface RuntimeEvent {
  type: string;
  data: unknown;
  time?: string;
}

export interface RuntimeRunInput {
  runId: string;
  agentName: string;
  options: Record<string, unknown>;
  prompt: string;
  workspacePath: string;
  environment: Record<string, string>;
  existingSessionId: string | null;
  attemptDirectory: string;
  timeoutMs: number;
  signal: AbortSignal;
  emit: (event: RuntimeEvent) => void;
  onSession: (sessionId: string) => void;
}

export interface AgentRuntime {
  readonly type: "opencode" | "hermes";
  check(): Promise<void>;
  run(input: RuntimeRunInput): Promise<RuntimeResult>;
}

export interface RuntimeFactoryContext {
  name: string;
  environment: NodeJS.ProcessEnv;
}
