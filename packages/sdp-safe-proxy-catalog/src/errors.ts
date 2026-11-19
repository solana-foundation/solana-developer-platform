import { z } from "zod";

/**
 * What a caller may conclude from a failure. `rejected`: the operation did not happen. `no_answer`:
 * it may have happened, so the caller resolves it before doing anything new.
 */
export const SAFE_PROXY_OUTCOMES = ["rejected", "no_answer"] as const;
export type SafeProxyOutcome = (typeof SAFE_PROXY_OUTCOMES)[number];

export const SAFE_PROXY_ERROR_CODES = [
  "invalid_request",
  "unknown_operation",
  "caller_not_allowed",
  "credential_not_found",
  "credential_mismatch",
  "provider_refused",
  "provider_unavailable",
  "deadline_exceeded",
  "internal",
  "proxy_unreachable",
] as const;
export type SafeProxyErrorCode = (typeof SAFE_PROXY_ERROR_CODES)[number];

/** The outcomes each code may carry. A code listing both is `rejected` only when nothing was sent. */
export const SAFE_PROXY_ERROR_OUTCOMES = {
  invalid_request: ["rejected"],
  unknown_operation: ["rejected"],
  caller_not_allowed: ["rejected"],
  credential_not_found: ["rejected"],
  credential_mismatch: ["rejected"],
  provider_refused: ["rejected"],
  provider_unavailable: ["no_answer", "rejected"],
  deadline_exceeded: ["no_answer", "rejected"],
  internal: ["no_answer", "rejected"],
  // Raised by the client when Safe Proxy gave no usable answer; the service never sends it.
  proxy_unreachable: ["no_answer"],
} as const satisfies Record<SafeProxyErrorCode, readonly SafeProxyOutcome[]>;

export const SAFE_PROXY_ERROR_HTTP_STATUS = {
  invalid_request: 400,
  unknown_operation: 404,
  caller_not_allowed: 403,
  credential_not_found: 404,
  credential_mismatch: 409,
  provider_refused: 422,
  provider_unavailable: 502,
  deadline_exceeded: 504,
  internal: 500,
  proxy_unreachable: 503,
} as const satisfies Record<SafeProxyErrorCode, number>;

export type SafeProxyFailure = {
  [Code in SafeProxyErrorCode]: {
    code: Code;
    outcome: (typeof SAFE_PROXY_ERROR_OUTCOMES)[Code][number];
  };
}[SafeProxyErrorCode];

export function isSafeProxyFailure(failure: {
  code: SafeProxyErrorCode;
  outcome: SafeProxyOutcome;
}): failure is SafeProxyFailure {
  const allowed: readonly SafeProxyOutcome[] = SAFE_PROXY_ERROR_OUTCOMES[failure.code];
  return allowed.includes(failure.outcome);
}

export const safeProxyFailureSchema = z
  .object({
    code: z.enum(SAFE_PROXY_ERROR_CODES),
    outcome: z.enum(SAFE_PROXY_OUTCOMES),
  })
  .refine(isSafeProxyFailure, "outcome is not one this code can carry");

/** The only error that crosses between sdp-api and Safe Proxy. It carries no provider text. */
export class SafeProxyError extends Error {
  readonly code: SafeProxyErrorCode;
  readonly outcome: SafeProxyOutcome;
  /** The pair as it goes on the wire. */
  readonly failure: SafeProxyFailure;

  constructor(failure: SafeProxyFailure, options?: { cause: unknown }) {
    super(`Safe Proxy: ${failure.code} (${failure.outcome})`, options);
    this.name = "SafeProxyError";
    this.code = failure.code;
    this.outcome = failure.outcome;
    this.failure = failure;
  }
}
