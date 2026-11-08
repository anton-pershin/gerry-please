import { createHmac } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Logger } from "../src/observability.ts";
import { WebhookHandler } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { configFixture, issuePayload, temporaryDirectory } from "./helpers.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const fixture = configFixture();
  directories.push(fixture.directory);
  const store = new Store(fixture.config.dataDir);
  const logger = new Logger(join(fixture.config.dataDir, "test.jsonl"), undefined, false);
  const secrets = { appId: "1", privateKey: "private", webhookSecret: "webhook-secret" };
  return { ...fixture, store, handler: new WebhookHandler(fixture.config, store, secrets, logger), secrets };
}

function request(payload: unknown, secret: string, deliveryId = "00000000-0000-4000-8000-000000000001"): Request {
  const raw = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  return new Request("http://localhost/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body: raw,
  });
}

describe("webhook ingress", () => {
  test("rejects bad signatures before persisting", async () => {
    const { handler, store, config } = setup();
    const result = await handler.handle(request(issuePayload(), "wrong"));
    expect(result.status).toBe(401);
    expect(store.hasDelivery("00000000-0000-4000-8000-000000000001")).toBe(false);
    expect(existsSync(join(config.dataDir, "deliveries", "00000000-0000-4000-8000-000000000001.json"))).toBe(false);
    store.close();
  });

  test("persists before acknowledgement, dispatches, and deduplicates", async () => {
    const { handler, store } = setup();
    const first = await handler.handle(request(issuePayload(), "webhook-secret"));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true, matched: 1, queued: 1 });
    expect(store.getDelivery("00000000-0000-4000-8000-000000000001").status).toBe("completed");
    expect(store.listRuns(10)).toHaveLength(1);
    const duplicate = await handler.handle(request(issuePayload(), "webhook-secret"));
    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true });
    expect(store.listRuns(10)).toHaveLength(1);
    store.close();
  });

  test("resumes incomplete deliveries on redelivery and startup recovery", async () => {
    const { handler, store, config } = setup();
    const payload = issuePayload();
    const redeliveryId = "00000000-0000-4000-8000-000000000002";
    const payloadPath = join(config.dataDir, "deliveries", `${redeliveryId}.json`);
    writeFileSync(payloadPath, JSON.stringify(payload));
    store.insertDelivery({
      id: redeliveryId,
      event: "issues",
      action: "opened",
      repository: "acme/widgets",
      installationId: 1234,
      payloadPath,
    });
    const resumed = await handler.handle(request(payload, "webhook-secret", redeliveryId));
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ ok: true, matched: 1, queued: 1, resumed: true });
    expect(store.listRuns(10)).toHaveLength(1);

    store.setDeliveryStatus(redeliveryId, "dispatch_failed", "simulated crash after dispatch");
    const recovered = await handler.recover();
    expect(recovered).toBe(1);
    expect(store.getDelivery(redeliveryId).status).toBe("completed");
    expect(store.listRuns(10)).toHaveLength(1);
    store.close();
  });

  test("rejects unsafe delivery IDs and aborts oversized streaming bodies", async () => {
    const { handler, store, config } = setup();
    const invalid = await handler.handle(request(issuePayload(), "webhook-secret", "../escape"));
    expect(invalid.status).toBe(400);
    expect(existsSync(join(config.dataDir, "escape.json"))).toBe(false);

    config.server.max_body_bytes = 1024;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024));
        controller.enqueue(new Uint8Array(1024));
        controller.close();
      },
    });
    const oversized = await handler.handle(new Request("http://localhost/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": "00000000-0000-4000-8000-000000000003",
        "x-hub-signature-256": "sha256=unused",
      },
      body: stream,
      duplex: "half",
    } as RequestInit));
    expect(oversized.status).toBe(413);
    expect(store.hasDelivery("00000000-0000-4000-8000-000000000003")).toBe(false);
    store.close();
  });

  test("durably ignores repositories outside config", async () => {
    const { handler, store } = setup();
    const payload = issuePayload();
    (payload.repository as Record<string, unknown>).full_name = "other/repo";
    const result = await handler.handle(request(payload, "webhook-secret"));
    expect(result.status).toBe(200);
    expect(store.getDelivery("00000000-0000-4000-8000-000000000001").status).toBe("ignored");
    expect(store.listRuns(10)).toHaveLength(0);
    store.close();
  });
});
