import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { buildAgentEnvironment, verifyWebhookSignature } from "../src/github.ts";
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
    expect(environment.GIT_CONFIG_VALUE_0).toContain("$GH_TOKEN");
  });
});
