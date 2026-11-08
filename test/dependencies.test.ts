import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DependencyService } from "../src/dependencies.ts";
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

    const nextCycle = store.beginDependencyRequest({
      parentWorkflowId: workflowId,
      parentRepository: "acme/widgets",
      targetRepository: "acme/library",
      requestKey: "third-api",
      title: "Third API",
      body: "A later dependency round",
      createdByRunId: resumes[0]!.id,
    });
    store.finishDependencyRequest(nextCycle.dependency.id, {
      number: 458,
      url: "https://github.com/acme/library/issues/458",
    });
    await service.track(dependencyIssueClosed(458, "dep-458-closed"));
    await service.track(dependencyPrMerged(458, "dep-458-merged"));
    const allResumes = store.listRuns(20).filter((run) => run.ruleName.startsWith("dependency-resume"));
    expect(allResumes).toHaveLength(2);
    expect(allResumes.some((run) => run.ruleName.endsWith("cycle-2"))).toBe(true);

    const inputs: RuntimeRunInput[] = [];
    const runtime: AgentRuntime = {
      type: "hermes",
      check: async () => {},
      run: async (input) => {
        inputs.push(input);
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
    for (let index = 0; index < 3; index += 1) await workers.runNext("worker-resume");
    expect(store.listRuns(20).filter((run) => run.ruleName.startsWith("dependency-resume") && run.status === "succeeded")).toHaveLength(2);
    expect(inputs.some((input) => input.prompt.includes("458"))).toBe(true);
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
        verifyIssueClosedByPullRequest: async (_repository, _issue, mergeCommitSha) => mergeCommitSha === "closing-merge",
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

  test("completes a waiting workflow on approval without resuming dependencies", async () => {
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
    expect(store.linkWorkflowPullRequest(approval)?.status).toBe("completed");
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
