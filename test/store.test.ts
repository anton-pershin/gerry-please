import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPrompt, type RuleConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";
import type { WebhookContext } from "../src/types.ts";
import { configFixture, context, temporaryDirectory } from "./helpers.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const fixture = configFixture();
  directories.push(fixture.directory);
  const store = new Store(fixture.config.dataDir);
  const prompt = readPrompt(fixture.config, "task.md");
  return { ...fixture, store, prompt };
}

function delivery(store: Store, dataDirectory: string, webhook: WebhookContext): void {
  const path = join(dataDirectory, `${webhook.deliveryId}.json`);
  writeFileSync(path, JSON.stringify(webhook.payload));
  store.insertDelivery({
    id: webhook.deliveryId,
    event: webhook.event,
    action: webhook.action,
    repository: webhook.repository,
    installationId: webhook.installationId,
    payloadPath: path,
  });
}

function enqueue(store: Store, fixture: ReturnType<typeof configFixture>, webhook: WebhookContext, rule: RuleConfig = fixture.config.rules[0]!) {
  delivery(store, fixture.config.dataDir, webhook);
  const agent = fixture.config.agents[rule.agent]!;
  const prompt = readPrompt(fixture.config, rule.prompt);
  return store.enqueueRun({
    context: webhook,
    rule,
    agent,
    agentName: rule.agent,
    runtimeName: agent.runtime,
    runtime: fixture.config.runtimes[agent.runtime]!,
    promptPath: prompt.path,
    promptHash: prompt.hash,
    promptContents: prompt.contents,
    instructions: "",
    configHash: fixture.config.hash,
    parentRunId: null,
  });
}

describe("durable store", () => {
  test("deduplicates deliveries and once-per-subject rules", () => {
    const fixture = setup();
    const first = enqueue(fixture.store, fixture, context());
    expect(first.decision).toBe("queued");
    const duplicate = enqueue(fixture.store, fixture, context());
    expect(duplicate.decision).toBe("duplicate");
    const second = enqueue(fixture.store, fixture, issueWithDelivery("delivery-2"));
    expect(second.decision).toBe("skipped");
    expect(second.reason).toContain("already");
    fixture.store.close();
  });

  test("serializes a conversation and enforces its shared turn budget", () => {
    const fixture = setup();
    const rule: RuleConfig = {
      ...fixture.config.rules[0]!,
      session: "conversation",
      conversation: "agents-discussing",
      max_turns: 2,
      once_per_subject: false,
    };
    const first = enqueue(fixture.store, fixture, context(), rule);
    const second = enqueue(fixture.store, fixture, issueWithDelivery("delivery-2"), rule);
    expect(first.decision).toBe("queued");
    expect(second.decision).toBe("queued");
    const third = enqueue(fixture.store, fixture, issueWithDelivery("delivery-3"), rule);
    expect(third.decision).toBe("skipped");
    expect(third.reason).toContain("turn limit");

    const claimed = fixture.store.claimNext("worker-1")!;
    expect(claimed.conversationKey).toContain("agents-discussing");
    expect(fixture.store.claimNext("worker-2")).toBeNull();
    fixture.store.succeed(claimed.id, "worker-1", {
      runtimeSessionId: "hermes-session-1",
      responsePath: "/tmp/response.md",
      usage: null,
      sessionCompatibilityHash: "config-v1",
    });
    expect(fixture.store.getConversationSession(claimed.conversationKey!, claimed.agentName, claimed.runtimeName, "config-v1")).toBe("hermes-session-1");
    expect(fixture.store.getConversationSession(claimed.conversationKey!, claimed.agentName, claimed.runtimeName, "config-v2")).toBeNull();
    expect(fixture.store.getConversationSession(claimed.conversationKey!, claimed.agentName, "another-runtime", "config-v1")).toBeNull();
    expect(fixture.store.claimNext("worker-2")?.id).toBe(second.runId);
    fixture.store.close();
  });

  test("does not automatically retry runtime failures and supports explicit retry", () => {
    const fixture = setup();
    const decision = enqueue(fixture.store, fixture, context());
    const claimed = fixture.store.claimNext("worker-1")!;
    const failed = fixture.store.fail(claimed.id, "worker-1", "agent failed", { retryable: false, preserveLedger: true });
    expect(failed.status).toBe("failed");
    expect(fixture.store.claimNext("worker-1")).toBeNull();
    const duplicate = enqueue(fixture.store, fixture, issueWithDelivery("delivery-ambiguous"));
    expect(duplicate.decision).toBe("skipped");
    expect(duplicate.reason).toContain("already");
    const retried = fixture.store.retry(decision.runId!);
    expect(retried.status).toBe("queued");
    expect(retried.maxAttempts).toBe(2);
    expect(fixture.store.claimNext("worker-1")?.attempt).toBe(2);
    fixture.store.close();
  });

  test("quarantines ambiguous conversations until explicit resolution", () => {
    const fixture = setup();
    const rule: RuleConfig = {
      ...fixture.config.rules[0]!,
      session: "conversation",
      conversation: "quarantine-test",
      once_per_subject: false,
    };
    const first = enqueue(fixture.store, fixture, context(), rule);
    const second = enqueue(fixture.store, fixture, issueWithDelivery("delivery-2"), rule);
    const claimed = fixture.store.claimNext("worker-1")!;
    fixture.store.fail(claimed.id, "worker-1", "timeout after comment", { retryable: false, preserveLedger: true });
    expect(fixture.store.claimNext("worker-2")).toBeNull();
    fixture.store.resolve(first.runId!);
    expect(fixture.store.getRun(first.runId!).resolvedAt).not.toBeNull();
    expect(() => fixture.store.resolve(first.runId!)).toThrow("already resolved");
    const secondClaim = fixture.store.claimNext("worker-2")!;
    expect(secondClaim.id).toBe(second.runId!);
    fixture.store.fail(secondClaim.id, "worker-2", "newer ambiguous failure", { retryable: false, preserveLedger: true });
    expect(() => fixture.store.retry(first.runId!)).toThrow("Resolved runs cannot be retried");
    expect(fixture.store.claimNext("worker-3")).toBeNull();
    fixture.store.resolve(secondClaim.id);
    fixture.store.close();
  });

  test("does not starve independent runs behind a large quarantined backlog", () => {
    const fixture = setup();
    const conversationRule: RuleConfig = {
      ...fixture.config.rules[0]!,
      session: "conversation",
      conversation: "blocked-backlog",
      once_per_subject: false,
      max_turns: 1000,
    };
    const first = enqueue(fixture.store, fixture, context(), conversationRule);
    const claimed = fixture.store.claimNext("worker-1")!;
    fixture.store.fail(claimed.id, "worker-1", "quarantine this conversation", { retryable: false, preserveLedger: true });
    for (let index = 0; index < 100; index += 1) {
      enqueue(fixture.store, fixture, issueWithDelivery(`blocked-${index}`), conversationRule);
    }
    const independent = enqueue(fixture.store, fixture, issueWithDelivery("independent"), fixture.config.rules[0]!);
    const next = fixture.store.claimNext("worker-2");
    expect(next?.id).toBe(independent.runId!);
    expect(next?.conversationKey).toBeNull();
    expect(first.runId).toBeDefined();
    fixture.store.close();
  });

  test("keeps later conversation turns behind an earlier retry-waiting turn", () => {
    const fixture = setup();
    const rule: RuleConfig = {
      ...fixture.config.rules[0]!,
      session: "conversation",
      conversation: "ordered-retries",
      once_per_subject: false,
    };
    const first = enqueue(fixture.store, fixture, context(), rule);
    const second = enqueue(fixture.store, fixture, issueWithDelivery("delivery-2"), rule);
    const claimed = fixture.store.claimNext("worker-1")!;
    expect(claimed.id).toBe(first.runId!);
    fixture.store.fail(claimed.id, "worker-1", "provider quota exhausted", {
      retryable: true,
      retryDelayMs: 300_000,
      ignoreAttemptLimit: true,
      preserveLedger: true,
    });

    expect(fixture.store.claimNext("worker-2")).toBeNull();
    fixture.store.db.query("UPDATE runs SET available_at = ? WHERE id = ?").run(Date.now() - 1, first.runId!);
    const retried = fixture.store.claimNext("worker-2")!;
    expect(retried.id).toBe(first.runId!);
    fixture.store.succeed(retried.id, "worker-2", {
      runtimeSessionId: "session-1",
      responsePath: "/tmp/response.md",
      usage: null,
    });
    expect(fixture.store.claimNext("worker-3")?.id).toBe(second.runId!);
    fixture.store.close();
  });

  test("retries preparation failures with backoff and cancels queued runs", () => {
    const fixture = setup();
    enqueue(fixture.store, fixture, context());
    const claimed = fixture.store.claimNext("worker-1")!;
    const failed = fixture.store.fail(claimed.id, "worker-1", "token unavailable", { retryable: true });
    expect(failed.status).toBe("retry_wait");
    expect(failed.availableAt).toBeGreaterThan(Date.now());
    const cancelled = fixture.store.cancel(failed.id);
    expect(cancelled.status).toBe("cancelled");
    fixture.store.close();
  });
});

function issueWithDelivery(deliveryId: string) {
  const webhook = context();
  return { ...webhook, deliveryId };
}
