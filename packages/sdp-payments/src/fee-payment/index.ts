/**
 * Fee Payment Adapters Registry
 *
 * Factory functions for creating fee payment adapters.
 * Kora is the primary provider for gasless transactions.
 */

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
// Default URLs
// ═══════════════════════════════════════════════════════════════════════════

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

export function createFeePaymentAdapter(env: FeePaymentEnv, userId?: string): FeePaymentPort {
  const provider = resolveFeePaymentProvider(env);

  switch (provider) {
    case "kora":
      return createKoraAdapter(env, userId);
    case "native":
      return new NativeAdapter(env);
    default:
      return createKoraAdapter(env, userId);
  }
}

/**
 * Create a Kora adapter from environment configuration.
 * SDP application callers must pass the server-derived identity from their
 * owned sponsorship boundary. Missing identities share one conservative
 * fallback bucket rather than bypassing Kora usage tracking.
 */
export function createKoraAdapter(env: FeePaymentEnv, userId?: string): KoraAdapter {
  const rpcUrl = env.KORA_RPC_URL;

  if (!rpcUrl) {
    throw new FeePaymentError(
      "Kora fee sponsorship is not configured for this cluster: set KORA_RPC_URL",
      "PROVIDER_NOT_AVAILABLE"
    );
  }

  const config: KoraAdapterConfig = {
    rpcUrl,
    apiKey: env.KORA_API_KEY,
    identityTokenAudience: env.KORA_CLOUD_RUN_AUDIENCE,
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
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// Re-exports
// ═══════════════════════════════════════════════════════════════════════════

export { KoraClient } from "@solana/kora";
export { KoraAdapter, type KoraAdapterConfig } from "./kora.adapter";
export { NativeAdapter } from "./native.adapter";
