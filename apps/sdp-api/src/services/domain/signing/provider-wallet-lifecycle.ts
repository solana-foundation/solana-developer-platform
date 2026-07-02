import { KeychainFireblocksAdapter } from "@/services/adapters";
import {
  deleteAnchorageWallet,
  provisionAnchorageWallet,
  provisionCoinbaseCdpAccount,
  provisionFireblocksVaultAccount,
  provisionParaWallet,
  provisionPrivyWallet,
  provisionTurnkeyPrivateKey,
  provisionUtilaWallet,
} from "@/services/custody/provisioning";
import {
  createDfnsApiClient,
  createIbmHavenApiClient,
  IBM_HAVEN_PROVIDER_LABEL,
  normalizeDfnsWalletId,
  resolveDfnsNetwork,
} from "@/services/dfns/client";
import { createEncryptionService } from "@/services/encryption.service";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";
import type { ProviderConfigRecord } from "./provider-config";
import {
  denormalizeAnchorageWalletId,
  normalizeAnchorageWalletId,
  normalizeCoinbaseCdpWalletId,
  normalizeFireblocksWalletId,
  normalizeIbmHavenWalletId,
  normalizeParaWalletId,
  normalizePrivyWalletId,
  normalizeTurnkeyWalletId,
  normalizeUtilaWalletId,
} from "./provider-wallet-ids";

export type ProvisionedProviderWallet = {
  walletId: string;
  publicKey: string;
};

type WalletCreateContext<TParsed extends ProviderConfigRecord = ProviderConfigRecord> = {
  env: Env;
  orgId: string;
  projectId: string | undefined;
  params: {
    label?: string;
  };
  parsed: TParsed;
};

type WalletDeleteContext<TParsed extends ProviderConfigRecord = ProviderConfigRecord> = {
  env: Env;
  walletId: string;
  parsed: TParsed;
};

type WalletLifecycleHandler<TParsed extends ProviderConfigRecord = ProviderConfigRecord> = {
  create?: (context: WalletCreateContext<TParsed>) => Promise<ProvisionedProviderWallet>;
  delete?: (context: WalletDeleteContext<TParsed>) => Promise<void>;
};

const providerWalletLifecycleRegistry = {
  local: {},
  fireblocks: {
    create: async ({ env, orgId, parsed }) => {
      if (!parsed.apiKey || !parsed.apiSecretEncrypted) {
        throw new SigningError(
          "Fireblocks configuration is missing API credentials",
          "PROVIDER_NOT_CONFIGURED"
        );
      }

      const encryption = createEncryptionService(env.CUSTODY_ENCRYPTION_KEY);
      const apiSecretPem = await encryption.decryptPrivateKey(orgId, parsed.apiSecretEncrypted);
      const provisioned = await withProvisioningError("Fireblocks", () =>
        provisionFireblocksVaultAccount(env, {
          orgId,
          orgSlug: orgId,
          apiKey: parsed.apiKey,
          apiSecretPem,
          assetId: parsed.assetId,
          apiBaseUrl: parsed.apiBaseUrl,
        })
      );
      const adapter = new KeychainFireblocksAdapter({
        apiKey: parsed.apiKey,
        apiSecretPem,
        vaultAccountId: provisioned.vaultAccountId,
        assetId: provisioned.assetId,
        apiBaseUrl: provisioned.apiBaseUrl,
      });

      return {
        walletId: normalizeFireblocksWalletId(provisioned.vaultAccountId),
        publicKey: await adapter.getPublicKey(),
      };
    },
  },
  privy: {
    create: async ({ env, parsed }) => {
      const apiBaseUrl = parsed.apiBaseUrl ?? env.PRIVY_API_BASE_URL;
      const provisioned = await withProvisioningError("Privy", () =>
        provisionPrivyWallet(env, { apiBaseUrl })
      );

      return {
        walletId: normalizePrivyWalletId(provisioned.walletId),
        publicKey: provisioned.address,
      };
    },
  },
  coinbase_cdp: {
    create: async ({ env, orgId, parsed }) => {
      const provisioned = await withProvisioningError("Coinbase CDP", () =>
        provisionCoinbaseCdpAccount(env, {
          orgId,
          orgSlug: orgId,
          apiBaseUrl: parsed.apiBaseUrl ?? env.COINBASE_CDP_API_BASE_URL,
          network: parsed.network ?? env.COINBASE_CDP_NETWORK,
          accountPolicy: parsed.accountPolicy,
        })
      );

      return {
        walletId: normalizeCoinbaseCdpWalletId(provisioned.address),
        publicKey: provisioned.address,
      };
    },
  },
  para: {
    create: async ({ env, orgId, projectId, parsed }) => {
      const provisioned = await withProvisioningError("Para", () =>
        provisionParaWallet(env, {
          orgId,
          projectId,
          orgSlug: orgId,
          apiBaseUrl: parsed.apiBaseUrl ?? env.PARA_API_BASE_URL,
        })
      );

      return {
        walletId: normalizeParaWalletId(provisioned.walletId),
        publicKey: provisioned.address,
      };
    },
  },
  turnkey: {
    create: async ({ env, orgId, parsed }) => {
      const provisioned = await withProvisioningError("Turnkey", () =>
        provisionTurnkeyPrivateKey(env, {
          orgId,
          orgSlug: orgId,
          apiBaseUrl: parsed.apiBaseUrl ?? env.TURNKEY_API_BASE_URL,
        })
      );

      return {
        walletId: normalizeTurnkeyWalletId(provisioned.privateKeyId),
        publicKey: provisioned.address,
      };
    },
  },
  dfns: {
    create: async ({ env, params, parsed }) => {
      const provisioned = await withProvisioningError("DFNS", async () => {
        const client = await createDfnsApiClient(env, { apiBaseUrl: parsed.apiBaseUrl });
        return client.wallets.createWallet({
          body: {
            network: resolveDfnsNetwork(parsed.network),
            ...(params.label ? { name: params.label } : {}),
          },
        });
      });

      if (!provisioned.id || !provisioned.address) {
        throw new SigningError("DFNS wallet creation returned incomplete payload", "NETWORK_ERROR");
      }

      return {
        walletId: normalizeDfnsWalletId(provisioned.id),
        publicKey: provisioned.address,
      };
    },
  },
  ibm_haven: {
    create: async ({ env, params, parsed }) => {
      const provisioned = await withProvisioningError("IBM Digital Asset Haven", async () => {
        const client = await createIbmHavenApiClient(env, { apiBaseUrl: parsed.apiBaseUrl });
        return client.wallets.createWallet({
          body: {
            network: resolveDfnsNetwork(parsed.network, IBM_HAVEN_PROVIDER_LABEL),
            ...(params.label ? { name: params.label } : {}),
          },
        });
      });

      if (!provisioned.id || !provisioned.address) {
        throw new SigningError(
          "IBM Digital Asset Haven wallet creation returned incomplete payload",
          "NETWORK_ERROR"
        );
      }

      return {
        walletId: normalizeIbmHavenWalletId(provisioned.id),
        publicKey: provisioned.address,
      };
    },
  },
  anchorage: {
    create: async ({ env, params, parsed }) => {
      const provisioned = await withProvisioningError("Anchorage", () =>
        provisionAnchorageWallet(env, {
          apiBaseUrl: parsed.apiBaseUrl,
          walletLabel: params.label,
          network: parsed.network,
        })
      );

      return {
        walletId: normalizeAnchorageWalletId(provisioned.walletId),
        publicKey: provisioned.address,
      };
    },
    delete: async ({ env, walletId, parsed }) => {
      await deleteAnchorageWallet(env, {
        apiBaseUrl: parsed.apiBaseUrl,
        walletId: denormalizeAnchorageWalletId(walletId),
      });
    },
  },
  utila: {
    create: async ({ env, params, parsed }) => {
      // Create a new Solana sub-wallet inside the configured Utila vault.
      const provisioned = await withProvisioningError("Utila", () =>
        provisionUtilaWallet(env, {
          vaultId: parsed.vaultId,
          network: parsed.network,
          apiBaseUrl: parsed.apiBaseUrl,
          displayName: params.label,
        })
      );

      return {
        walletId: normalizeUtilaWalletId(provisioned.walletId),
        publicKey: provisioned.address,
      };
    },
  },
} satisfies {
  [K in ProviderConfigRecord["provider"]]: WalletLifecycleHandler<
    Extract<ProviderConfigRecord, { provider: K }>
  >;
};

export async function createProviderWallet(
  context: WalletCreateContext
): Promise<ProvisionedProviderWallet> {
  const handler = (
    providerWalletLifecycleRegistry[context.parsed.provider] as WalletLifecycleHandler
  ).create;
  if (!handler) {
    throw new SigningError(
      `Wallet provisioning not supported for provider: ${context.parsed.provider}`,
      "INVALID_REQUEST"
    );
  }

  return handler(context as never);
}

export async function deleteProviderWallet(context: WalletDeleteContext): Promise<void> {
  const handler = (
    providerWalletLifecycleRegistry[context.parsed.provider] as WalletLifecycleHandler
  ).delete;
  if (!handler) {
    throw new SigningError(
      `Wallet deletion not supported for provider: ${context.parsed.provider}`,
      "INVALID_REQUEST"
    );
  }

  await handler(context as never);
}

async function withProvisioningError<T>(providerName: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SigningError) {
      throw error;
    }

    throw new SigningError(
      `Failed to provision ${providerName} wallet: ${error instanceof Error ? error.message : "Unknown error"}`,
      "NETWORK_ERROR",
      error instanceof Error ? error : undefined
    );
  }
}
