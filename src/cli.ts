#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatConfigError, loadConfig, readPrompt, resolveConfigPath, type LoadedConfig } from "./config.ts";
import { DependencyService } from "./dependencies.ts";
import { GitHubAppTokens, loadGitHubSecrets } from "./github.ts";
import { InstanceLock } from "./instance-lock.ts";
import { Logger, writeRunSummary } from "./observability.ts";
import { createRuntimes } from "./runtimes/index.ts";
import { hermesArguments } from "./runtimes/hermes.ts";
import { validateOpenCodeOptions } from "./runtimes/opencode.ts";
import { WebhookHandler, createFetchHandler } from "./server.ts";
import { Store } from "./store.ts";
import type { RunStatus } from "./types.ts";
import { compactError } from "./util.ts";
import { WorkerPool } from "./worker.ts";

function help(): void {
  console.log(`Gerry, Please — runtime-neutral GitHub multi-agent automation

Usage: gerry [--config PATH] <command> [options]

Commands:
  serve [--skip-checks]       Run the webhook server and durable workers
  validate [--check]          Validate config and files; --check also tests integrations
  doctor                      Run GitHub, runtime, git, and gh health checks
  status                      Show run counts by state
  workflows list              List workflow instances and their current state
  workflows show ID           Show a workflow and its dependencies
  dependencies list           List cross-repository dependency requests
  dependencies attach ID --issue-number N
                                Attach a verified issue after ambiguous creation
  dependencies abandon ID [--reason TEXT]
                                Abandon an unreconciled dependency request
  runs list [--status STATE] [--limit N]
  runs show ID                Show one run and its audit directory
  runs retry ID               Explicitly retry a failed/interrupted/cancelled run
  runs cancel ID              Cancel a queued or retry-waiting run
  runs resolve ID             Release quarantine/ledger after manual reconciliation
  deliveries show ID          Show dispatch decisions for a delivery

Default config: gerry.yaml. Paths in config are relative to that file.`);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function load(path: string): LoadedConfig {
  return loadConfig(path);
}

function validateFiles(config: LoadedConfig): string[] {
  const problems: string[] = [];
  for (const rule of config.rules) {
    try {
      readPrompt(config, rule.prompt);
    } catch (error) {
      problems.push(`Rule ${rule.name}: ${compactError(error)}`);
    }
    if (rule.session === "conversation" && rule.on.event !== "issue_comment" && rule.on.event !== "pull_request_review_comment" && rule.on.event !== "pull_request_review") {
      problems.push(`Rule ${rule.name}: persistent conversations currently require a comment/review event`);
    }
  }
  for (const [index, dependency] of config.dependencies.entries()) {
    if (!dependency.resume) continue;
    try {
      readPrompt(config, dependency.resume.prompt);
    } catch (error) {
      problems.push(`Dependency ${index} resume: ${compactError(error)}`);
    }
  }
  for (const [name, agent] of Object.entries(config.agents)) {
    if (agent.instructions && !existsSync(resolveConfigPath(config.baseDir, agent.instructions))) {
      problems.push(`Agent ${name}: instructions file not found`);
    }
    const runtime = config.runtimes[agent.runtime]!;
    try {
      if (runtime.type === "hermes") {
        hermesArguments({ workspacePath: "/tmp", promptPath: "/tmp/prompt.md", existingSessionId: null, options: agent.options });
      } else {
        validateOpenCodeOptions(agent.options);
      }
    } catch (error) {
      problems.push(`Agent ${name}: ${compactError(error)}`);
    }
  }
  for (const [name, repository] of Object.entries(config.repositories)) {
    if (!existsSync(resolveConfigPath(config.baseDir, repository.path))) problems.push(`Repository ${name}: checkout not found`);
  }
  return problems;
}

async function integrations(config: LoadedConfig, checkGitHub = true): Promise<void> {
  const secrets = loadGitHubSecrets(config);
  if (checkGitHub) await new GitHubAppTokens(secrets).check();
  const runtimes = await createRuntimes(config);
  for (const [name, runtime] of runtimes) {
    await runtime.check();
    console.log(`✓ Runtime ${name} (${runtime.type})`);
  }
  const git = Bun.spawnSync({ cmd: ["git", "--version"], stdout: "pipe", stderr: "pipe" });
  if (git.exitCode !== 0) throw new Error("git is unavailable");
  const gh = Bun.spawnSync({ cmd: ["gh", "--version"], stdout: "pipe", stderr: "pipe" });
  if (gh.exitCode !== 0) throw new Error("gh is unavailable; install GitHub CLI for agent Git operations");
  console.log("✓ GitHub App, git, and gh");
}

async function serve(config: LoadedConfig, skipChecks: boolean): Promise<void> {
  const secrets = loadGitHubSecrets(config);
  const instanceLock = InstanceLock.acquire(config.dataDir);
  process.once("exit", () => instanceLock.release());
  const logger = new Logger(
    `${config.dataDir}/logs/service.jsonl`,
    undefined,
    true,
  ).withSecrets([secrets.privateKey, secrets.webhookSecret, process.env.OPENCODE_TOKEN]);
  const store = new Store(config.dataDir);
  const tokens = new GitHubAppTokens(secrets);
  const runtimes = await createRuntimes(config);
  if (!skipChecks) {
    await tokens.check();
    for (const [name, runtime] of runtimes) {
      await runtime.check();
      logger.info("runtime.ready", { runtime: name, type: runtime.type });
    }
  }
  const workers = new WorkerPool({ config, store, runtimes, tokens, logger });
  const dependencies = new DependencyService(config, store, tokens, logger);
  const webhook = new WebhookHandler(config, store, secrets, logger, dependencies);
  await webhook.recover();
  const server = Bun.serve({
    hostname: config.server.host,
    port: config.server.port,
    fetch: createFetchHandler({ config, store, webhook, dependencies }),
  });
  workers.start();
  const dependencyRecovery = setInterval(() => {
    void dependencies.recover().catch((error) => logger.warn("dependency.recovery_failed", { error: compactError(error) }));
  }, 60_000);
  logger.info("server.started", { host: config.server.host, port: server.port, workers: config.server.workers });
  console.log(`Webhook endpoint: http://${config.server.host}:${server.port}/webhooks/github`);

  const shutdown = async (): Promise<void> => {
    logger.info("server.stopping");
    clearInterval(dependencyRecovery);
    server.stop(true);
    await workers.stop();
    store.close();
    instanceLock.release();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await new Promise(() => undefined);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = resolve(option(args, "--config") ?? "gerry.yaml");
  const command = args.find((arg) => !arg.startsWith("-") && arg !== configPath && args[args.indexOf(arg) - 1] !== "--config") ?? "help";
  if (command === "help" || args.includes("--help")) return help();
  const config = load(configPath);
  if (command === "validate") {
    const problems = validateFiles(config);
    if (problems.length) throw new Error(problems.join("\n"));
    console.log(`✓ ${config.rules.length} rules, ${Object.keys(config.agents).length} agents, ${Object.keys(config.runtimes).length} runtimes`);
    if (args.includes("--check")) await integrations(config);
    return;
  }
  if (command === "doctor") {
    const problems = validateFiles(config);
    if (problems.length) throw new Error(problems.join("\n"));
    await integrations(config);
    return;
  }
  if (command === "serve") return await serve(config, args.includes("--skip-checks"));

  const store = new Store(config.dataDir);
  try {
    if (command === "status") return console.log(JSON.stringify(store.stats(), null, 2));
    if (command === "workflows") {
      const subcommand = args[args.indexOf("workflows") + 1];
      if (subcommand === "list") return console.log(JSON.stringify(store.listWorkflows(), null, 2));
      if (subcommand === "show") {
        const workflowId = args[args.indexOf("workflows") + 2];
        if (!workflowId) throw new Error("Workflow ID is required");
        console.log(JSON.stringify(store.getWorkflow(workflowId), null, 2));
        console.log(JSON.stringify(store.listWorkflowDependencies(workflowId), null, 2));
        return;
      }
    }
    if (command === "dependencies") {
      const subcommand = args[args.indexOf("dependencies") + 1];
      if (subcommand === "list") return console.log(JSON.stringify(store.listDependencies(), null, 2));
      const dependencyId = args[args.indexOf("dependencies") + 2];
      if (!dependencyId) throw new Error("Dependency ID is required");
      if (subcommand === "abandon") {
        return console.log(JSON.stringify(store.abandonDependency(dependencyId, option(args, "--reason") ?? "Abandoned by operator"), null, 2));
      }
      if (subcommand === "attach") {
        const issueNumber = Number(option(args, "--issue-number"));
        if (!Number.isInteger(issueNumber) || issueNumber <= 0) throw new Error("--issue-number must be a positive integer");
        const secrets = loadGitHubSecrets(config);
        const service = new DependencyService(config, store, new GitHubAppTokens(secrets), new Logger(`${config.dataDir}/logs/service.jsonl`, undefined, false));
        return console.log(JSON.stringify(await service.attachDependencyIssue(dependencyId, issueNumber), null, 2));
      }
    }
    if (command === "runs") {
      const subcommand = args[args.indexOf("runs") + 1];
      if (subcommand === "list") {
        const status = option(args, "--status") as RunStatus | undefined;
        const limit = Number(option(args, "--limit") ?? 50);
        const runs = store.listRuns(limit, status);
        for (const run of runs) {
          console.log(`${run.id}  ${run.status.padEnd(12)} ${run.agentName.padEnd(20)} ${run.ruleName}  ${run.repository} ${run.subjectType}#${run.subjectNumber}`);
        }
        return;
      }
      const runId = args[args.indexOf("runs") + 2];
      if (!runId) throw new Error("Run ID is required");
      const run = store.findRun(runId);
      if (subcommand === "show") {
        writeRunSummary(config.dataDir, run);
        console.log(JSON.stringify(run, null, 2));
        console.log(`\nAudit directory: ${config.dataDir}/runs/${run.id}`);
        return;
      }
      if (subcommand === "retry") return console.log(JSON.stringify(store.retry(run.id), null, 2));
      if (subcommand === "cancel") return console.log(JSON.stringify(store.cancel(run.id), null, 2));
      if (subcommand === "resolve") return console.log(JSON.stringify(store.resolve(run.id), null, 2));
    }
    if (command === "deliveries" && args[args.indexOf("deliveries") + 1] === "show") {
      const deliveryId = args[args.indexOf("deliveries") + 2];
      if (!deliveryId) throw new Error("Delivery ID is required");
      console.log(JSON.stringify(store.getDelivery(deliveryId), null, 2));
      console.log(JSON.stringify(store.listDispatches(deliveryId), null, 2));
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } finally {
    store.close();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(formatConfigError(error));
    process.exitCode = 1;
  });
}
