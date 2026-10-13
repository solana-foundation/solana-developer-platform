/**
 * Fee Payment Adapters Registry
 *
 * Factory functions for creating fee payment adapters.
 * Kora is the primary provider for gasless transactions.
 */

import { currentClusterScope } from "@sdp/rpc/scope";
import type { SolanaCluster } from "@sdp/types";
import { KoraAdapter, type KoraAdapterConfig } from "./kora.adapter";
import { NativeAdapter } from "./native.adapter";
import { type FeePaymentEnv, FeePaymentError, type FeePaymentPort } from "./port";

export type {
  ExtendedFeePaymentPort,
  FeePaymentEnv,
  FeePaymentErrorCode,
  FeePaymentPort,
  SponsorshipProviderConfiguration,
} from "./port";
export { FeePaymentError } from "./port";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Supported fee payment provider types */
export type FeePaymentProviderType = "kora" | "native";

// ═══════════════════════════════════════════════════════════════════════════
// Factory Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a fee payment adapter from environment variables.
 * Uses Kora if configured, falls back to native adapter.
 */
export function resolveFeePaymentProvider(env: FeePaymentEnv): FeePaymentProviderType {
  return (env.FEE_PAYMENT_PROVIDER ?? "kora") as FeePaymentProviderType;
}

/** One Kora service: where it is and how the adapter authenticates to it. */
export interface KoraEndpoint {
  rpcUrl: string;
  apiKey?: string;
  identityTokenAudience?: string;
}

/**
 * Each cluster's Kora env trio. A Kora instance binds to one cluster, so each cluster names its
 * own service, key and audience; a trio never borrows another cluster's credentials.
 */
const KORA_ENV_KEYS_BY_CLUSTER = {
  devnet: {
    rpcUrl: "KORA_RPC_URL_DEVNET",
    apiKey: "KORA_API_KEY_DEVNET",
    identityTokenAudience: "KORA_CLOUD_RUN_AUDIENCE_DEVNET",
  },
  "mainnet-beta": {
    rpcUrl: "KORA_RPC_URL_MAINNET",
    apiKey: "KORA_API_KEY_MAINNET",
    identityTokenAudience: "KORA_CLOUD_RUN_AUDIENCE_MAINNET",
  },
} as const satisfies Record<SolanaCluster, Record<keyof KoraEndpoint, keyof FeePaymentEnv>>;

/**
 * The Kora that sponsors on the open cluster scope's cluster, from that cluster's
 * `KORA_*_<CLUSTER>` trio. There is no built-in URL and no cross-cluster reuse: a paymaster is
 * money, and a deployment reaches one only by naming it for the cluster.
 *
 * @param env - Environment carrying the per-cluster Kora trios.
 * @returns The scope cluster's Kora endpoint, or null when its `KORA_RPC_URL_<CLUSTER>` is unset.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export function resolveKoraEndpoint(env: FeePaymentEnv): KoraEndpoint | null {
  const { cluster } = currentClusterScope();
  const envKeys = KORA_ENV_KEYS_BY_CLUSTER[cluster];
  const rpcUrl = env[envKeys.rpcUrl]?.trim();
  if (!rpcUrl) return null;
  return {
    rpcUrl,
    apiKey: env[envKeys.apiKey],
    identityTokenAudience: env[envKeys.identityTokenAudience],
  };
}

/**
 * Whether this process can sponsor a transaction on the open cluster scope's cluster: the native
 * fee payer's one key serves every cluster, and Kora needs the cluster's own endpoint.
 *
 * @param env - Environment carrying the fee-payment provider and Kora trios.
 * @returns True when the configured provider serves the scope's cluster.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export function isFeePaymentConfigured(env: FeePaymentEnv): boolean {
  return resolveFeePaymentProvider(env) === "native" || resolveKoraEndpoint(env) !== null;
}

/**
 * Create the fee-payment adapter for the open cluster scope's cluster. Built per request: the
 * Kora adapter carries the caller's quota identity, and only the RPC client underneath is shared.
 *
 * @param env - Environment carrying the fee-payment provider, Kora trios and native key.
 * @param userId - Server-derived Kora quota identity for the caller.
 * @returns The native adapter, or the Kora adapter for the scope's cluster.
 * @throws FeePaymentError `PROVIDER_NOT_AVAILABLE` when Kora is selected and the scope's cluster
 *   has no Kora configured.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export function createFeePaymentAdapter(env: FeePaymentEnv, userId?: string): FeePaymentPort {
  const provider = resolveFeePaymentProvider(env);

  switch (provider) {
    case "native":
      return new NativeAdapter(env);
    default:
      return createKoraAdapter(env, userId);
  }
}

/**
 * Create the Kora adapter for the open cluster scope's cluster. SDP application callers pass the
 * server-derived identity from their owned sponsorship boundary; a missing identity shares one
 * conservative bucket rather than bypassing Kora usage tracking.
 *
 * @param env - Environment carrying the Kora trios and timeout.
 * @param userId - Server-derived Kora quota identity for the caller.
 * @returns The Kora adapter for the scope's cluster.
 * @throws FeePaymentError `PROVIDER_NOT_AVAILABLE` when the scope's cluster has no Kora configured.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export function createKoraAdapter(env: FeePaymentEnv, userId?: string): KoraAdapter {
  const endpoint = resolveKoraEndpoint(env);
  if (!endpoint) {
    const { cluster } = currentClusterScope();
    throw new FeePaymentError(
      `Kora is not configured for ${cluster}: set ${KORA_ENV_KEYS_BY_CLUSTER[cluster].rpcUrl}`,
      "PROVIDER_NOT_AVAILABLE"
    );
  }

  const config: KoraAdapterConfig = {
    ...endpoint,
    timeoutMs: env.KORA_TIMEOUT_MS ? Number.parseInt(env.KORA_TIMEOUT_MS, 10) : undefined,
    userId,
  };

  return new KoraAdapter(config);
}

/**
 * Create a native fee payment adapter (for testing/fallback).
 */
export function createNativeAdapter(env: FeePaymentEnv): NativeAdapter {
  return new NativeAdapter(env);
}

// ═══════════════════════════════════════════════════════════════════════════
// Re-exports
// ═══════════════════════════════════════════════════════════════════════════

export { KoraClient } from "@solana/kora";
export { KoraAdapter, type KoraAdapterConfig } from "./kora.adapter";
export { NativeAdapter } from "./native.adapter";
