/**
 * Solana Configuration
 *
 * Environment-based configuration for Solana RPC connection.
 * All crypto utilities come from @solana/kit packages.
 */

import type { OrganizationRpcProvider } from "@sdp/types";
import { type Address, assertIsAddress } from "@solana/addresses";
import type { Env } from "@/types/env";

// Re-export for convenience
export type { Address } from "@solana/addresses";
export { assertIsAddress, isAddress } from "@solana/addresses";

export interface SolanaConfig {
  rpcUrl: string;
  network: "devnet" | "mainnet-beta";
}

function applyApiKeyTemplate(url: string, apiKey: string): string {
  return url
    .replaceAll("${API_KEY}", encodeURIComponent(apiKey))
    .replaceAll("{API_KEY}", encodeURIComponent(apiKey));
}

function appendQueryParam(url: string, key: string, value: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, value);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function withHeliusApiKey(url: string, apiKey?: string): string {
  if (!apiKey) {
    return url;
  }

  const templated = applyApiKeyTemplate(url, apiKey);
  if (templated !== url) {
    return templated;
  }

  return appendQueryParam(url, "api-key", apiKey);
}

function withAlchemyApiKey(url: string, apiKey?: string): string {
  if (!apiKey) {
    return url;
  }

  const templated = applyApiKeyTemplate(url, apiKey);
  if (templated !== url) {
    return templated;
  }

  if (url.endsWith("/v2")) {
    return `${url}/${encodeURIComponent(apiKey)}`;
  }
  if (url.endsWith("/v2/")) {
    return `${url}${encodeURIComponent(apiKey)}`;
  }

  return appendQueryParam(url, "api_key", apiKey);
}

function withQuickNodeApiKey(url: string, apiKey?: string): string {
  if (!apiKey) {
    return url;
  }

  return applyApiKeyTemplate(url, apiKey);
}

type ManagedRpcProvider = {
  id: OrganizationRpcProvider;
  url: string;
};

export function resolveDefaultSolanaRpcUrl(env: Env): string | null {
  const providers: ManagedRpcProvider[] = [];

  if (env.SOLANA_RPC_TRITON_URL) {
    providers.push({
      id: "triton",
      url: applyApiKeyTemplate(env.SOLANA_RPC_TRITON_URL, env.SOLANA_RPC_TRITON_API_KEY ?? ""),
    });
  }

  if (env.SOLANA_RPC_HELIUS_URL) {
    providers.push({
      id: "helius",
      url: withHeliusApiKey(env.SOLANA_RPC_HELIUS_URL, env.SOLANA_RPC_HELIUS_API_KEY),
    });
  }

  if (env.SOLANA_RPC_ALCHEMY_URL) {
    providers.push({
      id: "alchemy",
      url: withAlchemyApiKey(env.SOLANA_RPC_ALCHEMY_URL, env.SOLANA_RPC_ALCHEMY_API_KEY),
    });
  }

  if (env.SOLANA_RPC_QUICKNODE_URL) {
    providers.push({
      id: "quicknode",
      url: withQuickNodeApiKey(env.SOLANA_RPC_QUICKNODE_URL, env.SOLANA_RPC_QUICKNODE_API_KEY),
    });
  }

  if (env.SOLANA_RPC_URL) {
    providers.push({
      id: "default",
      url: env.SOLANA_RPC_URL,
    });
  }

  const preferredDefault = env.SOLANA_RPC_DEFAULT_PROVIDER;
  if (preferredDefault) {
    const preferredProvider = providers.find((provider) => provider.id === preferredDefault);
    if (preferredProvider) {
      return preferredProvider.url;
    }
  }

  return providers[0]?.url ?? null;
}

/**
 * Extract Solana configuration from environment
 */
export function getSolanaConfig(env: Env): SolanaConfig {
  const rpcUrl = resolveDefaultSolanaRpcUrl(env);
  const network = env.SOLANA_NETWORK ?? "devnet";

  if (!rpcUrl) {
    throw new Error("No Solana RPC endpoint is configured");
  }

  return { rpcUrl, network };
}

/**
 * Validate and return a Solana address.
 * Throws if the address is invalid.
 */
export function assertValidAddress(value: string, fieldName = "address"): Address {
  try {
    assertIsAddress(value);
    return value;
  } catch {
    throw new Error(`Invalid Solana address for ${fieldName}: ${value}`);
  }
}
