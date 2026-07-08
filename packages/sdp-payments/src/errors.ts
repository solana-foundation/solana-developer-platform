import type { RampProviderId } from "@sdp/types/provider-access";
import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";

export type SdpPaymentsErrorCode =
  | "BAD_REQUEST"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_UNAVAILABLE"
  | "ESTIMATE_NOT_AVAILABLE";

const ERROR_STATUS_CODES: Record<SdpPaymentsErrorCode, number> = {
  BAD_REQUEST: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  PROVIDER_NOT_CONFIGURED: 503,
  PROVIDER_UNAVAILABLE: 503,
  ESTIMATE_NOT_AVAILABLE: 503,
};

const DEFAULT_ERROR_MESSAGES: Record<SdpPaymentsErrorCode, string> = {
  BAD_REQUEST: "Invalid request",
  CONFLICT: "Resource already exists",
  RATE_LIMITED: "Too many requests",
  INTERNAL_ERROR: "An internal error occurred",
  PROVIDER_NOT_CONFIGURED: "Payment provider is not configured for this environment",
  PROVIDER_UNAVAILABLE: "Payment provider is temporarily unavailable",
  ESTIMATE_NOT_AVAILABLE:
    "An indicative estimate is not available; the rate is known at quote time",
};

export class SdpPaymentsError extends Error {
  public readonly statusCode: number;

  constructor(
    public readonly code: SdpPaymentsErrorCode,
    message?: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message || DEFAULT_ERROR_MESSAGES[code]);
    this.name = "SdpPaymentsError";
    this.statusCode = ERROR_STATUS_CODES[code];
  }
}

export function badRequest(message?: string, details?: Record<string, unknown>): SdpPaymentsError {
  return new SdpPaymentsError("BAD_REQUEST", message, details);
}

export function internalError(message?: string): SdpPaymentsError {
  return new SdpPaymentsError("INTERNAL_ERROR", message);
}

export function providerNotConfigured(message?: string): SdpPaymentsError {
  return new SdpPaymentsError("PROVIDER_NOT_CONFIGURED", message);
}

export function providerUnavailable(
  message?: string,
  details?: Record<string, unknown>
): SdpPaymentsError {
  return new SdpPaymentsError("PROVIDER_UNAVAILABLE", message, details);
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
