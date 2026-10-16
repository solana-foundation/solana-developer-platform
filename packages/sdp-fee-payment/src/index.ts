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

/** The process default cluster (`SOLANA_NETWORK`): the one the native fee payer serves. */
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
 * transaction's cluster, never by the process default: `KORA_DEVNET_*` or
 * `KORA_MAINNET_*`, nothing else. A cluster without its URL answers null so
 * callers fail closed to wallet-pays rather than signing through the wrong
 * paymaster. There is NO built-in default URL: a paymaster is money, and a
 * deployment reaches one only by naming it.
 */
export function resolveKoraEndpoint(
  env: FeePaymentEnv,
  cluster: SolanaCluster
): KoraEndpoint | null {
  const endpoint =
    cluster === "mainnet-beta"
      ? {
          rpcUrl: env.KORA_MAINNET_URL?.trim(),
          apiKey: env.KORA_MAINNET_API_KEY,
          identityTokenAudience: env.KORA_MAINNET_CLOUD_RUN_AUDIENCE,
        }
      : {
          rpcUrl: env.KORA_DEVNET_URL?.trim(),
          apiKey: env.KORA_DEVNET_API_KEY,
          identityTokenAudience: env.KORA_DEVNET_CLOUD_RUN_AUDIENCE,
        };
  if (!endpoint.rpcUrl) return null;
  return {
    rpcUrl: endpoint.rpcUrl,
    apiKey: endpoint.apiKey,
    identityTokenAudience: endpoint.identityTokenAudience,
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
  userId: string,
  cluster: SolanaCluster
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
 * owned sponsorship boundary.
 */
export function createKoraAdapter(
  env: FeePaymentEnv,
  userId: string,
  cluster: SolanaCluster
): KoraAdapter {
  const endpoint = resolveKoraEndpoint(env, cluster);
  if (!endpoint) {
    throw new FeePaymentError(
      `Kora is not configured for ${cluster}: set KORA_${cluster === "mainnet-beta" ? "MAINNET" : "DEVNET"}_URL`,
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

// ═══════════════════════════════════════════════════════════════════════════
// Re-exports
// ═══════════════════════════════════════════════════════════════════════════

export { KoraClient } from "@solana/kora";
export { KoraAdapter, type KoraAdapterConfig } from "./kora.adapter";
export { NativeAdapter } from "./native.adapter";
