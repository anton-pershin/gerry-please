import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig, type LoadedConfig } from "../src/config.ts";
import type { JsonObject, WebhookContext } from "../src/types.ts";
import { buildContext } from "../src/rules.ts";

export function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "gerry-test-"));
}

export function issuePayload(action = "opened"): JsonObject {
  return {
    action,
    installation: { id: 1234 },
    repository: { full_name: "acme/widgets", html_url: "https://github.com/acme/widgets" },
    sender: { login: "alice" },
    issue: {
      number: 42,
      title: "Add retries",
      body: "Please add bounded retries",
      html_url: "https://github.com/acme/widgets/issues/42",
      labels: [],
    },
  };
}

export function context(payload: JsonObject = issuePayload(), event = "issues"): WebhookContext {
  return buildContext({ deliveryId: "delivery-1", event, action: String(payload.action ?? ""), payload });
}

export function configFixture(directory = temporaryDirectory()): { config: LoadedConfig; directory: string } {
  mkdirSync(join(directory, "repo"), { recursive: true });
  writeFileSync(join(directory, "task.md"), "Handle {{issue.title}} in {{repository.full_name}}\n");
  writeFileSync(join(directory, "agent.md"), "You are a careful implementation agent.\n");
  const raw = {
    server: { data_dir: ".data", workers: 1 },
    repositories: { "acme/widgets": { path: "repo", default_branch: "main" } },
    runtimes: {
      hermes: { type: "hermes", command: "hermes" },
    },
    agents: {
      implementer: {
        runtime: "hermes",
        instructions: "agent.md",
        workspace: "shared",
        max_attempts: 3,
        retry_backoff_seconds: 1,
        options: { profile: "implementer", max_turns: 20 },
      },
    },
    rules: [
      {
        name: "implement",
        on: { event: "issues", actions: ["opened"] },
        when: [],
        agent: "implementer",
        prompt: "task.md",
        session: "fresh",
        once_per_subject: true,
      },
    ],
  };
  const path = join(directory, "gerry.yaml");
  writeFileSync(path, stringify(raw));
  return { config: loadConfig(path), directory };
}
