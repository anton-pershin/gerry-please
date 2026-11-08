import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RuntimeConfig } from "../config.ts";
import { AttemptRecorder, Redactor } from "../observability.ts";
import type { RuntimeFactoryContext, RuntimeRunInput, AgentRuntime, RuntimeResult, Usage } from "../types.ts";
import { compactError } from "../util.ts";
import { RuntimeExecutionError } from "./types.ts";

const optionsSchema = z
  .object({
    profile: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    toolsets: z.array(z.string().min(1)).optional(),
    skills: z.array(z.string().min(1)).optional(),
    max_turns: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

export function hermesArguments(input: {
  workspacePath: string;
  promptPath: string;
  existingSessionId: string | null;
  options: Record<string, unknown>;
}): string[] {
  const options = optionsSchema.parse(input.options);
  const args = ["--in", input.workspacePath];
  if (options.profile) args.push("--profile", options.profile);
  if (input.existingSessionId) args.push("--resume", input.existingSessionId);
  args.push("chat", "--oneshot", "--query-file", input.promptPath, "--format", "stream-json", "--source", "gerry");
  if (options.provider) args.push("--provider", options.provider);
  if (options.model) args.push("--model", options.model);
  if (options.toolsets) args.push("--toolsets", options.toolsets.join(","));
  for (const skill of options.skills ?? []) args.push("--skills", skill);
  if (options.max_turns) args.push("--max-turns", String(options.max_turns));
  return args;
}

interface HermesEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  text?: string;
  exit_code?: number;
  error?: unknown;
  tokens?: {
    input?: number;
    output?: number;
    total?: number;
    cache_read?: number;
    cache_write?: number;
    reasoning?: number;
  };
  [key: string]: unknown;
}

async function lines(stream: ReadableStream<Uint8Array>, consume: (line: string) => Promise<void> | void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line) await consume(line);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer) await consume(buffer);
}

function killProcessGroup(child: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* Process already exited. */ }
  }
}

export class HermesRuntime implements AgentRuntime {
  readonly type = "hermes" as const;

  constructor(
    private readonly config: Extract<RuntimeConfig, { type: "hermes" }>,
    readonly name: string,
  ) {}

  static fromConfig(context: RuntimeFactoryContext, config: Extract<RuntimeConfig, { type: "hermes" }>): HermesRuntime {
    return new HermesRuntime(config, context.name);
  }

  async check(): Promise<void> {
    const result = Bun.spawnSync({ cmd: [this.config.command, "--version"], stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`${this.config.command} --version failed: ${result.stderr.toString()}`);
  }

  async run(input: RuntimeRunInput): Promise<RuntimeResult> {
    if (input.signal.aborted) throw new RuntimeExecutionError(compactError(input.signal.reason));
    const promptPath = join(input.attemptDirectory, "prompt.md");
    const recorder = new AttemptRecorder(input.attemptDirectory, new Redactor([input.environment.GH_TOKEN, input.environment.GITHUB_TOKEN]));
    recorder.write("prompt.md", input.prompt);
    const stderrPath = join(input.attemptDirectory, "stderr.log");
    const redactor = new Redactor([input.environment.GH_TOKEN, input.environment.GITHUB_TOKEN]);
    const args = hermesArguments({
      workspacePath: input.workspacePath,
      promptPath,
      existingSessionId: input.existingSessionId,
      options: input.options,
    });
    input.emit({ type: "runtime.started", data: { runtime: "hermes", command: this.config.command, args: args.map(redactor.text.bind(redactor)) } });

    const controller = new AbortController();
    const abort = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error(`Hermes run timed out after ${input.timeoutMs}ms`)), input.timeoutMs);
    const environment = { ...input.environment, HERMES_WRITE_SAFE_ROOT: input.environment.HERMES_WRITE_SAFE_ROOT ?? input.workspacePath };
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (!child) return;
      killProcessGroup(child, "SIGTERM");
      if (!forceKill) forceKill = setTimeout(() => child && killProcessGroup(child, "SIGKILL"), 2_000);
    };
    controller.signal.addEventListener("abort", terminate, { once: true });

    let sessionId = input.existingSessionId ?? "";
    let streamedText = "";
    let finalText = "";
    let usage: Usage | undefined;
    let terminalError: unknown;
    try {
      child = Bun.spawn([this.config.command, ...args], {
        cwd: input.workspacePath,
        env: environment,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      if (controller.signal.aborted) terminate();
      const stdout = lines(child.stdout, (line) => {
        let event: HermesEvent;
        try {
          event = JSON.parse(line) as HermesEvent;
        } catch {
          input.emit({ type: "hermes.output", data: { text: line } });
          return;
        }
        if (event.session_id && event.session_id !== sessionId) {
          sessionId = event.session_id;
          input.onSession(sessionId);
        }
        if (event.type === "text" && event.text) streamedText += event.text;
        if (event.type === "result") {
          finalText = event.text ?? "";
          if (event.error) terminalError = event.error;
          if (event.tokens) {
            usage = Object.fromEntries(
              Object.entries({
                inputTokens: event.tokens.input,
                outputTokens: event.tokens.output,
                totalTokens: event.tokens.total,
                cacheReadTokens: event.tokens.cache_read,
                cacheWriteTokens: event.tokens.cache_write,
                reasoningTokens: event.tokens.reasoning,
              }).filter(([, value]) => value !== undefined),
            );
          }
        }
        input.emit({ type: `hermes.${event.type ?? "event"}`, data: event });
      });
      const stderr = lines(child.stderr, (line) => {
        const safe = `${redactor.text(line)}\n`;
        appendFileSync(stderrPath, safe, { mode: 0o600 });
        input.emit({ type: "hermes.stderr", data: { text: line } });
      });
      const [exitCode] = await Promise.all([child.exited, stdout, stderr]);
      const response = finalText || streamedText;
      if (controller.signal.aborted) {
        throw new RuntimeExecutionError(compactError(controller.signal.reason), {
          ...(sessionId ? { sessionId } : {}),
          response,
          ...(usage ? { usage } : {}),
        });
      }
      if (exitCode !== 0 || terminalError) {
        throw new RuntimeExecutionError(`Hermes exited with code ${exitCode}${terminalError ? `: ${JSON.stringify(terminalError)}` : ""}`, {
          ...(sessionId ? { sessionId } : {}),
          response,
          ...(usage ? { usage } : {}),
        });
      }
      if (!sessionId) throw new RuntimeExecutionError("Hermes completed without reporting a session ID", { response });
      recorder.write("result.json", JSON.stringify({ sessionId, response, usage: usage ?? null }, null, 2));
      return { sessionId, response, ...(usage ? { usage } : {}) };
    } catch (error) {
      terminate();
      if (error instanceof RuntimeExecutionError) throw error;
      throw new RuntimeExecutionError(compactError(error), {
        ...(sessionId ? { sessionId } : {}),
        ...(usage ? { usage } : {}),
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      input.signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", terminate);
      if (child && child.exitCode === null) killProcessGroup(child, "SIGKILL");
    }
  }
}
