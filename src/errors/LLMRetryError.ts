export type LLMServiceName = "responder" | "evaluator";

export class LLMRetryError extends Error {
  public readonly service: LLMServiceName;
  public readonly attempts: number;
  public readonly cause: unknown;

  constructor(service: LLMServiceName, attempts: number, cause: unknown) {
    const reason =
      cause instanceof Error
        ? cause.message
        : typeof cause === "string"
          ? cause
          : "Unknown failure";
    super(`LLM ${service} failed after ${attempts} attempts: ${reason}`);
    this.name = "LLMRetryError";
    this.service = service;
    this.attempts = attempts;
    this.cause = cause;
  }
}
