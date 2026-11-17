import { App } from "@octokit/app";
import type { InstallationAccessTokenAuthentication } from "@octokit/auth-app";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, LoadedConfig } from "./config.ts";
import type { MergeObservation } from "./store.ts";
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

const DEFAULT_MINIMUM_TOKEN_LIFETIME_MS = 5 * 60_000;

export function hasSufficientTokenLifetime(expiresAt: number, minimumLifetimeMs = 0, timestamp = Date.now()): boolean {
  return expiresAt - timestamp > Math.max(DEFAULT_MINIMUM_TOKEN_LIFETIME_MS, minimumLifetimeMs);
}

interface PullRequestClosureEvidence {
  merged?: boolean;
  merge_commit_sha?: string | null;
  merged_at?: string | null;
  merged_by?: { login?: string } | null;
  base?: { ref?: string };
  body?: string | null;
}

interface IssueClosureTimelineEvent {
  event?: string;
  commit_id?: string | null;
  created_at?: string;
  actor?: { login?: string } | null;
}

export function verifyPullRequestClosureEvidence(input: {
  pullRequest: PullRequestClosureEvidence;
  timeline: IssueClosureTimelineEvent[];
  observation: MergeObservation;
  issueNumber: number;
  commitAssociationVerified?: boolean;
}): boolean {
  const { pullRequest, observation, timeline, issueNumber } = input;
  const mergedAt = Date.parse(pullRequest.merged_at ?? "");
  if (pullRequest.merged !== true) return false;
  if (pullRequest.merge_commit_sha) {
    if (pullRequest.merge_commit_sha !== observation.mergeCommitSha) return false;
  } else if (input.commitAssociationVerified !== true) {
    return false;
  }
  if (pullRequest.base?.ref !== observation.baseRef || !Number.isFinite(mergedAt)) return false;
  if (Math.abs(mergedAt - observation.mergedAt) > 1000) return false;
  if (typeof pullRequest.body !== "string") return false;
  const closingPattern = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issueNumber}\\b`, "i");
  if (!closingPattern.test(pullRequest.body)) return false;

  let squashCandidate = false;
  let mismatchedCommit = false;
  for (const event of timeline) {
    if (event.event !== "closed") continue;
    if (event.commit_id) {
      if (event.commit_id === observation.mergeCommitSha) return true;
      mismatchedCommit = true;
      continue;
    }
    const closedAt = Date.parse(event.created_at ?? "");
    const actor = event.actor?.login;
    const merger = pullRequest.merged_by?.login;
    const closeFollowsMerge = closedAt + 5000 >= mergedAt;
    const closeWithinMergeWindow = closedAt <= mergedAt + 5 * 60_000;
    if (Number.isFinite(closedAt) && closeFollowsMerge && closeWithinMergeWindow && actor && actor === merger) {
      squashCandidate = true;
    }
  }
  return squashCandidate && !mismatchedCommit;
}

export class GitHubAppTokens {
  private readonly app: App;
  private readonly cache = new Map<string, { token: string; expiresAt: number }>();

  constructor(secrets: GitHubSecrets) {
    this.app = new App({ appId: secrets.appId, privateKey: secrets.privateKey });
  }

  async get(installationId: number, repositoryFullName: string, minimumLifetimeMs = 0): Promise<string> {
    const repositoryName = repositoryFullName.split("/")[1];
    if (!repositoryName) throw new Error(`Invalid repository full name: ${repositoryFullName}`);
    const cacheKey = `${installationId}:${repositoryFullName}`;
    const cached = this.cache.get(cacheKey);
    if (cached && hasSufficientTokenLifetime(cached.expiresAt, minimumLifetimeMs)) return cached.token;
    const octokit = await this.app.getInstallationOctokit(installationId);
    const authentication = (await octokit.auth({
      type: "installation",
      repositoryNames: [repositoryName],
      refresh: true,
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

  async getIssue(repositoryFullName: string, issueNumber: number): Promise<{ number: number; url: string; body: string; labels: string[]; state: string }> {
    const [owner, repository] = repositoryFullName.split("/");
    const token = await this.installationToken(repositoryFullName);
    const result = await withDeadline(fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(repository!)}/issues/${issueNumber}`,
      { headers: this.apiHeaders(token) },
    ), 30_000, "Dependency issue lookup timed out");
    if (!result.ok) throw new Error(`Dependency issue lookup failed with HTTP ${result.status}`);
    const issue = await result.json() as {
      number?: number;
      html_url?: string;
      body?: string | null;
      state?: string;
      labels?: Array<{ name?: string } | string>;
    };
    if (!issue.number || !issue.html_url) throw new Error("GitHub returned an incomplete issue response");
    const labels = (issue.labels ?? []).flatMap((label) => {
      const name = typeof label === "string" ? label : label.name;
      return name ? [name] : [];
    });
    return { number: issue.number, url: issue.html_url, body: issue.body ?? "", labels, state: issue.state ?? "open" };
  }

  async verifyIssueClosedByPullRequest(repositoryFullName: string, issueNumber: number, observation: MergeObservation): Promise<boolean> {
    const [owner, repository] = repositoryFullName.split("/");
    if (!owner || !repository) throw new Error(`Invalid repository full name: ${repositoryFullName}`);
    const token = await this.installationToken(repositoryFullName);
    const pullRequestResult = await withDeadline(fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${observation.prNumber}`,
      { headers: this.apiHeaders(token) },
    ), 30_000, "Dependency pull request lookup timed out");
    if (!pullRequestResult.ok) throw new Error(`Dependency pull request lookup failed with HTTP ${pullRequestResult.status}`);
    const pullRequest = await pullRequestResult.json() as PullRequestClosureEvidence;
    let commitAssociationVerified = false;
    if (!pullRequest.merge_commit_sha) {
      const associationResult = await withDeadline(fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(observation.mergeCommitSha)}/pulls`,
        { headers: this.apiHeaders(token) },
      ), 30_000, "Dependency merge-commit association lookup timed out");
      if (!associationResult.ok) throw new Error(`Dependency merge-commit association lookup failed with HTTP ${associationResult.status}`);
      const associated = await associationResult.json() as Array<{ number?: number; state?: string; merged_at?: string | null; base?: { ref?: string } }>;
      commitAssociationVerified = associated.some((candidate) => {
        const mergedAt = Date.parse(candidate.merged_at ?? "");
        return candidate.number === observation.prNumber && candidate.state === "closed" &&
          candidate.base?.ref === observation.baseRef && Number.isFinite(mergedAt) &&
          Math.abs(mergedAt - observation.mergedAt) <= 1000;
      });
    }
    for (let page = 1; page <= 10; page += 1) {
      const result = await withDeadline(fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${issueNumber}/timeline?per_page=100&page=${page}`,
        { headers: this.apiHeaders(token) },
      ), 30_000, "Dependency timeline verification timed out");
      if (!result.ok) throw new Error(`Dependency timeline verification failed with HTTP ${result.status}`);
      const timeline = await result.json() as IssueClosureTimelineEvent[];
      if (verifyPullRequestClosureEvidence({ pullRequest, timeline, observation, issueNumber, commitAssociationVerified })) return true;
      if (timeline.length < 100) return false;
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

  async createIssueComment(repositoryFullName: string, issueNumber: number, body: string): Promise<{ id: number; url: string }> {
    const [owner, repository] = repositoryFullName.split("/");
    if (!owner || !repository) throw new Error(`Invalid repository full name: ${repositoryFullName}`);
    const token = await this.installationToken(repositoryFullName);
    const result = await withDeadline(fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: { ...this.apiHeaders(token), "content-type": "application/json" },
        body: JSON.stringify({ body }),
      },
    ), 30_000, "Dependency issue comment timed out");
    if (!result.ok) throw new Error(`Dependency issue comment failed with HTTP ${result.status}`);
    const comment = await result.json() as { id?: number; html_url?: string };
    if (!comment.id || !comment.html_url) throw new Error("GitHub returned an incomplete comment response");
    return { id: comment.id, url: comment.html_url };
  }

  async updateIssueBody(repositoryFullName: string, issueNumber: number, body: string): Promise<{ number: number; url: string }> {
    const [owner, repository] = repositoryFullName.split("/");
    if (!owner || !repository) throw new Error(`Invalid repository full name: ${repositoryFullName}`);
    const token = await this.installationToken(repositoryFullName);
    const result = await withDeadline(fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${issueNumber}`,
      {
        method: "PATCH",
        headers: { ...this.apiHeaders(token), "content-type": "application/json" },
        body: JSON.stringify({ body }),
      },
    ), 30_000, "Dependency issue update timed out");
    if (!result.ok) throw new Error(`Dependency issue update failed with HTTP ${result.status}`);
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
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_1: "!f() { echo username=x-access-token; echo password=\"$GH_TOKEN\"; }; f",
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
    GH_CONFIG_DIR: join(tmpdir(), "gerry-gh", input.runId),
  });
  return environment;
}
