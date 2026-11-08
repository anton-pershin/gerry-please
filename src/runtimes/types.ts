export class RuntimeExecutionError extends Error {
  constructor(
    message: string,
    readonly details: {
      sessionId?: string;
      response?: string;
      usage?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "RuntimeExecutionError";
  }
}
