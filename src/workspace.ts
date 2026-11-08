import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { AgentConfig, LoadedConfig } from "./config.ts";
import { resolveConfigPath } from "./config.ts";
import { id } from "./util.ts";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function kill(child: Bun.Subprocess): void {
  try {
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* Process already exited. */ }
  }
}

async function git(
  repositoryPath: string,
  args: string[],
  environment: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (signal?.aborted) throw signal.reason;
  const child = Bun.spawn(["git", "-C", repositoryPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...environment, GIT_TERMINAL_PROMPT: "0" },
    detached: true,
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    kill(child);
  }, 120_000);
  const abort = () => kill(child);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (signal?.aborted) throw signal.reason;
    if (timedOut) throw new Error(`git ${args.join(" ")} timed out after 120 seconds`);
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    if (child.exitCode === null) kill(child);
  }
}

async function assertGit(
  repositoryPath: string,
  args: string[],
  environment: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<string> {
  const result = await git(repositoryPath, args, environment, signal);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

export class WorkspaceManager {
  constructor(private readonly config: LoadedConfig) {}

  async prepare(input: {
    runId: string;
    repository: string;
    agent: AgentConfig;
    conversationKey: string | null;
    workflowId?: string | null;
    existing: { workspacePath: string | null; branch: string | null } | null;
    environment?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<{ workspacePath: string; branch: string | null }> {
    const repository = this.config.repositories[input.repository];
    if (!repository) throw new Error(`Repository is not configured: ${input.repository}`);
    const repositoryPath = resolveConfigPath(this.config.baseDir, repository.path);
    if (!existsSync(repositoryPath)) throw new Error(`Repository checkout does not exist: ${repositoryPath}`);
    await assertGit(repositoryPath, ["rev-parse", "--git-dir"], input.environment, input.signal);

    if (input.agent.workspace === "shared") {
      return { workspacePath: repositoryPath, branch: null };
    }

    if (input.existing?.workspacePath) {
      const worktreeRoot = join(this.config.dataDir, "worktrees");
      const relativePath = relative(worktreeRoot, input.existing.workspacePath);
      if (relativePath.startsWith("..") || isAbsolute(relativePath) || !input.existing.branch?.startsWith("gerry/")) {
        throw new Error("A worktree agent cannot reuse a shared or foreign conversation workspace");
      }
      if (existsSync(join(input.existing.workspacePath, ".git"))) {
        return { workspacePath: input.existing.workspacePath, branch: input.existing.branch };
      }
      if (!input.workflowId) {
        throw new Error(`Conversation workspace is missing or is not a git worktree: ${input.existing.workspacePath}`);
      }
      // Workflow paths/branches are allocated at dispatch before the first preparation.
    }

    const suffix = input.workflowId
      ? input.workflowId
      : input.conversationKey
        ? createHash("sha256").update(input.conversationKey).digest("hex").slice(0, 16)
        : input.runId;
    const workspacePath = join(this.config.dataDir, "worktrees", suffix);
    const branch = input.workflowId
      ? `gerry/${input.workflowId}`
      : input.conversationKey
        ? `gerry/discussion-${suffix}`
        : `gerry/${input.runId}`;
    if (existsSync(join(workspacePath, ".git"))) return { workspacePath, branch };
    if (existsSync(workspacePath)) throw new Error(`Worktree path exists but is not a git worktree: ${workspacePath}`);

    const branchExists = (await git(
      repositoryPath,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      input.environment,
      input.signal,
    )).exitCode === 0;
    if (branchExists) {
      await assertGit(repositoryPath, ["worktree", "add", workspacePath, branch], input.environment, input.signal);
    } else {
      await assertGit(repositoryPath, ["fetch", "origin", repository.default_branch], input.environment, input.signal);
      await assertGit(repositoryPath, [
        "worktree",
        "add",
        "-b",
        branch,
        workspacePath,
        `origin/${repository.default_branch}`,
      ], input.environment, input.signal);
    }
    return { workspacePath, branch };
  }

  temporaryDirectory(runId: string): string {
    return join(this.config.dataDir, "tmp", `${runId}-${id("tmp")}`);
  }
}
