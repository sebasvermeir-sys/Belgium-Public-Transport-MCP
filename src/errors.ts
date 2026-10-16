// Errors that tell Claude what to do next. Every ToolError carries a concrete next step.

export type ErrorCode =
  | "STOP_NOT_FOUND"
  | "STOP_AMBIGUOUS"
  | "BAD_INPUT"
  | "NOT_FOUND"
  | "UPSTREAM_RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_ERROR";

export class ToolError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public nextStep: string,
    public data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function errorResult(e: unknown) {
  const err =
    e instanceof ToolError
      ? e
      : new ToolError(
          "UPSTREAM_ERROR",
          `Unexpected error: ${e instanceof Error ? e.message : String(e)}`,
          "Retry once; if it fails again, tell the user the transit data source is unavailable.",
        );
  return {
    isError: true,
    content: [{ type: "text" as const, text: `${err.message} ${err.nextStep}` }],
    structuredContent: { error: err.code, message: err.message, nextStep: err.nextStep, ...err.data },
  };
}
