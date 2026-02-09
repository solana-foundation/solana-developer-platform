/**
 * Signing Adapters Registry
 *
 * Factory functions for creating signing adapters based on configuration.
 * Supports 3-tier resolution: project config → org config → env fallback.
 *
 * All signing uses @solana/keychain as the signing module.
 * Provider names refer to the custody backend:
 * - "local": In-memory keypair (KeychainMemoryAdapter) from env or encrypted DB storage
 * - "fireblocks": Fireblocks MPC custody (KeychainFireblocksAdapter)
 * - "privy": Privy hosted wallets (KeychainPrivyAdapter)
 */

import type { SigningPort } from "@/services/ports";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";
import {
  KeychainFireblocksAdapter,
  type KeychainFireblocksConfig,
  KeychainMemoryAdapter,
  KeychainPrivyAdapter,
  type KeychainPrivyConfig,
} from "./keychain";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Supported signing/custody provider types */
export type SigningProviderType = "local" | "fireblocks" | "privy";

/**
 * Database record for signing/custody configuration
 */
export interface SigningConfigRecord {
  id: string;
  organizationId: string;
  projectId: string | null;
  provider: SigningProviderType;
  config: string; // AES-256-GCM encrypted JSON (CUSTODY_ENCRYPTION_KEY); may include encrypted secrets.
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
 *
 * Returns a Promise since KeychainMemoryAdapter initialization is async.
 */
export async function createSigningAdapterFromEnv(env: Env): Promise<SigningPort> {
  const provider = (env.SIGNING_PROVIDER ?? "local") as SigningProviderType;

  switch (provider) {
    case "fireblocks":
      return createFireblocksAdapterFromEnv(env);
    case "privy":
      return createPrivyAdapterFromEnv(env);
    default:
      return createMemoryAdapterFromEnv(env);
  }
}

/**
 * Create a KeychainMemoryAdapter from environment variables.
 */
async function createMemoryAdapterFromEnv(env: Env): Promise<KeychainMemoryAdapter> {
  const privateKey = env.CUSTODY_PRIVATE_KEY;

  if (!privateKey) {
    throw new SigningError(
      "CUSTODY_PRIVATE_KEY environment variable is not configured",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  return KeychainMemoryAdapter.fromBase58(privateKey);
}

/**
 * Create a signing adapter from a database configuration record.
 */
export async function createSigningAdapterFromConfig(
  record: SigningConfigRecord,
  env: Env
): Promise<SigningPort> {
  switch (record.provider) {
    case "fireblocks":
      return createFireblocksAdapterFromRecord(record);
    case "privy":
      return createPrivyAdapterFromRecord(record);
    default:
      return createMemoryAdapterFromEnv(env);
  }
}

/**
 * Create a signing adapter with 3-tier resolution.
 * Checks project config → org config → env fallback.
 */
export async function createSigningAdapter(
  env: Env,
  config?: SigningConfigRecord | null
): Promise<SigningPort> {
  if (config) {
    return createSigningAdapterFromConfig(config, env);
  }
  return createSigningAdapterFromEnv(env);
}

// ═══════════════════════════════════════════════════════════════════════════
// Fireblocks Configuration (via @solana/keychain-fireblocks)
// ═══════════════════════════════════════════════════════════════════════════

interface FireblocksConfigJson {
  provider?: string;
  apiKey?: string;
  apiSecretEncrypted?: string;
  vaultAccountId?: string;
  assetId?: string;
  apiBaseUrl?: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  requestDelayMs?: number;
}

interface PrivyConfigJson {
  provider?: string;
  appId?: string;
  appSecretEncrypted?: string;
  walletId?: string;
  apiBaseUrl?: string;
  requestDelayMs?: number;
}

function createFireblocksAdapterFromEnv(env: Env): KeychainFireblocksAdapter {
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

  return new KeychainFireblocksAdapter({
    apiKey,
    apiSecretPem: apiSecret,
    vaultAccountId: vaultId,
    assetId,
    apiBaseUrl: env.FIREBLOCKS_API_BASE_URL,
  });
}

function createPrivyAdapterFromEnv(env: Env): KeychainPrivyAdapter {
  const appId = env.PRIVY_APP_ID;
  const appSecret = env.PRIVY_APP_SECRET;
  const walletId = env.PRIVY_WALLET_ID;
  const requestDelayMs = parseOptionalRequestDelayMs(env.PRIVY_REQUEST_DELAY_MS);

  if (!appId || !appSecret || !walletId) {
    throw new SigningError(
      "Privy environment variables not configured: PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_WALLET_ID",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  return new KeychainPrivyAdapter({
    appId,
    appSecret,
    walletId,
    apiBaseUrl: env.PRIVY_API_BASE_URL,
    requestDelayMs,
  });
}

function createFireblocksAdapterFromRecord(record: SigningConfigRecord): KeychainFireblocksAdapter {
  let parsed: FireblocksConfigJson;
  try {
    parsed = JSON.parse(record.config) as FireblocksConfigJson;
  } catch {
    throw new SigningError("Invalid Fireblocks configuration JSON", "PROVIDER_NOT_CONFIGURED");
  }

  if (parsed.provider && parsed.provider !== "fireblocks") {
    throw new SigningError("Custody configuration provider mismatch", "PROVIDER_NOT_CONFIGURED");
  }

  if (!parsed.apiKey || !parsed.apiSecretEncrypted || !parsed.vaultAccountId) {
    throw new SigningError(
      "Fireblocks config missing apiKey, apiSecretEncrypted, or vaultAccountId",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const config: KeychainFireblocksConfig = {
    apiKey: parsed.apiKey,
    apiSecretPem: parsed.apiSecretEncrypted,
    vaultAccountId: parsed.vaultAccountId,
    assetId: parsed.assetId ?? "SOL",
    apiBaseUrl: parsed.apiBaseUrl,
    pollIntervalMs: parsed.pollIntervalMs,
    maxPollAttempts: parsed.maxPollAttempts,
    requestDelayMs: parsed.requestDelayMs,
  };

  return new KeychainFireblocksAdapter(config);
}

function createPrivyAdapterFromRecord(record: SigningConfigRecord): KeychainPrivyAdapter {
  let parsed: PrivyConfigJson;
  try {
    parsed = JSON.parse(record.config) as PrivyConfigJson;
  } catch {
    throw new SigningError("Invalid Privy configuration JSON", "PROVIDER_NOT_CONFIGURED");
  }

  if (parsed.provider && parsed.provider !== "privy") {
    throw new SigningError("Custody configuration provider mismatch", "PROVIDER_NOT_CONFIGURED");
  }

  if (!parsed.appId || !parsed.appSecretEncrypted || !parsed.walletId) {
    throw new SigningError(
      "Privy config missing appId, appSecretEncrypted, or walletId",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const config: KeychainPrivyConfig = {
    appId: parsed.appId,
    appSecret: parsed.appSecretEncrypted,
    walletId: parsed.walletId,
    apiBaseUrl: parsed.apiBaseUrl,
    requestDelayMs: parsed.requestDelayMs,
  };

  return new KeychainPrivyAdapter(config);
}

function parseOptionalRequestDelayMs(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new SigningError(
      "PRIVY_REQUEST_DELAY_MS must be a non-negative number",
      "INVALID_REQUEST"
    );
  }
  return parsed;
}

// ═══════════════════════════════════════════════════════════════════════════
// Re-exports
// ═══════════════════════════════════════════════════════════════════════════

export {
  BaseKeychainAdapter,
  KeychainFireblocksAdapter,
  KeychainMemoryAdapter,
  KeychainPrivyAdapter,
  type KeychainFireblocksConfig,
  type KeychainPrivyConfig,
} from "./keychain";
