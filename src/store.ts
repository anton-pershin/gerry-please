import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, RuleConfig, RuntimeConfig } from "./config.ts";
import type { DependencyRecord, JsonObject, RunRecord, RunStatus, SubjectType, WebhookContext, WorkflowRecord } from "./types.ts";
import { id, now } from "./util.ts";

export interface DeliveryRecord {
  id: string;
  event: string;
  action: string;
  repository: string;
  installationId: number;
  payloadPath: string;
  status: string;
  error: string | null;
  receivedAt: number;
}

export interface DispatchDecision {
  decision: "queued" | "skipped" | "duplicate";
  reason: string;
  runId?: string;
}

export interface MergeObservation {
  prNumber: number;
  prUrl: string | null;
  mergeCommitSha: string;
  mergedAt: number;
  baseRef: string;
}

export interface DependencyResolutionCandidate {
  dependency: DependencyRecord;
  observation: MergeObservation;
}

interface EnqueueInput {
  context: WebhookContext;
  rule: RuleConfig;
  agent: AgentConfig;
  agentName: string;
  runtimeName: string;
  runtime: RuntimeConfig;
  promptPath: string;
  promptHash: string;
  promptContents: string;
  instructions: string;
  configHash: string;
  parentRunId: string | null;
  workflowId?: string;
  resumeWorkflow?: boolean;
}

interface ConversationRow {
  key: string;
  workspace_path: string | null;
  branch: string | null;
  turns: number;
}

interface RunRow {
  id: string;
  delivery_id: string;
  rule_name: string;
  rule_snapshot: string | null;
  agent_name: string;
  runtime_name: string;
  runtime_type: "opencode" | "hermes";
  repository: string;
  installation_id: number;
  subject_type: SubjectType;
  subject_number: number;
  conversation_key: string | null;
  workflow_id: string | null;
  workflow_type: string | null;
  session_policy: "fresh" | "conversation" | "workflow";
  once_per_subject: number;
  status: RunStatus;
  attempt: number;
  max_attempts: number;
  available_at: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  workspace_path: string | null;
  branch: string | null;
  runtime_session_id: string | null;
  agent_capability_hash: string | null;
  parent_run_id: string | null;
  config_hash: string;
  prompt_path: string;
  prompt_hash: string;
  prompt_snapshot: string;
  instructions_snapshot: string;
  retry_backoff_seconds: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  resolved_at: number | null;
  last_error: string | null;
  response_path: string | null;
  usage_json: string | null;
}

export class Store {
  readonly db: Database;
  readonly runsDirectory: string;
  readonly deliveriesDirectory: string;

  constructor(readonly dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true });
    this.runsDirectory = join(dataDirectory, "runs");
    this.deliveriesDirectory = join(dataDirectory, "deliveries");
    mkdirSync(this.runsDirectory, { recursive: true });
    mkdirSync(this.deliveriesDirectory, { recursive: true });
    this.db = new Database(join(dataDirectory, "gerry.sqlite"), { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        action TEXT NOT NULL,
        repository TEXT NOT NULL,
        installation_id INTEGER NOT NULL,
        payload_path TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        received_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dispatches (
        delivery_id TEXT NOT NULL REFERENCES deliveries(id),
        rule_name TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT NOT NULL,
        run_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (delivery_id, rule_name)
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES deliveries(id),
        rule_name TEXT NOT NULL,
        rule_snapshot TEXT,
        agent_name TEXT NOT NULL,
        runtime_name TEXT NOT NULL,
        runtime_type TEXT NOT NULL,
        repository TEXT NOT NULL,
        installation_id INTEGER NOT NULL,
        subject_type TEXT NOT NULL,
        subject_number INTEGER NOT NULL,
        conversation_key TEXT,
        workflow_id TEXT,
        workflow_type TEXT,
        session_policy TEXT NOT NULL,
        once_per_subject INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL,
        available_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        workspace_path TEXT,
        branch TEXT,
        runtime_session_id TEXT,
        agent_capability_hash TEXT,
        parent_run_id TEXT,
        config_hash TEXT NOT NULL,
        prompt_path TEXT NOT NULL,
        prompt_hash TEXT NOT NULL,
        prompt_snapshot TEXT NOT NULL,
        instructions_snapshot TEXT NOT NULL,
        retry_backoff_seconds INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        resolved_at INTEGER,
        last_error TEXT,
        response_path TEXT,
        usage_json TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_claim_idx ON runs(status, available_at, created_at);
      CREATE INDEX IF NOT EXISTS runs_conversation_idx ON runs(conversation_key, status);

      CREATE TABLE IF NOT EXISTS conversations (
        key TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_number INTEGER NOT NULL,
        group_name TEXT NOT NULL,
        workspace_path TEXT,
        branch TEXT,
        turns INTEGER NOT NULL DEFAULT 0,
        quarantined INTEGER NOT NULL DEFAULT 0,
        quarantine_run_id TEXT,
        quarantine_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_sessions (
        conversation_key TEXT NOT NULL REFERENCES conversations(key),
        agent_name TEXT NOT NULL,
        runtime_name TEXT NOT NULL,
        runtime_session_id TEXT NOT NULL,
        compatibility_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_key, agent_name)
      );

      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        repository TEXT NOT NULL,
        installation_id INTEGER NOT NULL,
        origin_subject_type TEXT NOT NULL,
        origin_subject_number INTEGER NOT NULL,
        status TEXT NOT NULL,
        workspace_path TEXT,
        branch TEXT,
        pull_request_number INTEGER,
        pull_request_url TEXT,
        turns INTEGER NOT NULL DEFAULT 0,
        dependency_cycle INTEGER NOT NULL DEFAULT 0,
        quarantined INTEGER NOT NULL DEFAULT 0,
        quarantine_run_id TEXT,
        quarantine_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(type, repository, origin_subject_type, origin_subject_number)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS workflows_branch_idx ON workflows(branch) WHERE branch IS NOT NULL;
      CREATE INDEX IF NOT EXISTS workflows_pr_idx ON workflows(repository, pull_request_number);

      CREATE TABLE IF NOT EXISTS workflow_sessions (
        workflow_id TEXT NOT NULL REFERENCES workflows(id),
        agent_name TEXT NOT NULL,
        runtime_name TEXT NOT NULL,
        runtime_session_id TEXT NOT NULL,
        compatibility_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (workflow_id, agent_name)
      );

      CREATE TABLE IF NOT EXISTS dependency_merge_observations (
        dependency_id TEXT NOT NULL REFERENCES dependencies(id),
        pr_number INTEGER NOT NULL,
        pr_url TEXT,
        merge_commit_sha TEXT NOT NULL,
        merged_at INTEGER NOT NULL,
        base_ref TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (dependency_id, pr_number, merge_commit_sha)
      );
      CREATE INDEX IF NOT EXISTS dependency_merge_observation_idx ON dependency_merge_observations(dependency_id, merged_at);

      CREATE TABLE IF NOT EXISTS dependencies (
        id TEXT PRIMARY KEY,
        parent_workflow_id TEXT NOT NULL REFERENCES workflows(id),
        parent_repository TEXT NOT NULL,
        target_repository TEXT NOT NULL,
        cycle INTEGER NOT NULL DEFAULT 0,
        resume_dispatched_at INTEGER,
        target_issue_number INTEGER,
        target_issue_url TEXT,
        target_issue_closed_at INTEGER,
        target_pr_number INTEGER,
        target_pr_url TEXT,
        target_pr_merged_at INTEGER,
        merge_commit_sha TEXT,
        request_key TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_by_run_id TEXT NOT NULL REFERENCES runs(id),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER,
        UNIQUE(parent_workflow_id, request_key)
      );
      CREATE INDEX IF NOT EXISTS dependencies_parent_idx ON dependencies(parent_workflow_id, status);
      CREATE INDEX IF NOT EXISTS dependencies_target_idx ON dependencies(target_repository, target_issue_number, status);

      CREATE TABLE IF NOT EXISTS rule_ledger (
        rule_name TEXT NOT NULL,
        repository TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_number INTEGER NOT NULL,
        run_id TEXT NOT NULL REFERENCES runs(id),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (rule_name, repository, subject_type, subject_number)
      );
    `);
    this.ensureColumn("runs", "workflow_id", "TEXT");
    this.ensureColumn("runs", "workflow_type", "TEXT");
    this.ensureColumn("runs", "agent_capability_hash", "TEXT");
    this.ensureColumn("runs", "rule_snapshot", "TEXT");
    this.ensureColumn("workflows", "dependency_cycle", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("dependencies", "cycle", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("dependencies", "resume_dispatched_at", "INTEGER");
    this.db.exec("CREATE INDEX IF NOT EXISTS runs_workflow_idx ON runs(workflow_id, status)");
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((candidate) => candidate.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  close(): void {
    this.db.close();
  }

  hasDelivery(deliveryId: string): boolean {
    return this.db.query("SELECT 1 FROM deliveries WHERE id = ?").get(deliveryId) !== null;
  }

  insertDelivery(input: {
    id: string;
    event: string;
    action: string;
    repository: string;
    installationId: number;
    payloadPath: string;
  }): boolean {
    const result = this.db
      .query(`INSERT OR IGNORE INTO deliveries
        (id, event, action, repository, installation_id, payload_path, status, received_at)
        VALUES (?, ?, ?, ?, ?, ?, 'received', ?)`)
      .run(input.id, input.event, input.action, input.repository, input.installationId, input.payloadPath, now());
    return result.changes === 1;
  }

  getDelivery(deliveryId: string): DeliveryRecord {
    const row = this.db.query("SELECT * FROM deliveries WHERE id = ?").get(deliveryId) as Record<string, unknown> | null;
    if (!row) throw new Error(`Delivery not found: ${deliveryId}`);
    return {
      id: String(row.id),
      event: String(row.event),
      action: String(row.action),
      repository: String(row.repository),
      installationId: Number(row.installation_id),
      payloadPath: String(row.payload_path),
      status: String(row.status),
      error: row.error === null ? null : String(row.error),
      receivedAt: Number(row.received_at),
    };
  }

  setDeliveryStatus(deliveryId: string, status: string, error: string | null = null): void {
    this.db.query("UPDATE deliveries SET status = ?, error = ? WHERE id = ?").run(status, error, deliveryId);
  }

  listIncompleteDeliveries(): DeliveryRecord[] {
    const rows = this.db.query("SELECT * FROM deliveries WHERE status IN ('received', 'dispatch_failed') ORDER BY received_at").all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      event: String(row.event),
      action: String(row.action),
      repository: String(row.repository),
      installationId: Number(row.installation_id),
      payloadPath: String(row.payload_path),
      status: String(row.status),
      error: row.error === null ? null : String(row.error),
      receivedAt: Number(row.received_at),
    }));
  }

  private mapWorkflow(row: Record<string, unknown>): WorkflowRecord {
    return {
      id: String(row.id),
      type: String(row.type),
      repository: String(row.repository),
      installationId: Number(row.installation_id),
      originSubjectType: String(row.origin_subject_type) as SubjectType,
      originSubjectNumber: Number(row.origin_subject_number),
      status: String(row.status) as WorkflowRecord["status"],
      workspacePath: row.workspace_path === null ? null : String(row.workspace_path),
      branch: row.branch === null ? null : String(row.branch),
      pullRequestNumber: row.pull_request_number === null ? null : Number(row.pull_request_number),
      pullRequestUrl: row.pull_request_url === null ? null : String(row.pull_request_url),
      turns: Number(row.turns),
      dependencyCycle: Number(row.dependency_cycle),
      quarantined: row.quarantined === 1,
      quarantineRunId: row.quarantine_run_id === null ? null : String(row.quarantine_run_id),
      quarantineReason: row.quarantine_reason === null ? null : String(row.quarantine_reason),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
    };
  }

  getWorkflow(workflowId: string): WorkflowRecord {
    const row = this.db.query("SELECT * FROM workflows WHERE id = ?").get(workflowId) as Record<string, unknown> | null;
    if (!row) throw new Error(`Workflow not found: ${workflowId}`);
    return this.mapWorkflow(row);
  }

  listWorkflows(limit = 50): WorkflowRecord[] {
    const rows = this.db.query("SELECT * FROM workflows ORDER BY created_at DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapWorkflow(row));
  }

  private findWorkflowByOrigin(type: string, repository: string, issueNumber: number): WorkflowRecord | null {
    const row = this.db.query(`SELECT * FROM workflows
      WHERE type = ? AND repository = ? AND origin_subject_type = 'issue' AND origin_subject_number = ?`)
      .get(type, repository, issueNumber) as Record<string, unknown> | null;
    return row ? this.mapWorkflow(row) : null;
  }

  private findWorkflowForContext(context: WebhookContext, type: string): WorkflowRecord | null {
    if (context.subject.type === "issue") {
      return this.findWorkflowByOrigin(type, context.repository, context.subject.number);
    }
    const pullRequest = context.payload.pull_request as Record<string, unknown> | undefined;
    const head = pullRequest?.head as Record<string, unknown> | undefined;
    const branch = typeof head?.ref === "string" ? head.ref : null;
    if (branch) {
      const row = this.db.query("SELECT * FROM workflows WHERE branch = ? AND repository = ?")
        .get(branch, context.repository) as Record<string, unknown> | null;
      if (row) {
        const workflow = this.mapWorkflow(row);
        if (this.pullRequestMatchesWorkflow(context, workflow)) return workflow;
      }
    }
    return null;
  }

  private pullRequestMatchesWorkflow(context: WebhookContext, workflow: WorkflowRecord): boolean {
    if (context.repository !== workflow.repository) return false;
    const pullRequest = context.payload.pull_request as Record<string, unknown> | undefined;
    if (!pullRequest) return false;
    const head = pullRequest.head as Record<string, unknown> | undefined;
    const base = pullRequest.base as Record<string, unknown> | undefined;
    const headRepository = head?.repo as Record<string, unknown> | undefined;
    const baseRepository = base?.repo as Record<string, unknown> | undefined;
    if (head?.ref !== workflow.branch) return false;
    if (headRepository?.full_name !== workflow.repository || baseRepository?.full_name !== workflow.repository) return false;
    const number = Number(pullRequest.number ?? context.subject.number);
    return !workflow.pullRequestNumber || workflow.pullRequestNumber === number;
  }

  private createWorkflow(input: {
    type: string;
    repository: string;
    installationId: number;
    originSubjectNumber: number;
  }): WorkflowRecord {
    const workflowId = id("wf");
    const timestamp = now();
    const workspacePath = join(this.dataDirectory, "worktrees", workflowId);
    const branch = `gerry/${workflowId}`;
    this.db.query(`INSERT INTO workflows
      (id, type, repository, installation_id, origin_subject_type, origin_subject_number, status,
       workspace_path, branch, turns, quarantined, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'issue', ?, 'active', ?, ?, 0, 0, ?, ?)`)
      .run(workflowId, input.type, input.repository, input.installationId, input.originSubjectNumber, workspacePath, branch, timestamp, timestamp);
    return this.getWorkflow(workflowId);
  }

  enqueueRun(input: EnqueueInput): DispatchDecision {
    return this.db.transaction((): DispatchDecision => {
      const { context, rule } = input;
      const previous = this.db
        .query("SELECT decision, reason, run_id FROM dispatches WHERE delivery_id = ? AND rule_name = ?")
        .get(context.deliveryId, rule.name) as { decision: string; reason: string; run_id: string | null } | null;
      if (previous) {
        return {
          decision: "duplicate",
          reason: previous.reason,
          ...(previous.run_id ? { runId: previous.run_id } : {}),
        };
      }

      const skip = (reason: string): DispatchDecision => {
        this.db
          .query("INSERT INTO dispatches (delivery_id, rule_name, decision, reason, created_at) VALUES (?, ?, 'skipped', ?, ?)")
          .run(context.deliveryId, rule.name, reason, now());
        return { decision: "skipped", reason };
      };

      if (rule.once_per_subject) {
        const existing = this.db
          .query(`SELECT run_id FROM rule_ledger
            WHERE rule_name = ? AND repository = ? AND subject_type = ? AND subject_number = ?`)
          .get(rule.name, context.repository, context.subject.type, context.subject.number);
        if (existing) return skip("Rule already has an active or successful run for this subject");
      }

      let workflowId = input.workflowId ?? null;
      const workflowType = rule.session === "workflow" ? rule.workflow ?? rule.name : null;
      if (rule.session === "workflow") {
        if (!workflowId && rule.workflow_start) {
          if (context.subject.type !== "issue") return skip("Workflow start rules require an issue subject");
          const existing = this.findWorkflowByOrigin(workflowType!, context.repository, context.subject.number);
          workflowId = existing?.id ?? this.createWorkflow({
            type: workflowType!,
            repository: context.repository,
            installationId: context.installationId,
            originSubjectNumber: context.subject.number,
          }).id;
        }
        if (!workflowId) workflowId = this.findWorkflowForContext(context, workflowType!)?.id ?? null;
        if (!workflowId) return skip("No matching workflow was found for this event");
        const workflow = this.getWorkflow(workflowId);
        if (workflow.type !== workflowType) return skip(`Workflow type mismatch: expected ${workflowType}, found ${workflow.type}`);
        if (!input.resumeWorkflow && workflow.status !== "active") return skip(`Workflow is ${workflow.status}`);
        if (workflow.status === "completed") return skip("Workflow is completed");
        if (workflow.turns >= rule.max_turns) return skip(`Workflow turn limit reached (${rule.max_turns})`);
        if (input.resumeWorkflow) {
          this.db.query("UPDATE workflows SET status = 'active', updated_at = ? WHERE id = ?").run(now(), workflowId);
        }
        this.db.query("UPDATE workflows SET turns = turns + 1, updated_at = ? WHERE id = ?").run(now(), workflowId);
      }

      const conversationKey = rule.session === "conversation"
        ? `${context.repository}#${context.subject.type}#${context.subject.number}#${rule.conversation ?? rule.name}`
        : null;
      if (conversationKey) {
        const timestamp = now();
        this.db
          .query(`INSERT OR IGNORE INTO conversations
            (key, repository, subject_type, subject_number, group_name, turns, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 0, ?, ?)`)
          .run(
            conversationKey,
            context.repository,
            context.subject.type,
            context.subject.number,
            rule.conversation ?? rule.name,
            timestamp,
            timestamp,
          );
        const conversation = this.db.query("SELECT turns FROM conversations WHERE key = ?").get(conversationKey) as { turns: number };
        if (conversation.turns >= rule.max_turns) {
          return skip(`Conversation turn limit reached (${rule.max_turns}); dispatch manually if more work is required`);
        }
        this.db.query("UPDATE conversations SET turns = turns + 1, updated_at = ? WHERE key = ?").run(timestamp, conversationKey);
      }

      const runId = id("run");
      const timestamp = now();
      this.db
        .query(`INSERT INTO runs (
          id, delivery_id, rule_name, rule_snapshot, agent_name, runtime_name, runtime_type, repository, installation_id,
          subject_type, subject_number, conversation_key, workflow_id, workflow_type, session_policy,
          once_per_subject, status, max_attempts, available_at, parent_run_id, config_hash,
          prompt_path, prompt_hash, prompt_snapshot, instructions_snapshot, retry_backoff_seconds, created_at
        ) VALUES (
          $id, $deliveryId, $ruleName, $ruleSnapshot, $agentName, $runtimeName, $runtimeType, $repository, $installationId,
          $subjectType, $subjectNumber, $conversationKey, $workflowId, $workflowType, $sessionPolicy,
          $oncePerSubject, 'queued', $maxAttempts, $availableAt, $parentRunId, $configHash,
          $promptPath, $promptHash, $promptSnapshot, $instructionsSnapshot, $retryBackoffSeconds, $createdAt
        )`)
        .run({
          $id: runId,
          $deliveryId: context.deliveryId,
          $ruleName: rule.name,
          $ruleSnapshot: JSON.stringify(rule),
          $agentName: input.agentName,
          $runtimeName: input.runtimeName,
          $runtimeType: input.runtime.type,
          $repository: context.repository,
          $installationId: context.installationId,
          $subjectType: context.subject.type,
          $subjectNumber: context.subject.number,
          $conversationKey: conversationKey,
          $workflowId: workflowId,
          $workflowType: workflowType,
          $sessionPolicy: rule.session,
          $oncePerSubject: rule.once_per_subject ? 1 : 0,
          $maxAttempts: input.agent.max_attempts,
          $availableAt: timestamp,
          $parentRunId: input.parentRunId,
          $configHash: input.configHash,
          $promptPath: input.promptPath,
          $promptHash: input.promptHash,
          $promptSnapshot: input.promptContents,
          $instructionsSnapshot: input.instructions,
          $retryBackoffSeconds: input.agent.retry_backoff_seconds,
          $createdAt: timestamp,
        });
      if (rule.once_per_subject) {
        this.db
          .query(`INSERT INTO rule_ledger (rule_name, repository, subject_type, subject_number, run_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`)
          .run(rule.name, context.repository, context.subject.type, context.subject.number, runId, timestamp);
      }
      this.db
        .query("INSERT INTO dispatches (delivery_id, rule_name, decision, reason, run_id, created_at) VALUES (?, ?, 'queued', ?, ?, ?)")
        .run(context.deliveryId, rule.name, "Rule matched", runId, timestamp);
      return { decision: "queued", reason: "Rule matched", runId };
    })();
  }

  private mapRun(row: RunRow): RunRecord {
    return {
      id: row.id,
      deliveryId: row.delivery_id,
      ruleName: row.rule_name,
      ruleSnapshot: row.rule_snapshot ? JSON.parse(row.rule_snapshot) as RunRecord["ruleSnapshot"] : null,
      agentName: row.agent_name,
      runtimeName: row.runtime_name,
      runtimeType: row.runtime_type,
      repository: row.repository,
      installationId: row.installation_id,
      subjectType: row.subject_type,
      subjectNumber: row.subject_number,
      conversationKey: row.conversation_key,
      workflowId: row.workflow_id,
      workflowType: row.workflow_type,
      sessionPolicy: row.session_policy,
      oncePerSubject: row.once_per_subject === 1,
      status: row.status,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      retryBackoffSeconds: row.retry_backoff_seconds,
      availableAt: row.available_at,
      workspacePath: row.workspace_path,
      branch: row.branch,
      runtimeSessionId: row.runtime_session_id,
      agentCapabilityHash: row.agent_capability_hash,
      parentRunId: row.parent_run_id,
      configHash: row.config_hash,
      promptPath: row.prompt_path,
      promptHash: row.prompt_hash,
      promptSnapshot: row.prompt_snapshot,
      instructionsSnapshot: row.instructions_snapshot,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      resolvedAt: row.resolved_at,
      lastError: row.last_error,
      responsePath: row.response_path,
      usage: row.usage_json ? (JSON.parse(row.usage_json) as JsonObject) : null,
    };
  }

  getRun(runId: string): RunRecord {
    const row = this.db.query("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | null;
    if (!row) throw new Error(`Run not found: ${runId}`);
    return this.mapRun(row);
  }

  findRun(prefix: string): RunRecord {
    const rows = this.db.query("SELECT * FROM runs WHERE id LIKE ? ORDER BY created_at DESC LIMIT 2").all(`${prefix}%`) as RunRow[];
    if (rows.length === 0) throw new Error(`Run not found: ${prefix}`);
    if (rows.length > 1) throw new Error(`Ambiguous run ID prefix: ${prefix}`);
    return this.mapRun(rows[0]!);
  }

  listRuns(limit = 50, status?: RunStatus): RunRecord[] {
    const rows = status
      ? this.db.query("SELECT * FROM runs WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit)
      : this.db.query("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(limit);
    return (rows as RunRow[]).map((row) => this.mapRun(row));
  }

  listDispatches(deliveryId: string): Array<Record<string, unknown>> {
    return this.db.query("SELECT * FROM dispatches WHERE delivery_id = ? ORDER BY created_at").all(deliveryId) as Array<Record<string, unknown>>;
  }

  claimNext(workerId: string, leaseMilliseconds = 60_000): RunRecord | null {
    return this.db.transaction((): RunRecord | null => {
      const candidate = this.db
        .query(`SELECT candidate.* FROM runs AS candidate
          WHERE candidate.status IN ('queued', 'retry_wait') AND candidate.available_at <= ?
            AND (
              candidate.conversation_key IS NULL OR (
                NOT EXISTS (
                  SELECT 1 FROM conversations AS conversation
                  WHERE conversation.key = candidate.conversation_key AND conversation.quarantined = 1
                )
                AND NOT EXISTS (
                  SELECT 1 FROM runs AS active
                  WHERE active.conversation_key = candidate.conversation_key
                    AND active.id != candidate.id AND active.status IN ('preparing', 'running')
                )
                AND NOT EXISTS (
                  SELECT 1 FROM runs AS earlier_retry
                  WHERE earlier_retry.conversation_key = candidate.conversation_key
                    AND earlier_retry.status = 'retry_wait'
                    AND (
                      earlier_retry.created_at < candidate.created_at
                      OR (earlier_retry.created_at = candidate.created_at AND earlier_retry.rowid < candidate.rowid)
                    )
                )
              )
            )
            AND (
              candidate.workflow_id IS NULL OR (
                EXISTS (
                  SELECT 1 FROM workflows AS workflow
                  WHERE workflow.id = candidate.workflow_id
                    AND workflow.status = 'active' AND workflow.quarantined = 0
                )
                AND NOT EXISTS (
                  SELECT 1 FROM runs AS active_workflow_run
                  WHERE active_workflow_run.workflow_id = candidate.workflow_id
                    AND active_workflow_run.id != candidate.id
                    AND active_workflow_run.status IN ('preparing', 'running')
                )
                AND NOT EXISTS (
                  SELECT 1 FROM runs AS earlier_workflow_retry
                  WHERE earlier_workflow_retry.workflow_id = candidate.workflow_id
                    AND earlier_workflow_retry.status = 'retry_wait'
                    AND (
                      earlier_workflow_retry.created_at < candidate.created_at
                      OR (earlier_workflow_retry.created_at = candidate.created_at AND earlier_workflow_retry.rowid < candidate.rowid)
                    )
                )
              )
            )
          ORDER BY candidate.created_at, candidate.rowid LIMIT 1`)
        .get(now()) as RunRow | null;
      if (!candidate) return null;
      const timestamp = now();
      const result = this.db
        .query(`UPDATE runs SET status = 'preparing', attempt = attempt + 1,
          started_at = COALESCE(started_at, ?), finished_at = NULL, lease_owner = ?, lease_expires_at = ?, last_error = NULL
          WHERE id = ? AND status IN ('queued', 'retry_wait')`)
        .run(timestamp, workerId, timestamp + leaseMilliseconds, candidate.id);
      return result.changes === 1 ? this.getRun(candidate.id) : null;
    })();
  }

  heartbeat(runId: string, workerId: string, leaseMilliseconds = 60_000): void {
    this.db
      .query("UPDATE runs SET lease_expires_at = ? WHERE id = ? AND lease_owner = ? AND status IN ('preparing', 'running')")
      .run(now() + leaseMilliseconds, runId, workerId);
  }

  setAgentCapability(runId: string, capabilityHash: string, workerId: string): void {
    const update = this.db.query(`UPDATE runs SET agent_capability_hash = ?
      WHERE id = ? AND lease_owner = ? AND status = 'preparing'`)
      .run(capabilityHash, runId, workerId);
    if (update.changes !== 1) throw new Error(`Run ownership was lost while issuing its agent capability: ${runId}`);
  }

  getRunByAgentCapability(capabilityHash: string): RunRecord | null {
    const row = this.db.query(`SELECT * FROM runs WHERE agent_capability_hash = ?
      AND status IN ('preparing', 'running') ORDER BY created_at DESC LIMIT 1`).get(capabilityHash) as RunRow | null;
    return row ? this.mapRun(row) : null;
  }

  validateAgentCapability(runId: string, capabilityHash: string): boolean {
    const row = this.db.query(`SELECT 1 FROM runs WHERE id = ? AND agent_capability_hash = ?
      AND status IN ('preparing', 'running')`).get(runId, capabilityHash);
    return row !== null;
  }

  markRunning(runId: string, workerId: string): void {
    const update = this.db.query("UPDATE runs SET status = 'running', lease_expires_at = ? WHERE id = ? AND lease_owner = ? AND status = 'preparing'")
      .run(now() + 60_000, runId, workerId);
    if (update.changes !== 1) throw new Error(`Run ownership was lost while starting ${runId}`);
  }

  setWorkspace(runId: string, workspacePath: string, branch: string | null, workerId?: string): void {
    this.db.transaction(() => {
      const run = this.getRun(runId);
      if (run.workflowId) {
        const existing = this.getWorkflow(run.workflowId);
        if (existing.workspacePath && existing.workspacePath !== workspacePath) {
          throw new Error(`Workflow workspace changed from ${existing.workspacePath} to ${workspacePath}`);
        }
        if (existing.branch && existing.branch !== branch) {
          throw new Error(`Workflow branch changed from ${existing.branch} to ${branch}`);
        }
      }
      if (run.conversationKey) {
        const existing = this.getConversationWorkspace(run.conversationKey);
        if (existing?.workspacePath && existing.workspacePath !== workspacePath) {
          throw new Error(`Conversation workspace changed from ${existing.workspacePath} to ${workspacePath}; mixed workspace modes are not allowed`);
        }
      }
      const update = workerId
        ? this.db.query("UPDATE runs SET workspace_path = ?, branch = ? WHERE id = ? AND lease_owner = ? AND status = 'preparing'")
          .run(workspacePath, branch, runId, workerId)
        : this.db.query("UPDATE runs SET workspace_path = ?, branch = ? WHERE id = ?").run(workspacePath, branch, runId);
      if (update.changes !== 1) throw new Error(`Run ownership was lost while assigning a workspace: ${runId}`);
      if (run.conversationKey) {
        this.db
          .query("UPDATE conversations SET workspace_path = ?, branch = ?, updated_at = ? WHERE key = ?")
          .run(workspacePath, branch, now(), run.conversationKey);
      }
      if (run.workflowId) {
        this.db.query("UPDATE workflows SET workspace_path = ?, branch = ?, updated_at = ? WHERE id = ?")
          .run(workspacePath, branch, now(), run.workflowId);
      }
    })();
  }

  getConversationWorkspace(conversationKey: string): { workspacePath: string | null; branch: string | null } | null {
    const row = this.db.query("SELECT workspace_path, branch FROM conversations WHERE key = ?").get(conversationKey) as {
      workspace_path: string | null;
      branch: string | null;
    } | null;
    return row ? { workspacePath: row.workspace_path, branch: row.branch } : null;
  }

  getConversationSession(
    conversationKey: string,
    agentName: string,
    runtimeName: string,
    compatibilityHash = "",
  ): string | null {
    const row = this.db
      .query(`SELECT runtime_session_id FROM conversation_sessions
        WHERE conversation_key = ? AND agent_name = ? AND runtime_name = ? AND compatibility_hash = ?`)
      .get(conversationKey, agentName, runtimeName, compatibilityHash) as { runtime_session_id: string } | null;
    return row?.runtime_session_id ?? null;
  }

  getWorkflowSession(workflowId: string, agentName: string, runtimeName: string, compatibilityHash = ""): string | null {
    const row = this.db.query(`SELECT runtime_session_id FROM workflow_sessions
      WHERE workflow_id = ? AND agent_name = ? AND runtime_name = ? AND compatibility_hash = ?`)
      .get(workflowId, agentName, runtimeName, compatibilityHash) as { runtime_session_id: string } | null;
    return row?.runtime_session_id ?? null;
  }

  private saveWorkflowSession(run: RunRecord, runtimeSessionId: string, compatibilityHash: string): void {
    if (!run.workflowId) return;
    this.db.query(`INSERT INTO workflow_sessions
      (workflow_id, agent_name, runtime_name, runtime_session_id, compatibility_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workflow_id, agent_name) DO UPDATE SET
        runtime_name = excluded.runtime_name, runtime_session_id = excluded.runtime_session_id,
        compatibility_hash = excluded.compatibility_hash, updated_at = excluded.updated_at`)
      .run(run.workflowId, run.agentName, run.runtimeName, runtimeSessionId, compatibilityHash, now(), now());
  }

  private saveConversationSession(run: RunRecord, runtimeSessionId: string, compatibilityHash: string): void {
    if (!run.conversationKey) return;
    this.db
      .query(`INSERT INTO conversation_sessions
        (conversation_key, agent_name, runtime_name, runtime_session_id, compatibility_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_key, agent_name) DO UPDATE SET
          runtime_name = excluded.runtime_name, runtime_session_id = excluded.runtime_session_id,
          compatibility_hash = excluded.compatibility_hash, updated_at = excluded.updated_at`)
      .run(run.conversationKey, run.agentName, run.runtimeName, runtimeSessionId, compatibilityHash, now(), now());
  }

  attachRuntimeSession(
    runId: string,
    runtimeSessionId: string,
    usage: JsonObject | null = null,
    compatibilityHash = "",
    workerId?: string,
  ): void {
    this.db.transaction(() => {
      const run = this.getRun(runId);
      const update = workerId
        ? this.db.query(`UPDATE runs SET runtime_session_id = ?, usage_json = COALESCE(?, usage_json)
            WHERE id = ? AND lease_owner = ? AND status IN ('preparing', 'running')`)
          .run(runtimeSessionId, usage ? JSON.stringify(usage) : null, runId, workerId)
        : this.db.query("UPDATE runs SET runtime_session_id = ?, usage_json = COALESCE(?, usage_json) WHERE id = ?")
          .run(runtimeSessionId, usage ? JSON.stringify(usage) : null, runId);
      if (update.changes !== 1) throw new Error(`Run ownership was lost while attaching its runtime session: ${runId}`);
      this.saveConversationSession(run, runtimeSessionId, compatibilityHash);
      this.saveWorkflowSession(run, runtimeSessionId, compatibilityHash);
    })();
  }

  succeed(
    runId: string,
    workerId: string,
    result: { runtimeSessionId: string; responsePath: string; usage: JsonObject | null; sessionCompatibilityHash?: string },
  ): void {
    this.db.transaction(() => {
      const run = this.getRun(runId);
      const update = this.db
        .query(`UPDATE runs SET status = 'succeeded', runtime_session_id = ?, response_path = ?, usage_json = ?,
          lease_owner = NULL, lease_expires_at = NULL, agent_capability_hash = NULL,
          finished_at = ?, last_error = NULL WHERE id = ? AND lease_owner = ?`)
        .run(result.runtimeSessionId, result.responsePath, result.usage ? JSON.stringify(result.usage) : null, now(), runId, workerId);
      if (update.changes !== 1) throw new Error(`Run ownership was lost while completing ${runId}`);
      this.saveConversationSession(run, result.runtimeSessionId, result.sessionCompatibilityHash ?? "");
      this.saveWorkflowSession(run, result.runtimeSessionId, result.sessionCompatibilityHash ?? "");
    })();
  }

  fail(
    runId: string,
    workerId: string,
    error: string,
    options: {
      retryable: boolean;
      interrupted?: boolean;
      preserveLedger?: boolean;
      retryDelayMs?: number;
      ignoreAttemptLimit?: boolean;
    },
  ): RunRecord {
    return this.db.transaction(() => {
      const run = this.getRun(runId);
      const withinAttemptLimit = options.ignoreAttemptLimit || run.attempt < run.maxAttempts;
      const retry = !options.interrupted && options.retryable && withinAttemptLimit;
      const status: RunStatus = options.interrupted ? "interrupted" : retry ? "retry_wait" : "failed";
      const defaultDelayMs = run.retryBackoffSeconds * 1000 * 2 ** Math.max(0, run.attempt - 1);
      const availableAt = retry ? now() + (options.retryDelayMs ?? defaultDelayMs) : run.availableAt;
      const update = this.db
        .query(`UPDATE runs SET status = ?, available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
          agent_capability_hash = NULL, finished_at = ?, last_error = ? WHERE id = ? AND lease_owner = ?`)
        .run(status, availableAt, retry ? null : now(), error, runId, workerId);
      if (update.changes !== 1) throw new Error(`Run ownership was lost while failing ${runId}`);
      if (!retry && !options.preserveLedger) this.releaseLedger(runId);
      if (!retry && options.preserveLedger && run.conversationKey) {
        this.db.query("UPDATE conversations SET quarantined = 1, quarantine_run_id = ?, quarantine_reason = ?, updated_at = ? WHERE key = ?")
          .run(runId, `Ambiguous runtime failure in ${runId}; retry or resolve that run before continuing`, now(), run.conversationKey);
      }
      if (!retry && options.preserveLedger && run.workflowId) {
        this.db.query("UPDATE workflows SET quarantined = 1, quarantine_run_id = ?, quarantine_reason = ?, updated_at = ? WHERE id = ?")
          .run(runId, `Ambiguous runtime failure in ${runId}; retry or resolve that run before continuing`, now(), run.workflowId);
      }
      return this.getRun(runId);
    })();
  }

  private releaseLedger(runId: string): void {
    this.db.query("DELETE FROM rule_ledger WHERE run_id = ?").run(runId);
  }

  cancel(runId: string): RunRecord {
    return this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!["queued", "retry_wait"].includes(run.status)) {
        throw new Error(`Only queued or retry-waiting runs can be cancelled; ${run.id} is ${run.status}`);
      }
      this.db
        .query("UPDATE runs SET status = 'cancelled', finished_at = ?, last_error = 'Cancelled by operator' WHERE id = ?")
        .run(now(), runId);
      this.releaseLedger(runId);
      return this.getRun(runId);
    })();
  }

  retry(runId: string): RunRecord {
    return this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!["failed", "interrupted", "cancelled"].includes(run.status)) {
        throw new Error(`Only failed, interrupted, or cancelled runs can be retried; ${run.id} is ${run.status}`);
      }
      if (run.resolvedAt) throw new Error(`Resolved runs cannot be retried: ${run.id}`);
      const ledgerEntry = this.db.query("SELECT 1 FROM rule_ledger WHERE run_id = ?").get(runId);
      if (run.oncePerSubject && !ledgerEntry) {
        const previous = this.db
          .query(`SELECT run_id FROM rule_ledger WHERE rule_name = ? AND repository = ? AND subject_type = ? AND subject_number = ?`)
          .get(run.ruleName, run.repository, run.subjectType, run.subjectNumber) as { run_id: string } | null;
        if (previous && previous.run_id !== runId) {
          throw new Error(`Cannot retry: another run (${previous.run_id}) now owns this rule's once-per-subject ledger entry`);
        }
        this.db
          .query(`INSERT INTO rule_ledger (rule_name, repository, subject_type, subject_number, run_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`)
          .run(run.ruleName, run.repository, run.subjectType, run.subjectNumber, runId, now());
      }
      this.db
        .query(`UPDATE runs SET status = 'queued', max_attempts = attempt + 1, available_at = ?,
          finished_at = NULL, resolved_at = NULL, last_error = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`)
        .run(now(), runId);
      if (run.conversationKey) {
        this.db.query("UPDATE conversations SET quarantined = 0, quarantine_run_id = NULL, quarantine_reason = NULL, updated_at = ? WHERE key = ? AND quarantine_run_id = ?")
          .run(now(), run.conversationKey, runId);
      }
      if (run.workflowId) {
        this.db.query("UPDATE workflows SET quarantined = 0, quarantine_run_id = NULL, quarantine_reason = NULL, updated_at = ? WHERE id = ? AND quarantine_run_id = ?")
          .run(now(), run.workflowId, runId);
      }
      return this.getRun(runId);
    })();
  }

  resolve(runId: string): RunRecord {
    return this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!["failed", "interrupted"].includes(run.status)) {
        throw new Error(`Only failed or interrupted runs can be resolved; ${run.id} is ${run.status}`);
      }
      if (run.resolvedAt) throw new Error(`Run is already resolved: ${run.id}`);
      this.releaseLedger(runId);
      this.db.query("UPDATE runs SET resolved_at = ? WHERE id = ?").run(now(), runId);
      if (run.conversationKey) {
        this.db.query("UPDATE conversations SET quarantined = 0, quarantine_run_id = NULL, quarantine_reason = NULL, updated_at = ? WHERE key = ? AND quarantine_run_id = ?")
          .run(now(), run.conversationKey, runId);
      }
      if (run.workflowId) {
        this.db.query("UPDATE workflows SET quarantined = 0, quarantine_run_id = NULL, quarantine_reason = NULL, updated_at = ? WHERE id = ? AND quarantine_run_id = ?")
          .run(now(), run.workflowId, runId);
      }
      return this.getRun(runId);
    })();
  }

  recoverActiveRuns(reason: string): number {
    return this.db.transaction(() => {
      const rows = this.db.query("SELECT id, conversation_key, workflow_id FROM runs WHERE status IN ('preparing', 'running')").all() as Array<{ id: string; conversation_key: string | null; workflow_id: string | null }>;
      for (const row of rows) {
        this.db
          .query(`UPDATE runs SET status = 'interrupted', finished_at = ?, last_error = ?,
            lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`)
          .run(now(), reason, row.id);
        if (row.conversation_key) {
          this.db.query("UPDATE conversations SET quarantined = 1, quarantine_run_id = ?, quarantine_reason = ?, updated_at = ? WHERE key = ?")
            .run(row.id, `Interrupted run ${row.id} must be retried or resolved`, now(), row.conversation_key);
        }
        if (row.workflow_id) {
          this.db.query("UPDATE workflows SET quarantined = 1, quarantine_run_id = ?, quarantine_reason = ?, updated_at = ? WHERE id = ?")
            .run(row.id, `Interrupted run ${row.id} must be retried or resolved`, now(), row.workflow_id);
        }
      }
      return rows.length;
    })();
  }

  activateWorkflowForResume(workflowId: string): void {
    this.db.query("UPDATE workflows SET status = 'active', updated_at = ? WHERE id = ? AND status = 'waiting'")
      .run(now(), workflowId);
  }

  linkWorkflowPullRequest(context: WebhookContext): WorkflowRecord | null {
    const pullRequest = context.payload.pull_request as Record<string, unknown> | undefined;
    if (!pullRequest) return null;
    const head = pullRequest.head as Record<string, unknown> | undefined;
    const branch = typeof head?.ref === "string" ? head.ref : null;
    if (!branch) return null;
    const row = this.db.query("SELECT id FROM workflows WHERE branch = ? AND repository = ?").get(branch, context.repository) as { id: string } | null;
    if (!row) return null;
    if (!this.pullRequestMatchesWorkflow(context, this.getWorkflow(row.id))) return null;
    const number = Number(pullRequest.number ?? context.subject.number);
    const url = typeof pullRequest.html_url === "string" ? pullRequest.html_url : null;
    this.db.query("UPDATE workflows SET pull_request_number = ?, pull_request_url = ?, updated_at = ? WHERE id = ?")
      .run(number, url, now(), row.id);
    if (context.event === "pull_request_review" && context.action === "submitted") {
      const review = context.payload.review as Record<string, unknown> | undefined;
      if (review?.state === "approved") {
        this.db.query("UPDATE workflows SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('active', 'waiting')")
          .run(now(), now(), row.id);
      }
    }
    return this.getWorkflow(row.id);
  }

  private mapDependency(row: Record<string, unknown>): DependencyRecord {
    return {
      id: String(row.id),
      parentWorkflowId: String(row.parent_workflow_id),
      parentRepository: String(row.parent_repository),
      targetRepository: String(row.target_repository),
      targetIssueNumber: row.target_issue_number === null ? null : Number(row.target_issue_number),
      targetIssueUrl: row.target_issue_url === null ? null : String(row.target_issue_url),
      targetIssueClosedAt: row.target_issue_closed_at === null ? null : Number(row.target_issue_closed_at),
      targetPrNumber: row.target_pr_number === null ? null : Number(row.target_pr_number),
      targetPrUrl: row.target_pr_url === null ? null : String(row.target_pr_url),
      targetPrMergedAt: row.target_pr_merged_at === null ? null : Number(row.target_pr_merged_at),
      mergeCommitSha: row.merge_commit_sha === null ? null : String(row.merge_commit_sha),
      cycle: Number(row.cycle),
      resumeDispatchedAt: row.resume_dispatched_at === null ? null : Number(row.resume_dispatched_at),
      requestKey: String(row.request_key),
      title: String(row.title),
      body: String(row.body),
      status: String(row.status) as DependencyRecord["status"],
      error: row.error === null ? null : String(row.error),
      createdByRunId: String(row.created_by_run_id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    };
  }

  getDependency(dependencyId: string): DependencyRecord {
    const row = this.db.query("SELECT * FROM dependencies WHERE id = ?").get(dependencyId) as Record<string, unknown> | null;
    if (!row) throw new Error(`Dependency not found: ${dependencyId}`);
    return this.mapDependency(row);
  }

  listDependencies(limit = 100): DependencyRecord[] {
    const rows = this.db.query("SELECT * FROM dependencies ORDER BY created_at DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapDependency(row));
  }

  listWorkflowDependencies(workflowId: string, cycle?: number): DependencyRecord[] {
    const rows = cycle === undefined
      ? this.db.query("SELECT * FROM dependencies WHERE parent_workflow_id = ? ORDER BY created_at").all(workflowId) as Array<Record<string, unknown>>
      : this.db.query("SELECT * FROM dependencies WHERE parent_workflow_id = ? AND cycle = ? ORDER BY created_at").all(workflowId, cycle) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapDependency(row));
  }

  private nextDependencyCycle(workflowId: string): number {
    const workflow = this.getWorkflow(workflowId);
    if (workflow.dependencyCycle === 0) return 1;
    if (workflow.status === "waiting") return Math.max(1, workflow.dependencyCycle);
    const unresolved = this.db.query(`SELECT 1 FROM dependencies
      WHERE parent_workflow_id = ? AND cycle = ? AND status NOT IN ('resolved', 'abandoned') LIMIT 1`)
      .get(workflowId, workflow.dependencyCycle);
    return unresolved ? workflow.dependencyCycle : workflow.dependencyCycle + 1;
  }

  beginDependencyRequest(input: {
    parentWorkflowId: string;
    parentRepository: string;
    targetRepository: string;
    requestKey: string;
    title: string;
    body: string;
    createdByRunId: string;
  }): { dependency: DependencyRecord; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.db.query("SELECT * FROM dependencies WHERE parent_workflow_id = ? AND request_key = ?")
        .get(input.parentWorkflowId, input.requestKey) as Record<string, unknown> | null;
      if (existing) return { dependency: this.mapDependency(existing), created: false };
      const dependencyId = id("dep");
      const timestamp = now();
      const cycle = this.nextDependencyCycle(input.parentWorkflowId);
      this.db.query(`INSERT INTO dependencies
        (id, parent_workflow_id, parent_repository, target_repository, cycle, request_key, title, body, status,
         created_by_run_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?, ?, ?)`)
        .run(dependencyId, input.parentWorkflowId, input.parentRepository, input.targetRepository, cycle,
          input.requestKey, input.title, input.body, input.createdByRunId, timestamp, timestamp);
      this.db.query("UPDATE workflows SET dependency_cycle = ?, updated_at = ? WHERE id = ?")
        .run(cycle, timestamp, input.parentWorkflowId);
      return { dependency: this.getDependency(dependencyId), created: true };
    })();
  }

  finishDependencyRequest(dependencyId: string, issue: { number: number; url: string }): DependencyRecord {
    return this.db.transaction(() => {
      const before = this.getDependency(dependencyId);
      const workflow = this.getWorkflow(before.parentWorkflowId);
      if (workflow.status === "completed") throw new Error("Cannot add a dependency to a completed workflow");
      const cycle = before.cycle || this.nextDependencyCycle(before.parentWorkflowId);
      this.db.query(`UPDATE dependencies SET target_issue_number = ?, target_issue_url = ?, status = 'pending',
        cycle = ?, error = NULL, updated_at = ? WHERE id = ? AND status = 'creating'`)
        .run(issue.number, issue.url, cycle, now(), dependencyId);
      const dependency = this.getDependency(dependencyId);
      if (dependency.status !== "pending") throw new Error(`Dependency request could not be completed: ${dependencyId}`);
      this.db.query("UPDATE workflows SET status = 'waiting', dependency_cycle = ?, updated_at = ? WHERE id = ?")
        .run(cycle, now(), dependency.parentWorkflowId);
      return dependency;
    })();
  }

  failDependencyRequest(dependencyId: string, error: string): void {
    this.db.query("UPDATE dependencies SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND status = 'creating'")
      .run(error, now(), dependencyId);
  }

  private resolutionCandidates(dependencyId: string): DependencyResolutionCandidate[] {
    const dependency = this.getDependency(dependencyId);
    if (dependency.status !== "pending" || !dependency.targetIssueClosedAt) return [];
    const observations = this.db.query(`SELECT * FROM dependency_merge_observations WHERE dependency_id = ? ORDER BY merged_at`)
      .all(dependencyId) as Array<Record<string, unknown>>;
    return observations.flatMap((row) => {
      const mergedAt = Number(row.merged_at);
      const closeFollowsMerge = dependency.targetIssueClosedAt! + 5_000 >= mergedAt;
      const closeWithinMergeWindow = dependency.targetIssueClosedAt! <= mergedAt + 5 * 60_000;
      if (!closeFollowsMerge || !closeWithinMergeWindow) return [];
      return [{
        dependency,
        observation: {
          prNumber: Number(row.pr_number),
          prUrl: row.pr_url === null ? null : String(row.pr_url),
          mergeCommitSha: String(row.merge_commit_sha),
          mergedAt,
          baseRef: String(row.base_ref),
        },
      }];
    });
  }

  recordDependencyIssueClosed(context: WebhookContext): DependencyResolutionCandidate[] {
    if (context.event !== "issues" || context.action !== "closed") return [];
    const issue = context.payload.issue as Record<string, unknown> | undefined;
    if (!issue || issue.state_reason === "not_planned") return [];
    const number = Number(issue.number);
    const parsedClosedAt = typeof issue.closed_at === "string" ? Date.parse(issue.closed_at) : Number.NaN;
    const timestamp = Number.isFinite(parsedClosedAt) ? parsedClosedAt : now();
    const rows = this.db.query(`SELECT id FROM dependencies
      WHERE target_repository = ? AND target_issue_number = ? AND status = 'pending'`)
      .all(context.repository, number) as Array<{ id: string }>;
    for (const row of rows) {
      this.db.query("UPDATE dependencies SET target_issue_closed_at = ?, updated_at = ? WHERE id = ?")
        .run(timestamp, timestamp, row.id);
    }
    return rows.flatMap((row) => this.resolutionCandidates(row.id));
  }

  recordDependencyPullRequestMerged(context: WebhookContext, defaultBranch: string): DependencyResolutionCandidate[] {
    const pullRequest = context.payload.pull_request as Record<string, unknown> | undefined;
    if (context.event !== "pull_request" || context.action !== "closed" || pullRequest?.merged !== true) return [];
    const base = pullRequest.base as Record<string, unknown> | undefined;
    if (base?.ref !== defaultBranch) return [];
    const body = typeof pullRequest.body === "string" ? pullRequest.body : "";
    const issueNumbers = new Set<number>();
    const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi;
    for (const match of body.matchAll(pattern)) issueNumbers.add(Number(match[1]));
    if (issueNumbers.size === 0) return [];
    const prNumber = Number(pullRequest.number ?? context.subject.number);
    const prUrl = typeof pullRequest.html_url === "string" ? pullRequest.html_url : null;
    const mergeCommitSha = typeof pullRequest.merge_commit_sha === "string" ? pullRequest.merge_commit_sha : null;
    if (!mergeCommitSha) return [];
    const parsedMergedAt = typeof pullRequest.merged_at === "string" ? Date.parse(pullRequest.merged_at) : Number.NaN;
    const mergedAt = Number.isFinite(parsedMergedAt) ? parsedMergedAt : now();
    const candidates: DependencyResolutionCandidate[] = [];
    for (const issueNumber of issueNumbers) {
      const rows = this.db.query(`SELECT id FROM dependencies
        WHERE target_repository = ? AND target_issue_number = ? AND status = 'pending'`)
        .all(context.repository, issueNumber) as Array<{ id: string }>;
      for (const row of rows) {
        this.db.query(`INSERT OR IGNORE INTO dependency_merge_observations
          (dependency_id, pr_number, pr_url, merge_commit_sha, merged_at, base_ref, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(row.id, prNumber, prUrl, mergeCommitSha, mergedAt, defaultBranch, now());
        candidates.push(...this.resolutionCandidates(row.id));
      }
    }
    return candidates;
  }

  listDependencyResolutionCandidates(): DependencyResolutionCandidate[] {
    const rows = this.db.query("SELECT id FROM dependencies WHERE status = 'pending' AND target_issue_closed_at IS NOT NULL").all() as Array<{ id: string }>;
    return rows.flatMap((row) => this.resolutionCandidates(row.id));
  }

  markDependencyResolved(dependencyId: string, observation: MergeObservation): DependencyRecord | null {
    const timestamp = now();
    const update = this.db.query(`UPDATE dependencies SET status = 'resolved', target_pr_number = ?, target_pr_url = ?,
      target_pr_merged_at = ?, merge_commit_sha = ?, resolved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'`)
      .run(observation.prNumber, observation.prUrl, observation.mergedAt, observation.mergeCommitSha,
        timestamp, timestamp, dependencyId);
    return update.changes === 1 ? this.getDependency(dependencyId) : null;
  }

  dependenciesAwaitingResume(): DependencyRecord[] {
    const rows = this.db.query(`SELECT dependencies.* FROM dependencies
      JOIN workflows ON workflows.id = dependencies.parent_workflow_id
      WHERE dependencies.status IN ('resolved', 'abandoned')
        AND dependencies.resume_dispatched_at IS NULL
        AND dependencies.cycle = workflows.dependency_cycle
        AND workflows.status = 'waiting'
      ORDER BY dependencies.resolved_at`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapDependency(row)).filter((dependency) => {
      const pending = this.db.query(`SELECT 1 FROM dependencies
        WHERE parent_workflow_id = ? AND cycle = ? AND status NOT IN ('resolved', 'abandoned') LIMIT 1`)
        .get(dependency.parentWorkflowId, dependency.cycle);
      return pending === null;
    });
  }

  markDependencyCycleResumed(workflowId: string, cycle: number): void {
    this.db.transaction(() => {
      this.db.query("UPDATE dependencies SET resume_dispatched_at = ? WHERE parent_workflow_id = ? AND cycle = ? AND status IN ('resolved', 'abandoned') AND resume_dispatched_at IS NULL")
        .run(now(), workflowId, cycle);
      this.activateWorkflowForResume(workflowId);
    })();
  }

  abandonDependency(dependencyId: string, reason: string): DependencyRecord {
    const dependency = this.getDependency(dependencyId);
    if (!["creating", "pending", "failed"].includes(dependency.status)) {
      throw new Error(`Only creating, pending, or failed dependencies can be abandoned; ${dependencyId} is ${dependency.status}`);
    }
    this.db.query("UPDATE dependencies SET status = 'abandoned', error = ?, updated_at = ? WHERE id = ?")
      .run(reason, now(), dependencyId);
    return this.getDependency(dependencyId);
  }

  attachDependencyIssue(dependencyId: string, issue: { number: number; url: string }): DependencyRecord {
    return this.db.transaction(() => {
      const dependency = this.getDependency(dependencyId);
      if (!["creating", "failed"].includes(dependency.status)) {
        throw new Error(`Only creating or failed dependencies can be attached; ${dependencyId} is ${dependency.status}`);
      }
      const workflow = this.getWorkflow(dependency.parentWorkflowId);
      if (workflow.status === "completed") throw new Error("Cannot attach a dependency to a completed workflow");
      const cycle = dependency.cycle || this.nextDependencyCycle(dependency.parentWorkflowId);
      this.db.query(`UPDATE dependencies SET target_issue_number = ?, target_issue_url = ?, status = 'pending', cycle = ?,
        error = NULL, updated_at = ? WHERE id = ?`)
        .run(issue.number, issue.url, cycle, now(), dependencyId);
      this.db.query("UPDATE workflows SET status = 'waiting', dependency_cycle = ?, updated_at = ? WHERE id = ?")
        .run(cycle, now(), dependency.parentWorkflowId);
      return this.getDependency(dependencyId);
    })();
  }

  stats(): Record<string, number> {
    const rows = this.db.query("SELECT status, COUNT(*) AS count FROM runs GROUP BY status").all() as Array<{ status: string; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }
}
