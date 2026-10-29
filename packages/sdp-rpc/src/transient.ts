/**
 * Shared RPC helpers used by the Solana RPC layer and the fee-payment adapters.
 */

import {
  isSolanaError,
  SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_STATUS_NOT_AVAILABLE_YET,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_UNREACHABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_HISTORY_NOT_AVAILABLE,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";
import { RpcHttpStatusError, RpcTimeoutError, SdpRpcError } from "./errors";

// Overloaded-gateway / timeout HTTP statuses worth retrying.
const TRANSIENT_HTTP_STATUS_CODES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/**
 * What a transient JSON-RPC error means for the request that got it:
 *
 * - `failover`: this node can't serve the request yet (unhealthy, behind the requested slot,
 *   missing history or block status). Nodes answer these with HTTP 200, so the managed pool reads
 *   them from the body and asks the next endpoint; a caller may also retry later.
 * - `retry`: the node failed this attempt (`-32603`, which providers answer for an upstream
 *   timeout). The pool returns it as-is; a caller may retry.
 *
 * Every code here is transient. One table, so the pool's failover and the caller's retry never
 * disagree about which codes are worth another attempt.
 */
export const TRANSIENT_JSON_RPC_ERROR_VERDICTS: ReadonlyMap<number, "failover" | "retry"> = new Map(
  [
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY, "failover"],
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED, "failover"],
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_STATUS_NOT_AVAILABLE_YET, "failover"],
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_HISTORY_NOT_AVAILABLE, "failover"],
    [SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_UNREACHABLE, "failover"],
    [SOLANA_ERROR__JSON_RPC__INTERNAL_ERROR, "retry"],
  ]
);

/**
 * Node and undici `code`s for a connection that failed, reset or timed out. `fetch` rejects with
 * a `TypeError` whose `cause` carries one; a caller walking a cause chain meets the code directly.
 * DNS `ENOTFOUND` is absent: a host that doesn't resolve is configuration, not load.
 */
const TRANSIENT_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/** The string `code` on `value`, as Node and undici errors carry it. */
function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) return undefined;
  return typeof value.code === "string" ? value.code : undefined;
}

/**
 * A connection-level failure: a Node/undici error with a transient `code`, or `fetch`'s
 * `TypeError` whose `cause` has one, or a `TimeoutError` from `AbortSignal.timeout`.
 */
function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError") return true;
  const code =
    errorCode(error) ?? (error instanceof TypeError ? errorCode(error.cause) : undefined);
  return code !== undefined && TRANSIENT_NETWORK_ERROR_CODES.has(code);
}

/**
 * The verdict for a JSON-RPC error kit decoded into a `SolanaError`, or `undefined` when the code
 * is not transient (or `error` is not one).
 *
 * @param error - The thrown or served error.
 * @returns `failover`, `retry`, or `undefined`.
 */
export function transientJsonRpcVerdict(error: unknown): "failover" | "retry" | undefined {
  if (!isSolanaError(error)) return undefined;
  return TRANSIENT_JSON_RPC_ERROR_VERDICTS.get(error.context.__code);
}

/**
 * Returns `true` when an RPC failure is transient and therefore safe to retry: overloaded-gateway
 * HTTP statuses (408/429/5xx), SDP's own attempt deadline, a transient JSON-RPC code, and
 * connection-level failures from `fetch` or the socket.
 *
 * Classified by type and code only, never by message: kit replaces its messages with
 * `Solana error #<code>` under `NODE_ENV=production`, so text that matches in tests would not in
 * prod. Persistent failures (blockhash expiry, invalid transactions, insufficient funds, 401/403)
 * are excluded so callers don't retry unrecoverable submissions.
 */
export function isTransientRpcError(error: unknown): boolean {
  if (error instanceof RpcTimeoutError) return true;
  if (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR)) {
    return TRANSIENT_HTTP_STATUS_CODES.has(error.context.statusCode);
  }
  if (error instanceof RpcHttpStatusError) return TRANSIENT_HTTP_STATUS_CODES.has(error.httpStatus);
  if (transientJsonRpcVerdict(error) !== undefined) return true;
  return isTransientNetworkError(error);
}

/**
 * Returns `true` when a transient failure came from Solana RPC itself: a kit `SolanaError`, an SDP
 * RPC error (the attempt deadline) or an SDP guarded transport's HTTP status. The API answers these
 * `503 RPC_UNAVAILABLE` with reason `upstream_unavailable`. A bare network error is excluded,
 * since nothing tells an RPC fetch apart from any other `fetch` once it reaches the boundary.
 */
export function isRpcUpstreamUnavailable(error: unknown): boolean {
  return (
    (isSolanaError(error) || error instanceof SdpRpcError || error instanceof RpcHttpStatusError) &&
    isTransientRpcError(error)
  );
}

/**
 * Returns `true` when an RPC failure is a gateway HTTP 401. `@solana/kit`'s HTTP
 * transport puts that on `error.context.statusCode`, and SDP's own guarded
 * transports (`createCustomerRpcTransport`, the Private Channels gateway
 * transport) throw the same status as an `RpcHttpStatusError`. Do not widen
 * past 401 (see `withGatewayRpc` for the one-shot refresh retry that depends on this).
 */
export function isUnauthorizedRpcError(error: unknown): boolean {
  return (
    (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) &&
      error.context.statusCode === 401) ||
    (error instanceof RpcHttpStatusError && error.httpStatus === 401)
  );
}

/**
 * Returns `true` when an RPC failure is a gateway HTTP 403. `@solana/kit`'s HTTP
 * transport puts that on `error.context.statusCode`, and SDP's own guarded
 * transports throw the same status as an `RpcHttpStatusError`. The SPC gateway
 * answers 403 (`-32002 "account not owned by caller"`) for a token account that
 * does not exist yet, so a channel read treats a never-credited owner as an
 * empty balance rather than an error — see `getChannelTokenBalance`.
 */
export function isForbiddenRpcError(error: unknown): boolean {
  return (
    (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) &&
      error.context.statusCode === 403) ||
    (error instanceof RpcHttpStatusError && error.httpStatus === 403)
  );
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
