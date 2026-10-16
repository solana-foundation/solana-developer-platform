import type { OrganizationRpcProvider } from "@sdp/types";
import { type ManagedRpcProvider, resolveManagedRpcProviders } from "./config";
import { SdpRpcError } from "./errors";
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

const ROUND_ROBIN_CURSOR_KEY = "rpc:relay:round-robin-cursor";

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
 * Advance the shared round-robin cursor and return the providers starting at the selected one.
 *
 * @param cache - KV store holding the cursor.
 * @param providers - The configured managed providers.
 * @returns Every provider, rotated so the selected one is first.
 */
async function rotateProviders(
  cache: KVStore,
  providers: ManagedRpcProvider[]
): Promise<ManagedRpcProvider[]> {
  if (providers.length === 0) {
    throw new SdpRpcError("SOLANA_RPC_ERROR", "No managed Solana RPC providers are configured");
  }

  if (providers.length === 1) {
    return providers;
  }

  const rawCursor = await cache.get(ROUND_ROBIN_CURSOR_KEY);
  const parsedCursor = rawCursor ? Number.parseInt(rawCursor, 10) : 0;
  const cursor = Number.isFinite(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0;
  const index = cursor % providers.length;

  await cache.put(ROUND_ROBIN_CURSOR_KEY, String((index + 1) % providers.length));
  return [...providers.slice(index), ...providers.slice(0, index)];
}

/**
 * The relay target for one managed provider, with a masked label for responses.
 *
 * @param provider - A managed provider.
 * @param env - Process env, used to mask the provider's keys out of the label.
 * @returns The relay target for that provider.
 */
function toRelayTarget(provider: ManagedRpcProvider, env: RpcEnv): ResolvedRpcTarget {
  return {
    providerId: provider.id,
    endpoint: provider.url,
    endpointLabel: maskEndpoint(provider.url, env),
  };
}

/**
 * The managed provider the next relay request goes to, chosen round-robin across the pool.
 *
 * @param input - Process env and the KV store holding the round-robin cursor.
 * @param input.env - Process env carrying the managed provider URLs and keys.
 * @param input.cache - KV store holding the round-robin cursor.
 * @returns The selected relay target.
 * @throws SdpRpcError `SOLANA_RPC_ERROR` when no managed provider is configured.
 */
export async function resolveRpcTarget(input: ResolveRpcTargetInput): Promise<ResolvedRpcTarget> {
  const [selected] = await rotateProviders(input.cache, resolveManagedRpcProviders(input.env));
  return toRelayTarget(selected, input.env);
}

/**
 * Every managed provider in round-robin order, for callers that try each in turn.
 *
 * @param input - Process env and the KV store holding the round-robin cursor.
 * @param input.env - Process env carrying the managed provider URLs and keys.
 * @param input.cache - KV store holding the round-robin cursor.
 * @returns The relay targets, starting at the selected provider.
 * @throws SdpRpcError `SOLANA_RPC_ERROR` when no managed provider is configured.
 */
export async function resolveRoundRobinRpcTargets(
  input: ResolveRpcTargetInput
): Promise<ResolvedRpcTarget[]> {
  const ordered = await rotateProviders(input.cache, resolveManagedRpcProviders(input.env));
  return ordered.map((provider) => toRelayTarget(provider, input.env));
}
