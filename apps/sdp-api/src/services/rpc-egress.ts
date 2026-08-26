/**
 * Where RPC traffic leaves the process.
 *
 * The question each egress path has to answer is whether the endpoint came
 * from a customer or from deployment config, because only the first can be
 * pointed anywhere. Two resolutions carry a customer-supplied endpoint:
 *
 *   * a tenant BYOK connection, which sets `connectionId`
 *   * the `custom` provider, whose endpoint is `projects.settings.rpcEndpoint`
 *     and is validated only as a URL when it is written
 *
 * Platform targets keep the ordinary fetch: they come from deployment config
 * and are legitimately private in local development and in the Surfpool suites.
 */
import type { RpcTransport } from "@solana/kit";
import { guardedFetch } from "@/services/guarded-egress";

/**
 * The relay followed redirects before the guard existed, and a provider
 * answering on a canonical or regional host is ordinary. Each hop is resolved
 * through the guard again, so following is bounded rather than trusted.
 */
const RELAY_MAX_REDIRECTS = 3;

export interface RpcEgressTarget {
  endpoint: string;
  /** Set only for tenant-owned connections. */
  connectionId?: string;
  /** `custom` is the project's own stored endpoint. */
  providerId?: string;
}

export interface RpcEgressInit {
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

/** Whether the endpoint came from a customer and so has to be address-checked. */
export function isCustomerSuppliedTarget(target: RpcEgressTarget): boolean {
  return Boolean(target.connectionId) || target.providerId === "custom";
}

/**
 * POST a JSON-RPC payload to a resolved target. Identical to the fetch the
 * relay made before, except that a customer-supplied target resolves under the
 * guard on every hop.
 */
export async function fetchRpcRelayTarget(
  target: RpcEgressTarget,
  init: RpcEgressInit
): Promise<Response> {
  if (isCustomerSuppliedTarget(target)) {
    return guardedFetch(target.endpoint, {
      method: "POST",
      headers: init.headers,
      body: init.body,
      signal: init.signal,
      maxRedirects: RELAY_MAX_REDIRECTS,
    });
  }

  return fetch(target.endpoint, {
    method: "POST",
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
}

/**
 * Adapt the canonical relay egress executor to a Solana Kit transport.
 * Customer/BYOK targets therefore receive the same DNS and redirect guards as
 * `/v1/rpc`, while managed platform targets keep their existing direct path.
 */
export function createRpcTransportForTarget(
  target: RpcEgressTarget & { headers?: Record<string, string> }
): RpcTransport {
  return async function rpcTransport<TResponse>({
    payload,
    signal,
  }: Parameters<RpcTransport>[0]): Promise<TResponse> {
    const upstream = await fetchRpcRelayTarget(target, {
      headers: {
        ...target.headers,
        Accept: "application/json",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!upstream.ok) {
      throw new Error(`RPC request failed with HTTP ${upstream.status}`);
    }

    return (await upstream.json()) as TResponse;
  };
}
