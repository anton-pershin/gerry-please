import { describe, expect, test } from "bun:test";
import type { Condition } from "../src/config.ts";
import { buildContext, evaluateCondition, parentRunFromPayload, renderTemplate, ruleMatches } from "../src/rules.ts";
import { configFixture, context, issuePayload } from "./helpers.ts";

const base = { path: "value", ignore_case: false };

describe("rule conditions", () => {
  test("supports equality, membership, containment, and existence", () => {
    expect(evaluateCondition({ ...base, equals: 2 }, { value: 2 })).toBe(true);
    expect(evaluateCondition({ ...base, in: [1, 2] }, { value: 2 })).toBe(true);
    expect(evaluateCondition({ ...base, contains: "world" }, { value: "hello world" })).toBe(true);
    expect(evaluateCondition({ ...base, contains: "WORLD", ignore_case: true }, { value: "hello world" })).toBe(true);
    expect(evaluateCondition({ ...base, contains: "x" }, { value: ["x", "y"] })).toBe(true);
    expect(evaluateCondition({ ...base, exists: false }, {})).toBe(true);
  });

  test("matches event, action, repository, and all conditions", () => {
    const { config } = configFixture();
    const rule = {
      ...config.rules[0]!,
      repositories: ["acme/widgets"],
      when: [{ path: "issue.title", contains: "retries", ignore_case: true } as Condition],
    };
    expect(ruleMatches(rule, context())).toBe(true);
    expect(ruleMatches(rule, context(issuePayload("edited")))).toBe(false);
    expect(ruleMatches({ ...rule, repositories: ["other/repo"] }, context())).toBe(false);
  });

  test("distinguishes issue comments on pull requests", () => {
    const payload = issuePayload("created");
    payload.comment = { body: "@maintainer please review" };
    (payload.issue as Record<string, unknown>).pull_request = { url: "https://api.github.test/pr/42" };
    const result = buildContext({ deliveryId: "d", event: "issue_comment", action: "created", payload });
    expect(result.subject.type).toBe("pull_request");
    expect(result.subject.number).toBe(42);
    expect(parentRunFromPayload(payload)).toBeNull();
  });

  test("renders scalar template values and reads run lineage markers", () => {
    expect(renderTemplate("{{issue.number}}: {{issue.title}}", issuePayload())).toBe("42: Add retries");
    expect(renderTemplate("{{missing.value}}", issuePayload())).toBe("");
    expect(() => renderTemplate("{{issue}}", issuePayload())).toThrow("not a scalar");
    const payload = issuePayload("created");
    payload.comment = { body: "Looks good\n<!-- gerry:run=run_abc-123 -->" };
    expect(parentRunFromPayload(payload)).toBe("run_abc-123");
  });
});
