import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEPENDENCY_READY_LABEL, DependencyService } from "../src/dependencies.ts";
import { Logger } from "../src/observability.ts";
import { buildContext } from "../src/rules.ts";
import { Store } from "../src/store.ts";
import type { AgentRuntime, JsonObject, RuntimeRunInput, WebhookContext } from "../src/types.ts";
import { WorkerPool } from "../src/worker.ts";
import { issuePayload } from "./helpers.ts";
import { enqueueWorkflow, initializeOrigin, issueContext, prContext, workflowConfigFixture } from "./workflow-helpers.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function dependencyIssueClosed(number: number, deliveryId: string, closedAt?: string): WebhookContext {
  const payload = issuePayload("closed");
  payload.installation = { id: 5678 };
  (payload.repository as Record<string, unknown>).full_name = "acme/library";
  (payload.issue as Record<string, unknown>).number = number;
  (payload.issue as Record<string, unknown>).state_reason = "completed";
  if (closedAt) (payload.issue as Record<string, unknown>).closed_at = closedAt;
  return buildContext({ deliveryId, event: "issues", action: "closed", payload });
}

function dependencyPrMerged(number: number, deliveryId: string, mergeCommitSha?: string, baseRef?: string): WebhookContext {
  return prContext({
    number: 900 + number,
    branch: `dependency-${number}`,
    deliveryId,
    event: "pull_request",
    action: "closed",
    body: `Implement the dependency. Closes #${number}`,
    merged: true,
    repository: "acme/library",
    installationId: 5678,
    ...(mergeCommitSha ? { mergeCommitSha } : {}),
    ...(baseRef ? { baseRef } : {}),
  });
}

function dependencyIssueComment(
  number: number,
  deliveryId: string,
  input: { id: number; body: string; labels?: string[] },
): WebhookContext {
  const payload = issuePayload("created");
  payload.installation = { id: 5678 };
  (payload.repository as Record<string, unknown>).full_name = "acme/library";
  (payload.issue as Record<string, unknown>).number = number;
  (payload.issue as Record<string, unknown>).labels = (input.labels ?? []).map((name) => ({ name }));
  payload.comment = { id: input.id, body: input.body };
  payload.sender = { login: "alice" };
  return buildContext({ deliveryId, event: "issue_comment", action: "created", payload });
}

async function dependencyDiscussionSetup(discussionAgent?: string, onIssueLookup?: () => void) {
  const fixture = workflowConfigFixture(true);
  if (discussionAgent) {
    fixture.config.agents[discussionAgent] = { ...fixture.config.agents.implementer! };
    fixture.config.dependencies[0]!.discussion!.agent = discussionAgent;
  }
  directories.push(fixture.directory);
  initializeOrigin(fixture.directory);
  const store = new Store(fixture.config.dataDir);
  const labels: string[] = [];
  const comments: Array<{ body: string }> = [];
  const updates: Array<{ body: string }> = [];
  const service = new DependencyService(
    fixture.config,
    store,
    {
      createIssue: async (repository) => ({ number: 456, url: `https://github.com/${repository}/issues/456` }),
      getIssue: async (repository) => {
        onIssueLookup?.();
        return { number: 456, url: `https://github.com/${repository}/issues/456`, body: "Requirements", labels };
      },
      createIssueComment: async (_repository, _issueNumber, body) => {
        comments.push({ body });
        return { id: 987, url: "https://github.com/acme/library/issues/456#issuecomment-987" };
      },
      updateIssueBody: async (repository, _issueNumber, body) => {
        updates.push({ body });
        return { number: 456, url: `https://github.com/${repository}/issues/456` };
      },
      verifyIssueClosedByPullRequest: async () => true,
    },
    new Logger(join(fixture.config.dataDir, "service.jsonl"), undefined, false),
  );
  const inputs: RuntimeRunInput[] = [];
  const runtime: AgentRuntime = {
    type: "hermes",
    check: async () => {},
    run: async (input) => {
      inputs.push(input);
      return { sessionId: "parent-session", response: "continued" };
    },
  };
  const workers = new WorkerPool({
    config: fixture.config,
    store,
    runtimes: new Map([["hermes", runtime]]),
    tokens: { get: async () => "token" },
    logger: new Logger(join(fixture.config.dataDir, "worker.jsonl"), undefined, false),
    runGate: service,
  });
  enqueueWorkflow(store, fixture, issueContext(), "implement-approved-issue");
  await workers.runNext("worker-parent");
  const parentRun = store.listRuns(1)[0]!;
  const workflow = store.getWorkflow(parentRun.workflowId!);
  const response = await service.requestDependency(parentRun.id, {
    to: "acme/library",
    title: "Required API",
    body: "Please provide the required API",
    requestKey: "discussion-api",
  });
  expect(response.status).toBe(201);
  expect(store.getWorkflow(workflow.id).status).toBe("waiting");
  return { fixture, store, service, workflow, parentRun, workers, inputs, labels, comments, updates };
}

describe("cross-repository dependencies", () => {
  test("brokers idempotent requests and resumes only after all dependencies close via merged PRs", async () => {
    const fixture = workflowConfigFixture(true);
    directories.push(fixture.directory);
    initializeOrigin(fixture.directory);
    const store = new Store(fixture.config.dataDir);
    const created: Array<{ repository: string; title: string; body: string }> = [];
    const service = new DependencyService(
      fixture.config,
      store,
      {
        createIssue: async (repository, title, body) => {
          created.push({ repository, title, body });
          const number = 455 + created.length;
          return { number, url: `https://github.com/${repository}/issues/${number}` };
        },
        getIssue: async () => { throw new Error("not used"); },
        verifyIssueClosedByPullRequest: async () => true,
      },
      new Logger(join(fixture.config.dataDir, "service.jsonl"), undefined, false),
    );

    const start = enqueueWorkflow(store, fixture, issueContext(), "implement-approved-issue");
    const claimed = store.claimNext("worker-1")!;
    const workflowId = store.getRun(start.runId!).workflowId!;
    const workflow = store.getWorkflow(workflowId);
    const capability = "test-agent-capability";
    store.setAgentCapability(claimed.id, createHash("sha256").update(capability).digest("hex"), "worker-1");
    const review = prContext({ number: 100, branch: workflow.branch!, deliveryId: "waiting-review" });
    store.linkWorkflowPullRequest(review);
    enqueueWorkflow(store, fixture, review, "address-pr-review");

    const request = (body: JsonObject) => new Request("http://localhost/agent/dependencies", {
      method: "POST",
      headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const first = await service.handleAgentRequest(request({
      to: "acme/library",
      title: "Add required API",
      body: "The parent workflow needs this API",
      requestKey: "required-api",
    }));
    expect(first.status).toBe(201);
    const second = await service.handleAgentRequest(request({
      to: "acme/library",
      title: "Add second API",
      body: "Another independent requirement",
      requestKey: "second-api",
    }));
    expect(second.status).toBe(201);
    expect(created).toHaveLength(2);
    expect(created[0]!.body).toContain("gerry:dependency=");

    const repeated = await service.handleAgentRequest(request({
      to: "acme/library",
      title: "Add required API",
      body: "The parent workflow needs this API",
      requestKey: "required-api",
    }));
    expect(repeated.status).toBe(200);
    expect(created).toHaveLength(2);
    const denied = await service.handleAgentRequest(request({
      to: "acme/other",
      title: "Not allowed",
      body: "",
      requestKey: "denied",
    }));
    expect(denied.status).toBe(403);

    store.succeed(claimed.id, "worker-1", { runtimeSessionId: "parent-session", responsePath: "/tmp/parent", usage: null });
    expect(store.getWorkflow(workflowId).status).toBe("waiting");
    expect(store.claimNext("worker-2")).toBeNull();

    await service.track(dependencyIssueClosed(456, "dep-456-closed"));
    expect(store.listDependencies().find((dependency) => dependency.targetIssueNumber === 456)?.status).toBe("pending");
    expect(store.listRuns(20).filter((run) => run.ruleName.startsWith("dependency-resume"))).toHaveLength(0);
    await service.track(dependencyPrMerged(456, "dep-456-merged"));
    expect(store.listRuns(20).filter((run) => run.ruleName.startsWith("dependency-resume"))).toHaveLength(0);
    expect(store.getWorkflow(workflowId).status).toBe("waiting");

    await service.track(dependencyPrMerged(457, "dep-457-merged"));
    expect(store.getDependency(store.listDependencies().find((dependency) => dependency.targetIssueNumber === 457)!.id).status).toBe("pending");
    await service.track(dependencyIssueClosed(457, "dep-457-closed"));

    const resumes = store.listRuns(20).filter((run) => run.ruleName.startsWith("dependency-resume"));
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.workflowId).toBe(workflowId);
    expect(store.getWorkflow(workflowId).status).toBe("active");
    expect(store.listWorkflowDependencies(workflowId).every((dependency) => dependency.status === "resolved")).toBe(true);
    expect(await service.recover()).toBe(0);
    expect(store.listRuns(20).filter((run) => run.ruleName.startsWith("dependency-resume"))).toHaveLength(1);

    const followUpResponses: Response[] = [];
    const inputs: RuntimeRunInput[] = [];
    const runtime: AgentRuntime = {
      type: "hermes",
      check: async () => {},
      run: async (input) => {
        inputs.push(input);
        if (input.runId === resumes[0]!.id) {
          const url = input.environment.GERRY_DEPENDENCY_URL;
          const capability = input.environment.GERRY_AGENT_TOKEN;
          expect(url).toContain("/agent/dependencies");
          expect(capability).toBeDefined();
          followUpResponses.push(await service.handleAgentRequest(new Request(url!, {
            method: "POST",
            headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
            body: JSON.stringify({
              to: "acme/library",
              title: "Third API",
              body: "The merged dependency left a distinct remaining gap",
              requestKey: "third-api",
            }),
          })));
        }
        return { sessionId: "parent-session", response: "resumed" };
      },
    };
    const workers = new WorkerPool({
      config: fixture.config,
      store,
      runtimes: new Map([["hermes", runtime]]),
      tokens: { get: async () => "token" },
      logger: new Logger(join(fixture.config.dataDir, "worker.jsonl"), undefined, false),
    });
    for (let index = 0; index < 3 && store.getRun(resumes[0]!.id).status !== "succeeded"; index += 1) {
      await workers.runNext("worker-resume");
    }
    expect(store.getRun(resumes[0]!.id).status).toBe("succeeded");
    expect(followUpResponses.map((response) => response.status)).toEqual([201]);
    const nextCycle = store.listWorkflowDependencies(workflowId).find((dependency) => dependency.requestKey === "third-api")!;
    expect(nextCycle.cycle).toBe(2);
    expect(nextCycle.createdByRunId).toBe(resumes[0]!.id);
    expect(store.getWorkflow(workflowId).status).toBe("waiting");

    await service.track(dependencyIssueClosed(458, "dep-458-closed"));
    await service.track(dependencyPrMerged(458, "dep-458-merged"));
    const allResumes = store.listRuns(20).filter((run) => run.ruleName.startsWith("dependency-resume"));
    expect(allResumes).toHaveLength(2);
    const secondResume = allResumes.find((run) => run.ruleName.endsWith("cycle-2"))!;
    for (let index = 0; index < 3 && store.getRun(secondResume.id).status !== "succeeded"; index += 1) {
      await workers.runNext("worker-resume");
    }
    expect(store.listRuns(20).filter((run) => run.ruleName.startsWith("dependency-resume") && run.status === "succeeded")).toHaveLength(2);
    expect(inputs.find((input) => input.runId === secondResume.id)?.prompt).toContain("458");
    store.close();
  });

  test("does not treat an old manual issue closure as closure via a later merge", () => {
    const fixture = workflowConfigFixture(true);
    directories.push(fixture.directory);
    const store = new Store(fixture.config.dataDir);
    const start = enqueueWorkflow(store, fixture, issueContext(), "implement-approved-issue");
    const run = store.getRun(start.runId!);
    const request = store.beginDependencyRequest({
      parentWorkflowId: run.workflowId!,
      parentRepository: run.repository,
      targetRepository: "acme/library",
      requestKey: "old-close",
      title: "Dependency",
      body: "Dependency body",
      createdByRunId: run.id,
    });
    store.finishDependencyRequest(request.dependency.id, {
      number: 456,
      url: "https://github.com/acme/library/issues/456",
    });
    store.recordDependencyIssueClosed(dependencyIssueClosed(456, "old-close", new Date(Date.now() - 60 * 60_000).toISOString()));
    store.recordDependencyPullRequestMerged(dependencyPrMerged(456, "later-merge"), "main");
    expect(store.getDependency(request.dependency.id).status).toBe("pending");
    store.close();
  });

  test("supports marker-checked attach and explicit abandonment during reconciliation", async () => {
    const fixture = workflowConfigFixture(true);
    directories.push(fixture.directory);
    const store = new Store(fixture.config.dataDir);
    const start = enqueueWorkflow(store, fixture, issueContext(), "implement-approved-issue");
    const run = store.getRun(start.runId!);
    const attached = store.beginDependencyRequest({
      parentWorkflowId: run.workflowId!,
      parentRepository: run.repository,
      targetRepository: "acme/library",
      requestKey: "ambiguous-create",
      title: "Dependency",
      body: "Body",
      createdByRunId: run.id,
    });
    const marker = Buffer.from(JSON.stringify({ id: attached.dependency.id, workflow: run.workflowId })).toString("base64url");
    let validMarker = false;
    const service = new DependencyService(
      fixture.config,
      store,
      {
        createIssue: async () => { throw new Error("not used"); },
        getIssue: async () => ({
          number: 456,
          url: "https://github.com/acme/library/issues/456",
          body: validMarker ? `Work\n<!-- gerry:dependency=${marker} -->` : "No marker",
        }),
        verifyIssueClosedByPullRequest: async () => true,
      },
      new Logger(join(fixture.config.dataDir, "service.jsonl"), undefined, false),
    );
    await expect(service.attachDependencyIssue(attached.dependency.id, 456)).rejects.toThrow("expected dependency marker");
    validMarker = true;
    expect((await service.attachDependencyIssue(attached.dependency.id, 456)).status).toBe("pending");

    const abandoned = store.beginDependencyRequest({
      parentWorkflowId: run.workflowId!,
      parentRepository: run.repository,
      targetRepository: "acme/library",
      requestKey: "abandoned-request",
      title: "No longer needed",
      body: "Body",
      createdByRunId: run.id,
    });
    store.failDependencyRequest(abandoned.dependency.id, "ambiguous timeout");
    expect(store.abandonDependency(abandoned.dependency.id, "Inspected; no issue was created").status).toBe("abandoned");
    await service.track(dependencyIssueClosed(456, "attached-closed"));
    await service.track(dependencyPrMerged(456, "attached-merged"));
    expect(store.listRuns(20).filter((candidate) => candidate.ruleName.startsWith("dependency-resume"))).toHaveLength(1);
    store.close();
  });

  test("retains multiple merge observations until the closing commit is timeline-verified", async () => {
    const fixture = workflowConfigFixture(true);
    directories.push(fixture.directory);
    const store = new Store(fixture.config.dataDir);
    const start = enqueueWorkflow(store, fixture, issueContext(), "implement-approved-issue");
    const run = store.getRun(start.runId!);
    const request = store.beginDependencyRequest({
      parentWorkflowId: run.workflowId!,
      parentRepository: run.repository,
      targetRepository: "acme/library",
      requestKey: "timeline-check",
      title: "Dependency",
      body: "Body",
      createdByRunId: run.id,
    });
    store.finishDependencyRequest(request.dependency.id, {
      number: 456,
      url: "https://github.com/acme/library/issues/456",
    });
    const service = new DependencyService(
      fixture.config,
      store,
      {
        createIssue: async () => { throw new Error("not used"); },
        getIssue: async () => { throw new Error("not used"); },
        verifyIssueClosedByPullRequest: async (_repository, _issue, observation) => observation.mergeCommitSha === "closing-merge",
      },
      new Logger(join(fixture.config.dataDir, "service.jsonl"), undefined, false),
    );
    await service.track(dependencyIssueClosed(456, "timeline-close"));
    await service.track(dependencyPrMerged(456, "non-default-merge", "closing-merge", "release"));
    expect(store.getDependency(request.dependency.id).status).toBe("pending");
    await service.track(dependencyPrMerged(456, "unrelated-merge", "unrelated-merge"));
    expect(store.getDependency(request.dependency.id).status).toBe("pending");
    await service.track(dependencyPrMerged(456, "actual-closing-merge", "closing-merge"));
    expect(store.getDependency(request.dependency.id).status).toBe("resolved");
    expect(store.getDependency(request.dependency.id).mergeCommitSha).toBe("closing-merge");
    store.close();
  });

  test("keeps failed requests in their cycle and resumes after explicit abandonment", async () => {
    const fixture = workflowConfigFixture(true);
    directories.push(fixture.directory);
    const store = new Store(fixture.config.dataDir);
    const start = enqueueWorkflow(store, fixture, issueContext(), "implement-approved-issue");
    const run = store.getRun(start.runId!);
    const failed = store.beginDependencyRequest({
      parentWorkflowId: run.workflowId!,
      parentRepository: run.repository,
      targetRepository: "acme/library",
      requestKey: "failed-original",
      title: "Original",
      body: "Body",
      createdByRunId: run.id,
    });
    store.failDependencyRequest(failed.dependency.id, "timeout");
    const replacement = store.beginDependencyRequest({
      parentWorkflowId: run.workflowId!,
      parentRepository: run.repository,
      targetRepository: "acme/library",
      requestKey: "replacement",
      title: "Replacement",
      body: "Body",
      createdByRunId: run.id,
    });
    expect(replacement.dependency.cycle).toBe(failed.dependency.cycle);
    store.finishDependencyRequest(replacement.dependency.id, {
      number: 456,
      url: "https://github.com/acme/library/issues/456",
    });
    store.markDependencyResolved(replacement.dependency.id, {
      prNumber: 900,
      prUrl: "https://github.com/acme/library/pull/900",
      mergeCommitSha: "closing-merge",
      mergedAt: Date.now(),
      baseRef: "main",
    });
    const service = new DependencyService(
      fixture.config,
      store,
      {
        createIssue: async () => { throw new Error("not used"); },
        getIssue: async () => { throw new Error("not used"); },
        verifyIssueClosedByPullRequest: async () => true,
      },
      new Logger(join(fixture.config.dataDir, "service.jsonl"), undefined, false),
    );
    expect(await service.recover()).toBe(0);
    store.abandonDependency(failed.dependency.id, "Inspected; replacement is sufficient");
    expect(await service.recover()).toBe(1);
    const resumeRuns = store.listRuns(20).filter((candidate) => candidate.ruleName.startsWith("dependency-resume"));
    expect(resumeRuns).toHaveLength(1);
    const delivery = store.getDelivery(resumeRuns[0]!.deliveryId);
    const payload = JSON.parse(readFileSync(delivery.payloadPath, "utf8")) as JsonObject;
    expect((payload.dependency as JsonObject).id).toBe(replacement.dependency.id);
    expect((payload.dependency as JsonObject).mergeCommitSha).toBe("closing-merge");
    store.close();
  });

  test("never marks a turn-limit-skipped resume as dispatched", async () => {
    const fixture = workflowConfigFixture(true);
    directories.push(fixture.directory);
    const store = new Store(fixture.config.dataDir);
    const start = enqueueWorkflow(store, fixture, issueContext(), "implement-approved-issue");
    const run = store.getRun(start.runId!);
    const request = store.beginDependencyRequest({
      parentWorkflowId: run.workflowId!,
      parentRepository: run.repository,
      targetRepository: "acme/library",
      requestKey: "budget-stop",
      title: "Dependency",
      body: "Body",
      createdByRunId: run.id,
    });
    store.finishDependencyRequest(request.dependency.id, {
      number: 456,
      url: "https://github.com/acme/library/issues/456",
    });
    store.markDependencyResolved(request.dependency.id, {
      prNumber: 900,
      prUrl: "https://github.com/acme/library/pull/900",
      mergeCommitSha: "closing-merge",
      mergedAt: Date.now(),
      baseRef: "main",
    });
    store.db.query("UPDATE workflows SET turns = 20 WHERE id = ?").run(run.workflowId);
    const service = new DependencyService(
      fixture.config,
      store,
      {
        createIssue: async () => { throw new Error("not used"); },
        getIssue: async () => { throw new Error("not used"); },
        verifyIssueClosedByPullRequest: async () => true,
      },
      new Logger(join(fixture.config.dataDir, "service.jsonl"), undefined, false),
    );
    expect(await service.recover()).toBe(0);
    expect(await service.recover()).toBe(0);
    expect(store.getWorkflow(run.workflowId!).status).toBe("waiting");
    expect(store.getDependency(request.dependency.id).resumeDispatchedAt).toBeNull();
    expect(store.listRuns(20).filter((candidate) => candidate.ruleName.startsWith("dependency-resume"))).toHaveLength(0);
    store.close();
  });

  test("keeps a waiting workflow paused on approval and completes it only on merge", async () => {
    const fixture = workflowConfigFixture(true);
    directories.push(fixture.directory);
    const store = new Store(fixture.config.dataDir);
    const start = enqueueWorkflow(store, fixture, issueContext(), "implement-approved-issue");
    const run = store.getRun(start.runId!);
    const workflow = store.getWorkflow(run.workflowId!);
    const request = store.beginDependencyRequest({
      parentWorkflowId: workflow.id,
      parentRepository: run.repository,
      targetRepository: "acme/library",
      requestKey: "approve-waiting",
      title: "Dependency",
      body: "Body",
      createdByRunId: run.id,
    });
    store.finishDependencyRequest(request.dependency.id, {
      number: 456,
      url: "https://github.com/acme/library/issues/456",
    });
    const approval = prContext({
      number: 100,
      branch: workflow.branch!,
      deliveryId: "approve-waiting",
      event: "pull_request_review",
      action: "submitted",
      reviewState: "approved",
    });
    expect(store.linkWorkflowPullRequest(approval)?.status).toBe("waiting");
    const service = new DependencyService(
      fixture.config,
      store,
      {
        createIssue: async () => { throw new Error("not used"); },
        getIssue: async () => { throw new Error("not used"); },
        verifyIssueClosedByPullRequest: async () => true,
      },
      new Logger(join(fixture.config.dataDir, "service.jsonl"), undefined, false),
    );
    expect(await service.recover()).toBe(0);
    expect(store.listRuns(20).filter((candidate) => candidate.ruleName.startsWith("dependency-resume"))).toHaveLength(0);
    const merged = prContext({
      number: 100,
      branch: workflow.branch!,
      deliveryId: "merge-waiting",
      event: "pull_request",
      action: "closed",
      merged: true,
    });
    expect(store.linkWorkflowPullRequest(merged)?.status).toBe("completed");
    expect(await service.recover()).toBe(0);
    expect(store.listRuns(20).filter((candidate) => candidate.ruleName.startsWith("dependency-resume"))).toHaveLength(0);
    store.close();
  });

  test("routes dependency comments to the requester while waiting and gates them with readiness labels", async () => {
    const { store, service, workflow, workers, inputs, labels } = await dependencyDiscussionSetup();
    const comment = dependencyIssueComment(456, "dependency-comment-1", {
      id: 101,
      body: "@implementer Please clarify the pagination requirement",
    });
    await service.track(comment);
    let discussions = store.listRuns(20).filter((run) => run.ruleName.startsWith("dependency-discussion"));
    expect(discussions).toHaveLength(1);
    expect(discussions[0]!.workflowId).toBe(workflow.id);
    expect(discussions[0]!.allowWaiting).toBe(true);
    expect(store.getWorkflow(workflow.id).status).toBe("waiting");

    await service.track(comment);
    expect(store.listRuns(20).filter((run) => run.ruleName.startsWith("dependency-discussion"))).toHaveLength(1);
    await service.track(dependencyIssueComment(456, "dependency-comment-ready", {
      id: 102,
      body: "@implementer This must not run",
      labels: [DEPENDENCY_READY_LABEL],
    }));
    expect(store.listRuns(20).filter((run) => run.ruleName.startsWith("dependency-discussion"))).toHaveLength(1);

    await workers.runNext("worker-discussion");
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.prompt).toContain("Cross-repository dependency requests are allowed only for");
    expect(inputs[0]!.prompt).toContain("- `acme/library`");
    expect(inputs[0]!.prompt).toContain("including upstream third-party libraries");
    expect(inputs[1]!.existingSessionId).toBe("parent-session");
    expect(inputs[1]!.prompt).toContain("Please clarify the pagination requirement");
    expect(store.getWorkflow(workflow.id).status).toBe("waiting");
    expect(store.getRun(discussions[0]!.id).status).toBe("succeeded");

    await service.track(dependencyIssueComment(456, "dependency-comment-reopened", {
      id: 103,
      body: "@implementer The human reopened discussion",
    }));
    discussions = store.listRuns(20).filter((run) => run.ruleName.startsWith("dependency-discussion"));
    expect(discussions).toHaveLength(2);
    expect(store.getWorkflow(workflow.id).status).toBe("waiting");

    labels.push(DEPENDENCY_READY_LABEL);
    await workers.runNext("worker-gated");
    expect(inputs).toHaveLength(2);
    expect(store.getRun(discussions[0]!.id).status).toBe("cancelled");
    expect(store.getWorkflow(workflow.id).status).toBe("waiting");
    labels.length = 0;
    await service.track(dependencyIssueComment(456, "dependency-comment-reopened-again", {
      id: 104,
      body: "@implementer Discussion is open again",
    }));
    expect(store.listRuns(20).filter((run) => run.ruleName.startsWith("dependency-discussion"))).toHaveLength(3);
    labels.push("approved");
    await workers.runNext("worker-approved-gated");
    expect(inputs).toHaveLength(2);
    expect(store.listRuns(20).filter((run) => run.ruleName.startsWith("dependency-discussion"))[0]!.status).toBe("cancelled");
    labels.length = 0;
    await service.track(dependencyIssueComment(456, "dependency-comment-final-reopen", {
      id: 105,
      body: "@implementer Open once more",
    }));
    expect(store.listRuns(20).filter((run) => run.ruleName.startsWith("dependency-discussion"))).toHaveLength(4);
    store.close();
  });

  test("rejects late broker comments and ignores broker-authored comment webhooks", async () => {
    const { store, service, workflow, labels, comments } = await dependencyDiscussionSetup();
    await service.track(dependencyIssueComment(456, "dependency-comment-broker", {
      id: 201,
      body: "@implementer Answer the maintainer",
    }));
    const claimed = store.claimNext("worker-discussion")!;
    const capability = "dependency-comment-capability";
    store.setAgentCapability(claimed.id, createHash("sha256").update(capability).digest("hex"), "worker-discussion");
    const dependency = store.listWorkflowDependencies(workflow.id)[0]!;
    const request = () => new Request("http://localhost/agent/dependencies/comments", {
      method: "POST",
      headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: JSON.stringify({ dependencyId: dependency.id, body: "Proposed clarification" }),
    });

    labels.push(DEPENDENCY_READY_LABEL);
    expect((await service.handleAgentComment(request())).status).toBe(409);
    expect(comments).toHaveLength(0);
    labels.length = 0;
    expect((await service.handleAgentComment(request())).status).toBe(201);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain(`gerry:run=${claimed.id}`);
    expect(comments[0]!.body).toContain(`gerry:dependency-comment=${dependency.id}`);

    await service.track(dependencyIssueComment(456, "dependency-comment-from-broker", {
      id: 987,
      body: `@implementer Ignore this broker reply\n\n<!-- gerry:dependency-comment=${dependency.id} -->`,
    }));
    expect(store.listRuns(20).filter((run) => run.ruleName.startsWith("dependency-discussion"))).toHaveLength(1);

    store.abandonDependency(dependency.id, "No longer needed");
    expect((await service.handleAgentComment(request())).status).toBe(409);
    store.db.query("UPDATE dependencies SET status = 'pending' WHERE id = ?").run(dependency.id);
    store.markDependencyResolved(dependency.id, {
      prNumber: 999,
      prUrl: null,
      mergeCommitSha: "abc123",
      mergedAt: Date.now(),
      baseRef: "main",
    });
    expect((await service.handleAgentComment(request())).status).toBe(409);
    store.db.query("UPDATE dependencies SET status = 'pending' WHERE id = ?").run(dependency.id);
    store.activateWorkflowForResume(workflow.id);
    expect((await service.handleAgentComment(request())).status).toBe(409);
    expect(comments).toHaveLength(1);
    store.close();
  });

  test("updates dependency issue bodies through the broker with readiness gates and a preserved marker", async () => {
    const { store, service, workflow, labels, updates } = await dependencyDiscussionSetup();
    await service.track(dependencyIssueComment(456, "dependency-comment-body-update", {
      id: 225,
      body: "@implementer Please revise the requirements",
    }));
    const claimed = store.claimNext("worker-body-update")!;
    const capability = "dependency-body-update-capability";
    store.setAgentCapability(claimed.id, createHash("sha256").update(capability).digest("hex"), "worker-body-update");
    const dependency = store.listWorkflowDependencies(workflow.id)[0]!;
    const request = () => new Request("http://localhost/agent/dependencies/issue", {
      method: "PATCH",
      headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
      body: JSON.stringify({
        dependencyId: dependency.id,
        body: "## Summary\nCollect papers.\n\n## Current situation\nNo collector.\n\n## Desired outcome\nCollect by date.\n\n## Why this matters\nResearch requires it.\n\n<!-- gerry:dependency=wrong -->",
      }),
    });

    labels.push(DEPENDENCY_READY_LABEL);
    expect((await service.handleAgentIssueUpdate(request())).status).toBe(409);
    expect(updates).toHaveLength(0);
    labels.length = 0;
    expect((await service.handleAgentIssueUpdate(request())).status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.body).toContain("## Summary");
    expect(updates[0]!.body).toContain("## Current situation");
    expect(updates[0]!.body).toContain("## Desired outcome");
    expect(updates[0]!.body).toContain("## Why this matters");
    expect(updates[0]!.body).not.toContain("gerry:dependency=wrong");
    const marker = Buffer.from(JSON.stringify({ id: dependency.id, workflow: workflow.id })).toString("base64url");
    expect(updates[0]!.body).toContain(`<!-- gerry:dependency=${marker} -->`);
    store.close();
  });

  test("rejects a parent resumed while the issue lookup is in flight", async () => {
    const holder: { store?: Store; workflowId?: string } = {};
    const { store, service, workflow } = await dependencyDiscussionSetup(undefined, () => {
      holder.store!.activateWorkflowForResume(holder.workflowId!);
    });
    holder.store = store;
    holder.workflowId = workflow.id;
    await service.track(dependencyIssueComment(456, "dependency-comment-in-flight", {
      id: 251,
      body: "@implementer Reply",
    }));
    const claimed = store.claimNext("worker-in-flight")!;
    const result = await service.check(claimed);
    expect(result).toEqual({ allowed: false, reason: "Parent workflow is no longer waiting for this dependency" });
    store.close();
  });

  test("rejects a discussion agent that differs from the dependency requester", async () => {
    const { store, service, workflow } = await dependencyDiscussionSetup("other-implementer");
    await service.track(dependencyIssueComment(456, "dependency-comment-wrong-agent", {
      id: 301,
      body: "@implementer Please reply",
    }));
    expect(store.listRuns(20).filter((run) => run.ruleName.startsWith("dependency-discussion"))).toHaveLength(0);
    expect(store.getWorkflow(workflow.id).status).toBe("waiting");
    store.close();
  });

  test("rejects invalid capabilities before creating any dependency", async () => {
    const fixture = workflowConfigFixture(true);
    directories.push(fixture.directory);
    const store = new Store(fixture.config.dataDir);
    const service = new DependencyService(
      fixture.config,
      store,
      {
        createIssue: async () => ({ number: 456, url: "https://github.com/acme/library/issues/456" }),
        getIssue: async () => { throw new Error("not used"); },
        verifyIssueClosedByPullRequest: async () => true,
      },
      new Logger(join(fixture.config.dataDir, "service.jsonl"), undefined, false),
    );
    const response = await service.handleAgentRequest(new Request("http://localhost/agent/dependencies", {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify({ to: "acme/library", title: "Nope", body: "", requestKey: "nope" }),
    }));
    expect(response.status).toBe(401);
    expect(store.listDependencies()).toHaveLength(0);
    store.close();
  });
});
