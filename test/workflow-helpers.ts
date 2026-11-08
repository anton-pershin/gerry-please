import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { loadConfig, readPrompt, type RuleConfig } from "../src/config.ts";
import { buildContext } from "../src/rules.ts";
import type { Store } from "../src/store.ts";
import type { JsonObject, WebhookContext } from "../src/types.ts";
import { configFixture, issuePayload } from "./helpers.ts";

export function workflowConfigFixture(withDependencies = false) {
  const fixture = configFixture();
  const path = join(fixture.directory, "gerry.yaml");
  const raw = parse(readFileSync(path, "utf8")) as any;
  raw.agents.implementer.workspace = "worktree";
  raw.rules = [
    {
      name: "implement-approved-issue",
      on: { event: "issues", actions: ["labeled"] },
      when: [{ path: "label.name", equals: "approved" }],
      agent: "implementer",
      prompt: "task.md",
      session: "workflow",
      workflow: "implementation",
      workflow_start: true,
      max_turns: 20,
      once_per_subject: true,
    },
    {
      name: "address-pr-review",
      on: { event: "pull_request_review_comment", actions: ["created"] },
      when: [{ path: "comment.body", contains: "@implementer", ignore_case: true }],
      agent: "implementer",
      prompt: "review.md",
      session: "workflow",
      workflow: "implementation",
      workflow_start: false,
      max_turns: 20,
      once_per_subject: false,
    },
  ];
  writeFileSync(join(fixture.directory, "review.md"), "Address review on PR #{{pull_request.number}} in {{workflow.id}}\n");
  if (withDependencies) {
    raw.repositories["acme/library"] = { path: "library", default_branch: "main" };
    raw.dependencies = [{
      from: "acme/widgets",
      to: "acme/library",
      allow_issue_creation: true,
      resume: {
        agent: "implementer",
        prompt: "resume.md",
        workflow: "implementation",
        max_turns: 20,
      },
    }];
    writeFileSync(join(fixture.directory, "resume.md"), "Resume after {{dependency.targetIssueUrl}} at {{dependency.mergeCommitSha}}\n");
  }
  writeFileSync(path, stringify(raw));
  return { ...fixture, config: loadConfig(path) };
}

export function issueContext(number = 42, deliveryId = `issue-${number}`): WebhookContext {
  const payload = issuePayload("labeled");
  payload.label = { name: "approved" };
  (payload.issue as Record<string, unknown>).number = number;
  return buildContext({ deliveryId, event: "issues", action: "labeled", payload });
}

export function prContext(input: {
  number?: number;
  branch: string;
  deliveryId?: string;
  event?: string;
  action?: string;
  body?: string;
  merged?: boolean;
  repository?: string;
  installationId?: number;
  reviewState?: string;
  baseRef?: string;
  headRepository?: string;
  mergeCommitSha?: string;
}): WebhookContext {
  const event = input.event ?? "pull_request_review_comment";
  const action = input.action ?? "created";
  const number = input.number ?? 100;
  const payload: JsonObject = {
    action,
    installation: { id: input.installationId ?? 1234 },
    repository: { full_name: input.repository ?? "acme/widgets" },
    pull_request: {
      number,
      title: "Implementation",
      body: input.body ?? "",
      html_url: `https://github.com/${input.repository ?? "acme/widgets"}/pull/${number}`,
      head: { ref: input.branch, repo: { full_name: input.headRepository ?? input.repository ?? "acme/widgets" } },
      base: { ref: input.baseRef ?? "main", repo: { full_name: input.repository ?? "acme/widgets" } },
      ...(input.merged === undefined ? {} : { merged: input.merged }),
      ...(input.merged ? { merged_at: new Date().toISOString(), merge_commit_sha: input.mergeCommitSha ?? "abc123" } : {}),
    },
  };
  if (event === "pull_request_review_comment") payload.comment = { body: "@implementer please address this" };
  if (input.reviewState) payload.review = { state: input.reviewState, body: "" };
  return buildContext({ deliveryId: input.deliveryId ?? `pr-${number}-${action}`, event, action, payload });
}

export function enqueueWorkflow(store: Store, fixture: ReturnType<typeof workflowConfigFixture>, context: WebhookContext, ruleName: string) {
  const path = join(fixture.config.dataDir, "deliveries", `${context.deliveryId}.json`);
  writeFileSync(path, JSON.stringify(context.payload));
  store.insertDelivery({
    id: context.deliveryId,
    event: context.event,
    action: context.action,
    repository: context.repository,
    installationId: context.installationId,
    payloadPath: path,
  });
  const rule = fixture.config.rules.find((candidate) => candidate.name === ruleName)!;
  const agent = fixture.config.agents[rule.agent]!;
  const prompt = readPrompt(fixture.config, rule.prompt);
  return store.enqueueRun({
    context,
    rule,
    agent,
    agentName: rule.agent,
    runtimeName: agent.runtime,
    runtime: fixture.config.runtimes[agent.runtime]!,
    promptPath: prompt.path,
    promptHash: prompt.hash,
    promptContents: prompt.contents,
    instructions: "Implement carefully\n",
    configHash: fixture.config.hash,
    parentRunId: null,
  });
}

export function initializeOrigin(directory: string): void {
  const origin = join(directory, "origin.git");
  const repository = join(directory, "repo");
  git(directory, "init", "--bare", origin);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.email", "tests@example.com");
  git(repository, "config", "user.name", "Tests");
  writeFileSync(join(repository, "README.md"), "test\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "initial");
  git(repository, "remote", "add", "origin", origin);
  git(repository, "push", "-u", "origin", "main");
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}
