import { ClientError, OpenCode, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client";
import { Service } from "@opencode/client/service";
import { z } from "zod";
import type { RuntimeConfig } from "../config.ts";
import { sanitizeAgentCredentialEnvironment } from "../credentials.ts";
import type { AgentRuntime, RuntimeFactoryContext, RuntimeResult, RuntimeRunInput, Usage } from "../types.ts";
import { compactError, parseModel, sleep, withDeadline } from "../util.ts";
import { prepareIsolatedOpenCodeService } from "./opencode-service.ts";
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

export interface OpenCodeBackgroundJob {
  id: string;
  kind: "shell" | "subagent" | "image";
  sessionID: string;
  status: "running" | "completed" | "error" | "cancelled";
  childSessionID?: string;
}

export type ListOpenCodeBackgroundJobs = (sessionID: string, signal: AbortSignal) => Promise<OpenCodeBackgroundJob[]>;

export function createOpenCodeBackgroundJobLister(client: OpenCodeClient): ListOpenCodeBackgroundJobs {
  return async (sessionID, signal) => client.experimental.job.list({ sessionID, descendants: true }, { signal });
}

export async function readOpenCodeSessionGeneration(
  client: OpenCodeClient,
  sessionID: string,
  signal: AbortSignal,
): Promise<number> {
  let generation = 0;
  for await (const item of client.experimental.session.log({ sessionID, follow: false }, { signal })) {
    if (item.type === "log.synced") return item.seq ?? generation;
    generation = Math.max(generation, item.durable.seq);
  }
  return generation;
}

export function isSupportedOpenCodeVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 2 || (major === 2 && minor >= 3);
}

interface OpenCodeConnection {
  client: OpenCodeClient;
  listBackgroundJobs: ListOpenCodeBackgroundJobs;
}

type OpenCodeConnector = () => Promise<OpenCodeConnection>;

function makeConnection(baseUrl: string, headers?: RequestInit["headers"]): OpenCodeConnection {
  const options: { baseUrl: string; headers?: RequestInit["headers"] } = { baseUrl };
  if (headers) options.headers = headers;
  const client = OpenCode.make(options);
  return { client, listBackgroundJobs: createOpenCodeBackgroundJobLister(client) };
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

async function waitForSessionIdle(input: {
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

type OpenCodeInboxItem = Awaited<ReturnType<OpenCodeClient["session"]["inbox"]["list"]>>[number];

async function listOpenCodeSessionTree(
  client: OpenCodeClient,
  rootSessionID: string,
  signal: AbortSignal,
): Promise<string[]> {
  const seen = new Set([rootSessionID]);
  const queue = [rootSessionID];
  for (let index = 0; index < queue.length; index += 1) {
    const parentID = queue[index]!;
    let cursor: string | undefined;
    while (true) {
      const response = await client.session.list({
        parentID,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }, { signal });
      for (const child of response.data) {
        if (!seen.has(child.id)) {
          seen.add(child.id);
          queue.push(child.id);
        }
      }
      if (response.data.length < 100) break;
      cursor = response.cursor.next ?? undefined;
      if (!cursor) break;
    }
  }
  return [...seen];
}

async function readSessionGenerations(
  sessionIDs: string[],
  read: (sessionID: string) => Promise<number>,
): Promise<Map<string, number>> {
  return new Map(await Promise.all(sessionIDs.map(async (sessionID) => [sessionID, await read(sessionID)] as const)));
}

async function readSessionInboxes(
  client: OpenCodeClient,
  sessionIDs: string[],
  signal: AbortSignal,
): Promise<Map<string, OpenCodeInboxItem[]>> {
  return new Map(await Promise.all(sessionIDs.map(async (sessionID) => [
    sessionID,
    await client.session.inbox.list({ sessionID }, { signal }),
  ] as const)));
}

function inboxCount(inboxes: Map<string, OpenCodeInboxItem[]>): number {
  return [...inboxes.values()].reduce((count, items) => count + items.length, 0);
}

export async function waitForOpenCodeSession(input: {
  client: OpenCodeClient;
  sessionID: string;
  timeoutMs: number;
  signal: AbortSignal;
  listBackgroundJobs: ListOpenCodeBackgroundJobs;
  getSessionGeneration: (sessionID: string) => Promise<number>;
  emit?: (event: { type: string; data: unknown }) => void;
}): Promise<void> {
  let previousActivity = "";
  let pollDelay = 50;
  while (true) {
    await waitForSessionIdle(input);
    const session = await input.client.session.get({ sessionID: input.sessionID }, { signal: input.signal });
    // Failed/interrupted attempts retain their ambiguous recovery semantics and
    // return promptly for outer classification. Only successful completion gets
    // the tree-quiescence guarantee below; failure recovery must reconcile work
    // that may still be running before retrying or resolving the attempt.
    if (session.outcome === "failed" || session.outcome === "interrupted") return;

    // Bracket the whole session tree with durable watermarks. Any turn, report,
    // new descendant, or job on either side of these snapshots restarts the pass.
    const sessionsBefore = await listOpenCodeSessionTree(input.client, input.sessionID, input.signal);
    const generationBefore = await readSessionGenerations(sessionsBefore, input.getSessionGeneration);
    const jobsBefore = await input.listBackgroundJobs(input.sessionID, input.signal);
    const inboxBefore = await readSessionInboxes(input.client, sessionsBefore, input.signal);
    const activeBefore = await input.client.session.active({ signal: input.signal });
    const jobsAfter = await input.listBackgroundJobs(input.sessionID, input.signal);
    const sessionsAfter = await listOpenCodeSessionTree(input.client, input.sessionID, input.signal);
    const allSessionIDs = [...new Set([...sessionsBefore, ...sessionsAfter])];
    const inboxAfter = await readSessionInboxes(input.client, allSessionIDs, input.signal);
    const activeAfter = await input.client.session.active({ signal: input.signal });
    const generationAfter = await readSessionGenerations(allSessionIDs, input.getSessionGeneration);
    const activeSessionIDs = allSessionIDs.filter((sessionID) => activeBefore[sessionID] || activeAfter[sessionID]);
    const sameSessionTree = [...sessionsBefore].sort().join("\n") === [...sessionsAfter].sort().join("\n");
    const generationChanged = allSessionIDs.some((sessionID) => generationBefore.get(sessionID) !== generationAfter.get(sessionID));
    if (sameSessionTree && !generationChanged && activeSessionIDs.length === 0 &&
        jobsBefore.length === 0 && jobsAfter.length === 0 &&
        inboxCount(inboxBefore) === 0 && inboxCount(inboxAfter) === 0) {
      return;
    }

    const jobs = [...new Map([...jobsBefore, ...jobsAfter].map((job) => [job.id, job])).values()];
    const activity = JSON.stringify({
      jobs: jobs.map((job) => [job.id, job.status]),
      activeSessionIDs,
      inboxBefore: inboxCount(inboxBefore),
      inboxAfter: inboxCount(inboxAfter),
      sameSessionTree,
      generationChanged,
    });
    if (activity !== previousActivity) {
      previousActivity = activity;
      const inboxItems = (inboxes: Map<string, OpenCodeInboxItem[]>) => [...inboxes].flatMap(([sessionID, items]) =>
        items.map((item) => ({ sessionID, id: item.id, type: item.type, delivery: item.delivery })),
      );
      input.emit?.({
        type: "opencode.session.background_activity",
        data: {
          jobs: jobs.map((job) => ({
            id: job.id,
            kind: job.kind,
            sessionID: job.sessionID,
            status: job.status,
            ...(job.childSessionID ? { childSessionID: job.childSessionID } : {}),
          })),
          activeSessionIDs,
          inboxBefore: inboxCount(inboxBefore),
          inboxAfter: inboxCount(inboxAfter),
          inboxBeforeItems: inboxItems(inboxBefore),
          inboxAfterItems: inboxItems(inboxAfter),
          sameSessionTree,
          generationBefore: Object.fromEntries(generationBefore),
          generationAfter: Object.fromEntries(generationAfter),
        },
      });
    }

    const childSessions = [...new Set(jobs.flatMap((job) =>
      job.kind === "subagent" && job.status === "running" && job.childSessionID ? [job.childSessionID] : [],
    ))];
    if (childSessions.length > 0) {
      await Promise.all(childSessions.map((sessionID) => waitForSessionIdle({ ...input, sessionID })));
      pollDelay = 50;
    } else {
      // Shell and image jobs have no session wait endpoint. Terminal reports
      // can also be waiting to wake a session. Back off while preserving the
      // overall attempt deadline instead of returning on a timing heuristic.
      await sleep(pollDelay, input.signal);
      pollDelay = Math.min(pollDelay * 2, 1_000);
    }
  }
}

export class OpenCodeRuntime implements AgentRuntime {
  readonly type = "opencode" as const;

  constructor(
    private client: OpenCodeClient,
    readonly name: string,
    private listBackgroundJobs: ListOpenCodeBackgroundJobs,
    private readonly recovery: {
      reconnect?: OpenCodeConnector;
      timeoutMs?: number;
    } = {},
  ) {}

  static async fromConfig(
    context: RuntimeFactoryContext,
    config: Extract<RuntimeConfig, { type: "opencode" }>,
  ): Promise<OpenCodeRuntime> {
    let connect: OpenCodeConnector;
    if (config.base_url) {
      const token = config.token_env ? context.environment[config.token_env] : undefined;
      if (config.token_env && !token) throw new Error(`Missing OpenCode token environment variable: ${config.token_env}`);
      const headers = token ? { authorization: `Bearer ${token}` } : undefined;
      connect = async () => makeConnection(config.base_url!, headers);
    } else if (config.dedicated_service) {
      const service = prepareIsolatedOpenCodeService(context.dataDirectory);
      connect = async () => {
        const endpoint = await Service.ensure({
          file: service.registrationFile,
          command: [service.launcherPath],
          version: isSupportedOpenCodeVersion,
        });
        return makeConnection(endpoint.url, Service.headers(endpoint));
      };
    } else {
      connect = async () => {
        const endpoint = await Service.ensure({ version: isSupportedOpenCodeVersion });
        return makeConnection(endpoint.url, Service.headers(endpoint));
      };
    }
    const connection = await connect();
    return new OpenCodeRuntime(connection.client, context.name, connection.listBackgroundJobs, { reconnect: connect });
  }

  async check(): Promise<void> {
    const info = await withDeadline(this.client.server.info(), 10_000, "OpenCode health check timed out");
    if (!isSupportedOpenCodeVersion(info.version)) {
      throw new Error(`OpenCode server ${info.version} is unsupported; Gerry requires OpenCode >= 2.3.0`);
    }
  }

  private async recoverFailedSession(sessionID: string, input: RuntimeRunInput): Promise<void> {
    const timeoutMs = this.recovery.timeoutMs ?? 15_000;
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("OpenCode recovery timed out")), timeoutMs);
    const abort = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", abort, { once: true });
    const signal = controller.signal;
    const remaining = () => Math.max(1, deadline - Date.now());
    let lastError: unknown;
    let reconnecting: Promise<OpenCodeConnection> | undefined;
    try {
      while (Date.now() < deadline && !signal.aborted) {
        try {
          if (this.recovery.reconnect) {
            reconnecting ??= this.recovery.reconnect().then(
              (connection) => {
                reconnecting = undefined;
                return connection;
              },
              (error) => {
                reconnecting = undefined;
                throw error;
              },
            );
            const connection = await withDeadline(
              reconnecting,
              Math.min(5_000, remaining()),
              "OpenCode reconnection timed out",
            );
            this.client = connection.client;
            this.listBackgroundJobs = connection.listBackgroundJobs;
          }
          await withDeadline(this.check(), remaining(), "OpenCode recovery health check timed out");

          // Revoke the run environment before stopping execution so a late tool
          // call cannot use the old capability while recovery is in progress.
          await withDeadline(this.client.session.environment({
            sessionID,
            variables: sanitizeAgentCredentialEnvironment(input.environment),
          }, { signal }), remaining(), "OpenCode recovery environment cleanup timed out");

          let sessionIDs = [sessionID];
          let treeError: unknown;
          try {
            sessionIDs = await listOpenCodeSessionTree(this.client, sessionID, signal);
          } catch (error) {
            treeError = error;
          }
          const cleanups = await Promise.allSettled(sessionIDs.map((id) => withDeadline(
            this.client.session.environment({
              sessionID: id,
              variables: sanitizeAgentCredentialEnvironment(input.environment),
            }, { signal }),
            remaining(),
            `OpenCode recovery environment cleanup timed out for ${id}`,
          )));
          const interruptions = await Promise.allSettled(sessionIDs.map((id) => withDeadline(
            this.client.session.interrupt({ sessionID: id, resume: false }, { signal }),
            remaining(),
            `OpenCode interruption timed out for ${id}`,
          )));
          if (treeError) throw treeError;
          const failedCleanup = cleanups.find((result) => result.status === "rejected");
          if (failedCleanup) {
            throw failedCleanup.status === "rejected" ? failedCleanup.reason : new Error("OpenCode recovery environment cleanup failed");
          }
          const failedInterruption = interruptions.find((result) => result.status === "rejected");
          if (failedInterruption) {
            throw failedInterruption.status === "rejected" ? failedInterruption.reason : new Error("OpenCode interruption failed");
          }

          const sessionsAfter = await listOpenCodeSessionTree(this.client, sessionID, signal);
          const newSessionIDs = sessionsAfter.filter((id) => !sessionIDs.includes(id));
          if (newSessionIDs.length > 0) {
            await Promise.allSettled(newSessionIDs.map((id) => withDeadline(
              this.client.session.environment({
                sessionID: id,
                variables: sanitizeAgentCredentialEnvironment(input.environment),
              }, { signal }),
              remaining(),
              `OpenCode recovery environment cleanup timed out for ${id}`,
            )));
            await Promise.allSettled(newSessionIDs.map((id) => withDeadline(
              this.client.session.interrupt({ sessionID: id, resume: false }, { signal }),
              remaining(),
              `OpenCode interruption timed out for ${id}`,
            )));
            throw new Error("OpenCode session tree changed during recovery");
          }
          const jobs = await this.listBackgroundJobs(sessionID, signal);
          const active = await this.client.session.active({ signal });
          const activeSessionIDs = sessionsAfter.filter((id) => active[id]);
          const runningJobIDs = jobs.filter((job) => job.status === "running").map((job) => job.id);
          input.emit({
            type: "opencode.recovery.interrupted",
            data: { sessionIDs, activeSessionIDs, runningJobIDs },
          });
          return;
        } catch (error) {
          lastError = error;
          if (Date.now() >= deadline || signal.aborted) break;
          input.emit({
            type: "opencode.recovery.reconnecting",
            data: { error: compactError(error) },
          });
          try {
            await sleep(250, signal);
          } catch (sleepError) {
            lastError = sleepError;
            break;
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
    }
    input.emit({
      type: "opencode.recovery.failed",
      data: { error: compactError(lastError ?? "OpenCode recovery timed out") },
    });
  }

  async run(input: RuntimeRunInput): Promise<RuntimeResult> {
    if (input.signal.aborted) throw new RuntimeExecutionError(compactError(input.signal.reason));
    validateOpenCodeOptions(input.options);
    const options = optionsSchema.parse(input.options);
    await this.check();
    const controller = new AbortController();
    const abort = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => controller.abort(new Error(`OpenCode run timed out after ${input.timeoutMs}ms`)), input.timeoutMs);
    const signal = controller.signal;
    let sessionId = input.existingSessionId ?? "";
    let streamedText = "";
    let executionError: unknown;
    let usage: Usage | undefined;
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
      input.emit({
        type: "opencode.environment.applied",
        data: {
          dependencyBrokerConfigured: Boolean(input.environment.GERRY_DEPENDENCY_URL && input.environment.GERRY_AGENT_TOKEN),
        },
      });

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
            } else if (event.type === "session.tool.input.started" || event.type === "session.tool.called") {
              try {
                await this.client.session.environment({ sessionID: sessionId, variables: input.environment }, { signal });
              } catch (error) {
                input.emit({ type: "opencode.environment.refresh_failed", data: { error: compactError(error) } });
                throw error;
              }
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
        listBackgroundJobs: this.listBackgroundJobs,
        getSessionGeneration: (sessionID) => readOpenCodeSessionGeneration(this.client, sessionID, signal),
        emit: input.emit,
      });
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
      if (sessionId) await this.recoverFailedSession(sessionId, input);
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
        try {
          await withDeadline(
            this.client.session.environment({ sessionID: sessionId, variables: sanitizeAgentCredentialEnvironment(input.environment) }),
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
