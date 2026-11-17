import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  AgentCredentialService,
  applyAgentCredentialWrappers,
  writeAgentCredentialWrappers,
} from "../src/credentials.ts";
import { readPrompt } from "../src/config.ts";
import { Logger } from "../src/observability.ts";
import { createFetchHandler, WebhookHandler } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { configFixture, context, temporaryDirectory } from "./helpers.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function activeRun() {
  const fixture = configFixture();
  directories.push(fixture.directory);
  const store = new Store(fixture.config.dataDir);
  const webhook = context();
  const payloadPath = join(fixture.config.dataDir, "deliveries", "delivery.json");
  writeFileSync(payloadPath, JSON.stringify(webhook.payload));
  store.insertDelivery({
    id: webhook.deliveryId,
    event: webhook.event,
    action: webhook.action,
    repository: webhook.repository,
    installationId: webhook.installationId,
    payloadPath,
  });
  const rule = fixture.config.rules[0]!;
  const agent = fixture.config.agents[rule.agent]!;
  const prompt = readPrompt(fixture.config, rule.prompt);
  const decision = store.enqueueRun({
    context: webhook,
    rule,
    agent,
    agentName: rule.agent,
    runtimeName: agent.runtime,
    runtime: fixture.config.runtimes[agent.runtime]!,
    promptPath: prompt.path,
    promptHash: prompt.hash,
    promptContents: prompt.contents,
    instructions: "Test",
    configHash: fixture.config.hash,
    parentRunId: null,
  });
  const run = store.claimNext("worker")!;
  expect(run.id).toBe(decision.runId!);
  const capability = "test-capability";
  store.setAgentCapability(run.id, createHash("sha256").update(capability).digest("hex"), "worker");
  return { fixture, store, run, capability };
}

function credentialRequest(runId: string, capability: string): Request {
  return new Request("http://localhost/agent/github/token", {
    method: "POST",
    headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
    body: JSON.stringify({ runId }),
  });
}

async function execute(command: string, args: string[], environment: Record<string, string>, input?: string) {
  const child = spawn(command, args, { env: environment });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { status, stdout, stderr };
}

describe("agent GitHub credentials", () => {
  test("issues same-repository tokens only for the active capability owner", async () => {
    const { fixture, store, run, capability } = activeRun();
    const calls: Array<[number, string, number | undefined]> = [];
    const service = new AgentCredentialService(store, {
      get: async (installationId, repository, minimumLifetimeMs) => {
        calls.push([installationId, repository, minimumLifetimeMs]);
        return "fresh-installation-token";
      },
    }, new Logger(join(fixture.config.dataDir, "service.jsonl"), undefined, false));
    const handler = createFetchHandler({
      config: fixture.config,
      store,
      webhook: new WebhookHandler(fixture.config, store, {
        appId: "1",
        privateKey: "unused",
        webhookSecret: "unused",
      }, new Logger(join(fixture.config.dataDir, "webhook.jsonl"), undefined, false)),
      credentials: service,
    });

    const invalid = await service.handleAgentRequest(credentialRequest(run.id, "wrong"));
    expect(invalid.status).toBe(401);
    expect(calls).toHaveLength(0);

    const issued = await handler(credentialRequest(run.id, capability));
    expect(issued.status).toBe(200);
    expect(issued.headers.get("cache-control")).toBe("no-store");
    expect(await issued.text()).toBe("fresh-installation-token");
    expect(calls).toEqual([[1234, "acme/widgets", undefined]]);

    const wrongOwner = await service.handleAgentRequest(credentialRequest("run_other", capability));
    expect(wrongOwner.status).toBe(403);
    expect(calls).toHaveLength(1);

    store.succeed(run.id, "worker", { runtimeSessionId: "session", responsePath: "/tmp/response", usage: null });
    const expired = await service.handleAgentRequest(credentialRequest(run.id, capability));
    expect(expired.status).toBe(401);
    expect(calls).toHaveLength(1);
    store.close();
  });

  test("gh and Git wrappers obtain fresh credentials for separate invocations", async () => {
    const directory = temporaryDirectory();
    directories.push(directory);
    const realGhPath = join(directory, "real-gh");
    writeFileSync(realGhPath, "#!/bin/sh\nprintf '%s|%s\\n' \"$GH_TOKEN\" \"$*\"\n", { mode: 0o700 });
    chmodSync(realGhPath, 0o700);
    const hostHelperPath = join(directory, "host-credential-helper");
    writeFileSync(hostHelperPath, "#!/bin/sh\nprintf 'username=host-user\\npassword=host-password\\n'\n", { mode: 0o700 });
    chmodSync(hostHelperPath, 0o700);
    const hostGitConfig = join(directory, "host-gitconfig");
    writeFileSync(hostGitConfig, `[credential]\n helper = ${hostHelperPath}\n`);

    let issued = 0;
    const requests: Array<{ runId: string; capability: string }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const body = await request.json() as { runId: string };
        requests.push({ runId: body.runId, capability: request.headers.get("authorization") ?? "" });
        issued += 1;
        return new Response(`ghs_wrapper_token_${issued}_12345678901234567890`);
      },
    });
    try {
      const wrapperDirectory = join(directory, "bin");
      writeAgentCredentialWrappers({
        directory: wrapperDirectory,
        runId: "run_test",
        credentialUrl: `http://127.0.0.1:${server.port}/agent/github/token`,
        realGhPath,
      });
      const environment = { ...process.env, GERRY_AGENT_TOKEN: "test-capability", PATH: "/usr/bin:/bin" } as Record<string, string>;
      environment.HOME = join(directory, "home");
      environment.XDG_CONFIG_HOME = join(directory, "xdg");
      environment.GIT_CONFIG_NOSYSTEM = "1";
      environment.GIT_CONFIG_GLOBAL = hostGitConfig;
      applyAgentCredentialWrappers(environment, wrapperDirectory);
      expect(environment.PATH).toBe(`${wrapperDirectory}:/usr/bin:/bin`);
      expect(environment.GIT_CONFIG_VALUE_0).toBe("");
      expect(environment.GIT_CONFIG_VALUE_1).toContain(join(wrapperDirectory, "git-credential-gerry"));

      const ghPath = join(wrapperDirectory, "gh");
      const first = await execute(ghPath, ["pr", "view", "5"], environment);
      const second = await execute(ghPath, ["pr", "view", "6"], environment);
      expect(first.status).toBe(0);
      expect(second.status).toBe(0);
      expect(first.stdout).toContain("ghs_wrapper_token_1_");
      expect(first.stdout).toContain("pr view 5");
      expect(second.stdout).toContain("ghs_wrapper_token_2_");

      const helperPath = join(wrapperDirectory, "git-credential-gerry");
      const input = "protocol=https\nhost=github.com\n\n";
      const third = await execute(helperPath, ["get"], environment, input);
      const fourth = await execute(helperPath, ["get"], environment, input);
      expect(third.status).toBe(0);
      expect(fourth.status).toBe(0);
      expect(third.stdout).toContain("password=ghs_wrapper_token_3_");
      expect(fourth.stdout).toContain("password=ghs_wrapper_token_4_");

      const git = await execute("git", ["credential", "fill"], environment, input);
      expect(git.status).toBe(0);
      expect(git.stderr).toBe("");
      expect(git.stdout).toContain("password=ghs_wrapper_token_5_");
      expect(requests).toEqual(Array.from({ length: 5 }, () => ({
        runId: "run_test",
        capability: "Bearer test-capability",
      })));
    } finally {
      server.stop(true);
    }
  });
});
