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

/**
 * Default Kora RPC URLs by network.
 * These may need to be updated based on Solana Foundation's deployment.
 */
const DEFAULT_KORA_URLS: Record<string, string> = {
  devnet: "https://kora-devnet.solana.com",
  "mainnet-beta": "https://kora.solana.com",
};

// ═══════════════════════════════════════════════════════════════════════════
// Factory Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a fee payment adapter from environment variables.
 * Uses Kora if configured, falls back to native adapter.
 */
export function createFeePaymentAdapter(env: FeePaymentEnv, userId?: string): FeePaymentPort {
  const provider = (env.FEE_PAYMENT_PROVIDER ?? "kora") as FeePaymentProviderType;

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
 * Pass `userId` (via `resolveKoraUserId(c)`) to forward it to Kora as `user_id`.
 */
export function createKoraAdapter(env: FeePaymentEnv, userId?: string): KoraAdapter {
  // Get RPC URL from env or use default based on network
  const rpcUrl = env.KORA_RPC_URL ?? getDefaultKoraUrl(env);

  if (!rpcUrl) {
    throw new FeePaymentError(
      "KORA_RPC_URL not configured and no default URL for network",
      "PROVIDER_NOT_AVAILABLE"
    );
  }

  const config: KoraAdapterConfig = {
    rpcUrl,
    apiKey: env.KORA_API_KEY,
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

function getDefaultKoraUrl(env: FeePaymentEnv): string | undefined {
  const network = env.SOLANA_NETWORK ?? "devnet";
  return DEFAULT_KORA_URLS[network];
}

// ═══════════════════════════════════════════════════════════════════════════
// Re-exports
// ═══════════════════════════════════════════════════════════════════════════

export { KoraClient } from "@solana/kora";
export { KoraAdapter, type KoraAdapterConfig } from "./kora.adapter";
export { NativeAdapter } from "./native.adapter";
