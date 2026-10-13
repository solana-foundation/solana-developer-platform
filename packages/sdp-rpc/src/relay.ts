import type { OrganizationRpcProvider, SolanaCluster } from "@sdp/types";
import { type ManagedRpcEndpoint, managedRpcEndpoints } from "./factory";
import { currentClusterScope } from "./scope";
import type { KVStore, RpcEnv } from "./types";

export { withHeliusApiKey } from "./config";

export interface ResolveRpcTargetInput {
  env: RpcEnv;
  cache: KVStore;
}

export interface ResolvedRpcTarget {
  providerId: OrganizationRpcProvider;
  endpoint: string;
  endpointLabel: string;
}

/**
 * The KV key of `cluster`'s round-robin cursor; each cluster rotates over its own pool.
 *
 * @param cluster - The cluster whose pool the cursor indexes.
 * @returns The cursor's KV key.
 */
function roundRobinCursorKey(cluster: SolanaCluster): string {
  return `rpc:relay:round-robin-cursor:${cluster}`;
}

function collectRpcApiKeys(env: RpcEnv): string[] {
  const secrets: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (
      key.startsWith("SOLANA_RPC_") &&
      key.endsWith("_API_KEY") &&
      typeof value === "string" &&
      value.trim().length > 0
    ) {
      secrets.push(value);
      if (value !== value.trim()) {
        secrets.push(value.trim());
      }
    }
  }
  // Longest first: replacing a shorter overlapping key before a longer one
  // would mangle the longer key's match and leave a partial secret behind.
  return secrets.sort((a, b) => b.length - a.length);
}

/**
 * A path segment shaped like an API credential: long token charset mixing
 * letters and digits. The digit requirement is what separates keys from real
 * path vocabulary — network names like `solana-mainnet-beta` clear the length
 * bar but carry no digit, while Alchemy/QuickNode/Triton-style keys always
 * mix both.
 *
 * @param segment - One URL path segment, possibly percent-encoded.
 * @returns Whether the segment looks like an API credential.
 */
function isCredentialPathSegment(segment: string): boolean {
  // Percent-encoded segments decode first, so a Base64-style credential
  // carrying +, / or = (spelled %2B/%2F/%3D in the URL) is classified by its
  // real content instead of slipping past on the % characters.
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Malformed escapes classify as written.
  }
  return (
    /^[A-Za-z0-9_\-+/=]{16,}$/.test(decoded) && /[0-9]/.test(decoded) && /[A-Za-z]/.test(decoded)
  );
}

/**
 * Redact provider API keys before an endpoint is exposed to callers. The
 * known-key pass covers path-segment keys (Alchemy, QuickNode, Triton,
 * Validation Cloud, Nodit); the shape pass covers query-value keys (Helius)
 * and any key embedded in a URL template the platform does not hold by value.
 *
 * @param url - The provider endpoint, keys included.
 * @param env - Process env holding the managed providers' keys.
 * @returns The endpoint with every key replaced by `***`.
 */
export function maskEndpoint(url: string, env: RpcEnv): string {
  let masked = url;
  for (const secret of collectRpcApiKeys(env)) {
    masked = masked.replaceAll(secret, "***");
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      masked = masked.replaceAll(encoded, "***");
    }
  }

  return maskCredentialShapes(masked);
}

/**
 * The value-blind half of endpoint masking: credential-looking query values
 * (`key`/`token` names) and credential-shaped path segments.
 *
 * @param url - The endpoint to mask.
 * @returns The endpoint with credential-shaped parts replaced by `***`, or the input unchanged when it is not a URL.
 */
function maskCredentialShapes(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of parsed.searchParams.keys()) {
      if (key.toLowerCase().includes("key") || key.toLowerCase().includes("token")) {
        parsed.searchParams.set(key, "***");
      }
    }
    parsed.pathname = parsed.pathname
      .split("/")
      .map((segment) => (isCredentialPathSegment(segment) ? "***" : segment))
      .join("/");
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * The open scope's cluster pool, rotated so the endpoint its round-robin cursor selects comes
 * first, advancing the cursor.
 *
 * @param cache - KV store holding the cursors.
 * @returns Every endpoint of the scope's cluster pool, starting at the selected one.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the scope's cluster has no endpoint configured.
 */
async function rotateScopeClusterEndpoints(cache: KVStore): Promise<ManagedRpcEndpoint[]> {
  const { cluster } = currentClusterScope();
  const endpoints = managedRpcEndpoints(cluster);
  if (endpoints.length === 1) {
    return endpoints;
  }

  const cursorKey = roundRobinCursorKey(cluster);
  const rawCursor = await cache.get(cursorKey);
  const parsedCursor = rawCursor ? Number.parseInt(rawCursor, 10) : 0;
  const cursor = Number.isFinite(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
  const index = cursor % endpoints.length;

  await cache.put(cursorKey, String((index + 1) % endpoints.length));
  return [...endpoints.slice(index), ...endpoints.slice(0, index)];
}

/**
 * The relay target for one managed endpoint, with a masked label for responses.
 *
 * @param endpoint - A managed pool endpoint.
 * @param env - Process env, used to mask the provider's keys out of the label.
 * @returns The relay target for that endpoint.
 */
function toRelayTarget(endpoint: ManagedRpcEndpoint, env: RpcEnv): ResolvedRpcTarget {
  return {
    providerId: endpoint.providerId,
    endpoint: endpoint.endpointUrl,
    endpointLabel: maskEndpoint(endpoint.endpointUrl, env),
  };
}

/**
 * The managed endpoint the next relay request goes to, chosen round-robin across the open
 * scope's cluster pool.
 *
 * @param input - Process env and the KV store holding the round-robin cursors.
 * @param input.env - Process env, used to mask provider keys out of the label.
 * @param input.cache - KV store holding the round-robin cursors.
 * @returns The selected relay target.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the scope's cluster has no endpoint configured.
 */
export async function resolveRpcTarget(input: ResolveRpcTargetInput): Promise<ResolvedRpcTarget> {
  const [selected] = await rotateScopeClusterEndpoints(input.cache);
  return toRelayTarget(selected, input.env);
}

/**
 * Every endpoint of the open scope's cluster pool in round-robin order, for callers that try
 * each in turn.
 *
 * @param input - Process env and the KV store holding the round-robin cursors.
 * @param input.env - Process env, used to mask provider keys out of the labels.
 * @param input.cache - KV store holding the round-robin cursors.
 * @returns The relay targets, starting at the selected endpoint.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the scope's cluster has no endpoint configured.
 */
export async function resolveRoundRobinRpcTargets(
  input: ResolveRpcTargetInput
): Promise<ResolvedRpcTarget[]> {
  const ordered = await rotateScopeClusterEndpoints(input.cache);
  return ordered.map((endpoint) => toRelayTarget(endpoint, input.env));
}
