import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "../src/observability.ts";
import { Store } from "../src/store.ts";
import type { AgentRuntime, RuntimeRunInput } from "../src/types.ts";
import { WorkerPool } from "../src/worker.ts";
import { enqueueWorkflow, initializeOrigin, issueContext, prContext, workflowConfigFixture } from "./workflow-helpers.ts";

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
    expect(store.linkWorkflowPullRequest(approval)?.status).toBe("completed");
    const afterApproval = enqueueWorkflow(store, fixture, prContext({
      number: 100,
      branch: firstWorkflow.branch!,
      deliveryId: "review-after-approval",
    }), "address-pr-review");
    expect(afterApproval.decision).toBe("skipped");
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
