export interface RuntimeExecutionErrorDetails {
  sessionId?: string;
  response?: string;
  usage?: Record<string, unknown>;
  cause?: unknown;
}

export class RuntimeExecutionError extends Error {
  constructor(
    message: string,
    readonly details: RuntimeExecutionErrorDetails = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "RuntimeExecutionError";
  }
}

/** A definite provider response that is safe to retry after waiting for quota. */
export class ProviderQuotaError extends RuntimeExecutionError {
  constructor(message: string, details: RuntimeExecutionErrorDetails = {}) {
    super(message, details);
    this.name = "ProviderQuotaError";
  }
}
