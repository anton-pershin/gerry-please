import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { loadConfig, readPrompt, resolveConfigPath } from "../src/config.ts";
import { configFixture, temporaryDirectory } from "./helpers.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("configuration", () => {
  test("applies defaults and resolves paths from the config directory", () => {
    const fixture = configFixture();
    directories.push(fixture.directory);
    expect(fixture.config.server.port).toBe(3789);
    expect(fixture.config.github.webhook_secret_env).toBe("GITHUB_WEBHOOK_SECRET");
    expect(fixture.config.dataDir).toBe(join(fixture.directory, ".data"));
    expect(resolveConfigPath(fixture.config.baseDir, fixture.config.rules[0]!.prompt)).toBe(join(fixture.directory, "task.md"));
    expect(readPrompt(fixture.config, "task.md").hash).toHaveLength(64);
  });

  test("rejects duplicate rules and unknown agents", () => {
    const fixture = configFixture();
    directories.push(fixture.directory);
    const path = join(fixture.directory, "gerry.yaml");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace("name: implement", "name: broken").replace("agent: implementer", "agent: missing"));
    expect(() => loadConfig(path)).toThrow("Unknown agent");
  });

  test("rejects mixed workspace modes in one conversation group", () => {
    const fixture = configFixture();
    directories.push(fixture.directory);
    const path = join(fixture.directory, "gerry.yaml");
    const raw = parse(readFileSync(path, "utf8")) as any;
    raw.rules[0].session = "conversation";
    raw.rules[0].conversation = "shared-group";
    raw.agents.coder = { ...raw.agents.implementer, workspace: "worktree" };
    raw.rules.push({ ...raw.rules[0], name: "coding-discussion", agent: "coder" });
    writeFileSync(path, stringify(raw));
    expect(() => loadConfig(path)).toThrow("mixes shared and worktree");
  });

  test("rejects conversation groups on fresh rules", () => {
    const fixture = configFixture();
    directories.push(fixture.directory);
    const path = join(fixture.directory, "gerry.yaml");
    writeFileSync(path, `${readFileSync(path, "utf8")}    conversation: invalid\n`);
    expect(() => loadConfig(path)).toThrow("conversation");
  });
});
