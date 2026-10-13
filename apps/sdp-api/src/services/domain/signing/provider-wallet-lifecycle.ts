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
} from "@sdp/custody";
import {
  createDfnsApiClient,
  createIbmHavenApiClient,
  normalizeDfnsWalletId,
} from "@sdp/custody/dfns";
import { SigningError } from "@sdp/custody/signing";
import { KeychainFireblocksAdapter } from "@/services/adapters";
import { currentCustodyProviderNetworks } from "@/services/custody/custody-network";
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
import { type CustodyCipher, createCustodyCipher } from "@/services/custody-cipher/cipher-router";
import type { Env } from "@/types/env";
import type { ProviderConfigRecord } from "./provider-config";

export type ProvisionedProviderWallet = {
  walletId: string;
  publicKey: string;
};

type WalletCreateContext<TParsed extends ProviderConfigRecord = ProviderConfigRecord> = {
  env: Env;
  orgId: string;
  projectId: string;
  params: {
    label?: string;
  };
  parsed: TParsed;
  cipher?: CustodyCipher;
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
    create: async ({ env, orgId, parsed, cipher }) => {
      if (!parsed.apiKey || !parsed.apiSecretEncrypted) {
        throw new SigningError(
          "Fireblocks configuration is missing API credentials",
          "PROVIDER_NOT_CONFIGURED"
        );
      }

      const apiSecretPem = await (cipher ?? createCustodyCipher(env)).decrypt(
        orgId,
        parsed.apiSecretEncrypted
      );
      const provisioned = await withProvisioningError("Fireblocks", () =>
        provisionFireblocksVaultAccount(env, {
          orgId,
          orgSlug: orgId,
          apiKey: parsed.apiKey,
          apiSecretPem,
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
    create: async ({ env }) => {
      const provisioned = await withProvisioningError("Privy", () => provisionPrivyWallet(env, {}));

      return {
        walletId: normalizePrivyWalletId(provisioned.walletId),
        publicKey: provisioned.address,
      };
    },
  },
  coinbase_cdp: {
    create: async ({ env, orgId, projectId, parsed }) => {
      // Additional wallets get a unique seed: every create provisions a fresh
      // account, and a name collision is an error rather than a silent reuse.
      const provisioned = await withProvisioningError("Coinbase CDP", () =>
        provisionCoinbaseCdpAccount(env, {
          orgId,
          projectId,
          walletSeed: crypto.randomUUID(),
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
    create: async ({ env, orgId, projectId }) => {
      const provisioned = await withProvisioningError("Para", () =>
        provisionParaWallet(env, {
          orgId,
          projectId,
          orgSlug: orgId,
        })
      );

      return {
        walletId: normalizeParaWalletId(provisioned.walletId),
        publicKey: provisioned.address,
      };
    },
  },
  turnkey: {
    create: async ({ env, orgId }) => {
      const provisioned = await withProvisioningError("Turnkey", () =>
        provisionTurnkeyPrivateKey(env, {
          orgId,
          orgSlug: orgId,
        })
      );

      return {
        walletId: normalizeTurnkeyWalletId(provisioned.privateKeyId),
        publicKey: provisioned.address,
      };
    },
  },
  dfns: {
    create: async ({ env, params }) => {
      const dfnsNetwork = currentCustodyProviderNetworks().dfns;
      const provisioned = await withProvisioningError("DFNS", async () => {
        const client = await createDfnsApiClient(env);
        return client.wallets.createWallet({
          body: {
            network: dfnsNetwork,
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
    create: async ({ env, params }) => {
      const dfnsNetwork = currentCustodyProviderNetworks().dfns;
      const provisioned = await withProvisioningError("IBM Digital Asset Haven", async () => {
        const client = await createIbmHavenApiClient(env);
        return client.wallets.createWallet({
          body: {
            network: dfnsNetwork,
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
    create: async ({ env, params }) => {
      const provisioned = await withProvisioningError("Anchorage", () =>
        provisionAnchorageWallet(env, {
          walletLabel: params.label,
        })
      );

      return {
        walletId: normalizeAnchorageWalletId(provisioned.walletId),
        publicKey: provisioned.address,
      };
    },
    delete: async ({ env, walletId }) => {
      await deleteAnchorageWallet(env, {
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

/**
 * Provisions one more wallet under a stored Managed config, on the caller's cluster.
 *
 * @param context - The wallet to create.
 * @param context.env - Process environment holding the platform provider credentials.
 * @param context.orgId - The organization that owns the config.
 * @param context.projectId - The project that owns the config.
 * @param context.params - The wallet's creation fields.
 * @param context.params.label - The wallet's label.
 * @param context.parsed - The parsed config the wallet lives under.
 * @param context.cipher - Decrypts the config's sealed fields.
 * @returns The provider wallet ID and its public key.
 * @throws SigningError `INVALID_REQUEST` when the provider has no wallet creation.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` when no cluster scope is open.
 */
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
      `Failed to provision ${providerName} wallet`,
      "NETWORK_ERROR",
      error instanceof Error ? error : undefined
    );
  }
}
