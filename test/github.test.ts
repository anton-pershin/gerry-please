import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { buildAgentEnvironment, hasSufficientTokenLifetime, verifyPullRequestClosureEvidence, verifyWebhookSignature } from "../src/github.ts";
import { configFixture } from "./helpers.ts";

describe("GitHub integration", () => {
  test("verifies HMAC signatures without accepting malformed values", () => {
    const payload = JSON.stringify({ zen: "Keep it simple" });
    const signature = createHmac("sha256", "secret").update(payload).digest("hex");
    expect(verifyWebhookSignature(payload, `sha256=${signature}`, "secret")).toBe(true);
    expect(verifyWebhookSignature(payload, `sha256=${signature}`, "wrong")).toBe(false);
    expect(verifyWebhookSignature(payload, `sha1=${signature}`, "secret")).toBe(false);
    expect(verifyWebhookSignature(payload, null, "secret")).toBe(false);
  });

  test("verifies direct and squash-merge dependency closures without weakening commit checks", () => {
    const observation = {
      prNumber: 23,
      prUrl: null,
      mergeCommitSha: "88e417cd451634a30d53e12cd92263fa9b8f8220",
      mergedAt: Date.parse("2026-11-13T05:19:36Z"),
      baseRef: "main",
    };
    const pullRequest = {
      merged: true,
      merge_commit_sha: observation.mergeCommitSha,
      merged_at: "2026-11-13T05:19:36Z",
      merged_by: { login: "anton-pershin" },
      base: { ref: "main" },
      body: "Closes #22.",
    };
    const closed = { event: "closed", created_at: "2026-11-13T05:19:38Z", actor: { login: "anton-pershin" } };
    const verify = (timeline: unknown[]) => verifyPullRequestClosureEvidence({
      pullRequest,
      timeline: timeline as Parameters<typeof verifyPullRequestClosureEvidence>[0]["timeline"],
      observation,
      issueNumber: 22,
    });

    expect(verify([{ ...closed, commit_id: observation.mergeCommitSha }])).toBe(true);
    expect(verify([{ ...closed, commit_id: null }])).toBe(true);
    expect(verify([{ ...closed, commit_id: null, actor: { login: "someone-else" } }])).toBe(false);
    expect(verify([{ ...closed, commit_id: null, created_at: "2026-11-13T05:25:00Z" }])).toBe(false);
    expect(verify([{ ...closed, commit_id: "different-commit" }])).toBe(false);
    expect(verifyPullRequestClosureEvidence({
      pullRequest: { ...pullRequest, merge_commit_sha: null },
      timeline: [{ ...closed, commit_id: null }],
      observation,
      issueNumber: 22,
      commitAssociationVerified: true,
    })).toBe(true);
    expect(verifyPullRequestClosureEvidence({
      pullRequest: { ...pullRequest, merge_commit_sha: null },
      timeline: [{ ...closed, commit_id: null }],
      observation,
      issueNumber: 22,
      commitAssociationVerified: false,
    })).toBe(false);
    expect(verifyPullRequestClosureEvidence({
      pullRequest: { ...pullRequest, merge_commit_sha: "different-commit" },
      timeline: [{ ...closed, commit_id: null }],
      observation,
      issueNumber: 22,
    })).toBe(false);
  });

  test("requires cached tokens to cover the requested run lifetime", () => {
    const timestamp = Date.parse("2026-11-10T15:51:00Z");
    expect(hasSufficientTokenLifetime(Date.parse("2026-11-10T16:08:00Z"), 15 * 60_000, timestamp)).toBe(true);
    expect(hasSufficientTokenLifetime(Date.parse("2026-11-10T16:05:00Z"), 15 * 60_000, timestamp)).toBe(false);
    expect(hasSufficientTokenLifetime(Date.parse("2026-11-10T15:57:00Z"), 0, timestamp)).toBe(true);
    expect(hasSufficientTokenLifetime(Date.parse("2026-11-10T15:55:00Z"), 0, timestamp)).toBe(false);
  });

  test("only forwards explicitly allowed process environment variables", () => {
    const { config } = configFixture();
    const agent = { ...config.agents.implementer!, pass_environment: ["MODEL_API_KEY"] };
    const environment = buildAgentEnvironment({
      agent,
      token: "installation-token",
      runId: "run_1",
      repository: "acme/widgets",
      workspacePath: "/workspace",
      processEnvironment: {
        PATH: "/bin",
        MODEL_API_KEY: "allowed",
        OPENCODE_TOKEN: "not-allowed",
        GITHUB_APP_PRIVATE_KEY_PATH: "/secret/key",
      },
    });
    expect(environment.MODEL_API_KEY).toBe("allowed");
    expect(environment.OPENCODE_TOKEN).toBeUndefined();
    expect(environment.GITHUB_APP_PRIVATE_KEY_PATH).toBeUndefined();
    expect(environment.GH_TOKEN).toBe("installation-token");
    expect(environment.GH_CONFIG_DIR).toContain("run_1");
    expect(environment.GIT_CONFIG_VALUE_0).toContain("$GH_TOKEN");
  });
});
