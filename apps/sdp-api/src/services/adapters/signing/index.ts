/**
 * Signing Adapters Registry
 *
 * Factory functions for creating signing adapters based on configuration.
 * Supports 3-tier resolution: project config → org config → env fallback.
 */

import type { SigningPort } from "@/services/ports";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";
import { FireblocksAdapter, type FireblocksAdapterConfig } from "./fireblocks";
import { LocalKeypairAdapter } from "./local";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Supported signing provider types */
export type SigningProviderType = "local" | "fireblocks";

/**
 * Database record for signing/custody configuration
 * (mirrors CustodyConfigRecord from old structure)
 */
export interface SigningConfigRecord {
  id: string;
  organizationId: string;
  projectId: string | null;
  provider: SigningProviderType;
  config: string; // Encrypted JSON
  defaultWalletId: string | null;
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Factory Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a signing adapter from environment variables.
 * Used as fallback when no database configuration exists.
 */
export function createSigningAdapterFromEnv(env: Env): SigningPort {
  const provider = (env.SIGNING_PROVIDER ?? "local") as SigningProviderType;

  switch (provider) {
    case "fireblocks":
      return createFireblocksAdapterFromEnv(env);
    default:
      return new LocalKeypairAdapter(env);
  }
}

/**
 * Create a signing adapter from a database configuration record.
 */
export function createSigningAdapterFromConfig(record: SigningConfigRecord, env: Env): SigningPort {
  switch (record.provider) {
    case "fireblocks":
      return createFireblocksAdapterFromRecord(record);
    default:
      return new LocalKeypairAdapter(env);
  }
}

/**
 * Create a signing adapter with 3-tier resolution.
 * Checks project config → org config → env fallback.
 */
export function createSigningAdapter(env: Env, config?: SigningConfigRecord | null): SigningPort {
  if (config) {
    return createSigningAdapterFromConfig(config, env);
  }

  return createSigningAdapterFromEnv(env);
}

// ═══════════════════════════════════════════════════════════════════════════
// Fireblocks Configuration Parsing
// ═══════════════════════════════════════════════════════════════════════════

interface FireblocksConfigJson {
  provider?: string;
  apiKey?: string;
  apiSecretEncrypted?: string;
  vaultAccountId?: string;
  assetId?: string;
  apiBaseUrl?: string;
  defaultWalletId?: string;
}

function createFireblocksAdapterFromEnv(env: Env): FireblocksAdapter {
  const apiKey = env.FIREBLOCKS_API_KEY;
  const apiSecret = env.FIREBLOCKS_API_SECRET;
  const vaultId = env.FIREBLOCKS_VAULT_ID;
  const assetId = env.FIREBLOCKS_ASSET_ID ?? "SOL";

  if (!apiKey || !apiSecret || !vaultId) {
    throw new SigningError(
      "Fireblocks environment variables not configured: FIREBLOCKS_API_KEY, FIREBLOCKS_API_SECRET, FIREBLOCKS_VAULT_ID",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  return new FireblocksAdapter({
    apiKey,
    apiSecretPem: apiSecret,
    vaultAccountId: vaultId,
    assetId,
    apiBaseUrl: env.FIREBLOCKS_API_BASE_URL,
  });
}

function createFireblocksAdapterFromRecord(record: SigningConfigRecord): FireblocksAdapter {
  let parsed: FireblocksConfigJson;
  try {
    parsed = JSON.parse(record.config) as FireblocksConfigJson;
  } catch {
    throw new SigningError(
      "Invalid Fireblocks custody configuration JSON",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  if (parsed.provider && parsed.provider !== "fireblocks") {
    throw new SigningError("Custody configuration provider mismatch", "PROVIDER_NOT_CONFIGURED");
  }

  if (!parsed.apiKey || !parsed.apiSecretEncrypted || !parsed.vaultAccountId || !parsed.assetId) {
    throw new SigningError(
      "Fireblocks config missing apiKey, apiSecretEncrypted, vaultAccountId, or assetId",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const config: FireblocksAdapterConfig = {
    apiKey: parsed.apiKey,
    apiSecretPem: parsed.apiSecretEncrypted,
    vaultAccountId: parsed.vaultAccountId,
    assetId: parsed.assetId,
    apiBaseUrl: parsed.apiBaseUrl,
    defaultWalletId: record.defaultWalletId ?? parsed.defaultWalletId,
  };

  return new FireblocksAdapter(config);
}

// ═══════════════════════════════════════════════════════════════════════════
// Re-exports
// ═══════════════════════════════════════════════════════════════════════════

export { FireblocksAdapter } from "./fireblocks";
export { LocalKeypairAdapter } from "./local";
