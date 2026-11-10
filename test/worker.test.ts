import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPrompt, type RuleConfig } from "../src/config.ts";
import { Logger } from "../src/observability.ts";
import { ProviderQuotaError, RuntimeExecutionError } from "../src/runtimes/types.ts";
import { Store } from "../src/store.ts";
import type { AgentRuntime, RuntimeRunInput } from "../src/types.ts";
import { WorkerPool } from "../src/worker.ts";
import { configFixture, context } from "./helpers.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class FakeRuntime implements AgentRuntime {
  readonly type = "hermes" as const;
  readonly inputs: RuntimeRunInput[] = [];

  constructor(private readonly behavior: (input: RuntimeRunInput) => Promise<{ sessionId: string; response: string }>) {}
  async check(): Promise<void> {}
  async run(input: RuntimeRunInput) {
    this.inputs.push(input);
    return this.behavior(input);
  }
}

function setup(behavior: (input: RuntimeRunInput) => Promise<{ sessionId: string; response: string }>, failToken = false) {
  const fixture = configFixture();
  directories.push(fixture.directory);
  const git = Bun.spawnSync({ cmd: ["git", "init"], cwd: join(fixture.directory, "repo"), stdout: "pipe", stderr: "pipe" });
  if (git.exitCode !== 0) throw new Error(git.stderr.toString());
  const store = new Store(fixture.config.dataDir);
  const runtime = new FakeRuntime(behavior);
  const logger = new Logger(join(fixture.config.dataDir, "service.jsonl"), undefined, false);
  const tokenCalls: Array<[number, string]> = [];
  const tokens = {
    get: async (installationId: number, repository: string) => {
      tokenCalls.push([installationId, repository]);
      if (failToken) throw new Error("token service unavailable");
      return "secret-installation-token";
    },
  };
  const workers = new WorkerPool({
    config: fixture.config,
    store,
    runtimes: new Map([["hermes", runtime]]),
    tokens,
    logger,
  });
  return { ...fixture, store, runtime, workers, tokenCalls };
}

function enqueue(fixture: ReturnType<typeof configFixture>, store: Store, deliveryId = "delivery-1", rule: RuleConfig = fixture.config.rules[0]!) {
  const webhook = { ...context(), deliveryId };
  const payloadPath = join(fixture.config.dataDir, `${deliveryId}.json`);
  writeFileSync(payloadPath, JSON.stringify(webhook.payload));
  store.insertDelivery({
    id: deliveryId,
    event: webhook.event,
    action: webhook.action,
    repository: webhook.repository,
    installationId: webhook.installationId,
    payloadPath,
  });
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
    instructions: "You are a careful implementation agent.\n",
    configHash: fixture.config.hash,
    parentRunId: null,
  });
}

describe("worker execution", () => {
  test("runs an agent and writes redacted audit artifacts", async () => {
    const fixture = setup(async (input) => {
      input.emit({ type: "fake.secret", data: { output: input.environment.GH_TOKEN } });
      return { sessionId: "session-1", response: `Done with ${input.environment.GH_TOKEN}` };
    });
    enqueue(fixture, fixture.store);
    writeFileSync(join(fixture.directory, "task.md"), "Changed after enqueue: {{issue.title}}\n");
    writeFileSync(join(fixture.directory, "agent.md"), "Changed instructions\n");
    expect(await fixture.workers.runNext("worker-test")).toBe(true);
    const run = fixture.store.listRuns(1)[0]!;
    expect(run.status).toBe("succeeded");
    expect(run.runtimeSessionId).toBe("session-1");
    expect(fixture.runtime.inputs[0]!.prompt).toContain("Add retries");
    expect(fixture.runtime.inputs[0]!.prompt).toContain("You are a careful implementation agent.");
    expect(fixture.runtime.inputs[0]!.prompt).not.toContain("Changed after enqueue");
    expect(fixture.runtime.inputs[0]!.prompt).not.toContain("Changed instructions");
    expect(fixture.runtime.inputs[0]!.prompt).toContain("<!-- gerry:run=");
    expect(fixture.tokenCalls).toEqual([[1234, "acme/widgets"]]);
    const events = readFileSync(join(fixture.config.dataDir, "runs", run.id, "attempts", "1", "events.jsonl"), "utf8");
    const response = readFileSync(join(fixture.config.dataDir, "runs", run.id, "response.md"), "utf8");
    expect(events).not.toContain("secret-installation-token");
    expect(response).not.toContain("secret-installation-token");
    expect(response).toContain("[REDACTED]");
    fixture.store.close();
  });

  test("resumes only conversation-scoped runtime sessions", async () => {
    const fixture = setup(async () => ({ sessionId: "persistent-session", response: "done" }));
    const rule: RuleConfig = {
      ...fixture.config.rules[0]!,
      session: "conversation",
      conversation: "discussion",
      once_per_subject: false,
    };
    enqueue(fixture, fixture.store, "delivery-1", rule);
    await fixture.workers.runNext("worker-test");
    enqueue(fixture, fixture.store, "delivery-2", rule);
    await fixture.workers.runNext("worker-test");
    expect(fixture.runtime.inputs).toHaveLength(2);
    expect(fixture.runtime.inputs[0]!.existingSessionId).toBeNull();
    expect(fixture.runtime.inputs[1]!.existingSessionId).toBe("persistent-session");
    fixture.store.close();
  });

  test("requires explicit retry after runtime execution begins", async () => {
    const fixture = setup(async () => {
      throw new RuntimeExecutionError("provider failed", { sessionId: "partial-session" });
    });
    const rule = { ...fixture.config.rules[0]!, session: "conversation" as const, once_per_subject: false };
    const decision = enqueue(fixture, fixture.store, "delivery-1", rule);
    await fixture.workers.runNext("worker-test");
    const failed = fixture.store.getRun(decision.runId!);
    expect(failed.status).toBe("failed");
    expect(failed.runtimeSessionId).toBe("partial-session");
    fixture.store.close();
  });

  test("waits for provider quota without exhausting attempts or losing the session", async () => {
    let attempts = 0;
    const fixture = setup(async () => {
      attempts += 1;
      if (attempts <= 4) {
        throw new ProviderQuotaError("5-hour quota exhausted; provider text mentions timed out and abort", { sessionId: "partial-session" });
      }
      return { sessionId: "partial-session", response: "recovered" };
    });
    const decision = enqueue(fixture, fixture.store);
    const expectedDelays = [300_000, 600_000, 1_200_000, 2_400_000];

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const before = Date.now();
      await fixture.workers.runNext("worker-test");
      const waiting = fixture.store.getRun(decision.runId!);
      expect(waiting.status).toBe("retry_wait");
      expect(waiting.attempt).toBe(attempt);
      expect(waiting.maxAttempts).toBe(3);
      expect(waiting.runtimeSessionId).toBe("partial-session");
      expect(waiting.availableAt - before).toBeGreaterThanOrEqual(expectedDelays[attempt - 1]!);
      expect(waiting.availableAt - before).toBeLessThan(expectedDelays[attempt - 1]! + 1000);
      fixture.store.db.query("UPDATE runs SET available_at = ? WHERE id = ?").run(Date.now() - 1, waiting.id);
    }

    await fixture.workers.runNext("worker-test");
    expect(fixture.store.getRun(decision.runId!).status).toBe("succeeded");
    expect(fixture.runtime.inputs).toHaveLength(5);
    expect(fixture.runtime.inputs[0]!.existingSessionId).toBeNull();
    for (const input of fixture.runtime.inputs.slice(1)) {
      expect(input.existingSessionId).toBe("partial-session");
    }
    fixture.store.close();
  });

  test("persists session IDs immediately and resumes them on explicit same-run retry", async () => {
    let attempts = 0;
    const fixture = setup(async (input) => {
      attempts += 1;
      input.onSession(`early-session-${attempts}`);
      if (attempts === 1) throw new Error("simulated runtime crash");
      return { sessionId: `early-session-${attempts}`, response: "recovered" };
    });
    const decision = enqueue(fixture, fixture.store);
    await fixture.workers.runNext("worker-test");
    expect(fixture.store.getRun(decision.runId!).runtimeSessionId).toBe("early-session-1");
    fixture.store.retry(decision.runId!);
    await fixture.workers.runNext("worker-test");
    expect(fixture.runtime.inputs[1]!.existingSessionId).toBe("early-session-1");
    expect(fixture.store.getRun(decision.runId!).status).toBe("succeeded");
    fixture.store.close();
  });

  test("automatically retries failures before runtime startup", async () => {
    const fixture = setup(async () => ({ sessionId: "unused", response: "unused" }), true);
    enqueue(fixture, fixture.store);
    await fixture.workers.runNext("worker-test");
    const run = fixture.store.listRuns(1)[0]!;
    expect(run.status).toBe("retry_wait");
    expect(fixture.runtime.inputs).toHaveLength(0);
    fixture.store.close();
  });
});
