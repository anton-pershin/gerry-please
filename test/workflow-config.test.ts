import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { loadConfig } from "../src/config.ts";
import { workflowConfigFixture } from "./workflow-helpers.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("workflow and dependency configuration", () => {
  test("loads workflow rules and dependency resume policies", () => {
    const fixture = workflowConfigFixture(true);
    directories.push(fixture.directory);
    expect(fixture.config.rules[0]!.workflow_start).toBe(true);
    expect(fixture.config.rules[1]!.workflow_start).toBe(false);
    expect(fixture.config.dependencies[0]!.resume?.workflow).toBe("implementation");
  });

  test("requires worktree agents for workflows and dependency resumes", () => {
    const fixture = workflowConfigFixture(true);
    directories.push(fixture.directory);
    const path = join(fixture.directory, "gerry.yaml");
    const raw = parse(readFileSync(path, "utf8")) as any;
    raw.agents.implementer.workspace = "shared";
    writeFileSync(path, stringify(raw));
    expect(() => loadConfig(path)).toThrow("worktree");
  });

  test("rejects dependency policies for unconfigured repositories", () => {
    const fixture = workflowConfigFixture(true);
    directories.push(fixture.directory);
    const path = join(fixture.directory, "gerry.yaml");
    const raw = parse(readFileSync(path, "utf8")) as any;
    raw.dependencies[0].to = "acme/missing";
    writeFileSync(path, stringify(raw));
    expect(() => loadConfig(path)).toThrow("not configured");
  });
});
