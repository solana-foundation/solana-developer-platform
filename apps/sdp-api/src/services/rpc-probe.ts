/**
 * The read-only JSON-RPC probe behind `POST /v1/rpc/test` and tenant
 * connection activation.
 *
 * Its own module so the provider setup registry and the RPC connection service
 * can both use it: the registry holds the per-provider hooks that call into the
 * connection service, so the connection service must not import the registry
 * back.
 */
import { guardedFetch } from "@/services/guarded-egress";

export interface RpcProbeTarget {
  endpoint: string;
  headers: Record<string, string>;
}

export interface RpcProbeResult {
  elapsedMs: number;
  upstream: Response;
  upstreamBody: unknown;
}

export interface RpcProbeOptions {
  /**
   * Set for an endpoint the tenant supplied. It routes the request through
   * `guardedFetch`, which refuses an address the host check cannot see because
   * DNS produced it. Platform endpoints leave it off: they come from
   * deployment config and are private on purpose in local development and in
   * the Surfpool suites.
   */
  enforcePublicEgress?: boolean;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function probeRpcEndpoint(
  target: RpcProbeTarget,
  options: RpcProbeOptions = {}
): Promise<RpcProbeResult> {
  const startedAt = Date.now();
  const headers = {
    "Content-Type": "application/json",
    ...target.headers,
  };
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: "rpc-connectivity-test",
    method: "getVersion",
    params: [],
  });

  const upstream = options.enforcePublicEgress
    ? await guardedFetch(target.endpoint, { method: "POST", headers, body })
    : await fetch(target.endpoint, {
        method: "POST",
        // A validated host can still redirect; following it would land the
        // request somewhere the host check already refused.
        redirect: "manual",
        headers,
        body,
      });

  const rawBody = await upstream.text();
  return {
    elapsedMs: Date.now() - startedAt,
    upstream,
    upstreamBody: rawBody ? tryParseJson(rawBody) : null,
  };
}

/**
 * Reduce an upstream failure to a code safe to store and show. The provider's
 * own response body never reaches the dashboard: it can echo the key.
 */
export function toRedactedFailureCode(status: number): string {
  if (status === 401 || status === 403) {
    return "provider_rejected_credentials";
  }
  if (status === 404) {
    return "provider_endpoint_not_found";
  }
  if (status === 429) {
    return "provider_rate_limited";
  }
  if (status >= 500) {
    return "provider_unavailable";
  }
  return "provider_check_failed";
}
