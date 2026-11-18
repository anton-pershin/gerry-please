import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { Service, type Endpoint } from "@opencode/client/service";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OpenCodeRuntime } from "../src/runtimes/opencode.ts";
import { prepareIsolatedOpenCodeService } from "../src/runtimes/opencode-service.ts";

function eventSessionID(event: unknown): string | undefined {
  if (!event || typeof event !== "object" || !("data" in event)) return undefined;
  const data = event.data;
  if (!data || typeof data !== "object" || !("sessionID" in data)) return undefined;
  return typeof data.sessionID === "string" ? data.sessionID : undefined;
}

function makeClient(baseUrl: string, headers?: RequestInit["headers"]): OpenCodeClient {
  const options: { baseUrl: string; headers?: RequestInit["headers"] } = { baseUrl };
  if (headers) options.headers = headers;
  return OpenCode.make(options);
}

async function shell(client: OpenCodeClient, sessionID: string, command: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Shell smoke test timed out")), 30_000);
  try {
    const events = client.event.subscribe({ signal: controller.signal })[Symbol.asyncIterator]();
    const connected = await events.next();
    if (connected.done || connected.value.type !== "server.connected") throw new Error("No server.connected event");
    await client.session.shell({ sessionID, command });
    while (true) {
      const next = await events.next();
      if (next.done) throw new Error("Event stream ended before shell completion");
      const event = next.value;
      if (event.type === "session.shell.ended" && eventSessionID(event) === sessionID) {
        return event.data.output.output;
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const providerID = process.env.OPENCODE_SMOKE_PROVIDER;
const modelID = process.env.OPENCODE_SMOKE_MODEL;
if (Boolean(providerID) !== Boolean(modelID)) {
  throw new Error("Set both OPENCODE_SMOKE_PROVIDER and OPENCODE_SMOKE_MODEL, or neither");
}
const requiredAgents = (process.env.OPENCODE_SMOKE_AGENTS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const oldSessionID = process.env.OPENCODE_SMOKE_OLD_SESSION;
const directory = mkdtempSync(join(homedir(), ".gerry-opencode-isolated-"));
let registrationFile = "";
let client: OpenCodeClient | undefined;
let sessionID = "";
let stopAllowed = false;
try {
  const defaultEndpoint = await Service.discover();
  if (!defaultEndpoint) throw new Error("The normal OpenCode service is not running");
  const defaultClient = makeClient(defaultEndpoint.url, Service.headers(defaultEndpoint as Endpoint));
  const defaultBefore = await defaultClient.server.info();

  const service = prepareIsolatedOpenCodeService(directory);
  registrationFile = service.registrationFile;
  const runtime = await OpenCodeRuntime.fromConfig(
    { name: "smoke", environment: process.env, dataDirectory: directory },
    { type: "opencode", dedicated_service: true },
  );
  await runtime.check();
  const registration = JSON.parse(readFileSync(registrationFile, "utf8")) as { url: string; pid: number };
  if (registration.pid === defaultBefore.pid || registration.url === defaultEndpoint.url) {
    throw new Error("The isolated smoke test reused the normal OpenCode service");
  }
  stopAllowed = true;
  const endpoint = await Service.discover({ file: registrationFile });
  if (!endpoint) throw new Error("The isolated service did not register correctly");
  client = makeClient(endpoint.url, Service.headers(endpoint as Endpoint));

  const session = await client.session.create({
    title: "Gerry isolated-service smoke test",
    location: { directory },
    agent: "build",
    ...(providerID && modelID ? { model: { providerID, id: modelID } } : {}),
  });
  sessionID = session.id;
  const output = await shell(client, sessionID, [
    "printf 'GH_CONFIG_DIR=%s\\n' \"$GH_CONFIG_DIR\"",
    "printf 'GIT_CONFIG_GLOBAL=%s\\n' \"$GIT_CONFIG_GLOBAL\"",
    "if gh api user --jq .login >/dev/null 2>&1; then echo GH_UNEXPECTEDLY_AUTHENTICATED; else echo GH_AUTH_BLOCKED; fi",
    "git config --get user.name",
  ].join("; "));
  if (!output.includes("GH_AUTH_BLOCKED") || output.includes("GH_UNEXPECTEDLY_AUTHENTICATED")) {
    throw new Error(`GitHub authentication was not isolated: ${output}`);
  }
  if (!output.includes("gerry-please[bot]")) throw new Error(`Bot Git identity was not applied: ${output}`);

  if (oldSessionID) {
    let oldSessionVisible = true;
    try {
      await client.session.get({ sessionID: oldSessionID });
    } catch {
      oldSessionVisible = false;
    }
    if (oldSessionVisible) throw new Error("The isolated database contains resumable user sessions");
  }

  const agentIDs = (await client.agent.list({ location: { directory } })).data.map((agent) => agent.id);
  for (const required of ["implementer", "maintainer", "reviewer"]) {
    if (!agentIDs.includes(required)) throw new Error(`Custom OpenCode agent is unavailable: ${required}`);
  }

  if (providerID && modelID) {
    await client.session.prompt({ sessionID, text: "Reply with exactly OK." });
    await client.experimental.session.wait({ sessionID });
    const completed = await client.session.get({ sessionID });
    if (completed.outcome !== "succeeded") throw new Error(`Provider smoke call failed: ${completed.outcome}`);
  }

  const defaultAfter = await defaultClient.server.info();
  if (defaultAfter.pid !== defaultBefore.pid) throw new Error("The normal OpenCode service was replaced");
  console.log(JSON.stringify({
    isolatedService: { pid: registration.pid, version: (await client.server.info()).version },
    normalServiceUnchanged: defaultAfter.pid === defaultBefore.pid,
    githubFallbackBlocked: true,
    botIdentity: true,
    oldSessionsIsolated: oldSessionID ? true : "not-checked",
    customAgentsAvailable: requiredAgents.length > 0 ? true : "not-checked",
    providerAccess: providerID && modelID ? true : "not-checked",
  }, null, 2));
} finally {
  if (client && sessionID) await client.session.remove({ sessionID }).catch(() => undefined);
  if (stopAllowed && registrationFile) await Service.stop({ file: registrationFile });
  rmSync(directory, { recursive: true, force: true });
}
