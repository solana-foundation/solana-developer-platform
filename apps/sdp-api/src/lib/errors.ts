/**
 * API Error Types and Handlers
 */

import type { RampProviderId } from "@sdp/types/provider-access";
import type { CounterpartyRequirements, RampDirection } from "@sdp/types/ramp-requirements";

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR"
  | "NOT_ALLOWLISTED"
  | "INVALID_API_KEY"
  | "EXPIRED_API_KEY"
  | "REVOKED_API_KEY"
  | "INSUFFICIENT_PERMISSIONS"
  | "INVALID_INVITATION"
  | "EXPIRED_INVITATION"
  | "INVALID_TOKEN"
  | "EXPIRED_SESSION"
  // Token issuance errors
  | "TOKEN_NOT_FOUND"
  | "TOKEN_NOT_ACTIVE"
  | "TOKEN_NOT_MINTABLE"
  | "TOKEN_NOT_DEPLOYED"
  | "TOKEN_PAUSED"
  | "INVALID_TOKEN_AMOUNT"
  | "NOT_ON_TOKEN_ALLOWLIST"
  | "DESTINATION_REVOKED"
  | "ON_TOKEN_BLOCKLIST"
  | "TOKEN_ACCOUNT_NOT_FOUND"
  | "INVALID_BURN_SOURCE"
  | "INSUFFICIENT_TOKEN_BALANCE"
  | "ACCOUNT_FROZEN"
  | "ACCOUNT_NOT_FROZEN"
  | "MAX_SUPPLY_EXCEEDED"
  | "SOLANA_RPC_ERROR"
  | "CUSTODY_ERROR"
  // Transaction errors
  | "TRANSACTION_FAILED"
  | "SIGNING_FAILED"
  | "SIGNING_PENDING"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_UNAVAILABLE"
  | "ESTIMATE_NOT_AVAILABLE";

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface ErrorResponse {
  error: ApiError;
}

const ERROR_STATUS_CODES: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  NOT_ALLOWLISTED: 403,
  INVALID_API_KEY: 401,
  EXPIRED_API_KEY: 401,
  REVOKED_API_KEY: 401,
  INSUFFICIENT_PERMISSIONS: 403,
  INVALID_INVITATION: 400,
  EXPIRED_INVITATION: 400,
  INVALID_TOKEN: 401,
  EXPIRED_SESSION: 401,
  // Token issuance errors
  TOKEN_NOT_FOUND: 404,
  TOKEN_NOT_ACTIVE: 400,
  TOKEN_NOT_MINTABLE: 400,
  TOKEN_NOT_DEPLOYED: 400,
  TOKEN_PAUSED: 400,
  INVALID_TOKEN_AMOUNT: 400,
  NOT_ON_TOKEN_ALLOWLIST: 403,
  DESTINATION_REVOKED: 403,
  ON_TOKEN_BLOCKLIST: 403,
  TOKEN_ACCOUNT_NOT_FOUND: 400,
  INVALID_BURN_SOURCE: 400,
  INSUFFICIENT_TOKEN_BALANCE: 400,
  ACCOUNT_FROZEN: 400,
  ACCOUNT_NOT_FROZEN: 400,
  MAX_SUPPLY_EXCEEDED: 400,
  SOLANA_RPC_ERROR: 502,
  CUSTODY_ERROR: 502,
  // Transaction errors
  TRANSACTION_FAILED: 400,
  SIGNING_FAILED: 400,
  SIGNING_PENDING: 202,
  PROVIDER_NOT_CONFIGURED: 503,
  PROVIDER_UNAVAILABLE: 503,
  ESTIMATE_NOT_AVAILABLE: 503,
};

const DEFAULT_ERROR_MESSAGES: Record<ErrorCode, string> = {
  BAD_REQUEST: "Invalid request",
  UNAUTHORIZED: "Authentication required",
  FORBIDDEN: "Access denied",
  NOT_FOUND: "Resource not found",
  CONFLICT: "Resource already exists",
  RATE_LIMITED: "Too many requests",
  INTERNAL_ERROR: "An internal error occurred",
  NOT_ALLOWLISTED: "Email or domain not on allowlist",
  INVALID_API_KEY: "Invalid API key",
  EXPIRED_API_KEY: "API key has expired",
  REVOKED_API_KEY: "API key has been revoked",
  INSUFFICIENT_PERMISSIONS: "Insufficient permissions for this action",
  INVALID_INVITATION: "Invalid invitation token",
  EXPIRED_INVITATION: "Invitation has expired",
  INVALID_TOKEN: "Invalid or expired token",
  EXPIRED_SESSION: "Session has expired",
  // Token issuance errors
  TOKEN_NOT_FOUND: "Token not found",
  TOKEN_NOT_ACTIVE: "Token is not active",
  TOKEN_NOT_MINTABLE: "Token is not mintable",
  TOKEN_NOT_DEPLOYED: "Token has not been deployed to Solana",
  TOKEN_PAUSED: "Token operations are paused",
  INVALID_TOKEN_AMOUNT: "Token amount is invalid",
  NOT_ON_TOKEN_ALLOWLIST: "Address is not on the token allowlist",
  DESTINATION_REVOKED:
    "Destination address was revoked from the allowlist; re-add it explicitly before minting",
  ON_TOKEN_BLOCKLIST: "Address is on the token denylist",
  TOKEN_ACCOUNT_NOT_FOUND: "Token account not found for this mint",
  INVALID_BURN_SOURCE: "Burn source is not valid for this signer",
  INSUFFICIENT_TOKEN_BALANCE: "Token account does not hold enough balance",
  ACCOUNT_FROZEN: "Account is frozen",
  ACCOUNT_NOT_FROZEN: "Account is not frozen",
  MAX_SUPPLY_EXCEEDED: "Operation would exceed maximum supply",
  SOLANA_RPC_ERROR: "Error communicating with Solana RPC",
  CUSTODY_ERROR: "Custody provider error",
  // Transaction errors
  TRANSACTION_FAILED: "Transaction failed",
  SIGNING_FAILED: "Transaction signing failed",
  SIGNING_PENDING: "Signing request pending approval",
  PROVIDER_NOT_CONFIGURED: "Payment provider is not configured for this environment",
  PROVIDER_UNAVAILABLE: "Payment provider is temporarily unavailable",
  ESTIMATE_NOT_AVAILABLE:
    "An indicative estimate is not available; the rate is known at quote time",
};

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message || DEFAULT_ERROR_MESSAGES[code]);
    this.code = code;
    this.statusCode = ERROR_STATUS_CODES[code];
    this.details = details;
    this.name = "AppError";
  }

  toResponse(): ErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details && { details: this.details }),
      },
    };
  }
}

export function badRequest(message?: string, details?: Record<string, unknown>): AppError {
  return new AppError("BAD_REQUEST", message, details);
}

export function badRequestQuery(details?: Record<string, unknown>): AppError {
  return new AppError("BAD_REQUEST", "Invalid query parameters", details);
}

export function badRequestParams(details?: Record<string, unknown>): AppError {
  return new AppError("BAD_REQUEST", "Invalid path parameters", details);
}

export function unauthorized(message?: string): AppError {
  return new AppError("UNAUTHORIZED", message);
}

export function forbidden(message?: string): AppError {
  return new AppError("FORBIDDEN", message);
}

export function notFound(resource?: string): AppError {
  return new AppError("NOT_FOUND", resource ? `${resource} not found` : undefined);
}

export function conflict(message?: string): AppError {
  return new AppError("CONFLICT", message);
}

export function rateLimited(message?: string): AppError {
  return new AppError("RATE_LIMITED", message);
}

export function internalError(message?: string): AppError {
  return new AppError("INTERNAL_ERROR", message);
}

export function transactionFailed(message?: string, details?: Record<string, unknown>): AppError {
  return new AppError("TRANSACTION_FAILED", message, details);
}

export function providerNotConfigured(message?: string): AppError {
  return new AppError("PROVIDER_NOT_CONFIGURED", message);
}

export function providerUnavailable(message?: string, details?: Record<string, unknown>): AppError {
  return new AppError("PROVIDER_UNAVAILABLE", message, details);
}

export function estimateNotAvailable(
  message?: string,
  details?: Record<string, unknown>
): AppError {
  return new AppError("ESTIMATE_NOT_AVAILABLE", message, details);
}

export function rampExecuteNotSupported(
  provider: RampProviderId,
  direction: RampDirection
): AppError {
  const label = direction === "offramp" ? "off-ramp" : "on-ramp";
  return new AppError(
    "BAD_REQUEST",
    `${provider} ${label} execute is not supported. Use POST /v1/payments/ramps/${direction}/quote instead.`,
    { provider, direction }
  );
}

export function unsupportedCounterparty(
  provider: RampProviderId,
  direction: RampDirection,
  reason: string
): CounterpartyRequirements {
  return { provider, direction, status: "unsupported", reason };
}

export function counterpartyNotProvisioned(
  provider: RampProviderId,
  direction: RampDirection,
  details?: Record<string, unknown>
): AppError {
  return new AppError(
    "CONFLICT",
    `Counterparty is not provisioned for ${provider} ${direction}. Complete the counterparty requirements (POST /counterparties/:counterpartyId/requirements) before requesting a quote.`,
    { ...details, provider, direction }
  );
}
