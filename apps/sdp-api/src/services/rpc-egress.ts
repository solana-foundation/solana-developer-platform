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
      maxRedirects: RELAY_MAX_REDIRECTS,
    });
  }

  return fetch(target.endpoint, {
    method: "POST",
    headers: init.headers,
    body: init.body,
  });
}
