import type { SigningConfigRecord } from "@/services/adapters";
import { createEncryptionService } from "@/services/encryption.service";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";

export interface LocalProviderConfig {
  provider: "local";
  encryptedPrivateKey: string;
}

export interface FireblocksProviderConfig {
  provider: "fireblocks";
  apiKey: string;
  apiSecretEncrypted: string;
  vaultAccountId: string;
  assetId: string;
  apiBaseUrl?: string;
}

export interface PrivyProviderConfig {
  provider: "privy";
  apiBaseUrl?: string;
  requestDelayMs?: number;
  privyAppId?: string;
  walletId?: string;
}

export interface CoinbaseCdpProviderConfig {
  provider: "coinbase_cdp";
  apiBaseUrl?: string;
  network?: "solana" | "solana-devnet";
  accountPolicy?: string;
  requestDelayMs?: number;
}

export interface ParaProviderConfig {
  provider: "para";
  apiBaseUrl?: string;
  requestDelayMs?: number;
  walletId?: string;
  userIdentifier?: string;
  userIdentifierType?: "CUSTOM_ID";
}

export interface TurnkeyProviderConfig {
  provider: "turnkey";
  organizationId?: string;
  apiBaseUrl?: string;
  requestDelayMs?: number;
  privateKeyId?: string;
  defaultWalletPublicKey?: string;
}

export interface DfnsProviderConfig {
  provider: "dfns";
  apiBaseUrl?: string;
  network?: "Solana" | "SolanaDevnet";
  walletId?: string;
  signingKeyId?: string;
}

export interface IbmHavenProviderConfig {
  provider: "ibm_haven";
  apiBaseUrl?: string;
  network?: "Solana" | "SolanaDevnet";
  walletId?: string;
  signingKeyId?: string;
}

export interface AnchorageProviderConfig {
  provider: "anchorage";
  apiBaseUrl?: string;
  walletId?: string;
  network?: "solana" | "solana-devnet";
}

export interface UtilaProviderConfig {
  provider: "utila";
  apiBaseUrl?: string;
  vaultId?: string;
  network?: "networks/solana-mainnet" | "networks/solana-devnet";
}

export type ProviderConfigRecord =
  | LocalProviderConfig
  | FireblocksProviderConfig
  | PrivyProviderConfig
  | CoinbaseCdpProviderConfig
  | ParaProviderConfig
  | TurnkeyProviderConfig
  | DfnsProviderConfig
  | IbmHavenProviderConfig
  | AnchorageProviderConfig
  | UtilaProviderConfig;

export async function parseConfigRecord(
  env: Env,
  orgId: string,
  record: SigningConfigRecord
): Promise<ProviderConfigRecord> {
  const parsedDirect = tryParseJson(record.config);
  if (parsedDirect !== null) {
    return coerceProviderConfig(parsedDirect, record.provider);
  }

  try {
    const encryption = createEncryptionService(env.CUSTODY_ENCRYPTION_KEY);
    const decrypted = await encryption.decrypt(orgId, record.config);
    const parsedDecrypted = tryParseJson(decrypted);
    if (parsedDecrypted === null) {
      throw new SigningError(
        "Custody configuration must be a valid JSON object",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    return coerceProviderConfig(parsedDecrypted, record.provider);
  } catch (error) {
    if (error instanceof SigningError) {
      throw error;
    }

    throw new SigningError(
      error instanceof Error ? error.message : "Failed to decrypt custody configuration",
      "PROVIDER_NOT_CONFIGURED"
    );
  }
}

export function parseOptionalRequestDelayMs(
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

function tryParseJson(value: string): unknown | null {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function coerceProviderConfig(
  parsed: unknown,
  recordProvider: SigningConfigRecord["provider"]
): ProviderConfigRecord {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { provider: recordProvider } as ProviderConfigRecord;
  }

  return {
    ...(parsed as Record<string, unknown>),
    provider: recordProvider,
  } as ProviderConfigRecord;
}
