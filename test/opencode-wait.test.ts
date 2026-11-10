import { describe, expect, test } from "bun:test";

describe("OpenCode wait reconnection", () => {
  test("issues a new wait request after Bun's HTTP idle timeout", async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const pathname = new URL(request.url).pathname;
        requests.push(pathname);
        if (requests.length === 1) await Bun.sleep(12_000);
        return new Response(null, { status: 204 });
      },
    });
    const child = Bun.spawn([process.execPath, new URL("./wait-client.ts", import.meta.url).pathname, server.url.toString()], {
      env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      expect(stdout).toContain("opencode.wait.reconnecting");
      expect(requests).toHaveLength(2);
      expect(requests.every((path) => path === "/api/experimental/session/ses_idle_timeout/wait")).toBe(true);
    } finally {
      child.kill();
      await child.exited;
      await server.stop(true);
    }
  }, 25_000);
});
