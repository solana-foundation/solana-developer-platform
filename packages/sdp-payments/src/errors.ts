import {
  RAMP_AMOUNT_LIMIT_REASONS,
  type RampAmountLimit,
  type RampAmountLimitReason,
  type RampDirection,
} from "@sdp/types/payments";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { z } from "zod";

export type SdpPaymentsErrorCode =
  | "BAD_REQUEST"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_RESPONSE_INVALID"
  | "ESTIMATE_NOT_AVAILABLE";

const ERROR_STATUS_CODES: Record<SdpPaymentsErrorCode, number> = {
  BAD_REQUEST: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  PROVIDER_NOT_CONFIGURED: 503,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_RESPONSE_INVALID: 502,
  ESTIMATE_NOT_AVAILABLE: 503,
};

const DEFAULT_ERROR_MESSAGES: Record<SdpPaymentsErrorCode, string> = {
  BAD_REQUEST: "Invalid request",
  CONFLICT: "Resource already exists",
  RATE_LIMITED: "Too many requests",
  INTERNAL_ERROR: "An internal error occurred",
  PROVIDER_NOT_CONFIGURED: "Payment provider is not configured for this environment",
  PROVIDER_UNAVAILABLE: "Payment provider is temporarily unavailable",
  PROVIDER_RESPONSE_INVALID: "Payment provider returned a response SDP could not read",
  ESTIMATE_NOT_AVAILABLE:
    "An indicative estimate is not available; the rate is known at quote time",
};

/**
 * A payments failure. `message` and `details` are public: the API serializes
 * them into error bodies and transfer rows, so they never carry provider
 * response text. Whatever the provider said, and why its response was refused,
 * goes in `diagnostics`, which the API logs scrubbed and never returns.
 */
export class SdpPaymentsError extends Error {
  public readonly statusCode: number;

  constructor(
    public readonly code: SdpPaymentsErrorCode,
    message?: string,
    public readonly details?: Record<string, unknown>,
    public readonly diagnostics?: Record<string, unknown>
  ) {
    super(message || DEFAULT_ERROR_MESSAGES[code]);
    this.name = "SdpPaymentsError";
    this.statusCode = ERROR_STATUS_CODES[code];
  }
}

export function badRequest(
  message?: string,
  details?: Record<string, unknown>,
  diagnostics?: Record<string, unknown>
): SdpPaymentsError {
  return new SdpPaymentsError("BAD_REQUEST", message, details, diagnostics);
}

export function internalError(
  message?: string,
  details?: Record<string, unknown>,
  diagnostics?: Record<string, unknown>
): SdpPaymentsError {
  return new SdpPaymentsError("INTERNAL_ERROR", message, details, diagnostics);
}

export function rateLimited(
  message?: string,
  details?: Record<string, unknown>,
  diagnostics?: Record<string, unknown>
): SdpPaymentsError {
  return new SdpPaymentsError("RATE_LIMITED", message, details, diagnostics);
}

export function providerNotConfigured(
  message?: string,
  details?: Record<string, unknown>,
  diagnostics?: Record<string, unknown>
): SdpPaymentsError {
  return new SdpPaymentsError("PROVIDER_NOT_CONFIGURED", message, details, diagnostics);
}

export function providerUnavailable(
  message?: string,
  details?: Record<string, unknown>,
  diagnostics?: Record<string, unknown>
): SdpPaymentsError {
  return new SdpPaymentsError("PROVIDER_UNAVAILABLE", message, details, diagnostics);
}

const AMOUNT_LIMIT_MESSAGES = {
  amount_below_minimum: "Amount is below this provider's minimum of",
  amount_above_maximum: "Amount is above this provider's maximum of",
} as const satisfies Record<RampAmountLimitReason, string>;

/**
 * A provider refuses the amount for this pair. The bound rides in `details`
 * so a caller can say what amount would work.
 *
 * @param reason - Which bound the amount crossed.
 * @param limit - The bound, in the currency the amount was given in.
 * @returns The 400 to throw.
 */
export function rampAmountOutOfRange(
  reason: RampAmountLimitReason,
  limit: RampAmountLimit
): SdpPaymentsError {
  return new SdpPaymentsError(
    "BAD_REQUEST",
    `${AMOUNT_LIMIT_MESSAGES[reason]} ${limit.amount} ${limit.currency}`,
    { reason, limit }
  );
}

/** The details a `rampAmountOutOfRange` error carries. */
const rampAmountLimitDetailsSchema = z.object({
  reason: z.enum(RAMP_AMOUNT_LIMIT_REASONS),
  limit: z.object({ amount: z.string(), currency: z.string() }),
});

/** The bound a `rampAmountOutOfRange` error carries, or null for any other error. */
export function rampAmountLimitOf(
  cause: unknown
): { reason: RampAmountLimitReason; limit: RampAmountLimit } | null {
  if (!(cause instanceof SdpPaymentsError) || cause.code !== "BAD_REQUEST") return null;
  const details = rampAmountLimitDetailsSchema.safeParse(cause.details);
  return details.success ? details.data : null;
}

export function estimateNotAvailable(
  message?: string,
  details?: Record<string, unknown>
): SdpPaymentsError {
  return new SdpPaymentsError("ESTIMATE_NOT_AVAILABLE", message, details);
}

export function unsupportedCounterparty(
  provider: RampProviderId,
  direction: RampDirection,
  reason: string
): CounterpartyRequirements {
  return { provider, direction, status: "unsupported", reason };
}
