import type { OrganizationRpcProvider } from "@sdp/types";
import { rpcProviderNeedsEndpoint } from "@sdp/types";
import {
  applyApiKeyTemplate,
  withAlchemyApiKey,
  withHeliusApiKey,
  withOptionalApiKeyTemplate,
} from "./config";
import { SdpRpcError } from "./errors";

/**
 * A tenant supplies the same pair the operator supplies today: an endpoint and
 * a key. `resolveManagedProviders` reads `SOLANA_RPC_<PROVIDER>_URL` plus
 * `SOLANA_RPC_<PROVIDER>_API_KEY` and applies a per-provider rule; BYOK applies
 * the identical rule to credentials the organization owns.
 *
 * The endpoint is required rather than derived from a built-in vendor URL:
 * QuickNode, Triton and Validation Cloud endpoints are account-specific, and
 * guessing a host for the others would put traffic somewhere nobody chose.
 */
export interface TenantRpcCredential {
  /** May carry the `{API_KEY}` placeholder the platform templates already use. */
  endpointUrl: string;
  apiKey: string;
}

export interface TenantRpcTarget {
  endpoint: string;
  headers: Record<string, string>;
}

/** `default` is SDP's own platform-managed rail — it has no tenant credential. */
export type ByokRpcProvider = Exclude<OrganizationRpcProvider, "default">;

export const BYOK_RPC_PROVIDERS: readonly ByokRpcProvider[] = [
  "alchemy",
  "helius",
  "nodit",
  "quicknode",
  "triton",
  "validationcloud",
];

export function isByokRpcProvider(value: string): value is ByokRpcProvider {
  return (BYOK_RPC_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Endpoints a tenant does not have to type.
 *
 * Only providers whose host is the same for every account belong here, and
 * only where this repository already carries both network URLs. QuickNode and
 * Triton issue an account-specific subdomain, and Nodit and Validation Cloud
 * are not confirmed for both clusters, so those still require an explicit
 * endpoint rather than a guessed one.
 */
export const DEFAULT_TENANT_ENDPOINTS: Partial<
  Record<ByokRpcProvider, Record<"devnet" | "mainnet-beta", string>>
> = {
  helius: {
    devnet: "https://devnet.helius-rpc.com",
    "mainnet-beta": "https://mainnet.helius-rpc.com",
  },
  alchemy: {
    devnet: "https://solana-devnet.g.alchemy.com/v2",
    "mainnet-beta": "https://solana-mainnet.g.alchemy.com/v2",
  },
};

/** Whether the tenant must supply an endpoint because we cannot know theirs. */
export function requiresExplicitEndpoint(provider: ByokRpcProvider): boolean {
  return rpcProviderNeedsEndpoint(provider);
}

export function resolveTenantEndpoint(
  provider: ByokRpcProvider,
  network: "devnet" | "mainnet-beta",
  supplied?: string
): string {
  const trimmed = supplied?.trim();
  if (trimmed) {
    return trimmed;
  }
  const fallback = DEFAULT_TENANT_ENDPOINTS[provider]?.[network];
  if (!fallback) {
    throw new SdpRpcError(
      "BAD_REQUEST",
      `${provider} issues an account-specific endpoint, so one must be supplied`
    );
  }
  return fallback;
}

/**
 * Build the outbound target for a tenant-owned credential. Pure on purpose:
 * the relay and the activation check must construct targets the same way, and
 * neither should need a database or a secret store to do it.
 */
export function buildTenantRpcTarget(
  provider: ByokRpcProvider,
  credential: TenantRpcCredential
): TenantRpcTarget {
  const endpointUrl = credential.endpointUrl.trim();
  const apiKey = credential.apiKey.trim();

  if (!endpointUrl) {
    throw new SdpRpcError("BAD_REQUEST", "A tenant RPC connection requires an endpoint URL");
  }
  if (!apiKey) {
    throw new SdpRpcError("BAD_REQUEST", "A tenant RPC connection requires an API key");
  }

  switch (provider) {
    case "helius":
      return { endpoint: withHeliusApiKey(endpointUrl, apiKey), headers: {} };
    case "alchemy":
      return { endpoint: withAlchemyApiKey(endpointUrl, apiKey), headers: {} };
    case "quicknode":
    case "nodit":
      return { endpoint: withOptionalApiKeyTemplate(endpointUrl, apiKey), headers: {} };
    // Triton authenticates by header; the key must not also be templated into
    // the URL, where it would end up in logs that only redact query strings.
    case "triton":
      return {
        endpoint: applyApiKeyTemplate(endpointUrl, apiKey),
        headers: { "x-api-key": apiKey },
      };
    case "validationcloud":
      return { endpoint: applyApiKeyTemplate(endpointUrl, apiKey), headers: {} };
  }
}

/**
 * Redact a tenant endpoint for display. The platform's `maskEndpoint` only
 * knows the operator's own env keys, so a tenant key would survive it.
 */
export function maskTenantEndpoint(endpoint: string, apiKey: string): string {
  const key = apiKey.trim();
  let masked = endpoint;
  if (key) {
    masked = masked.replaceAll(key, "***");
    const encoded = encodeURIComponent(key);
    if (encoded !== key) {
      masked = masked.replaceAll(encoded, "***");
    }
  }

  try {
    const parsed = new URL(masked);
    for (const name of parsed.searchParams.keys()) {
      if (name.toLowerCase().includes("key") || name.toLowerCase().includes("token")) {
        parsed.searchParams.set(name, "***");
      }
    }
    return parsed.toString();
  } catch {
    return masked;
  }
}

/**
 * What is safe to show about a stored connection. Never the endpoint with its
 * key applied — only the host and a short suffix so an admin can tell two
 * credentials apart.
 */
export function buildTenantDisplayMetadata(
  credential: TenantRpcCredential
): Record<string, string> {
  const metadata: Record<string, string> = {};
  try {
    metadata.endpointHost = new URL(credential.endpointUrl).host;
  } catch {
    // An unparseable URL is caught by validation before storage; display
    // metadata must not be the thing that fails a submission.
  }
  const key = credential.apiKey.trim();
  if (key.length > 4) {
    metadata.apiKeySuffix = key.slice(-4);
  }
  return metadata;
}
