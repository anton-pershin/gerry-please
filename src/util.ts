import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function now(): number {
  return Date.now();
}

export function iso(time?: number | null): string {
  if (time === null) return "—";
  return new Date(time ?? Date.now()).toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? `${error.message}\n${error.stack}` : error.message;
  }
  return String(error);
}

export function compactError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function clampText(value: string, maximum = 16_000): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n… [truncated ${value.length - maximum} characters]`;
}

export function parseModel(reference: string): { providerID: string; id: string; variant?: string } {
  const [modelPart, variant, ...extra] = reference.split("#");
  const separator = modelPart?.indexOf("/") ?? -1;
  if (!modelPart || separator <= 0 || separator === modelPart.length - 1 || extra.length > 0) {
    throw new Error(`Invalid model reference ${JSON.stringify(reference)}; expected provider/model[#variant]`);
  }
  return {
    providerID: modelPart.slice(0, separator),
    id: modelPart.slice(separator + 1),
    ...(variant ? { variant } : {}),
  };
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export async function withDeadline<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolvePromise, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
