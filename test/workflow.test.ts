import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "../src/observability.ts";
import { ruleMatches } from "../src/rules.ts";
import { Store } from "../src/store.ts";
import type { AgentRuntime, RuntimeRunInput } from "../src/types.ts";
import { WorkerPool } from "../src/worker.ts";
import { enqueueWorkflow, initializeOrigin, issueContext, prContext, prConversationContext, workflowConfigFixture } from "./workflow-helpers.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("workflow-scoped execution", () => {
  test("runs independent workflows in parallel while serializing turns and preserving PR identity", () => {
    const fixture = workflowConfigFixture();
    directories.push(fixture.directory);
    const store = new Store(fixture.config.dataDir);
    const first = enqueueWorkflow(store, fixture, issueContext(42, "first-issue"), "implement-approved-issue");
    const firstWorkflow = store.getWorkflow(first.runId ? store.getRun(first.runId).workflowId! : "");
    const review = prContext({ number: 100, branch: firstWorkflow.branch!, deliveryId: "first-review" });
    expect(store.linkWorkflowPullRequest(review)?.pullRequestNumber).toBe(100);
    const firstReview = enqueueWorkflow(store, fixture, review, "address-pr-review");
    const second = enqueueWorkflow(store, fixture, issueContext(43, "second-issue"), "implement-approved-issue");

    const firstRun = store.getRun(first.runId!);
    const secondRun = store.getRun(second.runId!);
    expect(firstRun.workflowId).not.toBe(secondRun.workflowId);
    expect(store.getRun(firstReview.runId!).workflowId).toBe(firstRun.workflowId);

    expect(store.claimNext("worker-1")?.id).toBe(first.runId);
    expect(store.claimNext("worker-2")?.id).toBe(second.runId);
    expect(store.claimNext("worker-3")).toBeNull();
    store.succeed(second.runId!, "worker-2", { runtimeSessionId: "session-2", responsePath: "/tmp/2", usage: null });
    expect(store.claimNext("worker-3")).toBeNull();
    store.succeed(first.runId!, "worker-1", {
      runtimeSessionId: "session-1",
      responsePath: "/tmp/1",
      usage: null,
      sessionCompatibilityHash: "v1",
    });
    expect(store.claimNext("worker-3")?.id).toBe(firstReview.runId);
    expect(store.getWorkflowSession(firstRun.workflowId!, "implementer", "hermes", "v1")).toBe("session-1");

    const approval = prContext({
      number: 100,
      branch: firstWorkflow.branch!,
      deliveryId: "approval",
      event: "pull_request_review",
      action: "submitted",
      reviewState: "approved",
    });
    expect(store.linkWorkflowPullRequest(approval)?.status).toBe("active");
    const afterApproval = enqueueWorkflow(store, fixture, prContext({
      number: 100,
      branch: firstWorkflow.branch!,
      deliveryId: "review-after-approval",
    }), "address-pr-review");
    expect(afterApproval.decision).toBe("queued");

    const merged = prContext({
      number: 100,
      branch: firstWorkflow.branch!,
      deliveryId: "merge",
      event: "pull_request",
      action: "closed",
      merged: true,
    });
    expect(store.linkWorkflowPullRequest(merged)?.status).toBe("completed");
    const afterMerge = enqueueWorkflow(store, fixture, prContext({
      number: 100,
      branch: firstWorkflow.branch!,
      deliveryId: "review-after-merge",
    }), "address-pr-review");
    expect(afterMerge.decision).toBe("skipped");
    store.close();
  });

  test("resumes an approved workflow from an ordinary PR conversation comment", () => {
    const fixture = workflowConfigFixture();
    directories.push(fixture.directory);
    const store = new Store(fixture.config.dataDir);
    const start = enqueueWorkflow(store, fixture, issueContext(), "implement-approved-issue");
    const workflow = store.getWorkflow(store.getRun(start.runId!).workflowId!);
    const approval = prContext({
      number: 100,
      branch: workflow.branch!,
      deliveryId: "conversation-approval",
      event: "pull_request_review",
      action: "submitted",
      reviewState: "approved",
    });
    expect(store.linkWorkflowPullRequest(approval)?.status).toBe("active");

    const comment = prConversationContext({ number: 100, deliveryId: "ordinary-pr-comment" });
    const rule = fixture.config.rules.find((candidate) => candidate.name === "address-pr-conversation-comment")!;
    expect(comment.subject.type).toBe("pull_request");
    expect(ruleMatches(rule, comment)).toBe(true);
    const decision = enqueueWorkflow(store, fixture, comment, rule.name);
    expect(decision.decision).toBe("queued");
    expect(store.getRun(decision.runId!).workflowId).toBe(workflow.id);
    store.close();
  });

  test("closes an unmerged workflow without completing it and reactivates it on reopen", () => {
    const fixture = workflowConfigFixture();
    directories.push(fixture.directory);
    const store = new Store(fixture.config.dataDir);
    const start = enqueueWorkflow(store, fixture, issueContext(), "implement-approved-issue");
    const workflow = store.getWorkflow(store.getRun(start.runId!).workflowId!);
    store.linkWorkflowPullRequest(prContext({ number: 100, branch: workflow.branch!, deliveryId: "link" }));
    const closed = prContext({
      number: 100,
      branch: workflow.branch!,
      deliveryId: "close-unmerged",
      event: "pull_request",
      action: "closed",
      merged: false,
    });
    expect(store.linkWorkflowPullRequest(closed)?.status).toBe("closed");
    expect(store.getWorkflow(workflow.id).completedAt).toBeNull();
    expect(enqueueWorkflow(store, fixture, prContext({
      number: 100,
      branch: workflow.branch!,
      deliveryId: "review-while-closed",
    }), "address-pr-review").decision).toBe("skipped");

    const reopened = prContext({
      number: 100,
      branch: workflow.branch!,
      deliveryId: "reopen",
      event: "pull_request",
      action: "reopened",
    });
    expect(store.linkWorkflowPullRequest(reopened)?.status).toBe("active");
    expect(enqueueWorkflow(store, fixture, prContext({
      number: 100,
      branch: workflow.branch!,
      deliveryId: "review-after-reopen",
    }), "address-pr-review").decision).toBe("queued");
    store.close();
  });

  test("abandons a closed workflow and lets a replacement use the same origin issue", () => {
    const fixture = workflowConfigFixture();
    directories.push(fixture.directory);
    const store = new Store(fixture.config.dataDir);
    const original = enqueueWorkflow(store, fixture, issueContext(), "implement-approved-issue");
    const originalRun = store.getRun(original.runId!);
    const originalWorkflow = store.getWorkflow(originalRun.workflowId!);
    store.linkWorkflowPullRequest(prContext({
      number: 100,
      branch: originalWorkflow.branch!,
      deliveryId: "abandon-close",
      event: "pull_request",
      action: "closed",
      merged: false,
    }));

    expect(store.abandonWorkflow(originalWorkflow.id).status).toBe("abandoned");
    expect(() => store.abandonWorkflow(originalWorkflow.id)).toThrow("Only closed-unmerged workflows");
    const replacement = enqueueWorkflow(store, fixture, issueContext(42, "replacement-approval"), "implement-approved-issue");
    expect(replacement.decision).toBe("queued");
    const replacementRun = store.getRun(replacement.runId!);
    expect(replacementRun.workflowId).not.toBe(originalWorkflow.id);
    expect(store.getWorkflow(replacementRun.workflowId!).status).toBe("active");
    expect(store.getWorkflow(originalWorkflow.id).status).toBe("abandoned");
    expect(store.getRun(originalRun.id).status).toBe("queued");
    store.close();
  });

  test("migrates the legacy origin constraint before abandoning a workflow", () => {
    const fixture = workflowConfigFixture();
    directories.push(fixture.directory);
    mkdirSync(fixture.config.dataDir, { recursive: true });
    const database = new Database(join(fixture.config.dataDir, "gerry.sqlite"));
    database.exec(`CREATE TABLE workflows (
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
    )`);
    const timestamp = Date.now();
    database.query(`INSERT INTO workflows
      (id, type, repository, installation_id, origin_subject_type, origin_subject_number, status,
       workspace_path, branch, turns, dependency_cycle, quarantined, created_at, updated_at)
      VALUES ('wf_legacy', 'implementation', 'acme/widgets', 1234, 'issue', 42, 'closed',
       '/old-worktree', 'gerry/legacy', 1, 0, 0, ?, ?)`).run(timestamp, timestamp);
    database.close();

    const store = new Store(fixture.config.dataDir);
    expect(store.abandonWorkflow("wf_legacy").status).toBe("abandoned");
    const replacement = enqueueWorkflow(store, fixture, issueContext(42, "legacy-replacement"), "implement-approved-issue");
    expect(replacement.decision).toBe("queued");
    expect(store.getRun(replacement.runId!).workflowId).not.toBe("wf_legacy");
    expect(store.getWorkflow("wf_legacy").branch).toBe("gerry/legacy");
    store.close();
  });

  test("refuses to abandon a workflow with an active run", () => {
    const fixture = workflowConfigFixture();
    directories.push(fixture.directory);
    const store = new Store(fixture.config.dataDir);
    const start = enqueueWorkflow(store, fixture, issueContext(), "implement-approved-issue");
    const workflow = store.getWorkflow(store.getRun(start.runId!).workflowId!);
    store.claimNext("worker-active");
    store.linkWorkflowPullRequest(prContext({
      number: 100,
      branch: workflow.branch!,
      deliveryId: "active-close",
      event: "pull_request",
      action: "closed",
      merged: false,
    }));
    expect(() => store.abandonWorkflow(workflow.id)).toThrow("while a run is active");
    store.close();
  });

  test("keeps a workflow active and ordered while an earlier turn waits for quota", () => {
    const fixture = workflowConfigFixture();
    directories.push(fixture.directory);
    const store = new Store(fixture.config.dataDir);
    const start = enqueueWorkflow(store, fixture, issueContext(), "implement-approved-issue");
    const startRun = store.getRun(start.runId!);
    const workflow = store.getWorkflow(startRun.workflowId!);
    const reviewContext = prContext({ number: 100, branch: workflow.branch!, deliveryId: "review" });
    store.linkWorkflowPullRequest(reviewContext);
    const review = enqueueWorkflow(store, fixture, reviewContext, "address-pr-review");
    const claimed = store.claimNext("worker-1")!;
    expect(claimed.id).toBe(start.runId!);
    store.fail(claimed.id, "worker-1", "provider quota exhausted", {
      retryable: true,
      retryDelayMs: 300_000,
      ignoreAttemptLimit: true,
      preserveLedger: true,
    });

    expect(store.getWorkflow(workflow.id).quarantined).toBe(false);
    expect(store.claimNext("worker-2")).toBeNull();
    store.db.query("UPDATE runs SET available_at = ? WHERE id = ?").run(Date.now() - 1, start.runId!);
    expect(store.claimNext("worker-2")?.id).toBe(start.runId!);
    store.succeed(start.runId!, "worker-2", {
      runtimeSessionId: "session-1",
      responsePath: "/tmp/response.md",
      usage: null,
    });
    expect(store.claimNext("worker-3")?.id).toBe(review.runId!);
    store.close();
  });

  test("rejects forked, wrong-repository, and replacement PR identities", () => {
    const fixture = workflowConfigFixture();
    directories.push(fixture.directory);
    const store = new Store(fixture.config.dataDir);
    const start = enqueueWorkflow(store, fixture, issueContext(), "implement-approved-issue");
    const workflow = store.getWorkflow(store.getRun(start.runId!).workflowId!);
    const fork = prContext({
      number: 200,
      branch: workflow.branch!,
      headRepository: "someone/fork",
      deliveryId: "fork",
    });
    expect(store.linkWorkflowPullRequest(fork)).toBeNull();
    expect(enqueueWorkflow(store, fixture, fork, "address-pr-review").decision).toBe("skipped");

    const legitimate = prContext({ number: 100, branch: workflow.branch!, deliveryId: "legitimate" });
    expect(store.linkWorkflowPullRequest(legitimate)).not.toBeNull();
    const replacement = prContext({ number: 101, branch: workflow.branch!, deliveryId: "replacement" });
    expect(store.linkWorkflowPullRequest(replacement)).toBeNull();
    expect(enqueueWorkflow(store, fixture, replacement, "address-pr-review").decision).toBe("skipped");

    const wrongRepository = prContext({
      number: 100,
      branch: workflow.branch!,
      repository: "acme/other",
      headRepository: "acme/other",
      deliveryId: "wrong-repository",
    });
    expect(store.linkWorkflowPullRequest(wrongRepository)).toBeNull();
    expect(store.getWorkflow(workflow.id).pullRequestNumber).toBe(100);
    store.close();
  });

  test("resumes one runtime session and worktree from issue through PR review", async () => {
    const fixture = workflowConfigFixture();
    directories.push(fixture.directory);
    initializeOrigin(fixture.directory);
    const store = new Store(fixture.config.dataDir);
    const inputs: RuntimeRunInput[] = [];
    const runtime: AgentRuntime = {
      type: "hermes",
      check: async () => {},
      run: async (input) => {
        inputs.push(input);
        return { sessionId: "implementation-session", response: "done" };
      },
    };
    const workers = new WorkerPool({
      config: fixture.config,
      store,
      runtimes: new Map([["hermes", runtime]]),
      tokens: { get: async () => "token" },
      logger: new Logger(join(fixture.config.dataDir, "service.jsonl"), undefined, false),
    });

    const first = enqueueWorkflow(store, fixture, issueContext(), "implement-approved-issue");
    await workers.runNext("worker-1");
    const workflow = store.getWorkflow(store.getRun(first.runId!).workflowId!);
    expect(inputs[0]!.existingSessionId).toBeNull();
    expect(inputs[0]!.prompt).toContain("No cross-repository dependency requests are allowed for this workflow");
    expect(inputs[0]!.prompt).not.toContain("send a JSON POST to $GERRY_DEPENDENCY_URL");
    expect(inputs[0]!.environment.GERRY_DEPENDENCY_URL).toContain("/agent/dependencies");
    expect(inputs[0]!.environment.GERRY_AGENT_TOKEN).toBeDefined();
    expect(store.getRun(first.runId!).agentCapabilityHash).toBeNull();

    const review = prContext({ number: 100, branch: workflow.branch!, deliveryId: "review" });
    store.linkWorkflowPullRequest(review);
    enqueueWorkflow(store, fixture, review, "address-pr-review");
    await workers.runNext("worker-1");
    expect(inputs).toHaveLength(2);
    expect(inputs[1]!.existingSessionId).toBe("implementation-session");
    expect(inputs[1]!.workspacePath).toBe(inputs[0]!.workspacePath);
    expect(inputs[1]!.prompt).toContain(workflow.id);
    store.close();
  });
});
