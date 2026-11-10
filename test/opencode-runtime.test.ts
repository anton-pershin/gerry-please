import { describe, expect, test } from "bun:test";
import type { OpenCodeClient } from "@opencode/client";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { OpenCodeRuntime } from "../src/runtimes/opencode.ts";
import type { RuntimeEvent } from "../src/types.ts";
import { temporaryDirectory } from "./helpers.ts";

function fakeClient(sessionID = "opencode-session") {
  const environmentCalls: Array<Record<string, string>> = [];
  const permissionReplies: Array<Record<string, unknown>> = [];
  const prompts: string[] = [];
  const messageListInputs: Array<{ limit?: number }> = [];
  const session = {
    id: sessionID,
    projectID: "project",
    cost: 0.25,
    tokens: { input: 100, output: 20, reasoning: 3, cache: { read: 10, write: 2 } },
    outcome: "succeeded",
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
    experimental: { session: { wait: async () => {} } },
    event: {
      subscribe: async function* (options: { signal: AbortSignal }) {
        yield { type: "server.connected", data: {} };
        yield { type: "permission.asked", data: { id: "permission-1", sessionID, action: "shell", resources: ["rm *"] } };
        yield { type: "session.text.delta", data: { sessionID, delta: "Hello " } };
        yield { type: "session.text.delta", data: { sessionID, delta: "world" } };
        while (!options.signal.aborted) await Bun.sleep(2);
      },
    },
    permission: {
      reply: async (input: Record<string, unknown>) => { permissionReplies.push(input); },
    },
    message: {
      list: async (input: { limit?: number }) => {
        messageListInputs.push(input);
        return {
        data: [{
          id: "message-1",
          type: "assistant",
          agent: "build",
          model: { providerID: "fake", id: "model" },
          time: { created: Date.now() },
          content: [{ type: "text", text: "Hello world" }],
        }],
          cursor: {},
        };
      },
    },
  };
  return { client: client as unknown as OpenCodeClient, environmentCalls, permissionReplies, prompts, messageListInputs };
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
});
