/**
 * Fee Payment Adapters Registry
 *
 * Factory functions for creating fee payment adapters.
 * Kora is the primary provider for gasless transactions.
 */

import { resolveDefaultCluster } from "@sdp/rpc";
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

/** The cluster the unsuffixed trio (`KORA_RPC_URL` and friends) serves: the process default. */
export function defaultFeePaymentCluster(env: FeePaymentEnv): SolanaCluster {
  return resolveDefaultCluster(env);
}

/** One Kora service: where it is and how the adapter authenticates to it. */
export interface KoraEndpoint {
  rpcUrl: string;
  apiKey?: string;
  identityTokenAudience?: string;
}

/**
 * The Kora that sponsors on `cluster`, or null when none is configured for it.
 *
 * One API process serves both clusters (a sandbox project is devnet, a
 * production project is mainnet-beta) and each cluster has its OWN Kora with
 * its own signer, policy and credentials, so the endpoint is selected by the
 * transaction's cluster, never by the process default. `KORA_*_<CLUSTER>` is
 * explicit and wins; the unsuffixed trio (`KORA_RPC_URL` and friends) serves
 * only the cluster `SOLANA_NETWORK` names. A cluster with neither answers null
 * so callers fail closed to wallet-pays rather than signing through the wrong
 * paymaster. There is NO built-in default URL: a paymaster is money, and a
 * deployment reaches one only by naming it. A per-cluster trio never borrows
 * the default trio's key or audience: a devnet key presented to the mainnet
 * service is a misconfiguration to surface, not paper over.
 *
 * Flipping `SOLANA_NETWORK` re-points the bare trio at the new cluster: a
 * `KORA_RPC_URL` that named the devnet Kora becomes the mainnet paymaster.
 * Rewire it in the same change (prod: HOO-717).
 */
export function resolveKoraEndpoint(
  env: FeePaymentEnv,
  cluster: SolanaCluster = defaultFeePaymentCluster(env)
): KoraEndpoint | null {
  const perCluster =
    cluster === "mainnet-beta"
      ? {
          rpcUrl: env.KORA_RPC_URL_MAINNET,
          apiKey: env.KORA_API_KEY_MAINNET,
          identityTokenAudience: env.KORA_CLOUD_RUN_AUDIENCE_MAINNET,
        }
      : {
          rpcUrl: env.KORA_RPC_URL_DEVNET,
          apiKey: env.KORA_API_KEY_DEVNET,
          identityTokenAudience: env.KORA_CLOUD_RUN_AUDIENCE_DEVNET,
        };
  const explicit = perCluster.rpcUrl?.trim();
  if (explicit) {
    return {
      rpcUrl: explicit,
      apiKey: perCluster.apiKey,
      identityTokenAudience: perCluster.identityTokenAudience,
    };
  }

  if (cluster !== defaultFeePaymentCluster(env)) return null;
  const rpcUrl = env.KORA_RPC_URL?.trim();
  if (!rpcUrl) return null;
  return {
    rpcUrl,
    apiKey: env.KORA_API_KEY,
    identityTokenAudience: env.KORA_CLOUD_RUN_AUDIENCE,
  };
}

/**
 * Whether this process can sponsor a transaction on `cluster` at all: Kora has
 * an endpoint for it, or the native fee payer serves it (the native adapter
 * signs on the process default cluster only). Feature gates read this so an
 * unconfigured cluster answers wallet-pays instead of a provider error.
 */
export function isFeePaymentConfiguredForCluster(
  env: FeePaymentEnv,
  cluster: SolanaCluster
): boolean {
  return resolveFeePaymentProvider(env) === "native"
    ? cluster === defaultFeePaymentCluster(env)
    : resolveKoraEndpoint(env, cluster) !== null;
}

export function createFeePaymentAdapter(
  env: FeePaymentEnv,
  userId?: string,
  cluster: SolanaCluster = defaultFeePaymentCluster(env)
): FeePaymentPort {
  const provider = resolveFeePaymentProvider(env);

  switch (provider) {
    case "native":
      if (cluster !== defaultFeePaymentCluster(env)) {
        throw new FeePaymentError(
          `The native fee payer serves ${defaultFeePaymentCluster(env)} only, not ${cluster}`,
          "PROVIDER_NOT_AVAILABLE"
        );
      }
      return new NativeAdapter(env);
    default:
      return createKoraAdapter(env, userId, cluster);
  }
}

/**
 * Create a Kora adapter for `cluster` from environment configuration.
 * SDP application callers must pass the server-derived identity from their
 * owned sponsorship boundary. Missing identities share one conservative
 * fallback bucket rather than bypassing Kora usage tracking.
 */
export function createKoraAdapter(
  env: FeePaymentEnv,
  userId?: string,
  cluster: SolanaCluster = defaultFeePaymentCluster(env)
): KoraAdapter {
  const endpoint = resolveKoraEndpoint(env, cluster);
  if (!endpoint) {
    throw new FeePaymentError(
      `Kora is not configured for ${cluster}: set KORA_RPC_URL for the process network or a KORA_RPC_URL_<CLUSTER> override`,
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
