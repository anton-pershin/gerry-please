import { OpenCode } from "@opencode/client";
import { waitForOpenCodeSession } from "../src/runtimes/opencode.ts";

const client = OpenCode.make({ baseUrl: process.argv[2]! });
await waitForOpenCodeSession({
  client,
  sessionID: "ses_idle_timeout",
  timeoutMs: 10_000,
  signal: AbortSignal.timeout(15_000),
  emit: (event) => console.log(JSON.stringify(event)),
});
