import { createHash } from "node:crypto";
import { z } from "zod";
import { REPORT_PUBLICATION_NAME, resolveReportRoot, type ReportHostStore } from "./report-host.ts";
import type { Logger } from "./observability.ts";
import type { ReportPublicationRecord, RunRecord } from "./types.ts";
import { compactError } from "./util.ts";

const publishSchema = z.object({
  name: z.string().regex(REPORT_PUBLICATION_NAME),
  directory: z.string().min(1),
  replace: z.boolean().default(false),
}).strict();

export interface PublishReportInput {
  workflowId: string;
  repository: string;
  name: string;
  rootPath: string;
  runId: string;
  replace: boolean;
  now: number;
}

export type PublishReportResult = {
  status: "created" | "replaced" | "unchanged" | "conflict";
  publication: ReportPublicationRecord;
} | {
  status: "unavailable";
};

export interface ReportStore extends ReportHostStore {
  getRunByAgentCapability(capabilityHash: string): RunRecord | null;
  getReportPublication(workflowId: string, name: string): ReportPublicationRecord | null;
  publishReport(input: PublishReportInput): PublishReportResult;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function readLimited(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 64 * 1024) {
      await reader.cancel();
      throw new Error("Report publication request is too large");
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Buffer.from(result).toString("utf8");
}

export class ReportHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class ReportService {
  constructor(
    private readonly store: ReportStore,
    private readonly publicBaseUrl: string,
    private readonly logger?: Pick<Logger, "info" | "warn">,
  ) {}

  async handleAgentRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return json({ error: "Missing agent capability" }, 401);
    const capabilityHash = createHash("sha256").update(authorization.slice("Bearer ".length)).digest("hex");
    const run = this.store.getRunByAgentCapability(capabilityHash);
    if (!run) return json({ error: "Invalid or expired agent capability" }, 401);
    let body: unknown;
    try {
      body = JSON.parse(await readLimited(request));
    } catch (error) {
      return json({ error: `Invalid report publication request: ${compactError(error)}` }, 400);
    }
    try {
      const result = this.publish(run, body);
      return json(result, result.status === "created" ? 201 : 200);
    } catch (error) {
      if (error instanceof ReportHttpError) return json({ error: error.message }, error.status);
      this.logger?.warn("report.publication_failed", { runId: run.id, error: compactError(error) });
      return json({ error: "Could not publish report" }, 500);
    }
  }

  publish(run: RunRecord, body: unknown): { url: string; workflowId: string; name: string; status: PublishReportResult["status"] } {
    if (!run.workflowId || !run.workspacePath) {
      throw new ReportHttpError(409, "Only a workflow run with an assigned workspace can publish reports");
    }
    let input: z.infer<typeof publishSchema>;
    try {
      input = publishSchema.parse(body);
    } catch (error) {
      throw new ReportHttpError(400, error instanceof Error ? error.message : "Invalid report publication");
    }
    let rootPath: string;
    try {
      rootPath = resolveReportRoot(run.workspacePath, input.directory);
    } catch (error) {
      throw new ReportHttpError(400, error instanceof Error ? error.message : "Invalid report directory");
    }
    const result = this.store.publishReport({
      workflowId: run.workflowId,
      repository: run.repository,
      name: input.name,
      rootPath,
      runId: run.id,
      replace: input.replace,
      now: Date.now(),
    });
    if (result.status === "conflict") {
      throw new ReportHttpError(409, "Report publication name already exists; choose another name or set replace: true");
    }
    if (result.status === "unavailable") {
      throw new ReportHttpError(409, "The workflow is not active, so it cannot publish reports");
    }
    const base = this.publicBaseUrl.replace(/\/$/, "");
    const url = `${base}/reports/${run.workflowId}/${input.name}/`;
    this.logger?.info("report.publication_updated", {
      runId: run.id,
      workflowId: run.workflowId,
      name: input.name,
      status: result.status,
    });
    return { url, workflowId: run.workflowId, name: input.name, status: result.status };
  }
}
