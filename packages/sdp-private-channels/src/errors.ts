/**
 * SPC client errors.
 *
 * Mirrors the `SdpPaymentsError` shape (`packages/sdp-payments/src/errors.ts`)
 * so the sdp-api adapter can map `PrivateChannelError.code` → `AppError` in one
 * place. The library throws only `PrivateChannelError`; it never reaches for the
 * app's `AppError`.
 */

/** Machine-readable error classifications, each mapped to an HTTP status below. */
export type PrivateChannelErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "AUTH_UNAVAILABLE"
  | "INTERNAL_ERROR";

const ERROR_STATUS_CODES: Record<PrivateChannelErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  AUTH_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

const DEFAULT_ERROR_MESSAGES: Record<PrivateChannelErrorCode, string> = {
  BAD_REQUEST: "Invalid request",
  UNAUTHORIZED: "Authentication required",
  FORBIDDEN: "Access denied",
  NOT_FOUND: "Resource not found",
  CONFLICT: "Resource already exists",
  RATE_LIMITED: "Too many requests",
  AUTH_UNAVAILABLE: "The private channel auth service is temporarily unavailable",
  INTERNAL_ERROR: "An internal error occurred",
};

/** The single error type the SPC client throws; the adapter maps `code` → `AppError`. */
export class PrivateChannelError extends Error {
  /** HTTP status derived from `code` (`ERROR_STATUS_CODES`). */
  public readonly statusCode: number;

  constructor(
    /** Machine-readable classification. */
    public readonly code: PrivateChannelErrorCode,
    /** Human-readable message; defaults to `DEFAULT_ERROR_MESSAGES[code]`. */
    message?: string,
    /** Optional structured context (e.g. `{ cause, status }`). */
    public readonly details?: Record<string, unknown>
  ) {
    super(message || DEFAULT_ERROR_MESSAGES[code]);
    this.name = "PrivateChannelError";
    this.statusCode = ERROR_STATUS_CODES[code];
  }
}

/** Build a `BAD_REQUEST` (400) error. */
export function badRequest(
  message?: string,
  details?: Record<string, unknown>
): PrivateChannelError {
  return new PrivateChannelError("BAD_REQUEST", message, details);
}

/** Classify an HTTP status from the auth service into a `PrivateChannelErrorCode`. */
export function classifyAuthStatus(status: number): PrivateChannelErrorCode {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "AUTH_UNAVAILABLE";
  return "BAD_REQUEST";
}
