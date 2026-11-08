import { describe, expect, test } from "bun:test";
import { hermesArguments } from "../src/runtimes/hermes.ts";

describe("Hermes adapter command construction", () => {
  test("uses non-interactive JSONL and resumes exact session IDs", () => {
    const args = hermesArguments({
      workspacePath: "/work/tree",
      promptPath: "/run/prompt.md",
      existingSessionId: "20260225_143052_a1b2c3",
      options: {
        profile: "reviewer",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        toolsets: ["terminal", "web"],
        skills: ["github-auth"],
        max_turns: 15,
      },
    });
    expect(args).toContain("--resume");
    expect(args).toContain("20260225_143052_a1b2c3");
    expect(args).toContain("--format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--oneshot");
    expect(args).not.toContain("--yolo");
    expect(args.join(" ")).toContain("--toolsets terminal,web");
  });

  test("rejects unknown options rather than silently weakening policy", () => {
    expect(() => hermesArguments({
      workspacePath: "/work",
      promptPath: "/prompt",
      existingSessionId: null,
      options: { yolo: true },
    })).toThrow();
  });
});
