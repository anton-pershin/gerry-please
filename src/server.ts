import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedConfig } from "./config.ts";
import type { DependencyService } from "./dependencies.ts";
import { readPrompt, resolveConfigPath } from "./config.ts";
import { verifyWebhookSignature, type GitHubSecrets } from "./github.ts";
import { Logger, atomicWrite } from "./observability.ts";
import { buildContext, parentRunFromPayload, ruleMatches } from "./rules.ts";
import type { Store } from "./store.ts";
import type { JsonObject } from "./types.ts";
import { compactError } from "./util.ts";

const DELIVERY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

class PayloadTooLarge extends Error {}

async function readBody(request: Request, maximum: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximum) {
      await reader.cancel();
      throw new PayloadTooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Buffer.from(body).toString("utf8");
}

export class WebhookHandler {
  constructor(
    private readonly config: LoadedConfig,
    private readonly store: Store,
    private readonly secrets: GitHubSecrets,
    private readonly logger: Logger,
    private readonly dependencies?: DependencyService,
  ) {}

  async handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > this.config.server.max_body_bytes) return response({ error: "Payload too large" }, 413);
    let raw: string;
    try {
      raw = await readBody(request, this.config.server.max_body_bytes);
    } catch (error) {
      if (error instanceof PayloadTooLarge) return response({ error: "Payload too large" }, 413);
      throw error;
    }
    if (!verifyWebhookSignature(raw, request.headers.get("x-hub-signature-256"), this.secrets.webhookSecret)) {
      this.logger.warn("webhook.signature_rejected");
      return response({ error: "Invalid signature" }, 401);
    }

    const event = request.headers.get("x-github-event");
    const deliveryId = request.headers.get("x-github-delivery");
    if (!event || !deliveryId) return response({ error: "Missing X-GitHub-Event or X-GitHub-Delivery" }, 400);
    if (!DELIVERY_ID.test(deliveryId) || !/^[a-z][a-z0-9_]{0,99}$/.test(event)) {
      return response({ error: "Invalid GitHub event or delivery ID" }, 400);
    }
    let payload: JsonObject;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      payload = parsed as JsonObject;
    } catch {
      return response({ error: "Invalid JSON payload" }, 400);
    }
    const action = typeof payload.action === "string" ? payload.action : "";

    const existing = this.store.hasDelivery(deliveryId) ? this.store.getDelivery(deliveryId) : null;
    if (existing && ["completed", "ignored"].includes(existing.status)) {
      this.logger.info("webhook.duplicate", { deliveryId, event, action });
      return response({ ok: true, duplicate: true });
    }
    if (!existing) {
      const repository = (payload.repository as JsonObject | undefined)?.full_name;
      const installation = (payload.installation as JsonObject | undefined)?.id;
      const payloadPath = join(this.store.deliveriesDirectory, `${deliveryId}.json`);
      atomicWrite(payloadPath, `${JSON.stringify(payload, null, 2)}\n`);
      const inserted = this.store.insertDelivery({
        id: deliveryId,
        event,
        action,
        repository: typeof repository === "string" ? repository : "",
        installationId: Number(installation) || 0,
        payloadPath,
      });
      if (!inserted) return response({ ok: true, duplicate: true });
      this.logger.info("webhook.received", { deliveryId, event, action, repository });
    } else {
      this.logger.info("webhook.resume", { deliveryId, previousStatus: existing.status });
    }
    return this.dispatch(deliveryId, Boolean(existing));
  }

  async recover(): Promise<number> {
    const incomplete = this.store.listIncompleteDeliveries();
    let recovered = 0;
    for (const delivery of incomplete) {
      const result = await this.dispatch(delivery.id, true);
      if (result.status === 200) recovered += 1;
    }
    if (this.dependencies) recovered += await this.dependencies.recover();
    if (incomplete.length > 0) this.logger.info("webhook.recovery_finished", { examined: incomplete.length, recovered });
    return recovered;
  }

  private async dispatch(deliveryId: string, resumed: boolean): Promise<Response> {
    try {
      const delivery = this.store.getDelivery(deliveryId);
      const payload = JSON.parse(readFileSync(delivery.payloadPath, "utf8")) as JsonObject;
      if (delivery.event === "ping") {
        this.store.setDeliveryStatus(deliveryId, "completed");
        return response({ ok: true, message: "pong", ...(resumed ? { resumed: true } : {}) });
      }
      if (!this.config.repositories[delivery.repository]) {
        this.store.setDeliveryStatus(deliveryId, "ignored", "Repository is not configured");
        this.logger.info("webhook.ignored", { deliveryId, reason: "repository_not_configured", repository: delivery.repository });
        return response({ ok: true, ignored: true, reason: "repository_not_configured", ...(resumed ? { resumed: true } : {}) });
      }

      const context = buildContext({
        deliveryId,
        event: delivery.event,
        action: delivery.action,
        payload,
      });
      if (this.dependencies) await this.dependencies.track(context);
      let queued = 0;
      let matched = 0;
      for (const rule of this.config.rules) {
        if (!ruleMatches(rule, context)) continue;
        matched += 1;
        const agent = this.config.agents[rule.agent]!;
        const runtime = this.config.runtimes[agent.runtime]!;
        const prompt = readPrompt(this.config, rule.prompt);
        const decision = this.store.enqueueRun({
          context,
          rule,
          agent,
          agentName: rule.agent,
          runtimeName: agent.runtime,
          runtime,
          promptPath: prompt.path,
          promptHash: prompt.hash,
          promptContents: prompt.contents,
          instructions: agent.instructions
            ? readFileSync(resolveConfigPath(this.config.baseDir, agent.instructions), "utf8")
            : "",
          configHash: this.config.hash,
          parentRunId: parentRunFromPayload(payload),
        });
        if (decision.decision === "queued") queued += 1;
        this.logger.info("webhook.dispatched", {
          deliveryId,
          rule: rule.name,
          decision: decision.decision,
          reason: decision.reason,
          runId: decision.runId,
          resumed,
        });
      }
      this.store.setDeliveryStatus(deliveryId, "completed", matched === 0 ? "No rules matched" : null);
      return response({ ok: true, matched, queued, ...(resumed ? { resumed: true } : {}) });
    } catch (error) {
      const message = compactError(error);
      this.store.setDeliveryStatus(deliveryId, "dispatch_failed", message);
      this.logger.error("webhook.dispatch_failed", { deliveryId, error: message });
      return response({ error: "Delivery persisted but dispatch failed", deliveryId }, 500);
    }
  }
}

export function createFetchHandler(input: {
  config: LoadedConfig;
  store: Store;
  webhook: WebhookHandler;
  dependencies?: DependencyService;
}): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return response({ ok: true, runs: input.store.stats() });
    }
    if (url.pathname === "/webhooks/github") return input.webhook.handle(request);
    if (url.pathname === "/agent/dependencies" && input.dependencies) {
      return input.dependencies.handleAgentRequest(request);
    }
    return response({ error: "Not found" }, 404);
  };
}
