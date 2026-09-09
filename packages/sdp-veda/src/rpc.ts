import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type RpcTransport,
} from "@solana/kit";

/**
 * Maximum time a single Veda RPC request may hold a worker open.
 *
 * Applied at the TRANSPORT boundary, not only to the reads this package issues
 * directly: `@vedatech/svm-sdk` receives this same client, so its vault, asset,
 * oracle, mint and position reads are bounded too. A deposit build fans out
 * over several of those, and an unbounded one would let a slow node hold an API
 * worker for as long as it liked.
 */
export const VEDA_RPC_REQUEST_TIMEOUT_MS = 30_000;

/** Package-local so the SDK gets a deadline without a new workspace dependency edge. */
export function withVedaRpcTimeout(
  transport: RpcTransport,
  timeoutMs = VEDA_RPC_REQUEST_TIMEOUT_MS
): RpcTransport {
  return async <TResponse>(config: Parameters<RpcTransport>[0]) => {
    const controller = new AbortController();
    // A distinct reason lets the catch path tell our deadline from a caller
    // cancellation even if both signals abort before the transport rejects.
    const deadlineReason = new Error("Veda RPC deadline elapsed");
    const timer = setTimeout(() => controller.abort(deadlineReason), timeoutMs);
    const signal = config.signal
      ? AbortSignal.any([config.signal, controller.signal])
      : controller.signal;
    try {
      return await transport<TResponse>({ ...config, signal });
    } catch (cause) {
      if (signal.aborted && signal.reason === deadlineReason) {
        // "timed out" deliberately matches the API's transient-error
        // classifier: a deadline is retryable, never a permanent vault fact.
        throw new Error(`Veda RPC request timed out after ${timeoutMs}ms`, { cause });
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** One deadline-aware RPC client shared by this package and the pinned SDK. */
export function createVedaRpc(rpcUrl: string, timeoutMs = VEDA_RPC_REQUEST_TIMEOUT_MS) {
  const transport = createDefaultRpcTransport({ url: rpcUrl });
  return createSolanaRpcFromTransport(withVedaRpcTimeout(transport, timeoutMs));
}
