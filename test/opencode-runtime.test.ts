import { describe, expect, test } from "bun:test";
import type { OpenCodeClient } from "@opencode/client";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OpenCodeRuntime } from "../src/runtimes/opencode.ts";
import { ProviderQuotaError } from "../src/runtimes/types.ts";
import type { RuntimeEvent } from "../src/types.ts";
import { temporaryDirectory } from "./helpers.ts";

const quotaError = {
  type: "provider.quota",
  message: "You've reached your 5-hour usage limit.",
  status: 429,
  response: { body: JSON.stringify({ error: { type: "exceeded_current_quota_error" } }) },
};

function fakeClient(sessionID = "opencode-session", executionError?: unknown, emitFailureEvent = true) {
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
    server: { info: async () => ({}) },
    session: {
      create: async () => session,
      get: async () => session,
      environment: async (input: { variables: Record<string, string> }) => { environmentCalls.push(input.variables); },
      prompt: async (input: { text: string }) => { prompts.push(input.text); return {}; },
      interrupt: async () => ({}),
    },
    experimental: { session: { wait: async () => { if (executionError && emitFailureEvent) await executionObserved; } } },
    event: {
      subscribe: async function* (options: { signal: AbortSignal }) {
        yield { type: "server.connected", data: {} };
        yield { type: "permission.asked", data: { id: "permission-1", sessionID, action: "shell", resources: ["rm *"] } };
        yield { type: "session.text.delta", data: { sessionID, delta: "Hello " } };
        yield { type: "session.text.delta", data: { sessionID, delta: "world" } };
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
      list: async (input: { limit?: number }) => {
        messageListInputs.push(input);
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
): Promise<unknown> {
  const workspace = join(directory, "workspace");
  const attempt = join(directory, "attempt");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(attempt, { recursive: true });
  const runtime = new OpenCodeRuntime(fake.client, "fake");
  try {
    await runtime.run({
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
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("OpenCode client adapter", () => {
  test("waits asynchronously, rejects approvals, collects output, and cleans tokens", async () => {
    const directory = temporaryDirectory();
    try {
      const workspace = join(directory, "workspace");
      const attempt = join(directory, "attempt");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(attempt, { recursive: true });
      const fake = fakeClient();
      const runtime = new OpenCodeRuntime(fake.client, "fake");
      const events: RuntimeEvent[] = [];
      const result = await runtime.run({
        runId: "run_oc",
        agentName: "maintainer",
        options: { agent: "build" },
        prompt: "Review the issue",
        workspacePath: workspace,
        environment: { GH_TOKEN: "secret", GITHUB_TOKEN: "secret", PATH: "/bin", GIT_CONFIG_VALUE_0: "secret-helper" },
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
      expect(fake.messageListInputs[0]?.limit).toBe(200);
      expect(fake.permissionReplies[0]).toMatchObject({ requestID: "permission-1", decision: "reject" });
      expect(fake.environmentCalls[0]?.GH_TOKEN).toBe("secret");
      expect(fake.environmentCalls.at(-1)?.GH_TOKEN).toBeUndefined();
      expect(fake.environmentCalls.at(-1)?.GITHUB_TOKEN).toBeUndefined();
      expect(fake.environmentCalls.at(-1)?.GIT_CONFIG_VALUE_0).toBeUndefined();
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
});
