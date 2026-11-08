import type { LoadedConfig } from "../config.ts";
import type { AgentRuntime } from "../types.ts";
import { HermesRuntime } from "./hermes.ts";
import { OpenCodeRuntime } from "./opencode.ts";

export async function createRuntimes(config: LoadedConfig): Promise<Map<string, AgentRuntime>> {
  const runtimes = new Map<string, AgentRuntime>();
  for (const [name, runtimeConfig] of Object.entries(config.runtimes)) {
    const context = { name, environment: process.env };
    const runtime = runtimeConfig.type === "opencode"
      ? await OpenCodeRuntime.fromConfig(context, runtimeConfig)
      : HermesRuntime.fromConfig(context, runtimeConfig);
    runtimes.set(name, runtime);
  }
  return runtimes;
}

export { RuntimeExecutionError } from "./types.ts";
export { HermesRuntime } from "./hermes.ts";
export { OpenCodeRuntime } from "./opencode.ts";
