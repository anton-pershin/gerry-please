import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceManager } from "../src/workspace.ts";
import { configFixture } from "./helpers.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

describe("worktree isolation", () => {
  test("creates and reuses a dedicated worktree and branch", async () => {
    const fixture = configFixture();
    directories.push(fixture.directory);
    const origin = join(fixture.directory, "origin.git");
    const repository = join(fixture.directory, "repo");
    git(fixture.directory, "init", "--bare", origin);
    git(repository, "init", "-b", "main");
    git(repository, "config", "user.email", "tests@example.com");
    git(repository, "config", "user.name", "Tests");
    writeFileSync(join(repository, "README.md"), "test\n");
    git(repository, "add", "README.md");
    git(repository, "commit", "-m", "initial");
    git(repository, "remote", "add", "origin", origin);
    git(repository, "push", "-u", "origin", "main");

    const manager = new WorkspaceManager(fixture.config);
    const agent = { ...fixture.config.agents.implementer!, workspace: "worktree" as const };
    const first = await manager.prepare({
      runId: "run_worktree_test",
      repository: "acme/widgets",
      agent,
      conversationKey: null,
      existing: null,
    });
    expect(first.branch).toBe("gerry/run_worktree_test");
    expect(gitOutput(first.workspacePath, "branch", "--show-current")).toBe(first.branch!);
    const second = await manager.prepare({
      runId: "run_worktree_test",
      repository: "acme/widgets",
      agent,
      conversationKey: null,
      existing: first,
    });
    expect(second).toEqual(first);
  });
});

function gitOutput(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
