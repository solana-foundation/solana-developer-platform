import { buildKeychainUtilaConfig } from "@sdp/custody";
import { createDfnsApiClient, createIbmHavenApiClient } from "@sdp/custody/dfns";
import { SigningError, type SigningPort } from "@sdp/custody/signing";
import type { Address } from "@solana/kit";
import { instrumentVendorPort } from "@/runtime/vendor-calls";
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
import { assertLocalSigningAllowed } from "@/services/adapters/signing";
import { type CustodyCipher, createCustodyCipher } from "@/services/custody-cipher/cipher-router";
import { assertCustodyProviderAvailable } from "@/services/provider-availability.service";
import type { Env } from "@/types/env";
import {
  type ProviderConfigRecord,
  parseConfigRecord,
  parseOptionalRequestDelayMs,
} from "./provider-config";

type AdapterFactoryContext<TParsed extends ProviderConfigRecord = ProviderConfigRecord> = {
  env: Env;
  orgId: string;
  parsed: TParsed;
  cipher: CustodyCipher;
};

type AdapterFactory<TParsed extends ProviderConfigRecord = ProviderConfigRecord> = (
  context: AdapterFactoryContext<TParsed>
) => Promise<SigningPort>;

export interface PrivyCredentialAdapterInput {
  appId: string;
  appSecret: string;
  walletId: string;
  requestDelayMs?: number;
}

class LifecycleOnlyAdapter implements SigningPort {
  constructor(public readonly providerId: string) {}

  async getPublicKey(_walletId?: string): Promise<Address> {
    throw new SigningError(
      `Provider does not support transaction signing: ${this.providerId}`,
      "INVALID_REQUEST"
    );
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
  privy: async ({ env, parsed }) => {
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

    return new KeychainPrivyAdapter({
      appId,
      appSecret,
      apiBaseUrl: env.PRIVY_API_BASE_URL,
      requestDelayMs,
    });
  },
  coinbase_cdp: async ({ env, parsed }) => {
    const apiKeyId = env.COINBASE_CDP_API_KEY_ID;
    const apiKeySecret = env.COINBASE_CDP_API_KEY_SECRET;
    const walletSecret = env.COINBASE_CDP_WALLET_SECRET;

    if (!apiKeyId || !apiKeySecret || !walletSecret) {
      throw new SigningError(
        "Coinbase CDP configuration is missing credentials",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    return new KeychainCoinbaseAdapter({
      apiKeyId,
      apiKeySecret,
      walletSecret,
      apiBaseUrl: env.COINBASE_CDP_API_BASE_URL,
      requestDelayMs: parsed.requestDelayMs,
    });
  },
  para: async ({ env, parsed }) => {
    const apiKey = env.PARA_API_KEY;
    const requestDelayMs =
      parsed.requestDelayMs ??
      parseOptionalRequestDelayMs(env.PARA_REQUEST_DELAY_MS, {
        envVarName: "PARA_REQUEST_DELAY_MS",
      });

    if (!apiKey) {
      throw new SigningError("Para configuration is missing API key", "PROVIDER_NOT_CONFIGURED");
    }

    return new KeychainParaAdapter({
      apiKey,
      apiBaseUrl: env.PARA_API_BASE_URL,
      requestDelayMs,
    });
  },
  turnkey: async ({ env, parsed }) => {
    const apiPublicKey = env.TURNKEY_API_PUBLIC_KEY;
    const apiPrivateKey = env.TURNKEY_API_PRIVATE_KEY;
    const organizationId = parsed.organizationId ?? env.TURNKEY_ORGANIZATION_ID;
    const requestDelayMs =
      parsed.requestDelayMs ??
      parseOptionalRequestDelayMs(env.TURNKEY_REQUEST_DELAY_MS, {
        envVarName: "TURNKEY_REQUEST_DELAY_MS",
      });

    if (!apiPublicKey || !apiPrivateKey || !organizationId) {
      throw new SigningError(
        "Turnkey configuration is missing credentials",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    return new KeychainTurnkeyAdapter({
      apiPublicKey,
      apiPrivateKey,
      organizationId,
      apiBaseUrl: env.TURNKEY_API_BASE_URL,
      requestDelayMs,
    });
  },
  dfns: async ({ env }) => {
    return new KeychainDfnsAdapter({
      client: await createDfnsApiClient(env),
    });
  },
  ibm_haven: async ({ env }) => {
    return new KeychainIbmHavenAdapter({
      client: await createIbmHavenApiClient(env),
    });
  },
  anchorage: async () => new LifecycleOnlyAdapter("anchorage"),
  utila: async ({ env, parsed }) => {
    return new KeychainUtilaAdapter(
      buildKeychainUtilaConfig(env, {
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

/**
 * Builds the signing adapter for a stored Managed custody config. The one function
 * every Managed signing path passes through, so it refuses a (provider, managed)
 * pair the release channel leaves out before any decrypt.
 *
 * @param env - Process environment naming the release channel and provider credentials.
 * @param orgId - The organization that owns the config, the decryption context.
 * @param record - The stored custody config row.
 * @param cipher - Decrypts the config's sealed fields.
 * @returns The instrumented signing adapter for the config's provider.
 * @throws 403 when the (provider, managed) pair is outside the release channel.
 */
export async function createAdapterFromEncryptedConfig(
  env: Env,
  orgId: string,
  record: SigningConfigRecord,
  cipher: CustodyCipher = createCustodyCipher(env)
): Promise<SigningPort> {
  assertCustodyProviderAvailable(env, record.provider, "managed");
  // Checked before parsing, which can decrypt: a stored local key must never be
  // loaded in a managed deployment, whatever row exists.
  if (record.provider === "local") {
    assertLocalSigningAllowed(env);
  }
  const parsed = await parseConfigRecord(env, orgId, record, cipher);
  const factory = providerAdapterFactories[parsed.provider] as AdapterFactory;
  // `return await`, not bare `return`: factories are async and can reject before
  // their first await. Some runtimes report the adopted, briefly
  // handler-less promise as an unhandled rejection — dropping the await fails
  // shared-module test runs and would log rejection noise in production.
  return instrumentVendorPort(parsed.provider, await factory({ env, orgId, parsed, cipher }));
}

/**
 * Builds the Privy signing adapter for a BYOK custody connection's stored credential.
 * The one function every BYOK signing path passes through, so it refuses the
 * (privy, byok) pair when the release channel leaves it out, before reading the input.
 *
 * @param env - Process environment naming the release channel and Privy API settings.
 * @param input - The connection's decrypted Privy credential and the exact wallet to sign with.
 * @param input.appId - The Privy app ID.
 * @param input.appSecret - The Privy app secret.
 * @param input.walletId - The connection's Privy wallet the adapter signs with.
 * @param input.requestDelayMs - The connection's request delay, else `PRIVY_REQUEST_DELAY_MS`.
 * @returns The Privy signing adapter.
 * @throws 403 when the (privy, byok) pair is outside the release channel.
 */
export function createPrivyAdapterFromCredential(
  env: Env,
  input: PrivyCredentialAdapterInput
): SigningPort {
  assertCustodyProviderAvailable(env, "privy", "byok");
  if (!input.appId || !input.appSecret || !input.walletId) {
    throw new SigningError("Privy credential or wallet is unavailable", "PROVIDER_NOT_CONFIGURED");
  }

  return new KeychainPrivyAdapter({
    appId: input.appId,
    appSecret: input.appSecret,
    defaultWalletId: input.walletId,
    apiBaseUrl: env.PRIVY_API_BASE_URL,
    requestDelayMs:
      input.requestDelayMs ??
      parseOptionalRequestDelayMs(env.PRIVY_REQUEST_DELAY_MS, {
        envVarName: "PRIVY_REQUEST_DELAY_MS",
      }),
  });
}
