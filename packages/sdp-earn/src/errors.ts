import type { EarnProviderId } from "@sdp/types/provider-access";

export type SdpEarnErrorCode =
  | "BAD_REQUEST"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "NOT_IMPLEMENTED"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_UNAVAILABLE"
  | "STRATEGY_NOT_AVAILABLE"
  | "INSUFFICIENT_LIQUIDITY";

const ERROR_STATUS_CODES: Record<SdpEarnErrorCode, number> = {
  BAD_REQUEST: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  NOT_IMPLEMENTED: 501,
  PROVIDER_NOT_CONFIGURED: 503,
  PROVIDER_UNAVAILABLE: 503,
  STRATEGY_NOT_AVAILABLE: 409,
  INSUFFICIENT_LIQUIDITY: 409,
};

const DEFAULT_ERROR_MESSAGES: Record<SdpEarnErrorCode, string> = {
  BAD_REQUEST: "Invalid request",
  CONFLICT: "Resource already exists",
  RATE_LIMITED: "Too many requests",
  INTERNAL_ERROR: "An internal error occurred",
  NOT_IMPLEMENTED: "This Earn operation is not implemented yet",
  PROVIDER_NOT_CONFIGURED: "Earn provider is not configured for this environment",
  PROVIDER_UNAVAILABLE: "Earn provider is temporarily unavailable",
  STRATEGY_NOT_AVAILABLE: "Strategy is not accepting this operation right now",
  INSUFFICIENT_LIQUIDITY: "Strategy has insufficient liquidity for instant redemption",
};

export class SdpEarnError extends Error {
  public readonly statusCode: number;

  constructor(
    public readonly code: SdpEarnErrorCode,
    message?: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message || DEFAULT_ERROR_MESSAGES[code]);
    this.name = "SdpEarnError";
    this.statusCode = ERROR_STATUS_CODES[code];
  }
}

export function badRequest(message?: string, details?: Record<string, unknown>): SdpEarnError {
  return new SdpEarnError("BAD_REQUEST", message, details);
}

export function internalError(message?: string): SdpEarnError {
  return new SdpEarnError("INTERNAL_ERROR", message);
}

export function providerNotConfigured(message?: string): SdpEarnError {
  return new SdpEarnError("PROVIDER_NOT_CONFIGURED", message);
}

export function providerUnavailable(
  message?: string,
  details?: Record<string, unknown>
): SdpEarnError {
  return new SdpEarnError("PROVIDER_UNAVAILABLE", message, details);
}

export function strategyNotAvailable(
  message?: string,
  details?: Record<string, unknown>
): SdpEarnError {
  return new SdpEarnError("STRATEGY_NOT_AVAILABLE", message, details);
}

export function insufficientLiquidity(
  message?: string,
  details?: Record<string, unknown>
): SdpEarnError {
  return new SdpEarnError("INSUFFICIENT_LIQUIDITY", message, details);
}

export function notImplemented(provider: EarnProviderId, operation: string): SdpEarnError {
  return new SdpEarnError("NOT_IMPLEMENTED", `${provider} ${operation} is not implemented yet`, {
    provider,
    operation,
  });
}
