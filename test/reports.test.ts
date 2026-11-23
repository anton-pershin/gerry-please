import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReportFetchHandler } from "../src/report-host.ts";
import { ReportService } from "../src/reports.ts";
import { Logger } from "../src/observability.ts";
import { createFetchHandler, WebhookHandler } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { temporaryDirectory } from "./helpers.ts";
import { enqueueWorkflow, issueContext, prContext, workflowConfigFixture } from "./workflow-helpers.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const fixture = workflowConfigFixture();
  directories.push(fixture.directory);
  const store = new Store(fixture.config.dataDir);
  enqueueWorkflow(store, fixture, issueContext(), "implement-approved-issue");
  const claimed = store.claimNext("worker")!;
  const workflow = store.getWorkflow(claimed.workflowId!);
  const workspace = workflow.workspacePath!;
  mkdirSync(join(workspace, "outputs", "bpe"), { recursive: true });
  mkdirSync(join(workspace, "outputs", "ablation"), { recursive: true });
  mkdirSync(join(workspace, "outputs", "replacement"), { recursive: true });
  writeFileSync(join(workspace, "outputs", "bpe", "index.html"), "BPE report");
  writeFileSync(join(workspace, "outputs", "ablation", "index.html"), "Ablation report");
  writeFileSync(join(workspace, "outputs", "replacement", "index.html"), "Replacement report");
  store.setWorkspace(claimed.id, workspace, workflow.branch, "worker");
  const capability = "report-test-capability";
  store.setAgentCapability(claimed.id, createHash("sha256").update(capability).digest("hex"), "worker");
  store.markRunning(claimed.id, "worker");
  const run = store.getRun(claimed.id);
  const logger = new Logger(join(fixture.config.dataDir, "reports-test.jsonl"), undefined, false);
  const service = new ReportService(store, "http://xxx.xxx.xxx.xxx:8123", logger);
  const webhook = new WebhookHandler(fixture.config, store, { appId: "1", privateKey: "private", webhookSecret: "secret" }, logger);
  const handler = createFetchHandler({ config: fixture.config, store, webhook, reports: service });
  return { fixture, store, run, capability, workspace, service, handler };
}

function publish(handler: (request: Request) => Promise<Response>, capability: string, body: unknown) {
  return handler(new Request("http://gerry.test/agent/reports/publish", {
    method: "POST",
    headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("managed report publications", () => {
  test("publishes different directories with capability auth, idempotency, and explicit replacement", async () => {
    const { fixture, store, run, capability, handler } = setup();
    const unauthorized = await handler(new Request("http://gerry.test/agent/reports/publish", { method: "POST", body: "{}" }));
    expect(unauthorized.status).toBe(401);

    const first = await publish(handler, capability, { name: "bpe", directory: "outputs/bpe" });
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({
      url: `http://xxx.xxx.xxx.xxx:8123/reports/${run.workflowId}/bpe/`,
      workflowId: run.workflowId,
      name: "bpe",
      status: "created",
    });
    const second = await publish(handler, capability, { name: "ablation", directory: "outputs/ablation" });
    expect(second.status).toBe(201);

    const retry = await publish(handler, capability, { name: "bpe", directory: "outputs/bpe" });
    expect(retry.status).toBe(200);
    expect((await retry.json()).status).toBe("unchanged");
    const conflict = await publish(handler, capability, { name: "bpe", directory: "outputs/replacement" });
    expect(conflict.status).toBe(409);
    const replaced = await publish(handler, capability, { name: "bpe", directory: "outputs/replacement", replace: true });
    expect(replaced.status).toBe(200);
    expect((await replaced.json()).status).toBe("replaced");

    const host = createReportFetchHandler(store);
    const bpe = await host(new Request(`http://reports.test/reports/${run.workflowId}/bpe/`));
    expect(await bpe.text()).toBe("Replacement report");
    const ablation = await host(new Request(`http://reports.test/reports/${run.workflowId}/ablation/`));
    expect(await ablation.text()).toBe("Ablation report");
    expect((await handler(new Request(`http://gerry.test/reports/${run.workflowId}/bpe/`))).status).toBe(404);
    expect(store.listReportPublications(run.workflowId!).map((report) => report.name)).toEqual(["ablation", "bpe"]);
    expect(store.unpublishReport(run.workflowId!, "ablation")).toBe(true);
    expect(store.unpublishReport(run.workflowId!, "ablation")).toBe(false);
    expect((await host(new Request(`http://reports.test/reports/${run.workflowId}/ablation/`))).status).toBe(404);

    expect((await publish(handler, capability, { name: "Bad_Name", directory: "outputs/bpe" })).status).toBe(400);
    expect((await publish(handler, capability, { name: "escape", directory: fixture.directory })).status).toBe(400);
    store.succeed(run.id, "worker", { runtimeSessionId: "session", responsePath: "/tmp/response", usage: null, sessionCompatibilityHash: "test" });
    expect((await host(new Request(`http://reports.test/reports/${run.workflowId}/bpe/`))).status).toBe(200);
    expect((await publish(handler, capability, { name: "expired", directory: "outputs/bpe" })).status).toBe(401);
    store.close();
  });

  test("persists publications across restart and unpublishes on merge without deleting files", async () => {
    const { fixture, store, run, capability, handler, workspace } = setup();
    expect((await publish(handler, capability, { name: "bpe", directory: "outputs/bpe" })).status).toBe(201);
    store.linkWorkflowPullRequest(prContext({ event: "pull_request", action: "opened", branch: run.branch! }));
    store.close();

    const restarted = new Store(fixture.config.dataDir);
    const host = createReportFetchHandler(restarted);
    expect((await host(new Request(`http://reports.test/reports/${run.workflowId}/bpe/`))).status).toBe(200);
    const merged = prContext({ event: "pull_request", action: "closed", merged: true, branch: run.branch! });
    expect(restarted.linkWorkflowPullRequest(merged)?.status).toBe("completed");
    expect(restarted.getActiveReportPublication(run.workflowId!, "bpe")).toBeNull();
    expect((await host(new Request(`http://reports.test/reports/${run.workflowId}/bpe/`))).status).toBe(404);
    expect(existsSync(join(workspace, "outputs", "bpe", "index.html"))).toBe(true);
    restarted.linkWorkflowPullRequest(merged);
    expect(restarted.getReportPublication(run.workflowId!, "bpe")?.unpublishedAt).not.toBeNull();
    const lateHandler = createFetchHandler({
      config: fixture.config,
      store: restarted,
      webhook: new WebhookHandler(fixture.config, restarted, { appId: "1", privateKey: "private", webhookSecret: "secret" }, new Logger(join(fixture.config.dataDir, "late-reports.jsonl"), undefined, false)),
      reports: new ReportService(restarted, "http://xxx.xxx.xxx.xxx:8123"),
    });
    expect((await publish(lateHandler, capability, { name: "late", directory: "outputs/bpe" })).status).toBe(409);
    restarted.close();
  });

  test("unpublishes on close-unmerged and does not silently restore URLs on reopen", async () => {
    const { store, run, capability, handler, workspace } = setup();
    expect((await publish(handler, capability, { name: "ablation", directory: "outputs/ablation" })).status).toBe(201);
    store.linkWorkflowPullRequest(prContext({ event: "pull_request", action: "opened", branch: run.branch! }));
    store.linkWorkflowPullRequest(prContext({ event: "pull_request", action: "closed", merged: false, branch: run.branch! }));
    expect(store.getWorkflow(run.workflowId!).status).toBe("closed");
    expect(store.getActiveReportPublication(run.workflowId!, "ablation")).toBeNull();
    store.linkWorkflowPullRequest(prContext({ event: "pull_request", action: "reopened", branch: run.branch! }));
    expect(store.getWorkflow(run.workflowId!).status).toBe("active");
    expect(store.getActiveReportPublication(run.workflowId!, "ablation")).toBeNull();
    expect(existsSync(join(workspace, "outputs", "ablation", "index.html"))).toBe(true);
    expect((await publish(handler, capability, { name: "ablation", directory: "outputs/ablation" })).status).toBe(409);
    expect((await publish(handler, capability, { name: "ablation", directory: "outputs/ablation", replace: true })).status).toBe(200);
    expect(store.getActiveReportPublication(run.workflowId!, "ablation")).not.toBeNull();
    store.close();
  });
});
