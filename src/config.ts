import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const conditionSchema = z
  .object({
    path: z.string().min(1),
    equals: z.unknown().optional(),
    not_equals: z.unknown().optional(),
    contains: z.unknown().optional(),
    not_contains: z.unknown().optional(),
    in: z.array(z.unknown()).optional(),
    exists: z.boolean().optional(),
    ignore_case: z.boolean().default(false),
  })
  .strict()
  .refine(
    (condition) =>
      [condition.equals, condition.not_equals, condition.contains, condition.not_contains, condition.in, condition.exists]
        .filter((value) => value !== undefined).length === 1,
    "A condition must define exactly one operator",
  );

const runtimeSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("opencode"),
      base_url: z.url().optional(),
      token_env: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("hermes"),
      command: z.string().min(1).default("hermes"),
    })
    .strict(),
]);

const dependencySchema = z
  .object({
    from: z.string().regex(/^[^/]+\/[^/]+$/),
    to: z.string().regex(/^[^/]+\/[^/]+$/),
    allow_issue_creation: z.boolean().default(false),
    resume: z
      .object({
        agent: z.string().min(1),
        prompt: z.string().min(1),
        workflow: z.string().min(1),
        max_turns: z.number().int().min(1).max(1000).default(20),
      })
      .strict()
      .optional(),
  })
  .strict();

const configSchema = z
  .object({
    server: z
      .object({
        host: z.string().min(1).default("127.0.0.1"),
        port: z.number().int().min(1).max(65535).default(3789),
        data_dir: z.string().min(1).default(".gerry"),
        workers: z.number().int().min(1).max(32).default(2),
        max_body_bytes: z.number().int().min(1024).default(10 * 1024 * 1024),
      })
      .strict()
      .default({ host: "127.0.0.1", port: 3789, data_dir: ".gerry", workers: 2, max_body_bytes: 10 * 1024 * 1024 }),
    github: z
      .object({
        app_id_env: z.string().min(1).default("GITHUB_APP_ID"),
        private_key_path_env: z.string().min(1).default("GITHUB_APP_PRIVATE_KEY_PATH"),
        webhook_secret_env: z.string().min(1).default("GITHUB_WEBHOOK_SECRET"),
      })
      .strict()
      .default({
        app_id_env: "GITHUB_APP_ID",
        private_key_path_env: "GITHUB_APP_PRIVATE_KEY_PATH",
        webhook_secret_env: "GITHUB_WEBHOOK_SECRET",
      }),
    repositories: z.record(
      z.string().regex(/^[^/]+\/[^/]+$/, "Repository keys must use owner/name"),
      z
        .object({
          path: z.string().min(1),
          default_branch: z.string().min(1).default("main"),
        })
        .strict(),
    ),
    runtimes: z.record(z.string().min(1), runtimeSchema),
    agents: z.record(
      z.string().min(1),
      z
        .object({
          runtime: z.string().min(1),
          instructions: z.string().min(1).optional(),
          workspace: z.enum(["shared", "worktree"]).default("shared"),
          timeout_seconds: z.number().int().min(1).default(1800),
          max_attempts: z.number().int().min(1).max(20).default(3),
          retry_backoff_seconds: z.number().int().min(1).default(30),
          pass_environment: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).default([]),
          env: z.record(z.string(), z.string()).default({}),
          options: z.record(z.string(), z.unknown()).default({}),
        })
        .strict(),
    ),
    dependencies: z.array(dependencySchema).default([]),
    rules: z
      .array(
        z
          .object({
            name: z.string().min(1),
            enabled: z.boolean().default(true),
            on: z
              .object({
                event: z.string().min(1),
                actions: z.array(z.string().min(1)).min(1).optional(),
              })
              .strict(),
            repositories: z.array(z.string().min(1)).min(1).optional(),
            when: z.array(conditionSchema).default([]),
            agent: z.string().min(1),
            prompt: z.string().min(1),
            session: z.enum(["fresh", "conversation", "workflow"]).default("fresh"),
            conversation: z.string().min(1).optional(),
            workflow: z.string().min(1).optional(),
            workflow_start: z.boolean().default(false),
            max_turns: z.number().int().min(1).max(1000).default(12),
            once_per_subject: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((config, context) => {
    const names = new Set<string>();
    const conversationWorkspaces = new Map<string, string>();
    for (const [index, rule] of config.rules.entries()) {
      if (names.has(rule.name)) {
        context.addIssue({ code: "custom", message: `Duplicate rule name: ${rule.name}`, path: ["rules", index, "name"] });
      }
      names.add(rule.name);
      if (!config.agents[rule.agent]) {
        context.addIssue({ code: "custom", message: `Unknown agent: ${rule.agent}`, path: ["rules", index, "agent"] });
      }
      if (rule.session !== "conversation" && rule.conversation) {
        context.addIssue({
          code: "custom",
          message: "conversation is only valid when session is conversation",
          path: ["rules", index, "conversation"],
        });
      }
      if (rule.session !== "workflow" && (rule.workflow || rule.workflow_start)) {
        context.addIssue({
          code: "custom",
          message: "workflow and workflow_start are only valid when session is workflow",
          path: ["rules", index, "workflow"],
        });
      }
      if (rule.session === "workflow" && config.agents[rule.agent]?.workspace !== "worktree") {
        context.addIssue({
          code: "custom",
          message: "Workflow agents must use workspace: worktree",
          path: ["rules", index, "agent"],
        });
      }
      if (rule.session === "conversation") {
        const group = rule.conversation ?? rule.name;
        const workspace = config.agents[rule.agent]?.workspace;
        const previous = conversationWorkspaces.get(group);
        if (workspace && previous && previous !== workspace) {
          context.addIssue({
            code: "custom",
            message: `Conversation group ${group} mixes shared and worktree agents; use one workspace mode per group`,
            path: ["rules", index, "conversation"],
          });
        }
        if (workspace) conversationWorkspaces.set(group, workspace);
      }
    }
    const dependencyPairs = new Set<string>();
    for (const [index, dependency] of config.dependencies.entries()) {
      const pair = `${dependency.from}→${dependency.to}`;
      if (dependencyPairs.has(pair)) {
        context.addIssue({ code: "custom", message: `Duplicate dependency policy: ${pair}`, path: ["dependencies", index] });
      }
      dependencyPairs.add(pair);
      for (const repository of [dependency.from, dependency.to]) {
        if (!config.repositories[repository]) {
          context.addIssue({ code: "custom", message: `Dependency repository is not configured: ${repository}`, path: ["dependencies", index] });
        }
      }
      if (dependency.from === dependency.to) {
        context.addIssue({ code: "custom", message: "Dependency repositories must differ", path: ["dependencies", index] });
      }
      if (dependency.resume && !config.agents[dependency.resume.agent]) {
        context.addIssue({ code: "custom", message: `Unknown agent: ${dependency.resume.agent}`, path: ["dependencies", index, "resume", "agent"] });
      }
      if (dependency.resume && config.agents[dependency.resume.agent]?.workspace !== "worktree") {
        context.addIssue({ code: "custom", message: "Dependency resume agents must use workspace: worktree", path: ["dependencies", index, "resume", "agent"] });
      }
    }
    for (const [name, agent] of Object.entries(config.agents)) {
      if (!config.runtimes[agent.runtime]) {
        context.addIssue({ code: "custom", message: `Unknown runtime: ${agent.runtime}`, path: ["agents", name, "runtime"] });
      }
    }
  });

export type Condition = z.infer<typeof conditionSchema>;
export type RuntimeConfig = z.infer<typeof runtimeSchema>;
export type AgentConfig = z.infer<typeof configSchema>["agents"][string];
export type RuleConfig = z.infer<typeof configSchema>["rules"][number];
export type DependencyConfig = z.infer<typeof dependencySchema>;
export type ConfigInput = z.infer<typeof configSchema>;

export interface LoadedConfig extends ConfigInput {
  readonly configPath: string;
  readonly baseDir: string;
  readonly dataDir: string;
  readonly hash: string;
  readonly raw: string;
}

export function loadConfig(path: string): LoadedConfig {
  const configPath = resolve(path);
  const raw = readFileSync(configPath, "utf8");
  const parsed = configSchema.parse(parse(raw));
  const baseDir = dirname(configPath);
  return {
    ...parsed,
    configPath,
    baseDir,
    dataDir: resolveConfigPath(baseDir, parsed.server.data_dir),
    hash: createHash("sha256").update(raw).digest("hex"),
    raw,
  };
}

export function resolveConfigPath(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

export function readPrompt(config: LoadedConfig, path: string): { contents: string; path: string; hash: string } {
  const promptPath = resolveConfigPath(config.baseDir, path);
  const contents = readFileSync(promptPath, "utf8");
  return { contents, path: promptPath, hash: createHash("sha256").update(contents).digest("hex") };
}

export function formatConfigError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}
