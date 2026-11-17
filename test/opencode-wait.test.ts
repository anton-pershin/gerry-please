import { describe, expect, test } from "bun:test";

describe("OpenCode wait reconnection", () => {
  test("issues a new wait request after Bun's HTTP idle timeout", async () => {
    const requests: string[] = [];
    const jobRequests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/experimental/job") {
          jobRequests.push(url.search);
          return Response.json({ data: [] });
        }
        if (url.pathname === "/api/experimental/session/ses_idle_timeout/log") {
          return new Response(
            'data: {"type":"log.synced","aggregateID":"ses_idle_timeout","seq":1}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        if (url.pathname === "/api/session") {
          return Response.json({ data: [], cursor: {} });
        }
        if (url.pathname === "/api/session/ses_idle_timeout") {
          return Response.json({
            data: {
              id: "ses_idle_timeout",
              projectID: "project",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              outcome: "succeeded",
              time: { created: 1, updated: 1 },
              location: { directory: "/tmp" },
            },
          });
        }
        if (url.pathname === "/api/session/active") {
          return Response.json({ data: {} });
        }
        if (url.pathname === "/api/session/ses_idle_timeout/inbox") {
          return Response.json({ data: [] });
        }
        if (url.pathname === "/api/session/ses_idle_timeout/message") {
          return Response.json({
            data: [{ id: "idle-latest", type: "idle", outcome: "succeeded", time: { created: 1 } }],
            cursor: {},
          });
        }
        if (url.pathname !== "/api/experimental/session/ses_idle_timeout/wait") {
          return new Response(null, { status: 404 });
        }
        requests.push(url.pathname);
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
      expect(jobRequests).toEqual([
        "?sessionID=ses_idle_timeout&descendants=true",
        "?sessionID=ses_idle_timeout&descendants=true",
      ]);
    } finally {
      child.kill();
      await child.exited;
      await server.stop(true);
    }
  }, 25_000);
});
