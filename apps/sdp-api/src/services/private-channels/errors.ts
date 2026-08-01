import { PrivateChannelError, type PrivateChannelErrorCode } from "@sdp/private-channels";
import { AppError, type ErrorCode } from "@/lib/errors";

const PRIVATE_CHANNEL_TO_APP_ERROR: Record<PrivateChannelErrorCode, ErrorCode> = {
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  AUTH_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  INTERNAL_ERROR: "INTERNAL_ERROR",
};

/**
 * Map an `PrivateChannelError` (thrown by `@sdp/private-channels`) to the app's `AppError`. Called in
 * the private-channels handler catch so `app.ts` `onError` need not learn about
 * `PrivateChannelError`.
 */
export function mapPrivateChannelError(error: unknown): AppError {
  if (error instanceof PrivateChannelError) {
    return new AppError(PRIVATE_CHANNEL_TO_APP_ERROR[error.code], error.message, {
      ...(error.details ?? {}),
      provider: "private-channels",
    });
  }
  if (error instanceof AppError) {
    return error;
  }
  return new AppError(
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : "Private channel request failed"
  );
}
