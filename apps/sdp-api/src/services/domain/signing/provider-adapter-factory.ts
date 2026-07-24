import {
  buildKeychainUtilaConfig,
  denormalizeIbmHavenWalletId,
  normalizeParaWalletId,
  normalizePrivyWalletId,
  normalizeTurnkeyWalletId,
} from "@sdp/custody";
import {
  createDfnsApiClient,
  createIbmHavenApiClient,
  normalizeDfnsWalletId,
} from "@sdp/custody/dfns";
import {
  SigningError,
  type SigningPort,
  type SignRequest,
  type SignResult,
} from "@sdp/custody/signing";
import type { Address } from "@solana/kit";
import { getDb } from "@/db";
import {
  KeychainCoinbaseAdapter,
  KeychainDfnsAdapter,
  KeychainFireblocksAdapter,
  KeychainIbmHavenAdapter,
  KeychainMemoryAdapter,
  KeychainParaAdapter,
  KeychainPrivyAdapter,
  KeychainTurnkeyAdapter,
  KeychainUtilaAdapter,
  type SigningConfigRecord,
} from "@/services/adapters";
import { type CustodyCipher, createCustodyCipher } from "@/services/custody-cipher/cipher-router";
import type { Env } from "@/types/env";
import {
  type ProviderConfigRecord,
  parseConfigRecord,
  parseOptionalRequestDelayMs,
} from "./provider-config";

type AdapterFactoryContext<TParsed extends ProviderConfigRecord = ProviderConfigRecord> = {
  env: Env;
  orgId: string;
  record: SigningConfigRecord;
  parsed: TParsed;
  cipher: CustodyCipher;
};

type AdapterFactory<TParsed extends ProviderConfigRecord = ProviderConfigRecord> = (
  context: AdapterFactoryContext<TParsed>
) => Promise<SigningPort>;

class LifecycleOnlyAdapter implements SigningPort {
  constructor(public readonly providerId: string) {}

  async getPublicKey(_walletId?: string): Promise<Address> {
    throw new SigningError(
      `Provider does not support transaction signing: ${this.providerId}`,
      "INVALID_REQUEST"
    );
  }

  async sign(_request: SignRequest): Promise<SignResult> {
    throw new SigningError(
      `Provider does not support transaction signing: ${this.providerId}`,
      "INVALID_REQUEST"
    );
  }

  requiresApproval(): boolean {
    return false;
  }
}

const providerAdapterFactories = {
  local: async ({ orgId, parsed, cipher }) => {
    if (!("encryptedPrivateKey" in parsed) || !parsed.encryptedPrivateKey) {
      throw new SigningError(
        "Local custody config missing encrypted private key",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    const privateKeyBase58 = await cipher.decrypt(orgId, parsed.encryptedPrivateKey);
    return KeychainMemoryAdapter.fromBase58(privateKeyBase58);
  },
  fireblocks: async ({ env, orgId, parsed, cipher }) => {
    if (!("apiSecretEncrypted" in parsed) || !parsed.apiSecretEncrypted) {
      throw new SigningError(
        "Fireblocks config missing encrypted API secret",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    const apiSecretPem = await cipher.decrypt(orgId, parsed.apiSecretEncrypted);

    return new KeychainFireblocksAdapter({
      apiKey: parsed.apiKey,
      apiSecretPem,
      vaultAccountId: parsed.vaultAccountId,
      assetId: parsed.assetId,
      apiBaseUrl: env.FIREBLOCKS_API_BASE_URL,
    });
  },
  privy: async ({ env, record, parsed }) => {
    const appId = env.PRIVY_APP_ID ?? parsed.privyAppId;
    const appSecret = env.PRIVY_APP_SECRET;

    if (!appId || !appSecret) {
      throw new SigningError(
        "Privy environment variables not configured: PRIVY_APP_ID, PRIVY_APP_SECRET",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    const requestDelayMs =
      parsed.requestDelayMs ??
      parseOptionalRequestDelayMs(env.PRIVY_REQUEST_DELAY_MS, {
        envVarName: "PRIVY_REQUEST_DELAY_MS",
      });

    const defaultWalletId =
      record.defaultWalletId ??
      (parsed.walletId ? normalizePrivyWalletId(parsed.walletId) : undefined);

    if (!defaultWalletId) {
      throw new SigningError("Privy config missing default wallet ID", "PROVIDER_NOT_CONFIGURED");
    }

    return new KeychainPrivyAdapter({
      appId,
      appSecret,
      apiBaseUrl: env.PRIVY_API_BASE_URL,
      requestDelayMs,
      defaultWalletId,
    });
  },
  coinbase_cdp: async ({ env, record, parsed }) => {
    const apiKeyId = env.COINBASE_CDP_API_KEY_ID;
    const apiKeySecret = env.COINBASE_CDP_API_KEY_SECRET;
    const walletSecret = env.COINBASE_CDP_WALLET_SECRET;
    const defaultWalletId = record.defaultWalletId;

    if (!apiKeyId || !apiKeySecret || !walletSecret || !defaultWalletId) {
      throw new SigningError(
        "Coinbase CDP configuration is missing credentials or default wallet ID",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    return new KeychainCoinbaseAdapter({
      apiKeyId,
      apiKeySecret,
      walletSecret,
      apiBaseUrl: env.COINBASE_CDP_API_BASE_URL,
      requestDelayMs: parsed.requestDelayMs,
      defaultWalletId,
    });
  },
  para: async ({ env, record, parsed }) => {
    const apiKey = env.PARA_API_KEY;
    const requestDelayMs =
      parsed.requestDelayMs ??
      parseOptionalRequestDelayMs(env.PARA_REQUEST_DELAY_MS, {
        envVarName: "PARA_REQUEST_DELAY_MS",
      });

    const defaultWalletId =
      record.defaultWalletId ??
      (parsed.walletId ? normalizeParaWalletId(parsed.walletId) : undefined);

    if (!apiKey || !defaultWalletId) {
      throw new SigningError(
        "Para configuration is missing API key or default wallet ID",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    return new KeychainParaAdapter({
      apiKey,
      apiBaseUrl: env.PARA_API_BASE_URL,
      requestDelayMs,
      defaultWalletId,
    });
  },
  turnkey: async ({ env, record, parsed }) => {
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
      (parsed.privateKeyId ? normalizeTurnkeyWalletId(parsed.privateKeyId) : undefined);

    let defaultWalletPublicKey = parsed.defaultWalletPublicKey ?? env.TURNKEY_PUBLIC_KEY;
    if (!defaultWalletPublicKey && defaultWalletId) {
      const wallet = await getDb(env)
        .prepare(
          `SELECT public_key
         FROM custody_wallets
         WHERE custody_config_id = ? AND wallet_id = ? AND status = 'active'
         LIMIT 1`
        )
        .bind(record.id, defaultWalletId)
        .first<{ public_key: string }>();
      defaultWalletPublicKey = wallet?.public_key;
    }

    if (
      !apiPublicKey ||
      !apiPrivateKey ||
      !organizationId ||
      !defaultWalletId ||
      !defaultWalletPublicKey
    ) {
      throw new SigningError(
        "Turnkey configuration is missing credentials or default wallet metadata",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    return new KeychainTurnkeyAdapter({
      apiPublicKey,
      apiPrivateKey,
      organizationId,
      apiBaseUrl: env.TURNKEY_API_BASE_URL,
      requestDelayMs,
      defaultWalletId,
      defaultWalletPublicKey,
    });
  },
  dfns: async ({ env, record, parsed }) => {
    const defaultWalletId =
      record.defaultWalletId ??
      (parsed.walletId ? normalizeDfnsWalletId(parsed.walletId) : undefined);

    if (!defaultWalletId) {
      throw new SigningError(
        "DFNS configuration is missing a default wallet ID",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    return new KeychainDfnsAdapter({
      client: await createDfnsApiClient(env),
      defaultWalletId,
    });
  },
  ibm_haven: async ({ env, record, parsed }) => {
    const defaultWalletId =
      (record.defaultWalletId ? denormalizeIbmHavenWalletId(record.defaultWalletId) : undefined) ??
      parsed.walletId;

    if (!defaultWalletId) {
      throw new SigningError(
        "IBM Digital Asset Haven configuration is missing a default wallet ID",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    return new KeychainIbmHavenAdapter({
      client: await createIbmHavenApiClient(env),
      defaultWalletId,
    });
  },
  anchorage: async () => new LifecycleOnlyAdapter("anchorage"),
  utila: async ({ env, record, parsed }) => {
    return new KeychainUtilaAdapter(
      buildKeychainUtilaConfig(env, {
        defaultWalletId: record.defaultWalletId,
        network: parsed.network,
        vaultId: parsed.vaultId,
      })
    );
  },
} satisfies {
  [K in ProviderConfigRecord["provider"]]: AdapterFactory<
    Extract<ProviderConfigRecord, { provider: K }>
  >;
};

export async function createAdapterFromEncryptedConfig(
  env: Env,
  orgId: string,
  record: SigningConfigRecord,
  cipher: CustodyCipher = createCustodyCipher(env)
): Promise<SigningPort> {
  const parsed = await parseConfigRecord(env, orgId, record, cipher);
  const factory = providerAdapterFactories[parsed.provider] as AdapterFactory;
  // `return await`, not bare `return`: factories are async and can reject before
  // their first await. Some runtimes report the adopted, briefly
  // handler-less promise as an unhandled rejection — dropping the await fails
  // shared-module test runs and would log rejection noise in production.
  return await factory({ env, orgId, record, parsed, cipher });
}
