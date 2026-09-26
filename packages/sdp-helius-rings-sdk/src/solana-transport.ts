import {
  type RpcResponse,
  type RpcTransport,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
} from "@solana/kit";
import { parseJsonWithBigInts, stringifyJsonWithBigInts } from "@solana/rpc-spec-types";

export interface GuardedSolanaRpcTransportConfig {
  /** The resolved Solana RPC endpoint; every request is confined to it. */
  readonly url: string;
  /**
   * The fetch the transport dials through — in production the guarded egress
   * fetch: DNS-checked at connect time, redirects refused, so the RPC leg can
   * neither rebind nor bounce into a second endpoint.
   */
  readonly fetch: typeof globalThis.fetch;
}

/**
 * A Kit `RpcTransport` over a caller-supplied `fetch`, wire-compatible with the
 * transport `createSolanaRpc` builds internally: `POST` JSON with bigint-aware
 * serialization, non-2xx raises Kit's HTTP transport error, and responses parse
 * through the same bigint codec so u64 fields stay exact.
 */
export function createGuardedSolanaRpcTransport(
  config: GuardedSolanaRpcTransportConfig
): RpcTransport {
  const { url, fetch: fetchImpl } = config;
  const transport = async ({
    payload,
    signal,
  }: {
    payload: unknown;
    signal?: AbortSignal;
  }): Promise<RpcResponse> => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json; charset=utf-8",
      },
      body: stringifyJsonWithBigInts(payload),
      signal,
    });
    if (!response.ok) {
      throw new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
        headers: response.headers,
        message: response.statusText,
        statusCode: response.status,
      });
    }
    return parseJsonWithBigInts(await response.text()) as RpcResponse;
  };
  // The wire-level parse is response-shape agnostic: every method's plan
  // narrows `RpcResponse<unknown>` itself, so the generic transport signature
  // is satisfied by the one implementation.
  return transport as unknown as RpcTransport;
}
