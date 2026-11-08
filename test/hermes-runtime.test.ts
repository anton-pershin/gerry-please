import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HermesRuntime } from "../src/runtimes/hermes.ts";
import { RuntimeExecutionError } from "../src/runtimes/types.ts";
import type { RuntimeEvent } from "../src/types.ts";
import { temporaryDirectory } from "./helpers.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(script: string) {
  const directory = temporaryDirectory();
  directories.push(directory);
  const command = join(directory, "fake-hermes");
  writeFileSync(command, script);
  chmodSync(command, 0o755);
  const workspace = join(directory, "workspace");
  const attempt = join(directory, "attempt");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(attempt, { recursive: true });
  const runtime = new HermesRuntime({ type: "hermes", command }, "fake");
  return { directory, command, workspace, attempt, runtime };
}

function input(testFixture: ReturnType<typeof fixture>, events: RuntimeEvent[]) {
  return {
    runId: "run_hermes",
    agentName: "implementer",
    options: {},
    prompt: "Do the task",
    workspacePath: testFixture.workspace,
    environment: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GH_TOKEN: "secret-token-for-redaction",
      FAKE_HERMES_ARGS: join(testFixture.directory, "arguments.txt"),
    },
    existingSessionId: null,
    attemptDirectory: testFixture.attempt,
    timeoutMs: 5000,
    signal: new AbortController().signal,
    emit: (event: RuntimeEvent) => events.push(event),
    onSession: () => undefined,
  };
}

describe("Hermes process adapter", () => {
  test("collects JSONL response, session, usage, and redacted stderr", async () => {
    const fixture = fixtureForTest(`#!/bin/sh
printf '%s\\n' "$@" > "$FAKE_HERMES_ARGS"
echo "leaked $GH_TOKEN" >&2
printf '%s\\n' '{"type":"system","subtype":"init","model":"fake","session_id":"hermes-session"}'
printf '%s\\n' '{"type":"text","text":"ignored partial"}'
printf '%s\\n' '{"type":"result","session_id":"hermes-session","exit_code":0,"text":"complete response","tokens":{"input":10,"output":5,"total":15,"cache_read":2}}'
`);
    const events: RuntimeEvent[] = [];
    const result = await fixture.runtime.run(input(fixture, events));
    expect(result.sessionId).toBe("hermes-session");
    expect(result.response).toBe("complete response");
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.cacheReadTokens).toBe(2);
    const stderr = readFileSync(join(fixture.attempt, "stderr.log"), "utf8");
    expect(stderr).not.toContain("secret-token-for-redaction");
    expect(stderr).toContain("[REDACTED]");
    expect(readFileSync(join(fixture.directory, "arguments.txt"), "utf8")).toContain("--format\nstream-json");
    expect(events.some((event) => event.type === "hermes.result")).toBe(true);
  });

  test("forces a stuck process group to exit after the timeout grace period", async () => {
    const fixture = fixtureForTest(`#!/bin/sh
( trap '' TERM; sleep 10 ) &
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"stuck-hermes"}'
exit 0
`);
    const runInput = { ...input(fixture, []), timeoutMs: 25 };
    await expect(fixture.runtime.run(runInput)).rejects.toThrow(/timed out/i);
  });

  test("preserves a partial session ID on process failure", async () => {
    const fixture = fixtureForTest(`#!/bin/sh
printf '%s\\n' '{"type":"system","subtype":"init","session_id":"partial-hermes"}'
printf '%s\\n' '{"type":"result","session_id":"partial-hermes","exit_code":1,"text":"partial","error":"provider unavailable"}'
exit 1
`);
    const promise = fixture.runtime.run(input(fixture, []));
    await expect(promise).rejects.toMatchObject({
      name: "RuntimeExecutionError",
      details: { sessionId: "partial-hermes", response: "partial" },
    });
  });
});

function fixtureForTest(script: string) {
  return fixture(script);
}
