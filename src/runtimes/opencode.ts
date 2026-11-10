import { ClientError, OpenCode, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { z } from "zod";
import type { RuntimeConfig } from "../config.ts";
import type { AgentRuntime, RuntimeFactoryContext, RuntimeResult, RuntimeRunInput, Usage } from "../types.ts";
import { compactError, parseModel, sleep, withDeadline } from "../util.ts";
import { ProviderQuotaError, RuntimeExecutionError } from "./types.ts";

const optionsSchema = z
  .object({
    agent: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    permissions: z
      .array(
        z
          .object({
            action: z.string().min(1),
            resource: z.string(),
            effect: z.enum(["allow", "deny", "ask"]),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export function validateOpenCodeOptions(options: Record<string, unknown>): void {
  const parsed = optionsSchema.parse(options);
  if (parsed.model) parseModel(parsed.model);
}

const COLLECTION_COMPLETE = "OpenCode event collection complete";

function sessionIDFromEvent(event: OpenCodeEvent): string | null {
  if (!("data" in event) || event.data === null || typeof event.data !== "object") return null;
  const sessionID = (event.data as Record<string, unknown>).sessionID;
  return typeof sessionID === "string" ? sessionID : null;
}

function responseFromMessages(response: Awaited<ReturnType<OpenCodeClient["message"]["list"]>>): string {
  const assistants = response.data.filter((message) => message.type === "assistant");
  const latest = assistants[0];
  if (!latest || latest.type !== "assistant") return "";
  return latest.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function latestErrorFromMessages(
  response: Awaited<ReturnType<OpenCodeClient["message"]["list"]>>,
  previousMessageId: string | null,
): unknown {
  for (const message of response.data) {
    if (message.id === previousMessageId) break;
    if ("error" in message && message.error) return message.error;
  }
  return undefined;
}

function isTransportTimeout(error: unknown): boolean {
  return error instanceof ClientError && error.reason === "Transport" && error.cause instanceof Error &&
    (error.cause.name === "TimeoutError" || error.cause.message.includes("The operation timed out"));
}

export function isOpenCodeProviderQuotaError(error: unknown): boolean {
  return error !== null && typeof error === "object" &&
    (error as { type?: unknown }).type === "provider.quota";
}

export async function waitForOpenCodeSession(input: {
  client: OpenCodeClient;
  sessionID: string;
  timeoutMs: number;
  signal: AbortSignal;
  emit?: (event: { type: string; data: unknown }) => void;
}): Promise<void> {
  const maximumAttempts = Math.max(2, Math.ceil(input.timeoutMs / 300_000));
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      await input.client.experimental.session.wait({ sessionID: input.sessionID }, { signal: input.signal });
      return;
    } catch (error) {
      if (!isTransportTimeout(error) || input.signal.aborted || attempt === maximumAttempts) throw error;
      input.emit?.({
        type: "opencode.wait.reconnecting",
        data: { nextAttempt: attempt + 1, maximumAttempts, error: compactError(error) },
      });
      await sleep(250, input.signal);
    }
  }
}

export class OpenCodeRuntime implements AgentRuntime {
  readonly type = "opencode" as const;

  constructor(
    private readonly client: OpenCodeClient,
    readonly name: string,
  ) {}

  static async fromConfig(
    context: RuntimeFactoryContext,
    config: Extract<RuntimeConfig, { type: "opencode" }>,
  ): Promise<OpenCodeRuntime> {
    if (config.base_url) {
      const token = config.token_env ? context.environment[config.token_env] : undefined;
      if (config.token_env && !token) throw new Error(`Missing OpenCode token environment variable: ${config.token_env}`);
      return new OpenCodeRuntime(
        OpenCode.make({
          baseUrl: config.base_url,
          ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        }),
        context.name,
      );
    }
    const endpoint = await Service.ensure();
    return new OpenCodeRuntime(OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }), context.name);
  }

  async check(): Promise<void> {
    await withDeadline(this.client.server.info(), 10_000, "OpenCode health check timed out");
  }

  async run(input: RuntimeRunInput): Promise<RuntimeResult> {
    if (input.signal.aborted) throw new RuntimeExecutionError(compactError(input.signal.reason));
    validateOpenCodeOptions(input.options);
    const options = optionsSchema.parse(input.options);
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error(`OpenCode run timed out after ${input.timeoutMs}ms`)), input.timeoutMs);
    const signal = controller.signal;
    let sessionId = input.existingSessionId ?? "";
    let streamedText = "";
    let executionError: unknown;
    let usage: Usage | undefined;
    let executionIdle = false;
    let eventPump: Promise<void> | undefined;
    let previousMessageId: string | null = null;

    try {
      if (sessionId) {
        await this.client.session.get({ sessionID: sessionId }, { signal });
        const previousMessages = await this.client.message.list(
          { sessionID: sessionId, limit: 1, order: "desc" },
          { signal },
        );
        previousMessageId = previousMessages.data[0]?.id ?? null;
      } else {
        const session = await this.client.session.create(
          {
            title: `Gerry: ${input.agentName} / ${input.runId}`,
            ...(options.agent ? { agent: options.agent } : {}),
            ...(options.model ? { model: parseModel(options.model) } : {}),
            ...(options.permissions ? { permissions: options.permissions } : {}),
            location: { directory: input.workspacePath },
            metadata: { gerry_run_id: input.runId, gerry_agent: input.agentName },
          },
          { signal },
        );
        sessionId = session.id;
      }
      input.onSession(sessionId);
      input.emit({ type: "runtime.session", data: { runtime: "opencode", sessionId, resumed: Boolean(input.existingSessionId) } });
      await this.client.session.environment({ sessionID: sessionId, variables: input.environment }, { signal });

      let markReady!: () => void;
      let failReady!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        markReady = resolve;
        failReady = reject;
      });
      eventPump = (async (): Promise<void> => {
        try {
          for await (const event of this.client.event.subscribe({ signal })) {
            if (event.type === "server.connected") {
              markReady();
              continue;
            }
            const eventSessionId = sessionIDFromEvent(event);
            if (eventSessionId !== sessionId) continue;
            input.emit({ type: `opencode.${event.type}`, data: "data" in event ? event.data : event });
            if (event.type === "session.text.delta") {
              streamedText += event.data.delta;
            } else if (event.type === "session.execution.failed") {
              executionError = event.data.error;
            } else if (event.type === "permission.asked") {
              await this.client.permission.reply({
                sessionID: sessionId,
                requestID: event.data.id,
                decision: "reject",
                message: "Gerry runs unattended with config-only permissions; adjust the agent's configured allow rules if this operation is required.",
              }, { signal });
            }
          }
          if (!signal.aborted) {
            const error = new Error("OpenCode event stream ended unexpectedly");
            failReady(error);
            controller.abort(error);
          }
        } catch (error) {
          if (!signal.aborted) {
            const streamError = new Error(`OpenCode event stream disconnected: ${compactError(error)}`);
            input.emit({ type: "opencode.events.disconnected", data: { error: streamError.message } });
            failReady(streamError);
            controller.abort(streamError);
          }
        }
      })();
      await withDeadline(ready, 10_000, "OpenCode event stream did not become ready");
      await this.client.session.prompt({ sessionID: sessionId, text: input.prompt }, { signal });
      await waitForOpenCodeSession({
        client: this.client,
        sessionID: sessionId,
        timeoutMs: input.timeoutMs,
        signal,
        emit: input.emit,
      });
      executionIdle = true;
      const session = await this.client.session.get({ sessionID: sessionId }, { signal });
      usage = {
        inputTokens: session.tokens.input,
        outputTokens: session.tokens.output,
        reasoningTokens: session.tokens.reasoning,
        cacheReadTokens: session.tokens.cache.read,
        cacheWriteTokens: session.tokens.cache.write,
        costUsd: session.cost,
        sessionTotals: true,
      };
      const messages = await this.client.message.list({ sessionID: sessionId, limit: 200, order: "desc" }, { signal });
      input.emit({ type: "opencode.snapshot.messages", data: messages });
      input.emit({ type: "opencode.snapshot.session", data: session });
      const failure = executionError ??
        (session.outcome === "failed" ? latestErrorFromMessages(messages, previousMessageId) : undefined);
      if (failure || session.outcome === "failed") {
        const ErrorClass = isOpenCodeProviderQuotaError(failure) ? ProviderQuotaError : RuntimeExecutionError;
        throw new ErrorClass(`OpenCode execution failed: ${JSON.stringify(failure ?? "See runtime events")}`, {
          sessionId,
          response: streamedText,
          usage,
        });
      }
      if (session.outcome === "interrupted" || signal.aborted) {
        throw new RuntimeExecutionError(compactError(signal.reason ?? "OpenCode session was interrupted"), {
          sessionId,
          response: streamedText,
          usage,
        });
      }
      return { sessionId, response: responseFromMessages(messages) || streamedText, ...(usage ? { usage } : {}) };
    } catch (error) {
      if (sessionId && !executionIdle) {
        try {
          await withDeadline(
            this.client.session.interrupt({ sessionID: sessionId }),
            5_000,
            "OpenCode interruption timed out",
          );
        } catch (interruptError) {
          input.emit({ type: "opencode.cleanup.interrupt_failed", data: { error: compactError(interruptError) } });
        }
      }
      if (error instanceof RuntimeExecutionError) throw error;
      throw new RuntimeExecutionError(compactError(error), {
        ...(sessionId ? { sessionId } : {}),
        response: streamedText,
        ...(usage ? { usage } : {}),
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
      controller.abort(COLLECTION_COMPLETE);
      if (eventPump) {
        try {
          await withDeadline(eventPump, 5_000, "OpenCode event subscription cleanup timed out");
        } catch (error) {
          input.emit({ type: "opencode.cleanup.events_failed", data: { error: compactError(error) } });
        }
      }
      if (sessionId) {
        const sanitized = Object.fromEntries(
          Object.entries(input.environment).filter(
            ([name]) => !["GH_TOKEN", "GITHUB_TOKEN", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GERRY_AGENT_TOKEN"].includes(name),
          ),
        );
        try {
          await withDeadline(
            this.client.session.environment({ sessionID: sessionId, variables: sanitized }),
            5_000,
            "OpenCode credential cleanup timed out",
          );
        } catch (error) {
          input.emit({ type: "opencode.cleanup.environment_failed", data: { error: compactError(error) } });
        }
      }
    }
  }
}
