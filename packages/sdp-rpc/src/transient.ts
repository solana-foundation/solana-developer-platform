/**
 * Shared RPC helpers used by the Solana RPC layer and the fee-payment adapters.
 */

import {
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_STATUS_NOT_AVAILABLE_YET,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_UNREACHABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
} from "@solana/kit";

// Overloaded-gateway / timeout HTTP statuses worth retrying.
const TRANSIENT_HTTP_STATUS = /\b(408|429|500|502|503|504)\b/;

// Transport-level failures thrown by `fetch` or the underlying socket. The `i`
// flag makes matching case-insensitive, so callers don't need to lowercase the
// message first.
const TRANSIENT_ERROR_TEXT =
  /service unavailable|too many requests|timed?\s*out|gateway timeout|unable to complete|bad gateway|fetch failed|network error|socket hang ?up|connection reset|connection refused|econnreset|econnrefused|etimedout|eai_again/i;

/**
 * Returns `true` when an RPC failure looks transient and is therefore safe to
 * retry — overloaded-gateway HTTP statuses (429/5xx) and transport-level errors
 * thrown by `fetch` or the underlying socket.
 *
 * Persistent failures (e.g. blockhash expiry, invalid transactions,
 * insufficient funds) are intentionally excluded so callers don't retry
 * unrecoverable submissions.
 */
// Transient Solana JSON-RPC server codes: node unhealthy/behind, block status
// not yet available, long-term storage unreachable.
const TRANSIENT_SOLANA_RPC_CODES = [
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_STATUS_NOT_AVAILABLE_YET,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_UNREACHABLE,
] as const;

export function isTransientRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    TRANSIENT_HTTP_STATUS.test(message) ||
    TRANSIENT_ERROR_TEXT.test(message) ||
    TRANSIENT_SOLANA_RPC_CODES.some((code) => isSolanaError(error, code))
  );
}

/**
 * Returns `true` when an RPC failure is a gateway HTTP 401. `@solana/kit`'s HTTP
 * transport puts that on `error.context.statusCode`; do not widen past 401 (see
 * `withGatewayRpc` for the one-shot refresh retry that depends on this).
 */
export function isUnauthorizedRpcError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const context = (error as { context?: unknown }).context;
  if (!context || typeof context !== "object") {
    return false;
  }
  return (context as { statusCode?: unknown }).statusCode === 401;
}

const TRANSIENT_RPC_RETRY_DELAYS_MS = [250, 750, 1500];

const TRANSIENT_RPC_RETRY_BUDGET_MS = 45_000;

/**
 * Run an RPC operation, retrying transient failures (as classified by
 * `isTransientRpcError`) on a short backoff schedule, bounded by a total
 * elapsed-time budget. Persistent errors, errors that survive the whole
 * schedule, and errors past the budget are rethrown.
 */
export async function withTransientRpcRetry<T>(
  operation: () => Promise<T>,
  delaysMs: readonly number[] = TRANSIENT_RPC_RETRY_DELAYS_MS,
  options: { maxElapsedMs?: number } = {}
): Promise<T> {
  const maxElapsedMs = options.maxElapsedMs ?? TRANSIENT_RPC_RETRY_BUDGET_MS;
  const startedAt = Date.now();
  let lastError: unknown;

  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (
        attempt === delaysMs.length ||
        !isTransientRpcError(error) ||
        Date.now() - startedAt >= maxElapsedMs
      ) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
  }

  throw lastError;
}
