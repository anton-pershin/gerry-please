import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyOpenCodeCredentialsWithoutSessions, prepareIsolatedOpenCodeService } from "../src/runtimes/opencode-service.ts";
import { temporaryDirectory } from "./helpers.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("isolated OpenCode service", () => {
  test("starts with dedicated state and no inherited GitHub credentials", async () => {
    const directory = temporaryDirectory();
    directories.push(directory);
    const outputPath = join(directory, "environment.txt");
    const argumentsPath = join(directory, "arguments.txt");
    const fakeOpenCodePath = join(directory, "fake-opencode");
    writeFileSync(
      fakeOpenCodePath,
      `#!/bin/sh\nenv > ${JSON.stringify(outputPath)}\nprintf '%s\\n' \"$@\" > ${JSON.stringify(argumentsPath)}\n`,
      { mode: 0o700 },
    );
    const service = prepareIsolatedOpenCodeService(
      directory,
      fakeOpenCodePath,
      join(directory, "missing-source.db"),
      join(directory, "missing-config"),
    );
    expect(service.registrationFile).toBe(join(service.directory, "state", "opencode", "service.json"));

    const child = spawn(service.launcherPath, {
      env: {
        ...process.env,
        CAPTURE_PATH: outputPath,
        GH_TOKEN: "personal-secret",
        GITHUB_TOKEN: "personal-secret",
        GERRY_AGENT_TOKEN: "capability-secret",
        OPENCODE_DB: "/shared/opencode.db",
        XDG_DATA_HOME: "/shared/data",
        GIT_CONFIG_GLOBAL: "/host/gitconfig",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "/host/helper",
      },
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    expect(exitCode).toBe(0);
    const environment = readFileSync(outputPath, "utf8");
    expect(environment).not.toContain("personal-secret");
    expect(environment).not.toContain("capability-secret");
    expect(environment).not.toContain("/host/helper");
    expect(environment).toContain(`XDG_STATE_HOME=${join(service.directory, "state")}`);
    expect(environment).toContain(`OPENCODE_CONFIG_DIR=${join(service.directory, "config")}`);
    expect(environment).toContain(`OPENCODE_DB=${service.databasePath}`);
    expect(environment).toContain("XDG_DATA_HOME=/shared/data");
    expect(environment).toContain(`GH_CONFIG_DIR=${join(service.directory, "gh")}`);
    expect(environment).toContain(`GIT_CONFIG_GLOBAL=${join(service.directory, "gitconfig")}`);
    expect(environment).toContain("GIT_CONFIG_NOSYSTEM=1");
    expect(environment).toContain("GIT_CONFIG_COUNT=1");
    expect(environment).toContain("GIT_CONFIG_KEY_0=credential.helper");
    expect(environment).toContain("GIT_CONFIG_VALUE_0=");
    expect(readFileSync(argumentsPath, "utf8").trim().split("\n")).toEqual([
      "serve",
      "--service",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
    ]);
    expect(readFileSync(join(service.directory, "gitconfig"), "utf8")).toContain("name = gerry-please[bot]");
  });

  test("links non-service resources without copying service configuration", () => {
    const directory = temporaryDirectory();
    directories.push(directory);
    const sourceConfig = join(directory, "source-config");
    mkdirSync(join(sourceConfig, "agents"), { recursive: true });
    mkdirSync(join(sourceConfig, "skills"), { recursive: true });
    writeFileSync(join(sourceConfig, "AGENTS.md"), "Shared instructions\n");
    writeFileSync(join(sourceConfig, "service.json"), "private-service-state\n");
    const service = prepareIsolatedOpenCodeService(
      directory,
      join(directory, "missing-opencode"),
      join(directory, "missing-source.db"),
      sourceConfig,
    );
    expect(readlinkSync(join(service.directory, "config", "agents"))).toBe(join(sourceConfig, "agents"));
    expect(readlinkSync(join(service.directory, "config", "skills"))).toBe(join(sourceConfig, "skills"));
    expect(readlinkSync(join(service.directory, "config", "AGENTS.md"))).toBe(join(sourceConfig, "AGENTS.md"));
    expect(existsSync(join(service.directory, "config", "service.json"))).toBe(false);
  });

  test("copies provider credentials without resumable session state", () => {
    const directory = temporaryDirectory();
    directories.push(directory);
    const sourcePath = join(directory, "source.db");
    const destinationPath = join(directory, "destination.db");
    const source = new Database(sourcePath);
    source.exec(`
      CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT);
      CREATE TABLE migration (id TEXT PRIMARY KEY);
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
      CREATE TABLE session_message (id TEXT PRIMARY KEY);
      CREATE TABLE job (id TEXT PRIMARY KEY);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO credential VALUES ('cred', 'provider', 'secret-value');
      INSERT INTO migration VALUES ('schema-1');
      INSERT INTO session_v2 VALUES ('session-1');
      INSERT INTO session_message VALUES ('message-1');
      INSERT INTO job VALUES ('job-1');
      INSERT INTO kv VALUES ('key', 'value');
    `);
    source.close();

    copyOpenCodeCredentialsWithoutSessions(sourcePath, destinationPath);
    const destination = new Database(destinationPath, { readonly: true });
    expect(destination.query("SELECT integration_id, value FROM credential").all()).toEqual([
      { integration_id: "provider", value: "secret-value" },
    ]);
    expect(destination.query("SELECT id FROM migration").all()).toEqual([{ id: "schema-1" }]);
    for (const table of ["session_v2", "session_message", "job", "kv"]) {
      expect(destination.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    destination.close();
  });
});
