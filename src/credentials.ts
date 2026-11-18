import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { GERRY_GIT_AUTHOR_EMAIL, GERRY_GIT_AUTHOR_NAME } from "./github.ts";
import type { Logger } from "./observability.ts";
import type { Store } from "./store.ts";
import { compactError, withDeadline } from "./util.ts";

export interface CredentialTokenProvider {
  get(installationId: number, repositoryFullName: string, minimumLifetimeMs?: number): Promise<string>;
}

const credentialRequestSchema = z.object({ runId: z.string().min(1).max(128) }).strict();

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
    if (size > 1024) {
      await reader.cancel();
      throw new Error("Credential request is too large");
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

export class AgentCredentialService {
  constructor(
    private readonly store: Store,
    private readonly tokens: CredentialTokenProvider,
    private readonly logger: Logger,
  ) {}

  async handleAgentRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return json({ error: "Missing agent capability" }, 401);
    const capabilityHash = createHash("sha256").update(authorization.slice("Bearer ".length)).digest("hex");
    const run = this.store.getRunByAgentCapability(capabilityHash);
    if (!run) return json({ error: "Invalid or expired agent capability" }, 401);

    let input: z.infer<typeof credentialRequestSchema>;
    try {
      input = credentialRequestSchema.parse(JSON.parse(await readLimited(request)));
    } catch {
      return json({ error: "Invalid credential request" }, 400);
    }
    if (input.runId !== run.id) return json({ error: "Credential request does not match the capability owner" }, 403);

    try {
      const token = await withDeadline(
        this.tokens.get(run.installationId, run.repository),
        30_000,
        "GitHub credential issuance timed out",
      );
      return new Response(token, {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    } catch (error) {
      this.logger.warn("credential.issue_failed", { runId: run.id, repository: run.repository, error: compactError(error) });
      return json({ error: "Could not issue GitHub credentials" }, 502);
    }
  }
}

function wrapperPrelude(input: { runId: string; credentialUrl: string }): string {
  return `const runId = ${JSON.stringify(input.runId)};
const credentialUrl = ${JSON.stringify(input.credentialUrl)};
async function freshToken() {
  const response = await fetch(credentialUrl, {
    method: "POST",
    headers: { authorization: \`Bearer \${process.env.GERRY_AGENT_TOKEN}\`, "content-type": "application/json" },
    body: JSON.stringify({ runId }),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error("credential request failed");
  const token = (await response.text()).trim();
  if (token.length < 4 || /[\\r\\n]/.test(token)) throw new Error("invalid credential response");
  return token;
}
`;
}

function ghWrapper(input: { runId: string; credentialUrl: string; realGhPath: string }): string {
  return `#!${process.execPath}
import { spawn } from "node:child_process";
${wrapperPrelude(input)}
const realGhPath = ${JSON.stringify(input.realGhPath)};
try {
  const token = await freshToken();
  const child = spawn(realGhPath, process.argv.slice(2), {
    stdio: "inherit",
    env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
  });
  const exitCode = await new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
  process.exit(exitCode);
} catch {
  console.error("Gerry could not obtain GitHub credentials for this run");
  process.exit(1);
}
`;
}

function gitCredentialHelper(input: { runId: string; credentialUrl: string }): string {
  return `#!${process.execPath}
${wrapperPrelude(input)}
if ((process.argv[2] ?? "") === "get") {
  let request = "";
  for await (const chunk of process.stdin) request += chunk;
  if (/^protocol=https$/m.test(request) && /^host=github\\.com$/m.test(request)) {
    try {
      const token = await freshToken();
      console.log("username=x-access-token");
      console.log(\`password=\${token}\`);
    } catch {
      console.error("Gerry could not obtain GitHub credentials for this run");
      process.exitCode = 1;
    }
  }
}
`;
}

export function writeAgentCredentialWrappers(input: {
  directory: string;
  runId: string;
  credentialUrl: string;
  realGhPath: string;
}): void {
  mkdirSync(input.directory, { recursive: true, mode: 0o700 });
  const ghPath = join(input.directory, "gh");
  const helperPath = join(input.directory, "git-credential-gerry");
  const gitConfigPath = join(input.directory, "gitconfig");
  writeFileSync(ghPath, ghWrapper(input), { mode: 0o700 });
  writeFileSync(helperPath, gitCredentialHelper(input), { mode: 0o700 });
  writeFileSync(
    gitConfigPath,
    `[user]\n name = ${GERRY_GIT_AUTHOR_NAME}\n email = ${GERRY_GIT_AUTHOR_EMAIL}\n[credential]\n helper =\n`,
    { mode: 0o600 },
  );
  chmodSync(ghPath, 0o700);
  chmodSync(helperPath, 0o700);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function sanitizeAgentCredentialEnvironment(environment: Record<string, string>): Record<string, string> {
  const sanitized = Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !["GH_TOKEN", "GITHUB_TOKEN", "GERRY_AGENT_TOKEN"].includes(name) && !name.startsWith("GIT_CONFIG_"),
    ),
  );
  sanitized.GIT_TERMINAL_PROMPT = "0";
  sanitized.GIT_CONFIG_NOSYSTEM = "1";
  sanitized.GIT_CONFIG_COUNT = "1";
  sanitized.GIT_CONFIG_KEY_0 = "credential.helper";
  sanitized.GIT_CONFIG_VALUE_0 = "";
  // Keep Git pinned to the run's managed, helper-free configuration even after
  // its broker capability and wrappers have been retired. Removing this value
  // would silently re-enable the host's global configuration.
  if (environment.GIT_CONFIG_GLOBAL !== undefined) sanitized.GIT_CONFIG_GLOBAL = environment.GIT_CONFIG_GLOBAL;
  return sanitized;
}

export function applyAgentCredentialWrappers(environment: Record<string, string>, directory: string): void {
  environment.PATH = [directory, environment.PATH].filter(Boolean).join(":");
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_CONFIG_GLOBAL = join(directory, "gitconfig");
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_COUNT = "2";
  environment.GIT_CONFIG_KEY_0 = "credential.helper";
  environment.GIT_CONFIG_VALUE_0 = "";
  environment.GIT_CONFIG_KEY_1 = "credential.https://github.com.helper";
  environment.GIT_CONFIG_VALUE_1 = `!${shellQuote(join(directory, "git-credential-gerry"))}`;
}
