/**
 * Shared RPC helpers used by the Solana RPC layer and the fee-payment adapters.
 */

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
export function isTransientRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_HTTP_STATUS.test(message) || TRANSIENT_ERROR_TEXT.test(message);
}
