import { describe, expect, test } from "bun:test";
import type { OpenCodeClient } from "@opencode/client";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  createOpenCodeBackgroundJobLister,
  isSupportedOpenCodeVersion,
  OpenCodeRuntime,
  readOpenCodeSessionGeneration,
  waitForOpenCodeSession,
  type ListOpenCodeBackgroundJobs,
  type OpenCodeBackgroundJob,
} from "../src/runtimes/opencode.ts";
import { ProviderQuotaError } from "../src/runtimes/types.ts";
import type { RuntimeEvent } from "../src/types.ts";
import { temporaryDirectory } from "./helpers.ts";

const quotaError = {
  type: "provider.quota",
  message: "You've reached your 5-hour usage limit.",
  status: 429,
  response: { body: JSON.stringify({ error: { type: "exceeded_current_quota_error" } }) },
};

function fakeClient(
  sessionID = "opencode-session",
  executionError?: unknown,
  emitFailureEvent = true,
  toolCalls = 0,
  onWait?: (sessionID: string) => Promise<void>,
  serverVersion = "2.3.0",
  latestTurnMessage?: () => "idle" | "synthetic",
  inboxItems?: () => Array<{ delivery: "steer" | "queue" }>,
  parentActive?: () => boolean,
  descendants?: () => Array<{ id: string; parentID?: string }>,
  activeDescendants?: () => string[],
) {
  const environmentCalls: Array<Record<string, string>> = [];
  const permissionReplies: Array<Record<string, unknown>> = [];
  const prompts: string[] = [];
  const messageListInputs: Array<{ limit?: number }> = [];
  let markExecutionObserved!: () => void;
  const executionObserved = new Promise<void>((resolve) => { markExecutionObserved = resolve; });
  const session = {
    id: sessionID,
    projectID: "project",
    cost: 0.25,
    tokens: { input: 100, output: 20, reasoning: 3, cache: { read: 10, write: 2 } },
    outcome: executionError ? "failed" : "succeeded",
    time: { created: Date.now(), updated: Date.now() },
    location: { directory: "/workspace" },
  };
  const client = {
    server: { info: async () => ({ version: serverVersion }) },
    session: {
      create: async () => session,
      get: async () => session,
      list: async (input: { parentID?: string }) => ({
        data: (descendants?.() ?? []).filter((child) => (child.parentID ?? sessionID) === input.parentID),
        cursor: {},
      }),
      active: async () => Object.fromEntries([
        ...(parentActive?.() ? [sessionID] : []),
        ...(activeDescendants?.() ?? []),
      ].map((id) => [id, { type: "running" }])),
      environment: async (input: { variables: Record<string, string> }) => { environmentCalls.push(input.variables); },
      prompt: async (input: { text: string }) => { prompts.push(input.text); return {}; },
      interrupt: async () => ({}),
      inbox: { list: async () => inboxItems?.() ?? [] },
    },
    experimental: {
      session: {
        wait: async (input: { sessionID: string }) => {
          if (onWait) return onWait(input.sessionID);
          if (executionError && emitFailureEvent) await executionObserved;
        },
        log: async function* () {
          yield { type: "log.synced", aggregateID: sessionID, seq: 1 };
        },
      },
    },
    event: {
      subscribe: async function* (options: { signal: AbortSignal }) {
        yield { type: "server.connected", data: {} };
        yield { type: "permission.asked", data: { id: "permission-1", sessionID, action: "shell", resources: ["rm *"] } };
        yield { type: "session.text.delta", data: { sessionID, delta: "Hello " } };
        yield { type: "session.text.delta", data: { sessionID, delta: "world" } };
        for (let index = 0; index < toolCalls; index += 1) {
          yield { type: "session.tool.called", data: { sessionID, id: `tool-${index}`, input: {}, executed: false } };
        }
        if (executionError && emitFailureEvent) {
          yield { type: "session.execution.failed", data: { sessionID, error: executionError } };
          markExecutionObserved();
        }
        while (!options.signal.aborted) await Bun.sleep(2);
      },
    },
    permission: {
      reply: async (input: Record<string, unknown>) => { permissionReplies.push(input); },
    },
    message: {
      list: async (input: { limit?: number; order?: "asc" | "desc" }) => {
        messageListInputs.push(input);
        if (input.limit === 1 && input.order === "desc") {
          const type = latestTurnMessage?.() ?? "idle";
          return {
            data: [{ id: `${type}-latest`, type, outcome: "succeeded", time: { created: Date.now() } }],
            cursor: {},
          };
        }
        const assistantMessage = {
          id: "message-1",
          type: "assistant",
          agent: "build",
          model: { providerID: "fake", id: "model" },
          time: { created: Date.now() },
          content: [{ type: "text", text: "Hello world" }],
        };
        if (input.limit === 1 && prompts.length === 0) {
          return { data: [assistantMessage], cursor: {} };
        }
        return {
          data: [
            ...(executionError ? [{
              id: "idle-error",
              type: "idle",
              outcome: "failed",
              error: executionError,
              time: { created: Date.now() },
            }] : []),
            assistantMessage,
          ],
          cursor: {},
        };
      },
    },
  };
  return { client: client as unknown as OpenCodeClient, environmentCalls, permissionReplies, prompts, messageListInputs };
}

async function runExistingSession(
  fake: ReturnType<typeof fakeClient>,
  directory: string,
  sessionID: string,
  listBackgroundJobs: ListOpenCodeBackgroundJobs = async () => [],
): Promise<unknown> {
  const workspace = join(directory, "workspace");
  const attempt = join(directory, "attempt");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(attempt, { recursive: true });
  const runtime = new OpenCodeRuntime(fake.client, "fake", listBackgroundJobs);
  try {
    return await runtime.run({
      runId: "run_quota",
      agentName: "implementer",
      options: { agent: "build" },
      prompt: "Continue the implementation",
      workspacePath: workspace,
      environment: { GH_TOKEN: "secret", PATH: "/bin" },
      existingSessionId: sessionID,
      attemptDirectory: attempt,
      timeoutMs: 5000,
      signal: new AbortController().signal,
      emit: () => undefined,
      onSession: () => undefined,
    });
  } catch (error) {
    return error;
  }
}

describe("OpenCode client adapter", () => {
  test("waits asynchronously, refreshes environment per tool, rejects approvals, collects output, and cleans tokens", async () => {
    const directory = temporaryDirectory();
    try {
      const workspace = join(directory, "workspace");
      const attempt = join(directory, "attempt");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(attempt, { recursive: true });
      const fake = fakeClient("opencode-session", undefined, true, 2);
      const runtime = new OpenCodeRuntime(fake.client, "fake", async () => []);
      const events: RuntimeEvent[] = [];
      const result = await runtime.run({
        runId: "run_oc",
        agentName: "maintainer",
        options: { agent: "build" },
        prompt: "Review the issue",
        workspacePath: workspace,
        environment: {
          GH_TOKEN: "secret",
          GITHUB_TOKEN: "secret",
          PATH: "/bin",
          GIT_CONFIG_VALUE_0: "secret-helper",
          GIT_CONFIG_VALUE_1: "another-secret-helper",
        },
        existingSessionId: null,
        attemptDirectory: attempt,
        timeoutMs: 5000,
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
        onSession: () => undefined,
      });
      expect(result.sessionId).toBe("opencode-session");
      expect(result.response).toBe("Hello world");
      expect(result.usage?.costUsd).toBe(0.25);
      expect(fake.prompts).toEqual(["Review the issue"]);
      expect(fake.messageListInputs.some((input) => input.limit === 200)).toBe(true);
      expect(fake.permissionReplies[0]).toMatchObject({ requestID: "permission-1", decision: "reject" });
      expect(fake.environmentCalls).toHaveLength(4);
      expect(fake.environmentCalls[0]?.GH_TOKEN).toBe("secret");
      expect(fake.environmentCalls[1]?.GH_TOKEN).toBe("secret");
      expect(fake.environmentCalls[2]?.GH_TOKEN).toBe("secret");
      expect(fake.environmentCalls.at(-1)?.GH_TOKEN).toBeUndefined();
      expect(fake.environmentCalls.at(-1)?.GITHUB_TOKEN).toBeUndefined();
      expect(fake.environmentCalls.at(-1)?.GIT_CONFIG_VALUE_0).toBeUndefined();
      expect(fake.environmentCalls.at(-1)?.GIT_CONFIG_VALUE_1).toBeUndefined();
      expect(events.some((event) => event.type === "opencode.snapshot.session")).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("classifies a structured provider quota failure for automatic retry", async () => {
    const directory = temporaryDirectory();
    try {
      const fake = fakeClient("quota-session", quotaError);
      const thrown = await runExistingSession(fake, directory, "quota-session");
      expect(thrown).toBeInstanceOf(ProviderQuotaError);
      expect((thrown as ProviderQuotaError).details.sessionId).toBe("quota-session");
      expect((thrown as ProviderQuotaError).message).toContain("5-hour usage limit");
      expect(fake.environmentCalls.at(-1)?.GH_TOKEN).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("classifies quota from the message snapshot when wait finishes before the failure event", async () => {
    const directory = temporaryDirectory();
    try {
      const fake = fakeClient("snapshot-quota-session", quotaError, false);
      const thrown = await runExistingSession(fake, directory, "snapshot-quota-session");
      expect(thrown).toBeInstanceOf(ProviderQuotaError);
      expect((thrown as ProviderQuotaError).details.sessionId).toBe("snapshot-quota-session");
      expect((thrown as ProviderQuotaError).message).toContain("5-hour usage limit");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("waits for a running subagent and subsequent parent turns before cleanup", async () => {
    const directory = temporaryDirectory();
    const root = "opencode-session";
    const child = "child-session";
    const waitOrder: string[] = [];
    let parentWaits = 0;
    let childFinished = false;
    const runningSubagent: OpenCodeBackgroundJob = {
      id: "job-subagent",
      kind: "subagent",
      sessionID: root,
      childSessionID: child,
      status: "running",
    };
    try {
      const fake = fakeClient(root, undefined, true, 0, async (sessionID) => {
        waitOrder.push(sessionID);
        if (sessionID === root) {
          parentWaits += 1;
        } else {
          await Bun.sleep(5);
          childFinished = true;
        }
      });
      const result = await runExistingSession(
        fake,
        directory,
        root,
        async () => childFinished ? [] : [runningSubagent],
      );
      expect(result).toMatchObject({ sessionId: root });
      expect(childFinished).toBe(true);
      expect(waitOrder[0]).toBe(root);
      expect(waitOrder).toContain(child);
      expect(parentWaits).toBeGreaterThanOrEqual(2);
      expect(fake.environmentCalls.at(-1)?.GH_TOKEN).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("waits for an unconsumed subagent completion report", async () => {
    const directory = temporaryDirectory();
    const root = "opencode-session";
    let parentWaits = 0;
    let jobQueries = 0;
    const completedSubagent: OpenCodeBackgroundJob = {
      id: "job-completed",
      kind: "subagent",
      sessionID: root,
      childSessionID: "child-session",
      status: "completed",
    };
    try {
      const fake = fakeClient(root, undefined, true, 0, async (sessionID) => {
        if (sessionID === root) parentWaits += 1;
      });
      const result = await runExistingSession(fake, directory, root, async () => {
        jobQueries += 1;
        return jobQueries === 1 ? [completedSubagent] : [];
      });
      expect(result).toMatchObject({ sessionId: root });
      expect(jobQueries).toBeGreaterThanOrEqual(2);
      expect(parentWaits).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("waits for an unconsumed shell completion report", async () => {
    const directory = temporaryDirectory();
    const root = "opencode-session";
    let parentWaits = 0;
    let jobQueries = 0;
    const completedShell: OpenCodeBackgroundJob = {
      id: "job-shell-completed",
      kind: "shell",
      sessionID: root,
      status: "completed",
    };
    try {
      const fake = fakeClient(root, undefined, true, 0, async (sessionID) => {
        if (sessionID === root) parentWaits += 1;
      });
      const result = await runExistingSession(fake, directory, root, async () => {
        jobQueries += 1;
        return jobQueries === 1 ? [completedShell] : [];
      });
      expect(result).toMatchObject({ sessionId: root });
      expect(jobQueries).toBeGreaterThanOrEqual(2);
      expect(parentWaits).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("waits for a running shell and then consumes its completion report", async () => {
    const directory = temporaryDirectory();
    const root = "opencode-session";
    const runningShell: OpenCodeBackgroundJob = {
      id: "job-build",
      kind: "shell",
      sessionID: root,
      status: "running",
    };
    const completedShell: OpenCodeBackgroundJob = { ...runningShell, status: "completed" };
    let jobQueries = 0;
    try {
      const fake = fakeClient(root);
      const result = await runExistingSession(fake, directory, root, async () => {
        jobQueries += 1;
        if (jobQueries === 1) return [runningShell];
        if (jobQueries === 2) return [completedShell];
        return [];
      });
      expect(result).toMatchObject({ sessionId: root });
      expect(jobQueries).toBe(4);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("restarts completion when the parent generation changes during a stale snapshot", async () => {
    const root = "opencode-session";
    let generation = 0;
    let jobQueries = 0;
    let activeQueries = 0;
    const client = {
      experimental: { session: { wait: async () => undefined } },
      session: {
        get: async () => ({ outcome: "succeeded" }),
        list: async () => ({ data: [], cursor: {} }),
        active: async () => {
          activeQueries += 1;
          if (activeQueries === 1) generation += 1;
          return {};
        },
        inbox: { list: async () => [] },
      },
    } as unknown as OpenCodeClient;
    await waitForOpenCodeSession({
      client,
      sessionID: root,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      listBackgroundJobs: async () => {
        jobQueries += 1;
        return [];
      },
      getSessionGeneration: async () => generation,
    });
    expect(activeQueries).toBe(4);
    expect(jobQueries).toBe(4);
  });

  test("returns a failed parent for error handling despite pending inbox work", async () => {
    const root = "opencode-session";
    let jobQueries = 0;
    const client = {
      experimental: { session: { wait: async () => undefined } },
      session: {
        get: async () => ({ outcome: "failed" }),
        active: async () => ({}),
        inbox: { list: async () => [{ delivery: "steer" }] },
      },
    } as unknown as OpenCodeClient;
    await waitForOpenCodeSession({
      client,
      sessionID: root,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      listBackgroundJobs: async () => {
        jobQueries += 1;
        return [];
      },
      getSessionGeneration: async () => 0,
    });
    expect(jobQueries).toBe(0);
  });

  test("revalidates jobs created after an initially empty result", async () => {
    const root = "opencode-session";
    let jobQueries = 0;
    const runningShell: OpenCodeBackgroundJob = {
      id: "job-created-mid-check",
      kind: "shell",
      sessionID: root,
      status: "running",
    };
    const client = {
      experimental: { session: { wait: async () => undefined } },
      session: {
        get: async () => ({ outcome: "succeeded" }),
        list: async () => ({ data: [], cursor: {} }),
        active: async () => ({}),
        inbox: { list: async () => [] },
      },
    } as unknown as OpenCodeClient;
    await waitForOpenCodeSession({
      client,
      sessionID: root,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      listBackgroundJobs: async () => {
        jobQueries += 1;
        if (jobQueries === 1) return [];
        if (jobQueries === 2) return [runningShell];
        return [];
      },
      getSessionGeneration: async () => 0,
    });
    expect(jobQueries).toBe(4);
  });

  test("waits for coordinator settlement after the terminal idle message", async () => {
    const directory = temporaryDirectory();
    const root = "opencode-session";
    let jobQueries = 0;
    try {
      const fake = fakeClient(
        root,
        undefined,
        true,
        0,
        undefined,
        "2.3.0",
        undefined,
        undefined,
        () => jobQueries < 3,
      );
      const result = await runExistingSession(fake, directory, root, async () => {
        jobQueries += 1;
        return [];
      });
      expect(result).toMatchObject({ sessionId: root });
      expect(jobQueries).toBe(4);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("revalidates active descendants after job and inbox reads", async () => {
    const directory = temporaryDirectory();
    const root = "opencode-session";
    const child = "child-session";
    let jobQueries = 0;
    let activeQueries = 0;
    try {
      const fake = fakeClient(
        root,
        undefined,
        true,
        0,
        undefined,
        "2.3.0",
        undefined,
        undefined,
        undefined,
        () => [{ id: child }],
        () => {
          activeQueries += 1;
          return activeQueries === 2 ? [child] : [];
        },
      );
      const result = await runExistingSession(fake, directory, root, async () => {
        jobQueries += 1;
        return [];
      });
      expect(result).toMatchObject({ sessionId: root });
      expect(activeQueries).toBe(4);
      expect(jobQueries).toBe(4);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("waits for both steering and queued inbox work", async () => {
    const directory = temporaryDirectory();
    let steeringQueries = 0;
    let queuedQueries = 0;
    try {
      const steering = fakeClient(
        "steering-session",
        undefined,
        true,
        0,
        undefined,
        "2.3.0",
        undefined,
        () => steeringQueries < 2 ? [{ delivery: "steer" }] : [],
      );
      const steeringResult = await runExistingSession(steering, directory, "steering-session", async () => {
        steeringQueries += 1;
        return [];
      });
      expect(steeringResult).toMatchObject({ sessionId: "steering-session" });
      expect(steeringQueries).toBe(4);

      const queued = fakeClient(
        "queued-session",
        undefined,
        true,
        0,
        undefined,
        "2.3.0",
        undefined,
        () => queuedQueries < 2 ? [{ delivery: "queue" }] : [],
      );
      const queuedResult = await runExistingSession(queued, directory, "queued-session", async () => {
        queuedQueries += 1;
        return [];
      });
      expect(queuedResult).toMatchObject({ sessionId: "queued-session" });
      expect(queuedQueries).toBe(4);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("queries descendant jobs through the typed client and propagates failures", async () => {
    const calls: Array<{ sessionID?: string; descendants?: boolean }> = [];
    const signal = new AbortController().signal;
    const job: OpenCodeBackgroundJob = {
      id: "job-subagent",
      kind: "subagent",
      sessionID: "root-session",
      childSessionID: "child-session",
      status: "running",
    };
    const client = {
      experimental: {
        job: {
          list: async (input: { sessionID: string; descendants: boolean }, options: { signal: AbortSignal }) => {
            calls.push(input);
            expect(options.signal).toBe(signal);
            return [job];
          },
        },
      },
    } as unknown as OpenCodeClient;
    const list = createOpenCodeBackgroundJobLister(client);
    expect(await list("root-session", signal)).toEqual([job]);
    expect(calls).toEqual([{ sessionID: "root-session", descendants: true }]);

    const failing = createOpenCodeBackgroundJobLister({
      experimental: { job: { list: async () => { throw new Error("jobs unavailable"); } } },
    } as unknown as OpenCodeClient);
    await expect(failing("root-session", signal)).rejects.toThrow("jobs unavailable");
  });

  test("reads the server-authoritative session-log watermark", async () => {
    const signal = new AbortController().signal;
    const client = {
      experimental: {
        session: {
          log: async function* (input: { follow?: boolean }, options: { signal: AbortSignal }) {
            expect(input.follow).toBe(false);
            expect(options.signal).toBe(signal);
            yield { type: "session.execution.started", durable: { seq: 4 } };
            yield { type: "log.synced", aggregateID: "root-session", seq: 7 };
          },
        },
      },
    } as unknown as OpenCodeClient;
    expect(await readOpenCodeSessionGeneration(client, "root-session", signal)).toBe(7);
  });

  test("requires OpenCode 2.3 or newer before prompt admission", async () => {
    expect(isSupportedOpenCodeVersion("2.2.9")).toBe(false);
    expect(isSupportedOpenCodeVersion("2.3.0")).toBe(true);
    expect(isSupportedOpenCodeVersion("2.10.0")).toBe(true);
    expect(isSupportedOpenCodeVersion("3.0.0")).toBe(true);
    expect(isSupportedOpenCodeVersion("development")).toBe(false);

    const directory = temporaryDirectory();
    try {
      const fake = fakeClient("old-server", undefined, true, 0, undefined, "2.2.5");
      const thrown = await runExistingSession(fake, directory, "old-server");
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("OpenCode >= 2.3.0");
      expect(fake.prompts).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
