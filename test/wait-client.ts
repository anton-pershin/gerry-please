import { OpenCode } from "@opencode/client";
import {
  createOpenCodeBackgroundJobLister,
  readOpenCodeSessionGeneration,
  waitForOpenCodeSession,
} from "../src/runtimes/opencode.ts";

const baseUrl = process.argv[2]!;
const client = OpenCode.make({ baseUrl });
const signal = AbortSignal.timeout(15_000);
await waitForOpenCodeSession({
  client,
  sessionID: "ses_idle_timeout",
  timeoutMs: 10_000,
  signal,
  listBackgroundJobs: createOpenCodeBackgroundJobLister(client),
  getSessionGeneration: (sessionID) => readOpenCodeSessionGeneration(client, sessionID, signal),
  emit: (event) => console.log(JSON.stringify(event)),
});
