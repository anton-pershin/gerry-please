import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { DependencyConfig, LoadedConfig, RuleConfig } from "./config.ts";
import { readPrompt, resolveConfigPath } from "./config.ts";
import { Logger, atomicWrite } from "./observability.ts";
import { buildContext } from "./rules.ts";
import type { DependencyResolutionCandidate, MergeObservation, Store } from "./store.ts";
import type { DependencyRecord, JsonObject, RunRecord, WebhookContext } from "./types.ts";
import { compactError } from "./util.ts";

export const DEPENDENCY_READY_LABEL = "ready-for-human-approval";

const agentRequestSchema = z
  .object({
    to: z.string().regex(/^[^/]+\/[^/]+$/),
    title: z.string().min(1).max(256),
    body: z.string().max(60_000),
    requestKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  })
  .strict();

const agentCommentSchema = z
  .object({
    dependencyId: z.string().min(1),
    body: z.string().min(1).max(60_000),
  })
  .strict();

function issueLabelNames(issue: Record<string, unknown>): Set<string> {
  const labels = Array.isArray(issue.labels) ? issue.labels : [];
  return new Set(labels.flatMap((label) => {
    if (typeof label === "string") return [label];
    if (label && typeof label === "object" && typeof (label as { name?: unknown }).name === "string") {
      return [(label as { name: string }).name];
    }
    return [];
  }));
}

export interface DependencyTokenProvider {
  createIssue(repositoryFullName: string, title: string, body: string): Promise<{ number: number; url: string }>;
  getIssue(repositoryFullName: string, issueNumber: number): Promise<{ number: number; url: string; body: string; labels?: string[]; state?: string }>;
  createIssueComment?(repositoryFullName: string, issueNumber: number, body: string): Promise<{ id: number; url: string }>;
  updateIssueBody?(repositoryFullName: string, issueNumber: number, body: string): Promise<{ number: number; url: string }>;
  verifyIssueClosedByPullRequest(repositoryFullName: string, issueNumber: number, observation: MergeObservation): Promise<boolean>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function readLimited(request: Request, maximum: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new Error("Request body is too large");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Buffer.from(result).toString("utf8");
}

export class DependencyService {
  constructor(
    private readonly config: LoadedConfig,
    private readonly store: Store,
    private readonly tokens: DependencyTokenProvider,
    private readonly logger: Logger,
  ) {}

  async check(run: RunRecord): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    if (!run.allowWaiting) return { allowed: true };
    const dependency = this.discussionDependencyForRun(run);
    if (!dependency) return { allowed: false, reason: "Run is not a valid dependency-discussion turn" };
    return this.discussionGate(dependency);
  }

  private discussionDependencyForRun(run: RunRecord): DependencyRecord | null {
    if (!run.allowWaiting || !run.workflowId) return null;
    const delivery = this.store.getDelivery(run.deliveryId);
    const payload = JSON.parse(readFileSync(delivery.payloadPath, "utf8")) as JsonObject;
    const dependencyId = (payload.dependency as Record<string, unknown> | undefined)?.id;
    if (typeof dependencyId !== "string") return null;
    const dependency = this.store.getDependency(dependencyId);
    if (dependency.parentWorkflowId !== run.workflowId || dependency.createdByRunId !== run.parentRunId) return null;
    return dependency;
  }

  private dependencyStateGate(dependency: DependencyRecord): { allowed: false; reason: string } | null {
    const current = this.store.getDependency(dependency.id);
    const workflow = this.store.getWorkflow(current.parentWorkflowId);
    if (workflow.status !== "waiting") return { allowed: false, reason: "Parent workflow is no longer waiting for this dependency" };
    if (current.status !== "pending") return { allowed: false, reason: `Dependency is ${current.status}` };
    if (!current.targetIssueNumber) return { allowed: false, reason: "Dependency has no target issue" };
    return null;
  }

  private async discussionGate(dependency: DependencyRecord): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const before = this.dependencyStateGate(dependency);
    if (before) return before;
    const issue = await this.tokens.getIssue(dependency.targetRepository, dependency.targetIssueNumber!);
    const after = this.dependencyStateGate(dependency);
    if (after) return after;
    if (issue.state === "closed") return { allowed: false, reason: "Dependency issue is closed" };
    const labels = new Set(issue.labels ?? []);
    if (labels.has(DEPENDENCY_READY_LABEL)) return { allowed: false, reason: "Dependency discussion is ready for human approval" };
    if (labels.has("approved")) return { allowed: false, reason: "Dependency issue is already approved" };
    return { allowed: true };
  }

  async handleAgentRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return json({ error: "Missing agent capability" }, 401);
    const capability = authorization.slice("Bearer ".length);
    const capabilityHash = createHash("sha256").update(capability).digest("hex");
    const run = this.store.getRunByAgentCapability(capabilityHash);
    if (!run) return json({ error: "Invalid or expired agent capability" }, 401);
    if (!run.workflowId) return json({ error: "Dependencies are only available to workflow runs" }, 403);

    let input: z.infer<typeof agentRequestSchema>;
    try {
      input = agentRequestSchema.parse(JSON.parse(await readLimited(request, 64 * 1024)));
    } catch (error) {
      return json({ error: `Invalid dependency request: ${compactError(error)}` }, 400);
    }
    return this.requestDependency(run.id, input);
  }

  async handleAgentComment(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return json({ error: "Missing agent capability" }, 401);
    const capability = authorization.slice("Bearer ".length);
    const capabilityHash = createHash("sha256").update(capability).digest("hex");
    const run = this.store.getRunByAgentCapability(capabilityHash);
    if (!run) return json({ error: "Invalid or expired agent capability" }, 401);
    if (!run.workflowId) return json({ error: "Dependency comments are only available to workflow runs" }, 403);

    let input: z.infer<typeof agentCommentSchema>;
    try {
      input = agentCommentSchema.parse(JSON.parse(await readLimited(request, 64 * 1024)));
    } catch (error) {
      return json({ error: `Invalid dependency comment request: ${compactError(error)}` }, 400);
    }
    const dependency = this.discussionDependencyForRun(run);
    if (!dependency || dependency.id !== input.dependencyId) return json({ error: "Run is not a discussion turn for this dependency" }, 403);
    if (!this.discussionPolicy(dependency)) return json({ error: "Dependency discussion is not configured" }, 403);
    if (!this.tokens.createIssueComment) return json({ error: "Dependency comments are not supported by this token provider" }, 501);

    try {
      const gate = await this.discussionGate(dependency);
      if (!gate.allowed) return json({ error: gate.reason }, 409);
      const comment = await this.tokens.createIssueComment(
        dependency.targetRepository,
        dependency.targetIssueNumber!,
        `${input.body}\n\n<!-- gerry:run=${run.id} -->\n<!-- gerry:dependency-comment=${dependency.id} -->\n`,
      );
      this.logger.info("dependency.comment_created", {
        dependencyId: dependency.id,
        workflowId: run.workflowId,
        runId: run.id,
        commentId: comment.id,
      });
      return json({ ok: true, dependencyId: dependency.id, comment }, 201);
    } catch (error) {
      const message = compactError(error);
      this.logger.warn("dependency.comment_failed", { dependencyId: dependency.id, runId: run.id, error: message });
      return json({ error: "Dependency comment failed; inspect the issue before retrying", detail: message }, 502);
    }
  }

  async handleAgentIssueUpdate(request: Request): Promise<Response> {
    if (request.method !== "PATCH") return json({ error: "Method not allowed" }, 405);
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return json({ error: "Missing agent capability" }, 401);
    const capability = authorization.slice("Bearer ".length);
    const capabilityHash = createHash("sha256").update(capability).digest("hex");
    const run = this.store.getRunByAgentCapability(capabilityHash);
    if (!run) return json({ error: "Invalid or expired agent capability" }, 401);
    if (!run.workflowId) return json({ error: "Dependency issue updates are only available to workflow runs" }, 403);

    let input: z.infer<typeof agentCommentSchema>;
    try {
      input = agentCommentSchema.parse(JSON.parse(await readLimited(request, 64 * 1024)));
    } catch (error) {
      return json({ error: `Invalid dependency issue update request: ${compactError(error)}` }, 400);
    }
    const dependency = this.discussionDependencyForRun(run);
    if (!dependency || dependency.id !== input.dependencyId) return json({ error: "Run is not a discussion turn for this dependency" }, 403);
    if (!this.discussionPolicy(dependency)) return json({ error: "Dependency discussion is not configured" }, 403);
    if (!this.tokens.updateIssueBody) return json({ error: "Dependency issue updates are not supported by this token provider" }, 501);

    try {
      const gate = await this.discussionGate(dependency);
      if (!gate.allowed) return json({ error: gate.reason }, 409);
      const marker = `<!-- gerry:dependency=${Buffer.from(JSON.stringify({
        id: dependency.id,
        workflow: run.workflowId,
      })).toString("base64url")} -->`;
      const requirements = input.body.replace(/<!--\s*gerry:dependency=[^>]+-->/g, "").trimEnd();
      const body = `${requirements}\n\n${marker}\n`;
      const issue = await this.tokens.updateIssueBody(dependency.targetRepository, dependency.targetIssueNumber!, body);
      this.logger.info("dependency.issue_updated", {
        dependencyId: dependency.id,
        workflowId: run.workflowId,
        runId: run.id,
        issue: issue.url,
      });
      return json({ ok: true, dependencyId: dependency.id, issue }, 200);
    } catch (error) {
      const message = compactError(error);
      this.logger.warn("dependency.issue_update_failed", { dependencyId: dependency.id, runId: run.id, error: message });
      return json({ error: "Dependency issue update failed; inspect the issue before retrying", detail: message }, 502);
    }
  }

  async requestDependency(runId: string, input: z.infer<typeof agentRequestSchema>): Promise<Response> {
    const run = this.store.getRun(runId);
    if (!run.workflowId) return json({ error: "Run is not associated with a workflow" }, 409);
    const policy = this.config.dependencies.find((candidate) => candidate.from === run.repository && candidate.to === input.to);
    if (!policy) return json({ error: `Dependency policy does not allow ${run.repository} → ${input.to}` }, 403);
    if (!policy.allow_issue_creation) return json({ error: "Issue creation is disabled for this dependency policy" }, 403);
    if (policy.resume && run.workflowType !== policy.resume.workflow) {
      return json({ error: `Dependency resume workflow ${policy.resume.workflow} does not match ${run.workflowType}` }, 409);
    }

    const request = this.store.beginDependencyRequest({
      parentWorkflowId: run.workflowId,
      parentRepository: run.repository,
      targetRepository: input.to,
      requestKey: input.requestKey,
      title: input.title,
      body: input.body,
      createdByRunId: run.id,
    });
    if (!request.created) {
      const dependency = request.dependency;
      if (dependency.targetIssueUrl) {
        return json({
          ok: true,
          idempotent: true,
          dependencyId: dependency.id,
          issue: { number: dependency.targetIssueNumber, url: dependency.targetIssueUrl },
          status: dependency.status,
        });
      }
      return json({
        error: "An earlier request reached an ambiguous state; inspect it before retrying",
        dependencyId: dependency.id,
        status: dependency.status,
        detail: dependency.error,
      }, 409);
    }

    const marker = `<!-- gerry:dependency=${Buffer.from(JSON.stringify({
      id: request.dependency.id,
      workflow: run.workflowId,
    })).toString("base64url")} -->`;
    try {
      const issue = await this.tokens.createIssue(input.to, input.title, `${input.body}\n\n${marker}\n`);
      const dependency = this.store.finishDependencyRequest(request.dependency.id, issue);
      this.logger.info("dependency.created", {
        dependencyId: dependency.id,
        workflowId: run.workflowId,
        from: run.repository,
        to: input.to,
        issue: issue.url,
      });
      return json({
        ok: true,
        dependencyId: dependency.id,
        issue,
        status: dependency.status,
        message: "Dependency recorded. End this turn; the workflow resumes after the issue closes and its linked PR merges.",
      }, 201);
    } catch (error) {
      const message = compactError(error);
      this.store.failDependencyRequest(request.dependency.id, message);
      this.logger.error("dependency.creation_failed", {
        dependencyId: request.dependency.id,
        workflowId: run.workflowId,
        error: message,
      });
      return json({ error: "Dependency issue creation failed; inspect before retrying", dependencyId: request.dependency.id }, 502);
    }
  }

  async attachDependencyIssue(dependencyId: string, issueNumber: number): Promise<DependencyRecord> {
    const dependency = this.store.getDependency(dependencyId);
    const issue = await this.tokens.getIssue(dependency.targetRepository, issueNumber);
    const markers = [...issue.body.matchAll(/<!--\s*gerry:dependency=([A-Za-z0-9_-]+)\s*-->/g)];
    const matched = markers.some((match) => {
      try {
        const metadata = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")) as { id?: string; workflow?: string };
        return metadata.id === dependency.id && metadata.workflow === dependency.parentWorkflowId;
      } catch {
        return false;
      }
    });
    if (!matched) throw new Error(`Issue ${issue.url} does not contain the expected dependency marker`);
    return this.store.attachDependencyIssue(dependencyId, { number: issue.number, url: issue.url });
  }

  async track(context: WebhookContext): Promise<void> {
    await this.dispatchDiscussion(context);
    const linked = this.store.linkWorkflowPullRequest(context);
    if (linked) {
      this.logger.info("workflow.pull_request_linked", {
        workflowId: linked.id,
        repository: context.repository,
        pullRequest: linked.pullRequestNumber,
        status: linked.status,
      });
    }
    const candidates = [
      ...this.store.recordDependencyIssueClosed(context),
      ...this.store.recordDependencyPullRequestMerged(
        context,
        this.config.repositories[context.repository]!.default_branch,
      ),
    ];
    await this.verifyAndResolve(candidates);
    await this.resumeResolvedDependencies();
  }

  private async verifyAndResolve(candidates: DependencyResolutionCandidate[]): Promise<void> {
    const examined = new Set<string>();
    for (const candidate of candidates) {
      const key = `${candidate.dependency.id}:${candidate.observation.mergeCommitSha}`;
      if (examined.has(key)) continue;
      examined.add(key);
      const issueNumber = candidate.dependency.targetIssueNumber;
      if (!issueNumber) continue;
      try {
        const verified = await this.tokens.verifyIssueClosedByPullRequest(
          candidate.dependency.targetRepository,
          issueNumber,
          candidate.observation,
        );
        if (!verified) {
          this.logger.debug("dependency.closure_not_verified", {
            dependencyId: candidate.dependency.id,
            mergeCommitSha: candidate.observation.mergeCommitSha,
          });
          continue;
        }
        const dependency = this.store.markDependencyResolved(candidate.dependency.id, candidate.observation);
        if (dependency) {
          this.logger.info("dependency.resolved", {
            dependencyId: dependency.id,
            workflowId: dependency.parentWorkflowId,
            issue: dependency.targetIssueUrl,
            pullRequest: dependency.targetPrUrl,
            mergeCommitSha: dependency.mergeCommitSha,
          });
        }
      } catch (error) {
        this.logger.warn("dependency.verification_failed", {
          dependencyId: candidate.dependency.id,
          error: compactError(error),
        });
      }
    }
  }

  async recover(): Promise<number> {
    await this.verifyAndResolve(this.store.listDependencyResolutionCandidates());
    return this.resumeResolvedDependencies();
  }

  private async dispatchDiscussion(context: WebhookContext): Promise<void> {
    if (context.event !== "issue_comment" || context.action !== "created" || context.subject.type !== "issue") return;
    const issue = context.payload.issue as Record<string, unknown>;
    const comment = context.payload.comment as Record<string, unknown> | undefined;
    const body = typeof comment?.body === "string" ? comment.body : "";
    if (!body.toLocaleLowerCase().includes("@implementer") || body.includes("<!-- gerry:dependency-comment=")) return;
    const labels = issueLabelNames(issue);
    if (labels.has(DEPENDENCY_READY_LABEL) || labels.has("approved")) return;
    const commentId = Number(comment?.id);
    if (!Number.isInteger(commentId) || commentId <= 0) return;
    const dependency = this.store.findPendingDependencyForIssue(context.repository, context.subject.number);
    if (!dependency) return;
    const discussion = this.discussionPolicy(dependency);
    if (!discussion) return;
    const workflow = this.store.getWorkflow(dependency.parentWorkflowId);
    if (workflow.type !== discussion.workflow || workflow.status !== "waiting") return;
    const agent = this.config.agents[discussion.agent];
    if (!agent) throw new Error(`Dependency discussion agent is not configured: ${discussion.agent}`);
    const creator = this.store.getRun(dependency.createdByRunId);
    if (creator.agentName !== discussion.agent || creator.runtimeName !== agent.runtime) {
      this.logger.error("dependency.discussion_agent_mismatch", {
        dependencyId: dependency.id,
        workflowId: workflow.id,
        creatorAgent: creator.agentName,
        configuredAgent: discussion.agent,
      });
      return;
    }

    const deliveryId = `gerry-dependency-discussion-${dependency.id}-${commentId}`;
    const payload: JsonObject = {
      action: "discussion",
      installation: { id: workflow.installationId },
      repository: { full_name: workflow.repository },
      issue: {
        number: workflow.originSubjectNumber,
        title: `Implementation workflow ${workflow.id}`,
        body: "",
      },
      dependency,
      discussion: {
        commentId,
        body,
        author: typeof (context.payload.sender as Record<string, unknown> | undefined)?.login === "string"
          ? (context.payload.sender as Record<string, unknown>).login
          : "unknown",
        issueNumber: dependency.targetIssueNumber,
        issueUrl: dependency.targetIssueUrl,
        issueTitle: typeof issue.title === "string" ? issue.title : dependency.title,
        issueBody: typeof issue.body === "string" ? issue.body : dependency.body,
      },
      workflow: { id: workflow.id, type: workflow.type, dependencyCycle: dependency.cycle },
    };
    const payloadPath = join(this.store.deliveriesDirectory, `${deliveryId}.json`);
    if (!this.store.hasDelivery(deliveryId)) {
      atomicWrite(payloadPath, `${JSON.stringify(payload, null, 2)}\n`);
      this.store.insertDelivery({
        id: deliveryId,
        event: "dependency",
        action: "discussion",
        repository: workflow.repository,
        installationId: workflow.installationId,
        payloadPath,
      });
    }
    const internalContext = buildContext({ deliveryId, event: "dependency", action: "discussion", payload });
    const prompt = readPrompt(this.config, discussion.prompt);
    const rule: RuleConfig = {
      name: `dependency-discussion-${dependency.id}-${commentId}`,
      enabled: true,
      on: { event: "dependency", actions: ["discussion"] },
      when: [],
      agent: discussion.agent,
      prompt: discussion.prompt,
      session: "workflow",
      workflow: discussion.workflow,
      workflow_start: false,
      max_turns: discussion.max_turns,
      once_per_subject: false,
    };
    const decision = this.store.enqueueRun({
      context: internalContext,
      rule,
      agent,
      agentName: discussion.agent,
      runtimeName: agent.runtime,
      runtime: this.config.runtimes[agent.runtime]!,
      promptPath: prompt.path,
      promptHash: prompt.hash,
      promptContents: prompt.contents,
      instructions: agent.instructions ? readFileSync(resolveConfigPath(this.config.baseDir, agent.instructions), "utf8") : "",
      configHash: this.config.hash,
      parentRunId: dependency.createdByRunId,
      workflowId: workflow.id,
      allowWaiting: true,
    });
    const existingRun = decision.runId ? this.store.getRun(decision.runId) : null;
    const discussionExists = decision.decision === "queued" || (
      decision.decision === "duplicate" && existingRun !== null &&
      ["queued", "preparing", "running", "retry_wait", "succeeded"].includes(existingRun.status)
    );
    this.store.setDeliveryStatus(deliveryId, discussionExists ? "completed" : "dispatch_failed", discussionExists ? null : decision.reason);
    this.logger.info("dependency.discussion_dispatched", {
      dependencyId: dependency.id,
      workflowId: workflow.id,
      commentId,
      decision: decision.decision,
      runId: decision.runId,
      reason: decision.reason,
    });
  }

  private async resumeResolvedDependencies(): Promise<number> {
    let queued = 0;
    const awaiting = this.store.dependenciesAwaitingResume();
    const handledWorkflows = new Set<string>();
    for (const candidate of awaiting) {
      if (handledWorkflows.has(candidate.parentWorkflowId)) continue;
      handledWorkflows.add(candidate.parentWorkflowId);
      const siblings = awaiting.filter((dependency) => dependency.parentWorkflowId === candidate.parentWorkflowId);
      const dependency = siblings.find((entry) => entry.status === "resolved" && entry.mergeCommitSha && this.resumePolicy(entry)) ??
        siblings.find((entry) => this.resumePolicy(entry)) ?? candidate;
      const resume = this.resumePolicy(dependency);
      if (!resume) {
        this.logger.warn("dependency.resume_not_configured", {
          dependencyId: dependency.id,
          workflowId: dependency.parentWorkflowId,
        });
        continue;
      }
      const workflow = this.store.getWorkflow(dependency.parentWorkflowId);
      if (workflow.type !== resume.workflow) {
        this.logger.error("dependency.resume_type_mismatch", {
          dependencyId: dependency.id,
          expected: resume.workflow,
          actual: workflow.type,
        });
        continue;
      }
      const agent = this.config.agents[resume.agent];
      if (!agent) {
        this.logger.error("dependency.resume_agent_missing", { dependencyId: dependency.id, agent: resume.agent });
        continue;
      }
      const deliveryId = `gerry-dependency-${workflow.id}-cycle-${dependency.cycle}`;
      const payloadPath = join(this.store.deliveriesDirectory, `${deliveryId}.json`);
      const payload = this.syntheticPayload(dependency);
      if (!this.store.hasDelivery(deliveryId)) {
        atomicWrite(payloadPath, `${JSON.stringify(payload, null, 2)}\n`);
        this.store.insertDelivery({
          id: deliveryId,
          event: "dependency",
          action: "resolved",
          repository: workflow.repository,
          installationId: workflow.installationId,
          payloadPath,
        });
      }
      const context = buildContext({ deliveryId, event: "dependency", action: "resolved", payload });
      const prompt = readPrompt(this.config, resume.prompt);
      const rule: RuleConfig = {
        name: `dependency-resume-${workflow.id}-cycle-${dependency.cycle}`,
        enabled: true,
        on: { event: "dependency", actions: ["resolved"] },
        when: [],
        agent: resume.agent,
        prompt: resume.prompt,
        session: "workflow",
        workflow: resume.workflow,
        workflow_start: false,
        max_turns: resume.max_turns,
        once_per_subject: false,
      };
      const decision = this.store.enqueueRun({
        context,
        rule,
        agent,
        agentName: resume.agent,
        runtimeName: agent.runtime,
        runtime: this.config.runtimes[agent.runtime]!,
        promptPath: prompt.path,
        promptHash: prompt.hash,
        promptContents: prompt.contents,
        instructions: agent.instructions ? readFileSync(resolveConfigPath(this.config.baseDir, agent.instructions), "utf8") : "",
        configHash: this.config.hash,
        parentRunId: dependency.createdByRunId,
        workflowId: workflow.id,
        resumeWorkflow: true,
      });
      const existingRun = decision.runId ? this.store.getRun(decision.runId) : null;
      const resumeExists = decision.decision === "queued" || (
        decision.decision === "duplicate" && existingRun !== null &&
        ["queued", "preparing", "running", "retry_wait", "succeeded"].includes(existingRun.status)
      );
      if (resumeExists) {
        this.store.markDependencyCycleResumed(workflow.id, dependency.cycle);
        this.store.setDeliveryStatus(deliveryId, "completed");
        if (decision.decision === "queued") queued += 1;
      } else {
        this.store.setDeliveryStatus(deliveryId, "dispatch_failed", decision.reason);
      }
      this.logger.info("dependency.resume_dispatched", {
        dependencyId: dependency.id,
        workflowId: workflow.id,
        decision: decision.decision,
        runId: decision.runId,
        reason: decision.reason,
      });
    }
    return queued;
  }

  private resumePolicy(dependency: DependencyRecord): DependencyConfig["resume"] | undefined {
    return this.config.dependencies.find(
      (candidate) => candidate.from === dependency.parentRepository && candidate.to === dependency.targetRepository,
    )?.resume;
  }

  private discussionPolicy(dependency: DependencyRecord): DependencyConfig["discussion"] | undefined {
    return this.config.dependencies.find(
      (candidate) => candidate.from === dependency.parentRepository && candidate.to === dependency.targetRepository,
    )?.discussion;
  }

  private syntheticPayload(dependency: DependencyRecord): JsonObject {
    const workflow = this.store.getWorkflow(dependency.parentWorkflowId);
    const dependencies = this.store.listWorkflowDependencies(workflow.id, dependency.cycle);
    const payload: JsonObject = {
      action: "resolved",
      installation: { id: workflow.installationId },
      repository: { full_name: workflow.repository },
      dependency,
      dependencies,
      workflow: { id: workflow.id, type: workflow.type, dependencyCycle: dependency.cycle },
    };
    if (workflow.pullRequestNumber) {
      payload.pull_request = {
        number: workflow.pullRequestNumber,
        title: `Implementation for ${workflow.type} #${workflow.originSubjectNumber}`,
        body: "",
        html_url: workflow.pullRequestUrl,
        head: { ref: workflow.branch },
      };
    } else {
      payload.issue = {
        number: workflow.originSubjectNumber,
        title: `Implementation workflow ${workflow.id}`,
        body: "",
      };
    }
    return payload;
  }
}
