import type { Json } from "./contract";

export class CliError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode: number,
    readonly status: number | null = null,
    readonly requestId: string | null = null,
    readonly details?: Json
  ) {
    super(message);
  }
}

export function usageError(message: string): never {
  throw new CliError(message, "USAGE_ERROR", 2);
}
