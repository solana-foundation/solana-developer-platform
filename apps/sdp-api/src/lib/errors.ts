/**
 * API Error Types and Handlers
 */

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
  | "EXPIRED_INVITATION";

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
