import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type RpcTransport,
} from "@solana/kit";

/**
 * Maximum time a single Kamino RPC request may hold a worker open.
 *
 * This deadline is applied at the transport boundary, not only to the reads
 * this package issues directly. klend-sdk receives the same RPC client, so its
 * vault, reserve, farm and exchange-rate reads are bounded too.
 */
export const KAMINO_RPC_REQUEST_TIMEOUT_MS = 30_000;

/** Package-local so the SDK gets a deadline without adding a new workspace dependency edge. */
export function withKaminoRpcTimeout(
  transport: RpcTransport,
  timeoutMs = KAMINO_RPC_REQUEST_TIMEOUT_MS
): RpcTransport {
  return async <TResponse>(config: Parameters<RpcTransport>[0]) => {
    const controller = new AbortController();
    // A distinct reason lets the catch path tell our deadline from a caller
    // cancellation even if both signals become aborted before transport rejects.
    const deadlineReason = new Error("Kamino RPC deadline elapsed");
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
        throw new Error(`Kamino RPC request timed out after ${timeoutMs}ms`, { cause });
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** One deadline-aware RPC client shared by the package and the pinned SDK. */
export function createKaminoRpc(rpcUrl: string, timeoutMs = KAMINO_RPC_REQUEST_TIMEOUT_MS) {
  const transport = createDefaultRpcTransport({ url: rpcUrl });
  return createSolanaRpcFromTransport(withKaminoRpcTimeout(transport, timeoutMs));
}
