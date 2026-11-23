import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { LoadedConfig } from "./config.ts";
import { applyAgentCredentialWrappers, writeAgentCredentialWrappers } from "./credentials.ts";
import { buildAgentEnvironment, gitCredentialEnvironment } from "./github.ts";
import { AttemptRecorder, Logger, Redactor, atomicWrite, writeRunSummary } from "./observability.ts";
import { buildContext, renderTemplate, templateRoot } from "./rules.ts";
import { ProviderQuotaError, RuntimeExecutionError } from "./runtimes/types.ts";
import type { Store } from "./store.ts";
import type { AgentRuntime, JsonObject, RunRecord, WebhookContext } from "./types.ts";
import { compactError, errorMessage, id, sleep, stableStringify, withDeadline } from "./util.ts";
import { WorkspaceManager } from "./workspace.ts";

export interface TokenProvider {
  get(installationId: number, repositoryFullName: string, minimumLifetimeMs?: number): Promise<string>;
}

export interface RunGate {
  check(run: RunRecord): Promise<{ allowed: true } | { allowed: false; reason: string }>;
}

export interface WorkerPoolOptions {
  config: LoadedConfig;
  store: Store;
  runtimes: Map<string, AgentRuntime>;
  tokens: TokenProvider;
  logger: Logger;
  workspace?: WorkspaceManager;
  runGate?: RunGate;
}

const QUOTA_INITIAL_RETRY_DELAY_MS = 5 * 60 * 1000;
const QUOTA_MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

function quotaRetryDelayMs(attempt: number): number {
  const exponent = Math.min(4, Math.max(0, attempt - 1));
  return Math.min(QUOTA_MAX_RETRY_DELAY_MS, QUOTA_INITIAL_RETRY_DELAY_MS * 2 ** exponent);
}

function dependencyInstructions(targets: string[]): string {
  if (targets.length === 0) {
    return "No cross-repository dependency requests are allowed for this workflow. Do not create issues in other repositories, including upstream third-party libraries. " +
      "If a required change is outside the configured policy, stop and explain what configuration change is required.";
  }
  const list = targets.map((target) => `- \`${target}\``).join("\n");
  return `Cross-repository dependency requests are allowed only for:\n${list}\n` +
    "Do not request changes in any other repository, including upstream third-party libraries. If a required change is outside this list, stop and explain instead of creating an issue. " +
    "Only request changes needed to unblock the approved task; do not delegate the task itself. " +
    "If you need functionality from another repository, do not use GH_TOKEN for cross-repository access. " +
    "Instead, send a JSON POST to $GERRY_DEPENDENCY_URL with header `Authorization: Bearer $GERRY_AGENT_TOKEN`. " +
    "The JSON fields are `to`, `title`, `body`, and `requestKey`. Use a stable descriptive requestKey so retries are idempotent. " +
    "The broker returns the dependency issue URL only when the repository policy allows it. After requesting a required dependency, " +
    "summarize it and end your turn; the same workflow will resume after the dependency issue closes and its linked PR merges. " +
    "If a resolved dependency leaves a distinct remaining gap, request that gap with a new stable requestKey instead of repeating the resolved request.";
}

function buildPrompt(input: {
  instructions: string;
  task: string;
  context: WebhookContext;
  run: RunRecord;
  workspacePath: string;
  branch: string | null;
  contextPath: string;
  dependencyTargets: string[];
  reportsEnabled: boolean;
}): string {
  const subject = `${input.context.subject.type} #${input.context.subject.number}`;
  return `${input.instructions ? `# Agent instructions\n\n${input.instructions}\n\n` : ""}# Task\n\n${input.task}\n\n# Execution contract\n\n` +
    `- Run ID: \`${input.run.id}\`\n` +
    `- Repository: \`${input.context.repository}\`\n` +
    `- Subject: ${subject}${input.context.subject.url ? ` (${input.context.subject.url})` : ""}\n` +
    `- GitHub event: \`${input.context.event}.${input.context.action}\`\n` +
    `- Workspace: \`${input.workspacePath}\`\n` +
    `- Branch: ${input.branch ? `\`${input.branch}\`` : "shared checkout; do not create commits unless the task explicitly requires them"}\n` +
    `${input.run.workflowId ? `- Workflow: \`${input.run.workflowType}\` / \`${input.run.workflowId}\`\n` : ""}` +
    `- Complete webhook context: \`${input.contextPath}\`\n\n` +
    `Work only inside the assigned workspace. Use \`gh\` and Git normally for GitHub operations; ` +
    `Gerry obtains fresh repository credentials for each new command. Do not bypass the provided \`gh\` command or Git credential helper. ` +
    `Do not use \`gh auth token\` or override credentials with personal or stored credentials. ` +
    `Never print or persist credentials. Do not read or modify Gerry's own configuration, database, or data directory. ` +
    `Do not finish with tracked background jobs, including jobs left by earlier turns: await subagents and commands and consume their results. ` +
    `If an earlier review service is still tracked, stop it during the current turn and consume its completion report before restarting it. ` +
    (input.reportsEnabled
      ? `Publish HTML reports through Gerry instead of starting standalone or nohup HTTP servers. For each distinct report directory, choose a unique lowercase hyphenated publication name and send a JSON POST to $GERRY_REPORT_PUBLISH_URL with header \`Authorization: Bearer $GERRY_AGENT_TOKEN\` and fields \`name\` and \`directory\`. The directory is relative to the assigned workspace. Finish writing all report files before publishing; later source edits are not an atomic replacement. The response contains the public report URL; use that URL in comments and preserve its relative assets. To replace an existing publication name atomically, include \`replace: true\`; otherwise choose a new name. Report URLs are unpublished automatically when the PR closes or merges. `
      : `Start persistent review services only through a foreground launcher that detaches them with nohup and redirected stdin/stdout/stderr, so no tracked job can later wake this session. `) +
    `When writing a GitHub issue comment, PR comment, or review, append the hidden lineage marker ` +
    `\`<!-- gerry:run=${input.run.id} -->\` on its own line. ` +
    `If the task needs an operation outside your configured permissions, stop and explain what configuration change is required.` +
    `${input.run.workflowId ? `\n\n${dependencyInstructions(input.dependencyTargets)}` : ""}`;
}

export class WorkerPool {
  private readonly workspace: WorkspaceManager;
  private readonly workers: Promise<void>[] = [];
  private readonly shutdownController = new AbortController();
  private running = false;

  constructor(private readonly options: WorkerPoolOptions) {
    this.workspace = options.workspace ?? new WorkspaceManager(options.config);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const interrupted = this.options.store.recoverActiveRuns("Gerry restarted while this run was active; inspect GitHub and the worktree before retrying");
    if (interrupted > 0) this.options.logger.warn("runs.recovered", { interrupted });
    for (let index = 0; index < this.options.config.server.workers; index++) {
      this.workers.push(this.loop(id(`worker${index + 1}`)));
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.shutdownController.abort(new Error("Gerry is shutting down"));
    await Promise.allSettled(this.workers);
    this.running = false;
  }

  private async loop(workerId: string): Promise<void> {
    while (!this.shutdownController.signal.aborted) {
      try {
        const claimed = await this.runNext(workerId);
        if (!claimed) await sleep(250, this.shutdownController.signal);
      } catch (error) {
        if (this.shutdownController.signal.aborted) break;
        this.options.logger.error("worker.unexpected_error", { workerId, error: errorMessage(error) });
        await sleep(1000, this.shutdownController.signal).catch(() => undefined);
      }
    }
  }

  async runNext(workerId = id("manual-worker")): Promise<boolean> {
    const run = this.options.store.claimNext(workerId);
    if (!run) return false;
    await this.execute(run, workerId);
    return true;
  }

  private async execute(run: RunRecord, workerId: string): Promise<void> {
    const { store, config, logger } = this.options;
    const runDirectory = join(store.dataDirectory, "runs", run.id);
    const attemptDirectory = join(runDirectory, "attempts", String(run.attempt));
    let token: string | undefined;
    let capability: string | undefined;
    let runtimeStarted = false;
    let heartbeat: Timer | undefined;
    let recorder: AttemptRecorder | undefined;
    let credentialDirectory: string | undefined;
    let ghConfigDirectory: string | undefined;
    let sessionCompatibilityHash = "";
    try {
      logger.info("run.started", { runId: run.id, attempt: run.attempt, rule: run.ruleName, agent: run.agentName });
      heartbeat = setInterval(() => {
        try {
          store.heartbeat(run.id, workerId);
          writeRunSummary(store.dataDirectory, store.getRun(run.id));
        } catch (error) {
          logger.warn("run.heartbeat_failed", { runId: run.id, error: compactError(error) });
        }
      }, 15_000);
      const delivery = store.getDelivery(run.deliveryId);
      const payload = JSON.parse(readFileSync(delivery.payloadPath, "utf8")) as JsonObject;
      const context = buildContext({
        deliveryId: delivery.id,
        event: delivery.event,
        action: delivery.action,
        payload,
      });
      const rule = run.ruleSnapshot ?? config.rules.find((candidate) => candidate.name === run.ruleName);
      const agent = config.agents[run.agentName];
      const runtime = this.options.runtimes.get(run.runtimeName);
      if (!rule || !agent || !runtime) throw new Error("Run references configuration that is no longer available");
      sessionCompatibilityHash = createHash("sha256")
        .update(stableStringify({ runtime: config.runtimes[run.runtimeName], options: agent.options }))
        .digest("hex");
      if (run.configHash !== config.hash) throw new Error("Configuration changed after this run was queued; create a new delivery or retry with the original config");

      token = await withDeadline(
        this.options.tokens.get(run.installationId, run.repository, agent.timeout_seconds * 1000 + 60_000),
        30_000,
        "GitHub installation token acquisition timed out",
      );
      const existingWorkspace = run.workspacePath
        ? { workspacePath: run.workspacePath, branch: run.branch }
        : run.workflowId
          ? store.getWorkflow(run.workflowId)
          : run.conversationKey
            ? store.getConversationWorkspace(run.conversationKey)
            : null;
      const workspace = await this.workspace.prepare({
        runId: run.id,
        repository: run.repository,
        agent,
        conversationKey: run.conversationKey,
        workflowId: run.workflowId,
        existing: existingWorkspace,
        environment: gitCredentialEnvironment(token),
        signal: this.shutdownController.signal,
      });
      store.setWorkspace(run.id, workspace.workspacePath, workspace.branch, workerId);

      const contextPath = join(runDirectory, "context.json");
      atomicWrite(contextPath, `${JSON.stringify(context, null, 2)}\n`);
      const task = renderTemplate(run.promptSnapshot, templateRoot(
        context,
        run.id,
        workspace.workspacePath,
        run.workflowId ? { id: run.workflowId, type: run.workflowType! } : null,
      ));
      const instructions = run.instructionsSnapshot;
      const prompt = buildPrompt({
        instructions,
        task,
        context,
        run,
        workspacePath: workspace.workspacePath,
        branch: workspace.branch,
        contextPath,
        dependencyTargets: [...new Set(config.dependencies
          .filter((dependency) => dependency.from === run.repository && dependency.allow_issue_creation)
          .map((dependency) => dependency.to))].sort(),
        reportsEnabled: Boolean(config.reports && run.workflowId),
      });
      atomicWrite(join(runDirectory, "prompt.md"), prompt);

      capability = randomBytes(32).toString("base64url");
      const redactor = new Redactor([token, capability]);
      recorder = new AttemptRecorder(attemptDirectory, redactor);
      recorder.write("prompt.md", prompt);
      const environment = buildAgentEnvironment({
        agent,
        token,
        runId: run.id,
        repository: run.repository,
        workspacePath: workspace.workspacePath,
      });
      ghConfigDirectory = environment.GH_CONFIG_DIR;
      const brokerHost = ["0.0.0.0", "::", ""].includes(config.server.host) ? "127.0.0.1" : config.server.host;
      const credentialUrl = `http://${brokerHost}:${config.server.port}/agent/github/token`;
      const realGhPath = Bun.which("gh");
      if (!realGhPath) throw new Error("GitHub CLI is unavailable");
      credentialDirectory = this.workspace.temporaryDirectory(run.id);
      writeAgentCredentialWrappers({
        directory: credentialDirectory,
        runId: run.id,
        credentialUrl,
        realGhPath,
      });
      applyAgentCredentialWrappers(environment, credentialDirectory);
      environment.GERRY_AGENT_TOKEN = capability;
      store.setAgentCapability(run.id, createHash("sha256").update(capability).digest("hex"), workerId);
      recorder.emit({
        type: "runtime.credential_broker_environment",
        data: { url: credentialUrl, capabilityConfigured: true },
      });
      if (run.workflowId) {
        environment.GERRY_DEPENDENCY_URL = `http://${brokerHost}:${config.server.port}/agent/dependencies`;
        recorder.emit({
          type: "runtime.broker_environment",
          data: {
            url: environment.GERRY_DEPENDENCY_URL,
            capabilityConfigured: true,
          },
        });
      }
      if (config.reports && run.workflowId) {
        environment.GERRY_REPORT_PUBLISH_URL = `http://${brokerHost}:${config.server.port}/agent/reports/publish`;
        recorder.emit({
          type: "runtime.report_broker_environment",
          data: { url: environment.GERRY_REPORT_PUBLISH_URL, capabilityConfigured: true },
        });
      }
      const existingRuntimeSessionId = run.runtimeSessionId ?? (run.workflowId
        ? store.getWorkflowSession(run.workflowId, run.agentName, run.runtimeName, sessionCompatibilityHash)
        : run.conversationKey
          ? store.getConversationSession(run.conversationKey, run.agentName, run.runtimeName, sessionCompatibilityHash)
          : null);
      if (this.options.runGate) {
        const gate = await this.options.runGate.check(run);
        if (!gate.allowed) {
          const skipped = store.skipClaimed(run.id, workerId, gate.reason);
          logger.info("run.skipped", { runId: run.id, attempt: run.attempt, rule: run.ruleName, reason: gate.reason, status: skipped.status });
          return;
        }
      }
      store.markRunning(run.id, workerId);
      runtimeStarted = true;
      const result = await runtime.run({
        runId: run.id,
        agentName: run.agentName,
        options: agent.options,
        prompt,
        workspacePath: workspace.workspacePath,
        environment,
        existingSessionId: existingRuntimeSessionId,
        attemptDirectory,
        timeoutMs: agent.timeout_seconds * 1000,
        signal: this.shutdownController.signal,
        emit: (event) => recorder!.emit(event),
        onSession: (sessionId) => store.attachRuntimeSession(run.id, sessionId, null, sessionCompatibilityHash, workerId),
      });
      const responsePath = join(runDirectory, "response.md");
      atomicWrite(responsePath, redactor.text(result.response));
      store.succeed(run.id, workerId, {
        runtimeSessionId: result.sessionId,
        responsePath,
        usage: result.usage ?? null,
        sessionCompatibilityHash,
      });
      logger.info("run.succeeded", { runId: run.id, attempt: run.attempt, sessionId: result.sessionId });
    } catch (error) {
      if (error instanceof RuntimeExecutionError && error.details.sessionId) {
        store.attachRuntimeSession(run.id, error.details.sessionId, error.details.usage ?? null, sessionCompatibilityHash, workerId);
      }
      if (error instanceof RuntimeExecutionError && error.details.response) {
        const responsePath = join(runDirectory, "response.md");
        atomicWrite(responsePath, new Redactor([token, capability]).text(error.details.response));
      }
      const safeError = new Redactor([token, capability]).text(errorMessage(error));
      const quotaFailure = error instanceof ProviderQuotaError;
      const interrupted = this.shutdownController.signal.aborted ||
        (!quotaFailure && /timed out|abort/i.test(compactError(error)));
      const updated = store.fail(run.id, workerId, safeError, {
        retryable: !runtimeStarted || quotaFailure,
        ...(quotaFailure ? { retryDelayMs: quotaRetryDelayMs(run.attempt), ignoreAttemptLimit: true } : {}),
        interrupted,
        preserveLedger: runtimeStarted,
      });
      logger.error("run.failed", {
        runId: run.id,
        attempt: run.attempt,
        status: updated.status,
        retryable: updated.status === "retry_wait",
        ...(quotaFailure ? { retryReason: "provider_quota" } : {}),
        ...(updated.status === "retry_wait" ? { nextAttemptAt: new Date(updated.availableAt).toISOString() } : {}),
        error: safeError,
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      recorder?.emit({ type: "run.attempt.finished", data: { status: store.getRun(run.id).status } });
      if (credentialDirectory) {
        try {
          rmSync(credentialDirectory, { recursive: true, force: true });
        } catch (error) {
          logger.warn("credential.wrapper_cleanup_failed", { runId: run.id, error: compactError(error) });
        }
      }
      if (ghConfigDirectory) {
        try {
          rmSync(ghConfigDirectory, { recursive: true, force: true });
        } catch (error) {
          logger.warn("credential.gh_config_cleanup_failed", { runId: run.id, error: compactError(error) });
        }
      }
      writeRunSummary(store.dataDirectory, store.getRun(run.id));
    }
  }
}
