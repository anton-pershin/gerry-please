import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const REPORT_PUBLICATION_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const REPORT_WORKFLOW_ID = /^wf_[a-f0-9]{32}$/;

export interface ActiveReportPublication {
  rootPath: string;
}

export interface ReportHostStore {
  getActiveReportPublication(workflowId: string, name: string): ActiveReportPublication | null;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function resolveReportRoot(workspacePath: string, directory: string): string {
  if (!directory || isAbsolute(directory)) throw new Error("Report directory must be a non-empty relative path");
  const workspace = realpathSync(workspacePath);
  const candidate = resolve(workspace, directory);
  if (!isWithin(workspace, candidate) || candidate === workspace) {
    throw new Error("Report directory must be a subdirectory of the run workspace");
  }
  const root = realpathSync(candidate);
  if (!isWithin(workspace, root) || root === workspace) {
    throw new Error("Report directory must remain inside the run workspace");
  }
  if (!statSync(root).isDirectory()) throw new Error("Report path is not a directory");
  const workspaceRelative = relative(workspace, root);
  if (workspaceRelative === ".git" || workspaceRelative.startsWith(`.git${sep}`)) {
    throw new Error("The Git metadata directory cannot be published");
  }
  return root;
}

export function resolveHostedReportFile(rootPath: string, segments: string[]): string | null {
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\\/\0]/.test(segment))) return null;
  try {
    const root = realpathSync(rootPath);
    const candidate = resolve(root, ...segments);
    if (!isWithin(root, candidate)) return null;
    const file = realpathSync(candidate);
    if (!isWithin(root, file) || !statSync(file).isFile()) return null;
    return file;
  } catch {
    return null;
  }
}

function notFound(): Response {
  return new Response("Not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export function createReportFetchHandler(store: ReportHostStore): (request: Request) => Response {
  return (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/reports/")) return notFound();
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
    }

    let parts: string[];
    try {
      parts = url.pathname.slice(1).split("/").map((part) => decodeURIComponent(part));
    } catch {
      return new Response("Malformed URL\n", { status: 400 });
    }
    const directoryRequest = parts.at(-1) === "";
    if (directoryRequest) parts.pop();
    const [prefix, workflowId, name, ...segments] = parts;
    if (prefix !== "reports" || !workflowId || !name || !REPORT_WORKFLOW_ID.test(workflowId) || !REPORT_PUBLICATION_NAME.test(name)) {
      return notFound();
    }
    if (segments.length === 0 || directoryRequest) segments.push("index.html");
    const publication = store.getActiveReportPublication(workflowId, name);
    if (!publication) return notFound();
    const filePath = resolveHostedReportFile(publication.rootPath, segments);
    if (!filePath) return notFound();

    const file = Bun.file(filePath);
    const headers = {
      "cache-control": "no-cache",
      "content-length": String(file.size),
      "content-type": file.type || "application/octet-stream",
      "x-content-type-options": "nosniff",
    };
    return request.method === "HEAD" ? new Response(null, { headers }) : new Response(file, { headers });
  };
}
