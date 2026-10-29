import { RpcHttpStatusError } from "@sdp/rpc/errors";
import type { RpcTransport } from "@solana/kit";
import { guardedFetch } from "@/services/guarded-egress";

/**
 * A provider answering on a canonical or regional host is ordinary. Each hop
 * is resolved through the guard again, so following is bounded rather than
 * trusted.
 */
const CUSTOMER_RPC_MAX_REDIRECTS = 3;

/**
 * Upper bound on what is buffered back from a customer endpoint. Sized for the
 * largest ordinary answers (`getProgramAccounts`, a full block) with room to
 * spare; a hostile endpoint cannot stream unbounded bytes into the process.
 */
const CUSTOMER_RPC_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** How long a customer endpoint gets to answer. */
const CUSTOMER_RPC_TIMEOUT_MS = 30_000;

/**
 * The time bound joins the caller's signal rather than yielding to it: the
 * Kit transport always supplies one, and a caller's cancellation must not
 * disable the ceiling.
 *
 * @param signal - The caller's abort signal, when it supplied one.
 * @returns A signal that aborts on the caller's signal or the timeout, whichever fires first.
 */
function boundedSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(CUSTOMER_RPC_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * The relaxations a destination earned by matching an exact
 * operator-approved Private Channels egress-allowlist entry. `plaintext`
 * permits `http:` for an entry written as plaintext (the public sandbox
 * gateway answers on it); `insecure` dials without the connect-time address
 * check for an entry written as a private literal. A plaintext entry written
 * as a NAME keeps the address check — only the scheme is relaxed. Both must
 * come from the allowlist, never from anything a request can influence.
 */
export interface ApprovedEgressOrigin {
  plaintext: boolean;
  insecure: boolean;
}

/**
 * A Solana Kit transport for a customer-supplied RPC URL. Every request is
 * DNS-checked at connect time and re-guarded on each redirect hop, because the
 * customer can point the URL anywhere.
 *
 * @param endpointUrl - The customer's RPC URL.
 * @param approvedOrigin - The egress-allowlist verdict for this exact origin,
 *   when it has one. It relaxes the guard no further than the probe path is
 *   relaxed for the same entry; an unapproved destination keeps the strict
 *   guard.
 * @returns A Kit transport that posts through the egress guard.
 */
export function createCustomerRpcTransport(
  endpointUrl: string,
  approvedOrigin?: ApprovedEgressOrigin
): RpcTransport {
  return async function rpcTransport<TResponse>({
    payload,
    signal,
  }: Parameters<RpcTransport>[0]): Promise<TResponse> {
    const upstream = await guardedFetch(endpointUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
      signal: boundedSignal(signal),
      maxRedirects: CUSTOMER_RPC_MAX_REDIRECTS,
      maxResponseBytes: CUSTOMER_RPC_MAX_RESPONSE_BYTES,
      rejectOversizeResponse: true,
      approvedPlaintextDestination: approvedOrigin?.plaintext ?? false,
      approvedInsecureDestination: approvedOrigin?.insecure ?? false,
    });

    if (!upstream.ok) {
      throw new RpcHttpStatusError(
        upstream.status,
        `RPC request failed with HTTP ${upstream.status}`
      );
    }

    return (await upstream.json()) as TResponse;
  };
}
