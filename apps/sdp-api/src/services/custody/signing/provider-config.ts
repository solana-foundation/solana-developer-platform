import { SigningError } from "@sdp/custody/signing";
import type { SigningConfigRecord } from "@/services/adapters/signing";
import { type CustodyCipher, createCustodyCipher } from "@/services/custody-cipher/cipher-router";
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
}

export interface PrivyProviderConfig {
  provider: "privy";
  requestDelayMs?: number;
  privyAppId?: string;
  walletId?: string;
}

export interface CoinbaseCdpProviderConfig {
  provider: "coinbase_cdp";
  accountPolicy?: string;
  requestDelayMs?: number;
}

export interface ParaProviderConfig {
  provider: "para";
  requestDelayMs?: number;
  walletId?: string;
  userIdentifier?: string;
  userIdentifierType?: "CUSTOM_ID";
}

export interface TurnkeyProviderConfig {
  provider: "turnkey";
  organizationId?: string;
  requestDelayMs?: number;
  privateKeyId?: string;
}

export interface DfnsProviderConfig {
  provider: "dfns";
  walletId?: string;
  signingKeyId?: string;
}

export interface IbmHavenProviderConfig {
  provider: "ibm_haven";
  walletId?: string;
  signingKeyId?: string;
}

export interface AnchorageProviderConfig {
  provider: "anchorage";
  walletId?: string;
}

export interface UtilaProviderConfig {
  provider: "utila";
  vaultId?: string;
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
  record: SigningConfigRecord,
  cipher: CustodyCipher = createCustodyCipher(env)
): Promise<ProviderConfigRecord> {
  const parsedDirect = tryParseJson(record.config);
  if (parsedDirect !== null) {
    return coerceProviderConfig(parsedDirect, record.provider);
  }

  try {
    const decrypted = await cipher.decrypt(orgId, record.config);
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
