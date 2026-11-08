import { App } from "@octokit/app";
import type { InstallationAccessTokenAuthentication } from "@octokit/auth-app";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentConfig, LoadedConfig } from "./config.ts";
import { withDeadline } from "./util.ts";

export function verifyWebhookSignature(payload: string, signature: string | null, secret: string): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(payload, "utf8").digest("hex");
  const actual = signature.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/i.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export interface GitHubSecrets {
  appId: string;
  privateKey: string;
  webhookSecret: string;
}

export function loadGitHubSecrets(config: LoadedConfig, environment: NodeJS.ProcessEnv = process.env): GitHubSecrets {
  const appId = environment[config.github.app_id_env];
  const privateKeyPath = environment[config.github.private_key_path_env];
  const webhookSecret = environment[config.github.webhook_secret_env];
  const missing: string[] = [];
  if (!appId) missing.push(config.github.app_id_env);
  if (!privateKeyPath) missing.push(config.github.private_key_path_env);
  if (!webhookSecret) missing.push(config.github.webhook_secret_env);
  if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  return { appId: appId!, privateKey: readFileSync(privateKeyPath!, "utf8"), webhookSecret: webhookSecret! };
}

export class GitHubAppTokens {
  private readonly app: App;
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();

  constructor(secrets: GitHubSecrets) {
    this.app = new App({ appId: secrets.appId, privateKey: secrets.privateKey });
  }

  async get(installationId: number, repositoryFullName: string): Promise<string> {
    const repositoryName = repositoryFullName.split("/")[1];
    if (!repositoryName) throw new Error(`Invalid repository full name: ${repositoryFullName}`);
    const cacheKey = `${installationId}:${repositoryFullName}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
    const octokit = await this.app.getInstallationOctokit(installationId);
    const authentication = (await octokit.auth({
      type: "installation",
      repositoryNames: [repositoryName],
    })) as InstallationAccessTokenAuthentication;
    if (authentication.type !== "token" || !authentication.token || !authentication.expiresAt) {
      throw new Error(`Could not obtain an installation token for ${repositoryFullName} (installation ${installationId})`);
    }
    this.cache.set(cacheKey, {
      token: authentication.token,
      expiresAt: Date.parse(authentication.expiresAt),
    });
    return authentication.token;
  }

  private async installationToken(repositoryFullName: string): Promise<string> {
    const [owner, repository] = repositoryFullName.split("/");
    if (!owner || !repository) throw new Error(`Invalid repository full name: ${repositoryFullName}`);
    const installation = await this.app.octokit.request("GET /repos/{owner}/{repo}/installation", {
      owner,
      repo: repository,
    });
    const installationId = Number((installation.data as { id?: unknown }).id);
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new Error(`GitHub App is not installed on ${repositoryFullName}`);
    }
    return this.get(installationId, repositoryFullName);
  }

  async getIssue(repositoryFullName: string, issueNumber: number): Promise<{ number: number; url: string; body: string }> {
    const [owner, repository] = repositoryFullName.split("/");
    const token = await this.installationToken(repositoryFullName);
    const result = await withDeadline(fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repository!)}/issues/${issueNumber}`,
      { headers: this.apiHeaders(token) },
    ), 30_000, "Dependency issue lookup timed out");
    if (!result.ok) throw new Error(`Dependency issue lookup failed with HTTP ${result.status}`);
    const issue = await result.json() as { number?: number; html_url?: string; body?: string | null };
    if (!issue.number || !issue.html_url) throw new Error("GitHub returned an incomplete issue response");
    return { number: issue.number, url: issue.html_url, body: issue.body ?? "" };
  }

  async verifyIssueClosedByPullRequest(repositoryFullName: string, issueNumber: number, mergeCommitSha: string): Promise<boolean> {
    const [owner, repository] = repositoryFullName.split("/");
    const token = await this.installationToken(repositoryFullName);
    for (let page = 1; page <= 10; page += 1) {
      const result = await withDeadline(fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repository!)}/issues/${issueNumber}/timeline?per_page=100&page=${page}`,
        { headers: this.apiHeaders(token) },
      ), 30_000, "Dependency timeline verification timed out");
      if (!result.ok) throw new Error(`Dependency timeline verification failed with HTTP ${result.status}`);
      const events = await result.json() as Array<{ event?: string; commit_id?: string | null }>;
      if (events.some((event) => event.event === "closed" && event.commit_id === mergeCommitSha)) return true;
      if (events.length < 100) return false;
    }
    return false;
  }

  private apiHeaders(token: string): Record<string, string> {
    return {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "gerry-please",
      "x-github-api-version": "2026-03-10",
    };
  }

  async createIssue(repositoryFullName: string, title: string, body: string): Promise<{ number: number; url: string }> {
    const [owner, repository] = repositoryFullName.split("/");
    if (!owner || !repository) throw new Error(`Invalid repository full name: ${repositoryFullName}`);
    const installation = await this.app.octokit.request("GET /repos/{owner}/{repo}/installation", {
      owner,
      repo: repository,
    });
    const installationId = Number((installation.data as { id?: unknown }).id);
    if (!Number.isInteger(installationId) || installationId <= 0) {
      throw new Error(`GitHub App is not installed on ${repositoryFullName}`);
    }
    const token = await this.get(installationId, repositoryFullName);
    const result = await withDeadline(fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "gerry-please",
          "x-github-api-version": "2026-03-10",
        },
        body: JSON.stringify({ title, body }),
      },
    ), 30_000, "Dependency issue creation timed out");
    if (!result.ok) {
      const details = (await result.text()).slice(0, 2000);
      throw new Error(`GitHub issue creation failed with HTTP ${result.status}: ${details}`);
    }
    const issue = await result.json() as { number?: number; html_url?: string };
    if (!issue.number || !issue.html_url) throw new Error("GitHub returned an incomplete issue response");
    return { number: issue.number, url: issue.html_url };
  }

  async check(): Promise<void> {
    await this.app.octokit.request("GET /app");
  }
}

const DEFAULT_ENVIRONMENT = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

export function gitCredentialEnvironment(token: string): Record<string, string> {
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "!f() { echo username=x-access-token; echo password=\"$GH_TOKEN\"; }; f",
  };
}

export function buildAgentEnvironment(input: {
  agent: AgentConfig;
  token: string;
  runId: string;
  repository: string;
  workspacePath: string;
  processEnvironment?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const processEnvironment = input.processEnvironment ?? process.env;
  const environment: Record<string, string> = {};
  const allowed = new Set([...DEFAULT_ENVIRONMENT, ...input.agent.pass_environment]);
  for (const name of allowed) {
    const value = processEnvironment[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(processEnvironment)) {
    if ((name.startsWith("LC_") || name.startsWith("XDG_")) && value !== undefined) environment[name] = value;
  }
  Object.assign(environment, input.agent.env, gitCredentialEnvironment(input.token), {
    GERRY_RUN_ID: input.runId,
    GERRY_REPOSITORY: input.repository,
    GERRY_WORKSPACE: input.workspacePath,
  });
  return environment;
}
