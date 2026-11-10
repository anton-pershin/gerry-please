import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunRecord, RuntimeEvent } from "./types.ts";
import { iso } from "./util.ts";

const SECRET_PATTERN = /(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]+)/gi;

export class Redactor {
  private readonly secrets: string[];

  constructor(secrets: Array<string | undefined> = []) {
    this.secrets = secrets.filter((secret): secret is string => Boolean(secret && secret.length >= 4));
  }

  text(value: string): string {
    let redacted = value.replace(SECRET_PATTERN, "[REDACTED]");
    for (const secret of this.secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
    return redacted;
  }

  value<T>(value: T): T {
    if (typeof value === "string") return this.text(value) as T;
    if (Array.isArray(value)) return value.map((entry) => this.value(entry)) as T;
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
          if (/^(authorization|token|private_key|webhook_secret|password)$/i.test(key)) return [key, "[REDACTED]"];
          return [key, this.value(entry)];
        }),
      ) as T;
    }
    return value;
  }
}

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  [key: string]: unknown;
}

export class Logger {
  constructor(
    private readonly path: string,
    private readonly redactor = new Redactor(),
    private readonly consoleOutput = true,
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  withSecrets(secrets: Array<string | undefined>): Logger {
    return new Logger(this.path, new Redactor(secrets), this.consoleOutput);
  }

  write(entry: LogEntry): void {
    const safe = this.redactor.value({ timestamp: iso(), ...entry });
    appendFileSync(this.path, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
    if (this.consoleOutput) {
      const { timestamp, level, event, ...details } = safe;
      const suffix = Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
      const line = `${timestamp} ${level.toUpperCase()} ${event}${suffix}`;
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    }
  }

  debug(event: string, details: Record<string, unknown> = {}): void { this.write({ level: "debug", event, ...details }); }
  info(event: string, details: Record<string, unknown> = {}): void { this.write({ level: "info", event, ...details }); }
  warn(event: string, details: Record<string, unknown> = {}): void { this.write({ level: "warn", event, ...details }); }
  error(event: string, details: Record<string, unknown> = {}): void { this.write({ level: "error", event, ...details }); }
}

export class AttemptRecorder {
  readonly eventsPath: string;

  constructor(readonly directory: string, private readonly redactor: Redactor) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.eventsPath = join(directory, "events.jsonl");
  }

  emit(event: RuntimeEvent): void {
    const safe = this.redactor.value({ timestamp: event.time ?? iso(), ...event });
    appendFileSync(this.eventsPath, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
  }

  write(name: string, contents: string): string {
    const path = join(this.directory, name);
    writeFileSync(path, this.redactor.text(contents), { mode: 0o600 });
    return path;
  }
}

export function atomicWrite(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  renameSync(temporary, path);
}

export function writeRunSummary(dataDirectory: string, run: RunRecord): string {
  const path = join(dataDirectory, "runs", run.id, "summary.md");
  const lines = [
    `# Run ${run.id}`,
    "",
    `- Status: **${run.status}**`,
    `- Rule: \`${run.ruleName}\``,
    `- Agent: \`${run.agentName}\` (${run.runtimeName}/${run.runtimeType})`,
    `- Repository: \`${run.repository}\``,
    `- Subject: ${run.subjectType} ${run.subjectNumber || "—"}`,
    `- Delivery: \`${run.deliveryId}\``,
    `- Parent run: ${run.parentRunId ? `\`${run.parentRunId}\`` : "—"}`,
    `- Conversation: ${run.conversationKey ? `\`${run.conversationKey}\`` : "—"}`,
    `- Workflow: ${run.workflowId ? `\`${run.workflowType}\` / \`${run.workflowId}\`` : "—"}`,
    `- Attempts: ${run.attempt}`,
    `- Preparation-attempt budget: ${run.maxAttempts}`,
    `- Next attempt: ${run.status === "retry_wait" ? iso(run.availableAt) : "—"}`,
    `- Created: ${iso(run.createdAt)}`,
    `- Started: ${iso(run.startedAt)}`,
    `- Finished: ${iso(run.finishedAt)}`,
    `- Resolved: ${iso(run.resolvedAt)}`,
    `- Workspace: ${run.workspacePath ? `\`${run.workspacePath}\`` : "—"}`,
    `- Branch: ${run.branch ? `\`${run.branch}\`` : "—"}`,
    `- Runtime session: ${run.runtimeSessionId ? `\`${run.runtimeSessionId}\`` : "—"}`,
    `- Config SHA-256: \`${run.configHash}\``,
    `- Prompt SHA-256: \`${run.promptHash}\``,
    "",
  ];
  if (run.lastError) lines.push("## Last error", "", "```text", run.lastError, "```", "");
  if (run.usage) lines.push("## Usage", "", "```json", JSON.stringify(run.usage, null, 2), "```", "");
  lines.push(
    "## Files",
    "",
    "- `context.json`: normalized event context and original webhook payload",
    "- `prompt.md`: fully rendered prompt for the current attempt",
    "- `attempts/<n>/events.jsonl`: normalized runtime events with timestamps",
    "- `attempts/<n>/stderr.log`: runtime diagnostics (Hermes)",
    "- `response.md`: final assistant response, when available",
    "",
  );
  atomicWrite(path, lines.join("\n"));
  return path;
}
