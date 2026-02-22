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
 * - "coinbase_cdp": Coinbase CDP hosted wallets (KeychainCoinbaseAdapter)
 */

import type { SigningPort } from "@/services/ports";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";
import {
  KeychainCoinbaseAdapter,
  type KeychainCoinbaseConfig,
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
export type SigningProviderType = "local" | "fireblocks" | "privy" | "coinbase_cdp";

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
    case "coinbase_cdp":
      return createCoinbaseAdapterFromEnv(env);
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
      return createPrivyAdapterFromRecord(record, env);
    case "coinbase_cdp":
      return createCoinbaseAdapterFromRecord(record, env);
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
  privyAppId?: string;
}

interface CoinbaseConfigJson {
  provider?: string;
  apiBaseUrl?: string;
  requestDelayMs?: number;
  walletId?: string;
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
    apiBaseUrl: env.PRIVY_API_BASE_URL,
    requestDelayMs,
    defaultWalletId: walletId,
  });
}

function createCoinbaseAdapterFromEnv(env: Env): KeychainCoinbaseAdapter {
  const apiKeyId = env.COINBASE_CDP_API_KEY_ID;
  const apiKeySecret = env.COINBASE_CDP_API_KEY_SECRET;
  const walletSecret = env.COINBASE_CDP_WALLET_SECRET;
  const walletId = env.COINBASE_CDP_WALLET_ID;

  if (!apiKeyId || !apiKeySecret || !walletSecret || !walletId) {
    throw new SigningError(
      "Coinbase CDP environment variables not configured: COINBASE_CDP_API_KEY_ID, COINBASE_CDP_API_KEY_SECRET, COINBASE_CDP_WALLET_SECRET, COINBASE_CDP_WALLET_ID",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  return new KeychainCoinbaseAdapter({
    apiKeyId,
    apiKeySecret,
    walletSecret,
    apiBaseUrl: env.COINBASE_CDP_API_BASE_URL,
    defaultWalletId: walletId,
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

function createPrivyAdapterFromRecord(record: SigningConfigRecord, env: Env): KeychainPrivyAdapter {
  let parsed: PrivyConfigJson;
  try {
    parsed = JSON.parse(record.config) as PrivyConfigJson;
  } catch {
    throw new SigningError("Invalid Privy configuration JSON", "PROVIDER_NOT_CONFIGURED");
  }

  if (parsed.provider && parsed.provider !== "privy") {
    throw new SigningError("Custody configuration provider mismatch", "PROVIDER_NOT_CONFIGURED");
  }

  const appId = parsed.appId ?? parsed.privyAppId ?? env.PRIVY_APP_ID;
  const appSecret = parsed.appSecretEncrypted ?? env.PRIVY_APP_SECRET;
  const defaultWalletId = parsed.walletId ?? record.defaultWalletId ?? env.PRIVY_WALLET_ID;

  if (!appId || !appSecret || !defaultWalletId) {
    throw new SigningError(
      "Privy config missing appId/appSecret/walletId and env is not configured",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const config: KeychainPrivyConfig = {
    appId,
    appSecret,
    apiBaseUrl: parsed.apiBaseUrl,
    requestDelayMs: parsed.requestDelayMs,
    defaultWalletId,
  };

  return new KeychainPrivyAdapter(config);
}

function createCoinbaseAdapterFromRecord(
  record: SigningConfigRecord,
  env: Env
): KeychainCoinbaseAdapter {
  let parsed: CoinbaseConfigJson;
  try {
    parsed = JSON.parse(record.config) as CoinbaseConfigJson;
  } catch {
    throw new SigningError("Invalid Coinbase CDP configuration JSON", "PROVIDER_NOT_CONFIGURED");
  }

  if (parsed.provider && parsed.provider !== "coinbase_cdp") {
    throw new SigningError("Custody configuration provider mismatch", "PROVIDER_NOT_CONFIGURED");
  }

  const apiKeyId = env.COINBASE_CDP_API_KEY_ID;
  const apiKeySecret = env.COINBASE_CDP_API_KEY_SECRET;
  const walletSecret = env.COINBASE_CDP_WALLET_SECRET;
  const defaultWalletId = record.defaultWalletId ?? parsed.walletId ?? env.COINBASE_CDP_WALLET_ID;

  if (!apiKeyId || !apiKeySecret || !walletSecret || !defaultWalletId) {
    throw new SigningError(
      "Coinbase CDP config missing API credentials/default wallet and env is not configured",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const config: KeychainCoinbaseConfig = {
    apiKeyId,
    apiKeySecret,
    walletSecret,
    apiBaseUrl: parsed.apiBaseUrl ?? env.COINBASE_CDP_API_BASE_URL,
    requestDelayMs: parsed.requestDelayMs,
    defaultWalletId,
  };

  return new KeychainCoinbaseAdapter(config);
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
  KeychainCoinbaseAdapter,
  KeychainFireblocksAdapter,
  KeychainMemoryAdapter,
  KeychainPrivyAdapter,
  type KeychainCoinbaseConfig,
  type KeychainFireblocksConfig,
  type KeychainPrivyConfig,
} from "./keychain";
