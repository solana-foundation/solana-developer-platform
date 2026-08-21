import type { FailureCode } from "@sdp/helius-rings";

/**
 * Failure from the signer or RPC adapter, carrying exactly what the service
 * needs to take the state machine's fail edge: the operation-level failure
 * code and whether a retry can succeed.
 */
export class RingsAdapterError extends Error {
  readonly failureCode: Extract<FailureCode, "signer_failed" | "submit_failed">;
  readonly retryable: boolean;

  constructor(
    failureCode: Extract<FailureCode, "signer_failed" | "submit_failed">,
    message: string,
    options: { retryable: boolean; cause?: unknown }
  ) {
    super(message, { cause: options.cause });
    this.name = "RingsAdapterError";
    this.failureCode = failureCode;
    this.retryable = options.retryable;
  }
}
