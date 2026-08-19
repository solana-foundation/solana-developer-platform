/**
 * Where RPC traffic leaves the process.
 *
 * A resolved target carries `connectionId` only when it is tenant-owned, which
 * makes it the one signal both egress paths need: the endpoint behind it was
 * typed into a form by a customer, so it goes out under the DNS guard. Platform
 * targets come from deployment config and keep the ordinary fetch, because they
 * are legitimately private in local development and in the Surfpool suites.
 */
import { guardedFetch } from "@/services/guarded-egress";

export interface RpcEgressTarget {
  endpoint: string;
  /** Set only for tenant-owned connections. */
  connectionId?: string;
}

export interface RpcEgressInit {
  headers: Record<string, string>;
  body: string;
}

/** Whether this target's egress has to be address-checked. */
export function isTenantOwnedTarget(target: RpcEgressTarget): boolean {
  return Boolean(target.connectionId);
}

/**
 * POST a JSON-RPC payload to a resolved target. Identical to the fetch the
 * relay made before, except that a tenant target resolves under the guard.
 */
export async function fetchRpcRelayTarget(
  target: RpcEgressTarget,
  init: RpcEgressInit
): Promise<Response> {
  if (isTenantOwnedTarget(target)) {
    return guardedFetch(target.endpoint, {
      method: "POST",
      headers: init.headers,
      body: init.body,
    });
  }

  return fetch(target.endpoint, {
    method: "POST",
    headers: init.headers,
    body: init.body,
  });
}
