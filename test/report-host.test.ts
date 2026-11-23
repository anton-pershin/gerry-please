import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createReportFetchHandler,
  resolveHostedReportFile,
  resolveReportRoot,
  type ActiveReportPublication,
  type ReportHostStore,
} from "../src/report-host.ts";
import { temporaryDirectory } from "./helpers.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = temporaryDirectory();
  directories.push(directory);
  const workspace = join(directory, "workspace");
  const first = join(workspace, "outputs", "first-report");
  const second = join(workspace, "other", "second-report");
  mkdirSync(join(first, "assets"), { recursive: true });
  mkdirSync(second, { recursive: true });
  writeFileSync(join(first, "index.html"), "<h1>First</h1>");
  writeFileSync(join(first, "assets", "figure.svg"), "<svg>first</svg>");
  writeFileSync(join(second, "index.html"), "<h1>Second</h1>");
  writeFileSync(join(workspace, "outside-report.txt"), "not beneath either publication");
  const workflowId = `wf_${"a".repeat(32)}`;
  const publications = new Map<string, ActiveReportPublication>([
    [`${workflowId}/bpe`, { rootPath: first }],
    [`${workflowId}/ablation`, { rootPath: second }],
  ]);
  const store: ReportHostStore = {
    getActiveReportPublication: (workflow, name) => publications.get(`${workflow}/${name}`) ?? null,
  };
  return { directory, workspace, first, second, workflowId, publications, store };
}

describe("report hosting", () => {
  test("serves named publications from different directories and supports HEAD", async () => {
    const { store, workflowId } = fixture();
    const handler = createReportFetchHandler(store);
    const first = await handler(new Request(`http://reports.test/reports/${workflowId}/bpe/`));
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/html");
    expect(await first.text()).toBe("<h1>First</h1>");

    const second = await handler(new Request(`http://reports.test/reports/${workflowId}/ablation/index.html`));
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("<h1>Second</h1>");

    const asset = await handler(new Request(`http://reports.test/reports/${workflowId}/bpe/assets/figure.svg`));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe("<svg>first</svg>");

    const head = await handler(new Request(`http://reports.test/reports/${workflowId}/bpe/`, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String("<h1>First</h1>".length));
    expect(await head.text()).toBe("");

    const missing = await handler(new Request(`http://reports.test/reports/${workflowId}/unknown/`));
    expect(missing.status).toBe(404);
    const post = await handler(new Request(`http://reports.test/reports/${workflowId}/bpe/`, { method: "POST" }));
    expect(post.status).toBe(405);
  });

  test("serves through a real dynamic loopback port", async () => {
    const { store, workflowId } = fixture();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: createReportFetchHandler(store) });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/reports/${workflowId}/ablation/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<h1>Second</h1>");
    } finally {
      server.stop(true);
    }
  });

  test("validates publication roots and prevents workspace escapes", () => {
    const { directory, workspace, first } = fixture();
    expect(resolveReportRoot(workspace, "outputs/first-report")).toBe(first);
    expect(() => resolveReportRoot(workspace, ".")).toThrow("subdirectory");
    expect(() => resolveReportRoot(workspace, directory)).toThrow("relative path");
    expect(() => resolveReportRoot(workspace, "../outside")).toThrow();
    symlinkSync(directory, join(workspace, "outputs", "escape"), "dir");
    expect(() => resolveReportRoot(workspace, "outputs/escape")).toThrow("inside");
  });

  test("rejects traversal and symlinked files outside the publication root", () => {
    const { workspace, first } = fixture();
    expect(resolveHostedReportFile(first, ["..", "outside-report.txt"])).toBeNull();
    expect(resolveHostedReportFile(first, ["assets", "..", "index.html"])).toBeNull();
    symlinkSync(join(workspace, "outside-report.txt"), join(first, "assets", "escape.txt"), "file");
    expect(resolveHostedReportFile(first, ["assets", "escape.txt"])).toBeNull();
    expect(resolveHostedReportFile(first, ["assets", "figure.svg"])).toBe(join(first, "assets", "figure.svg"));
  });
});
