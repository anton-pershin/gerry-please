import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { GERRY_GIT_AUTHOR_EMAIL, GERRY_GIT_AUTHOR_NAME } from "../github.ts";

export interface IsolatedOpenCodeService {
  directory: string;
  registrationFile: string;
  launcherPath: string;
  databasePath: string;
}

function launcherSource(input: {
  openCodePath: string;
  stateDirectory: string;
  configDirectory: string;
  databasePath: string;
  ghConfigDirectory: string;
  gitConfigPath: string;
}): string {
  return `#!${process.execPath}
import { spawn } from "node:child_process";
const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  if (["GH_TOKEN", "GITHUB_TOKEN", "GERRY_AGENT_TOKEN"].includes(name) || name.startsWith("GIT_CONFIG_")) {
    delete environment[name];
  }
}
Object.assign(environment, {
  XDG_STATE_HOME: ${JSON.stringify(input.stateDirectory)},
  OPENCODE_CONFIG_DIR: ${JSON.stringify(input.configDirectory)},
  OPENCODE_DB: ${JSON.stringify(input.databasePath)},
  GH_CONFIG_DIR: ${JSON.stringify(input.ghConfigDirectory)},
  GIT_CONFIG_GLOBAL: ${JSON.stringify(input.gitConfigPath)},
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_TERMINAL_PROMPT: "0",
});
const child = spawn(${JSON.stringify(input.openCodePath)}, ["serve", "--service", "--hostname", "127.0.0.1", "--port", "0"], {
  env: environment,
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (child.exitCode === null) child.kill(signal);
  });
}
const exitCode = await new Promise((resolve) => {
  child.once("error", () => resolve(1));
  child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
});
process.exit(exitCode);
`;
}

const CREDENTIAL_TABLES = new Set(["account", "account_state", "credential", "control_account", "migration"]);

export function defaultOpenCodeDatabasePath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.OPENCODE_DB) return resolve(environment.OPENCODE_DB);
  const dataHome = environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, "opencode", "opencode.db");
}

export function defaultOpenCodeConfigDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.OPENCODE_CONFIG_DIR) return resolve(environment.OPENCODE_CONFIG_DIR);
  const legacy = join(homedir(), ".opencode");
  return existsSync(legacy) ? legacy : join(homedir(), ".config", "opencode");
}

function linkSharedOpenCodeResources(sourceDirectory: string, destinationDirectory: string): void {
  for (const name of ["agents", "commands", "skills", "plugins", "AGENTS.md", "opencode.json", "opencode.jsonc"]) {
    const source = join(sourceDirectory, name);
    const destination = join(destinationDirectory, name);
    if (!existsSync(source) || existsSync(destination)) continue;
    symlinkSync(source, destination, statSync(source).isDirectory() ? "dir" : "file");
  }
}

export function copyOpenCodeCredentialsWithoutSessions(sourcePath: string, destinationPath: string): void {
  const temporaryPath = `${destinationPath}.${process.pid}.${randomUUID()}.tmp`;
  let source: Database | undefined;
  let destination: Database | undefined;
  try {
    source = new Database(sourcePath, { readonly: true });
    writeFileSync(temporaryPath, source.serialize(), { mode: 0o600, flag: "wx" });
    source.close();
    source = undefined;

    destination = new Database(temporaryPath);
    destination.exec("PRAGMA foreign_keys = OFF");
    const tables = destination.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    for (const table of tables) {
      if (CREDENTIAL_TABLES.has(table.name)) continue;
      const escaped = table.name.replaceAll('"', '""');
      destination.exec(`DELETE FROM "${escaped}"`);
    }
    destination.exec("VACUUM");
    destination.close();
    destination = undefined;
    renameSync(temporaryPath, destinationPath);
  } finally {
    source?.close();
    destination?.close();
    rmSync(temporaryPath, { force: true });
  }
}

export function prepareIsolatedOpenCodeService(
  dataDirectory: string,
  openCodePath = Bun.which("opencode"),
  sourceDatabasePath = defaultOpenCodeDatabasePath(),
  sourceConfigDirectory = defaultOpenCodeConfigDirectory(),
): IsolatedOpenCodeService {
  if (!openCodePath) throw new Error("OpenCode CLI is unavailable; cannot start the isolated service");
  const directory = join(dataDirectory, "opencode-service");
  const stateDirectory = join(directory, "state");
  const configDirectory = join(directory, "config");
  const databasePath = join(directory, "opencode.db");
  const ghConfigDirectory = join(directory, "gh");
  const gitConfigPath = join(directory, "gitconfig");
  const launcherPath = join(directory, "serve");
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(ghConfigDirectory, { recursive: true, mode: 0o700 });
  linkSharedOpenCodeResources(sourceConfigDirectory, configDirectory);
  if (!existsSync(databasePath) && existsSync(sourceDatabasePath) && resolve(sourceDatabasePath) !== resolve(databasePath)) {
    copyOpenCodeCredentialsWithoutSessions(sourceDatabasePath, databasePath);
  }
  writeFileSync(
    gitConfigPath,
    `[user]\n name = ${GERRY_GIT_AUTHOR_NAME}\n email = ${GERRY_GIT_AUTHOR_EMAIL}\n[credential]\n helper =\n`,
    { mode: 0o600 },
  );
  writeFileSync(launcherPath, launcherSource({
    openCodePath,
    stateDirectory,
    configDirectory,
    databasePath,
    ghConfigDirectory,
    gitConfigPath,
  }), { mode: 0o700 });
  chmodSync(launcherPath, 0o700);
  return {
    directory,
    registrationFile: join(stateDirectory, "opencode", "service.json"),
    launcherPath,
    databasePath,
  };
}
