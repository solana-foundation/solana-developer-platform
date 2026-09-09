/**
 * Coded errors thrown by the helius-rings domain. Operation-level failures
 * (policy denials, proof failures, etc.) do not throw — they land on the
 * operation row as a `FailureCode`. Errors here are for the API layer to map
 * to `AppError` at the sdp-api boundary.
 */
export type HeliusRingsErrorCode =
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "gateway_unavailable"
  | "config_error"
  | "insufficient_balance"
  | "manual_reconciliation_required";

export class HeliusRingsError extends Error {
  readonly code: HeliusRingsErrorCode;

  constructor(code: HeliusRingsErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HeliusRingsError";
    this.code = code;
  }
}

/**
 * The discriminator a bridged failure carries on its `cause`. Only a name and,
 * where there was one, a status: enough to tell two failures apart in a log
 * without carrying an upstream message that could quote a keyed endpoint.
 */
export interface RingsErrorCause {
  readonly upstream: string;
  readonly status?: number;
}

/**
 * A wallet whose material no longer derives the identity it was provisioned
 * with. Named on the `cause` rather than matched on a message, because the
 * service quarantines the wallet on it and that decision must not hinge on
 * error prose.
 */
export const RINGS_IDENTITY_MISMATCH = "identity_mismatch";

/**
 * Whether a failure is the unrecoverable identity mismatch. Every read derives
 * the same identity from the same inputs, so this can never clear on its own —
 * which is what separates it from the other `conflict`s.
 */
export function isRingsIdentityMismatch(error: unknown): boolean {
  if (!(error instanceof HeliusRingsError) || error.code !== "conflict") return false;
  const cause = error.cause as RingsErrorCause | undefined;
  return cause?.upstream === RINGS_IDENTITY_MISMATCH;
}
