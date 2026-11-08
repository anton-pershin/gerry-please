import { describe, expect, test } from "bun:test";
import { Redactor } from "../src/observability.ts";

describe("observability redaction", () => {
  test("redacts explicit secrets and common credential shapes recursively", () => {
    const redactor = new Redactor(["installation-secret"]);
    const result = redactor.value({
      message: "token installation-secret and ghp_abcdefghijklmnopqrstuvwxyz123456",
      nested: { authorization: "Bearer should-not-survive", safe: 42 },
    });
    expect(JSON.stringify(result)).not.toContain("installation-secret");
    expect(JSON.stringify(result)).not.toContain("ghp_");
    expect(JSON.stringify(result)).not.toContain("should-not-survive");
    expect(result.nested.safe).toBe(42);
  });
});
