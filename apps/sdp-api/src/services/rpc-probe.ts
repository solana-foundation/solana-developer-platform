/**
 * The read-only JSON-RPC probe behind `POST /v1/rpc/test` and tenant
 * connection activation.
 *
 * Its own module so the provider setup registry and the RPC connection service
 * can both use it: the registry holds the per-provider hooks that call into the
 * connection service, so the connection service must not import the registry
 * back.
 */
export interface RpcProbeTarget {
  endpoint: string;
  headers: Record<string, string>;
}

export interface RpcProbeResult {
  elapsedMs: number;
  upstream: Response;
  upstreamBody: unknown;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function probeRpcEndpoint(target: RpcProbeTarget): Promise<RpcProbeResult> {
  const startedAt = Date.now();
  const upstream = await fetch(target.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...target.headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "rpc-connectivity-test",
      method: "getVersion",
      params: [],
    }),
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
