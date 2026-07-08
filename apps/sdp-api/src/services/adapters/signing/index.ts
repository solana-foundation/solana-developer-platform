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
 * - "para": Para hosted wallets (KeychainParaAdapter)
 * - "turnkey": Turnkey hosted wallets (KeychainTurnkeyAdapter)
 * - "dfns": DFNS hosted wallets (KeychainDfnsAdapter)
 * - "ibm_haven": IBM Digital Asset Haven hosted wallets (KeychainIbmHavenAdapter)
 * - "utila": Utila vault wallets (KeychainUtilaAdapter)
 */

import { parsePostgresJson } from "@/db/postgres-utils";
import type { CustodyProvider } from "@/services/custody/providers";
import { normalizePem } from "@/services/custody/provisioning.common";
import {
  createDfnsApiClient,
  createIbmHavenApiClient,
  normalizeDfnsWalletId,
} from "@/services/dfns/client";
import { denormalizeIbmHavenWalletId } from "@/services/domain/signing/provider-wallet-ids";
import type { SigningPort } from "@/services/ports";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";
import {
  KeychainCoinbaseAdapter,
  type KeychainCoinbaseConfig,
  KeychainDfnsAdapter,
  type KeychainDfnsConfig,
  KeychainFireblocksAdapter,
  type KeychainFireblocksConfig,
  KeychainIbmHavenAdapter,
  KeychainMemoryAdapter,
  KeychainParaAdapter,
  type KeychainParaConfig,
  KeychainPrivyAdapter,
  type KeychainPrivyConfig,
  KeychainTurnkeyAdapter,
  type KeychainTurnkeyConfig,
  KeychainUtilaAdapter,
} from "./keychain";
import { buildKeychainUtilaConfig } from "./keychain/utila-config";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Supported signing/custody provider types */
export type SigningProviderType = CustodyProvider;

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

function parseSigningConfigJson<T>(record: SigningConfigRecord, providerName: string): T {
  try {
    return parsePostgresJson<T>(record.config);
  } catch {
    throw new SigningError(`Invalid ${providerName} configuration JSON`, "PROVIDER_NOT_CONFIGURED");
  }
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
  const provider = env.SIGNING_PROVIDER ?? "local";

  switch (provider) {
    case "fireblocks":
      return createFireblocksAdapterFromEnv(env);
    case "privy":
      return createPrivyAdapterFromEnv(env);
    case "coinbase_cdp":
      return createCoinbaseAdapterFromEnv(env);
    case "para":
      return createParaAdapterFromEnv(env);
    case "turnkey":
      return createTurnkeyAdapterFromEnv(env);
    case "dfns":
      return createDfnsAdapterFromEnv(env);
    case "ibm_haven":
      return createIbmHavenAdapterFromEnv(env);
    case "utila":
      return createUtilaAdapterFromEnv(env);
    case "local":
      return createMemoryAdapterFromEnv(env);
    case "anchorage":
      throw new SigningError(
        "Anchorage does not support transaction signing in SDP",
        "PROVIDER_NOT_CONFIGURED"
      );
    default:
      throw new SigningError(
        `Unsupported signing provider: ${provider}`,
        "PROVIDER_NOT_CONFIGURED"
      );
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
    case "para":
      return createParaAdapterFromRecord(record, env);
    case "turnkey":
      return createTurnkeyAdapterFromRecord(record, env);
    case "dfns":
      return createDfnsAdapterFromRecord(record, env);
    case "ibm_haven":
      return createIbmHavenAdapterFromRecord(record, env);
    case "utila":
      return createUtilaAdapterFromRecord(record, env);
    case "local":
      return createMemoryAdapterFromEnv(env);
    case "anchorage":
      throw new SigningError(
        "Anchorage does not support transaction signing in SDP",
        "PROVIDER_NOT_CONFIGURED"
      );
    default:
      throw new SigningError(
        `Unsupported signing provider in custody config: ${record.provider}`,
        "PROVIDER_NOT_CONFIGURED"
      );
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

interface TurnkeyConfigJson {
  provider?: string;
  organizationId?: string;
  apiBaseUrl?: string;
  requestDelayMs?: number;
  privateKeyId?: string;
  publicKey?: string;
  defaultWalletPublicKey?: string;
}

interface ParaConfigJson {
  provider?: string;
  apiBaseUrl?: string;
  requestDelayMs?: number;
  walletId?: string;
}

interface DfnsConfigJson {
  provider?: string;
  apiBaseUrl?: string;
  walletId?: string;
}

interface IbmHavenConfigJson {
  provider?: string;
  apiBaseUrl?: string;
  walletId?: string;
}

interface UtilaConfigJson {
  provider?: string;
  apiBaseUrl?: string;
  vaultId?: string;
  network?: "networks/solana-mainnet" | "networks/solana-devnet";
}

function createFireblocksAdapterFromEnv(env: Env): KeychainFireblocksAdapter {
  const apiKey = env.FIREBLOCKS_API_KEY;
  const apiSecret = env.FIREBLOCKS_API_SECRET ? normalizePem(env.FIREBLOCKS_API_SECRET) : undefined;
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
  const requestDelayMs = parseOptionalRequestDelayMs(env.PRIVY_REQUEST_DELAY_MS, {
    envVarName: "PRIVY_REQUEST_DELAY_MS",
  });

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

function createTurnkeyAdapterFromEnv(env: Env): KeychainTurnkeyAdapter {
  const apiPublicKey = env.TURNKEY_API_PUBLIC_KEY;
  const apiPrivateKey = env.TURNKEY_API_PRIVATE_KEY;
  const organizationId = env.TURNKEY_ORGANIZATION_ID;
  const walletId = env.TURNKEY_PRIVATE_KEY_ID;
  const publicKey = env.TURNKEY_PUBLIC_KEY;
  const requestDelayMs = parseOptionalRequestDelayMs(env.TURNKEY_REQUEST_DELAY_MS, {
    envVarName: "TURNKEY_REQUEST_DELAY_MS",
  });

  if (!apiPublicKey || !apiPrivateKey || !organizationId || !walletId || !publicKey) {
    throw new SigningError(
      "Turnkey environment variables not configured: TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, TURNKEY_ORGANIZATION_ID, TURNKEY_PRIVATE_KEY_ID, TURNKEY_PUBLIC_KEY",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  return new KeychainTurnkeyAdapter({
    apiPublicKey,
    apiPrivateKey,
    organizationId,
    apiBaseUrl: env.TURNKEY_API_BASE_URL,
    requestDelayMs,
    defaultWalletId: normalizeTurnkeyWalletId(walletId),
    defaultWalletPublicKey: publicKey,
  });
}

function createParaAdapterFromEnv(env: Env): KeychainParaAdapter {
  const apiKey = env.PARA_API_KEY;
  const walletId = env.PARA_WALLET_ID;
  const requestDelayMs = parseOptionalRequestDelayMs(env.PARA_REQUEST_DELAY_MS, {
    envVarName: "PARA_REQUEST_DELAY_MS",
  });

  if (!apiKey || !walletId) {
    throw new SigningError(
      "Para environment variables not configured: PARA_API_KEY, PARA_WALLET_ID",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  return new KeychainParaAdapter({
    apiKey,
    apiBaseUrl: env.PARA_API_BASE_URL,
    requestDelayMs,
    defaultWalletId: normalizeParaWalletId(walletId),
  });
}

async function createDfnsAdapterFromEnv(env: Env): Promise<KeychainDfnsAdapter> {
  const walletId = env.DFNS_WALLET_ID;
  if (!walletId) {
    throw new SigningError(
      "DFNS environment variables not configured: DFNS_WALLET_ID",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const config: KeychainDfnsConfig = {
    client: await createDfnsApiClient(env),
    defaultWalletId: normalizeDfnsWalletId(walletId),
  };

  return new KeychainDfnsAdapter(config);
}

function createUtilaAdapterFromEnv(env: Env): KeychainUtilaAdapter {
  return new KeychainUtilaAdapter(
    buildKeychainUtilaConfig(env, {
      defaultWalletIdFromEnv: true,
      missingMessage:
        "Utila environment variables not configured: UTILA_SERVICE_ACCOUNT_EMAIL, UTILA_SERVICE_ACCOUNT_PRIVATE_KEY, UTILA_VAULT_ID",
    })
  );
}

function createFireblocksAdapterFromRecord(record: SigningConfigRecord): KeychainFireblocksAdapter {
  const parsed = parseSigningConfigJson<FireblocksConfigJson>(record, "Fireblocks");

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
  const parsed = parseSigningConfigJson<PrivyConfigJson>(record, "Privy");

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
  const parsed = parseSigningConfigJson<CoinbaseConfigJson>(record, "Coinbase CDP");

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

function createTurnkeyAdapterFromRecord(
  record: SigningConfigRecord,
  env: Env
): KeychainTurnkeyAdapter {
  const parsed = parseSigningConfigJson<TurnkeyConfigJson>(record, "Turnkey");

  if (parsed.provider && parsed.provider !== "turnkey") {
    throw new SigningError("Custody configuration provider mismatch", "PROVIDER_NOT_CONFIGURED");
  }

  const apiPublicKey = env.TURNKEY_API_PUBLIC_KEY;
  const apiPrivateKey = env.TURNKEY_API_PRIVATE_KEY;
  const organizationId = parsed.organizationId ?? env.TURNKEY_ORGANIZATION_ID;
  const requestDelayMs =
    parsed.requestDelayMs ??
    parseOptionalRequestDelayMs(env.TURNKEY_REQUEST_DELAY_MS, {
      envVarName: "TURNKEY_REQUEST_DELAY_MS",
    });

  const defaultWalletId =
    record.defaultWalletId ??
    (parsed.privateKeyId ? normalizeTurnkeyWalletId(parsed.privateKeyId) : undefined) ??
    (env.TURNKEY_PRIVATE_KEY_ID ? normalizeTurnkeyWalletId(env.TURNKEY_PRIVATE_KEY_ID) : undefined);
  const defaultWalletPublicKey =
    parsed.defaultWalletPublicKey ?? parsed.publicKey ?? env.TURNKEY_PUBLIC_KEY;

  if (
    !apiPublicKey ||
    !apiPrivateKey ||
    !organizationId ||
    !defaultWalletId ||
    !defaultWalletPublicKey
  ) {
    throw new SigningError(
      "Turnkey config missing API credentials/default wallet and env is not configured",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const config: KeychainTurnkeyConfig = {
    apiPublicKey,
    apiPrivateKey,
    organizationId,
    apiBaseUrl: parsed.apiBaseUrl ?? env.TURNKEY_API_BASE_URL,
    requestDelayMs,
    defaultWalletId,
    defaultWalletPublicKey,
  };

  return new KeychainTurnkeyAdapter(config);
}

function createParaAdapterFromRecord(record: SigningConfigRecord, env: Env): KeychainParaAdapter {
  const parsed = parseSigningConfigJson<ParaConfigJson>(record, "Para");

  if (parsed.provider && parsed.provider !== "para") {
    throw new SigningError("Custody configuration provider mismatch", "PROVIDER_NOT_CONFIGURED");
  }

  const apiKey = env.PARA_API_KEY;
  const requestDelayMs =
    parsed.requestDelayMs ??
    parseOptionalRequestDelayMs(env.PARA_REQUEST_DELAY_MS, {
      envVarName: "PARA_REQUEST_DELAY_MS",
    });
  const defaultWalletId =
    record.defaultWalletId ??
    (parsed.walletId ? normalizeParaWalletId(parsed.walletId) : undefined) ??
    (env.PARA_WALLET_ID ? normalizeParaWalletId(env.PARA_WALLET_ID) : undefined);

  if (!apiKey || !defaultWalletId) {
    throw new SigningError(
      "Para config missing API key/default wallet and env is not configured",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const config: KeychainParaConfig = {
    apiKey,
    apiBaseUrl: parsed.apiBaseUrl ?? env.PARA_API_BASE_URL,
    requestDelayMs,
    defaultWalletId,
  };

  return new KeychainParaAdapter(config);
}

async function createDfnsAdapterFromRecord(
  record: SigningConfigRecord,
  env: Env
): Promise<KeychainDfnsAdapter> {
  const parsed = parseSigningConfigJson<DfnsConfigJson>(record, "DFNS");

  if (parsed.provider && parsed.provider !== "dfns") {
    throw new SigningError("Custody configuration provider mismatch", "PROVIDER_NOT_CONFIGURED");
  }

  const defaultWalletId =
    record.defaultWalletId ??
    (parsed.walletId ? normalizeDfnsWalletId(parsed.walletId) : undefined) ??
    (env.DFNS_WALLET_ID ? normalizeDfnsWalletId(env.DFNS_WALLET_ID) : undefined);

  if (!defaultWalletId) {
    throw new SigningError(
      "DFNS config missing default wallet and env is not configured",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const config: KeychainDfnsConfig = {
    client: await createDfnsApiClient(env, { apiBaseUrl: parsed.apiBaseUrl }),
    defaultWalletId,
  };

  return new KeychainDfnsAdapter(config);
}

async function createIbmHavenAdapterFromEnv(env: Env): Promise<KeychainIbmHavenAdapter> {
  const walletId = env.IBM_HAVEN_WALLET_ID;
  if (!walletId) {
    throw new SigningError(
      "IBM Digital Asset Haven environment variables not configured: IBM_HAVEN_WALLET_ID",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const config: KeychainDfnsConfig = {
    client: await createIbmHavenApiClient(env),
    defaultWalletId: denormalizeIbmHavenWalletId(walletId),
  };

  return new KeychainIbmHavenAdapter(config);
}

async function createIbmHavenAdapterFromRecord(
  record: SigningConfigRecord,
  env: Env
): Promise<KeychainIbmHavenAdapter> {
  const parsed = parseSigningConfigJson<IbmHavenConfigJson>(record, "IBM Digital Asset Haven");

  if (parsed.provider && parsed.provider !== "ibm_haven") {
    throw new SigningError("Custody configuration provider mismatch", "PROVIDER_NOT_CONFIGURED");
  }

  const defaultWalletId =
    (record.defaultWalletId ? denormalizeIbmHavenWalletId(record.defaultWalletId) : undefined) ??
    parsed.walletId ??
    (env.IBM_HAVEN_WALLET_ID ? denormalizeIbmHavenWalletId(env.IBM_HAVEN_WALLET_ID) : undefined);

  if (!defaultWalletId) {
    throw new SigningError(
      "IBM Digital Asset Haven config missing default wallet and env is not configured",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const config: KeychainDfnsConfig = {
    client: await createIbmHavenApiClient(env, { apiBaseUrl: parsed.apiBaseUrl }),
    defaultWalletId,
  };

  return new KeychainIbmHavenAdapter(config);
}

function createUtilaAdapterFromRecord(record: SigningConfigRecord, env: Env): KeychainUtilaAdapter {
  const parsed = parseSigningConfigJson<UtilaConfigJson>(record, "Utila");

  if (parsed.provider && parsed.provider !== "utila") {
    throw new SigningError("Custody configuration provider mismatch", "PROVIDER_NOT_CONFIGURED");
  }

  return new KeychainUtilaAdapter(
    buildKeychainUtilaConfig(env, {
      apiBaseUrl: parsed.apiBaseUrl,
      defaultWalletId: record.defaultWalletId,
      missingMessage: "Utila config missing service account credentials or vault ID",
      network: parsed.network,
      vaultId: parsed.vaultId,
    })
  );
}

function parseOptionalRequestDelayMs(
  value?: string,
  options?: { envVarName?: string }
): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new SigningError(
      `${options?.envVarName ?? "REQUEST_DELAY_MS"} must be a non-negative number`,
      "INVALID_REQUEST"
    );
  }
  return parsed;
}

function normalizeTurnkeyWalletId(privateKeyId: string): string {
  return privateKeyId.startsWith("turnkey_") ? privateKeyId : `turnkey_${privateKeyId}`;
}

function normalizeParaWalletId(walletId: string): string {
  return walletId.startsWith("para_") ? walletId : `para_${walletId}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Re-exports
// ═══════════════════════════════════════════════════════════════════════════

export {
  BaseKeychainAdapter,
  KeychainCoinbaseAdapter,
  type KeychainCoinbaseConfig,
  KeychainDfnsAdapter,
  type KeychainDfnsConfig,
  KeychainFireblocksAdapter,
  type KeychainFireblocksConfig,
  KeychainIbmHavenAdapter,
  KeychainMemoryAdapter,
  KeychainParaAdapter,
  type KeychainParaConfig,
  KeychainPrivyAdapter,
  type KeychainPrivyConfig,
  KeychainTurnkeyAdapter,
  type KeychainTurnkeyConfig,
  KeychainUtilaAdapter,
  type KeychainUtilaConfig,
} from "./keychain";
