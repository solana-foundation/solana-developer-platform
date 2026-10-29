import { RpcUnavailableError } from "@sdp/rpc/errors";
import { currentClusterScope } from "@sdp/rpc/scope";
import { isRpcUpstreamUnavailable, isTransientRpcError } from "@sdp/rpc/transient";

/**
 * Rethrow a failed Solana RPC read that the API answers `503 RPC_UNAVAILABLE`, from a route's catch
 * around that read, so the route's own error covers only what RPC actually answered. Inside such a
 * catch a bare network error came from RPC, so it is `upstream_unavailable` too; `app.ts` cannot
 * tell it apart from any other `fetch` once it reaches the boundary.
 *
 * Reads only: a send that failed after it left SDP may still land, so its caller decides.
 *
 * @param error - What the RPC read threw.
 * @throws RpcUnavailableError, or the kit or SDP error the API maps to one, when RPC was unavailable.
 */
export function rethrowRpcUnavailable(error: unknown): void {
  if (error instanceof RpcUnavailableError || isRpcUpstreamUnavailable(error)) throw error;
  if (isTransientRpcError(error)) {
    throw new RpcUnavailableError(
      "upstream_unavailable",
      "Solana RPC could not be reached",
      { cluster: currentClusterScope().cluster },
      { cause: error }
    );
  }
}
