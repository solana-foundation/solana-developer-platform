import {
  type DeleteAnchorageOptions as CustodyDeleteAnchorageOptions,
  type ProvisionAnchorageOptions as CustodyProvisionAnchorageOptions,
  deleteAnchorageWallet as deleteAnchorageWalletInCustody,
  type ProvisionAnchorageResult,
  provisionAnchorageWallet as provisionAnchorageWalletInCustody,
} from "@sdp/custody/providers/anchorage/provisioning";
import {
  type ProvisionCoinbaseCdpOptions as CustodyProvisionCoinbaseCdpOptions,
  type ProvisionCoinbaseCdpResult,
  provisionCoinbaseCdpAccount as provisionCoinbaseCdpAccountInCustody,
} from "@sdp/custody/providers/coinbase/provisioning";
import {
  type ProvisionFireblocksOptions as CustodyProvisionFireblocksOptions,
  type ProvisionFireblocksResult,
  provisionFireblocksVaultAccount as provisionFireblocksVaultAccountInCustody,
} from "@sdp/custody/providers/fireblocks/provisioning";
import {
  getFireblocksVault as getFireblocksVaultInCustody,
  listFireblocksVaults as listFireblocksVaultsInCustody,
} from "@sdp/custody/providers/fireblocks/vaults";
import {
  type ProvisionParaOptions as CustodyProvisionParaOptions,
  type ProvisionParaResult,
  provisionParaWallet as provisionParaWalletInCustody,
} from "@sdp/custody/providers/para/provisioning";
import {
  type ProvisionPrivyOptions as CustodyProvisionPrivyOptions,
  findPrivyWalletByExternalId as findPrivyWalletByExternalIdInCustody,
  type ProvisionPrivyResult,
  provisionPrivyWallet as provisionPrivyWalletInCustody,
} from "@sdp/custody/providers/privy/provisioning";
import {
  type ProvisionTurnkeyOptions as CustodyProvisionTurnkeyOptions,
  type ProvisionTurnkeyResult,
  provisionTurnkeyPrivateKey as provisionTurnkeyPrivateKeyInCustody,
} from "@sdp/custody/providers/turnkey/provisioning";
import {
  type ProvisionUtilaOptions as CustodyProvisionUtilaOptions,
  type ProvisionUtilaResult,
  provisionUtilaWallet as provisionUtilaWalletInCustody,
} from "@sdp/custody/providers/utila/provisioning";
import type { CustodyProvisioningRuntime } from "@sdp/custody/shared/runtime";
import { currentClusterScope } from "@sdp/rpc/scope";
import type { PrivyCredentialAuthentication } from "@/services/custody/privy-credential";
import type { Env } from "@/types/env";

// Credential-bearing provider requests must resolve destinations from trusted
// server configuration. Operation options intentionally cannot override URLs.
export type ProvisionFireblocksOptions = CustodyProvisionFireblocksOptions & {
  assetId?: string;
  apiKey?: string;
  apiSecretPem?: string;
};

export type ProvisionPrivyOptions = CustodyProvisionPrivyOptions;

export type ProvisionCoinbaseCdpOptions = CustodyProvisionCoinbaseCdpOptions & {
  network?: "solana" | "solana-devnet";
};

export type ProvisionParaOptions = CustodyProvisionParaOptions;

export type ProvisionTurnkeyOptions = CustodyProvisionTurnkeyOptions;

export type ProvisionUtilaOptions = CustodyProvisionUtilaOptions & {
  serviceAccountEmail?: string;
  serviceAccountPrivateKeyPem?: string;
  vaultId?: string;
  network?: "networks/solana-mainnet" | "networks/solana-devnet";
};

export type ProvisionAnchorageOptions = CustodyProvisionAnchorageOptions;

export type DeleteAnchorageOptions = CustodyDeleteAnchorageOptions;

export async function provisionFireblocksVaultAccount(
  env: Env,
  options: ProvisionFireblocksOptions
): Promise<ProvisionFireblocksResult> {
  return provisionFireblocksVaultAccountInCustody(
    createRuntime(),
    {
      apiKey: options.apiKey ?? env.FIREBLOCKS_API_KEY,
      apiSecretPem: options.apiSecretPem ?? env.FIREBLOCKS_API_SECRET,
      assetId: options.assetId ?? env.FIREBLOCKS_ASSET_ID,
    },
    options
  );
}

export async function provisionPrivyWallet(
  env: Env,
  options: ProvisionPrivyOptions,
  authentication?: PrivyCredentialAuthentication
): Promise<ProvisionPrivyResult> {
  return provisionPrivyWalletInCustody(
    createRuntime(),
    {
      appId: authentication?.appId ?? env.PRIVY_APP_ID,
      appSecret: authentication?.appSecret ?? env.PRIVY_APP_SECRET,
    },
    options
  );
}

export async function findPrivyWalletByExternalId(
  env: Env,
  externalId: string,
  authentication?: PrivyCredentialAuthentication
): Promise<ProvisionPrivyResult | undefined> {
  return findPrivyWalletByExternalIdInCustody(
    createRuntime(),
    {
      appId: authentication?.appId ?? env.PRIVY_APP_ID,
      appSecret: authentication?.appSecret ?? env.PRIVY_APP_SECRET,
    },
    externalId
  );
}

export async function provisionCoinbaseCdpAccount(
  env: Env,
  options: ProvisionCoinbaseCdpOptions
): Promise<ProvisionCoinbaseCdpResult> {
  return provisionCoinbaseCdpAccountInCustody(
    createRuntime(),
    {
      apiKeyId: env.COINBASE_CDP_API_KEY_ID,
      apiKeySecret: env.COINBASE_CDP_API_KEY_SECRET,
      walletSecret: env.COINBASE_CDP_WALLET_SECRET,
      network: options.network ?? env.COINBASE_CDP_NETWORK,
      accountScope: env.COINBASE_CDP_ACCOUNT_NAMESPACE?.trim() || env.ENVIRONMENT,
    },
    options
  );
}

export async function provisionParaWallet(
  env: Env,
  options: ProvisionParaOptions
): Promise<ProvisionParaResult> {
  return provisionParaWalletInCustody(createRuntime(), { apiKey: env.PARA_API_KEY }, options);
}

export async function provisionTurnkeyPrivateKey(
  env: Env,
  options: ProvisionTurnkeyOptions
): Promise<ProvisionTurnkeyResult> {
  return provisionTurnkeyPrivateKeyInCustody(
    createRuntime(),
    {
      apiPublicKey: env.TURNKEY_API_PUBLIC_KEY,
      apiPrivateKey: env.TURNKEY_API_PRIVATE_KEY,
      organizationId: env.TURNKEY_ORGANIZATION_ID,
    },
    options
  );
}

export async function provisionUtilaWallet(
  env: Env,
  options: ProvisionUtilaOptions
): Promise<ProvisionUtilaResult> {
  return provisionUtilaWalletInCustody(
    createRuntime(),
    {
      serviceAccountEmail: options.serviceAccountEmail ?? env.UTILA_SERVICE_ACCOUNT_EMAIL,
      serviceAccountPrivateKeyPem:
        options.serviceAccountPrivateKeyPem ?? env.UTILA_SERVICE_ACCOUNT_PRIVATE_KEY,
      vaultId: options.vaultId ?? env.UTILA_VAULT_ID,
      network:
        options.network ??
        env.UTILA_NETWORK ??
        (currentClusterScope().cluster === "mainnet-beta"
          ? "networks/solana-mainnet"
          : "networks/solana-devnet"),
    },
    options
  );
}

export async function provisionAnchorageWallet(
  env: Env,
  options: ProvisionAnchorageOptions
): Promise<ProvisionAnchorageResult> {
  return provisionAnchorageWalletInCustody(
    createRuntime(),
    { apiKey: env.ANCHORAGE_API_KEY },
    options
  );
}

export async function deleteAnchorageWallet(
  env: Env,
  options: DeleteAnchorageOptions
): Promise<void> {
  await deleteAnchorageWalletInCustody(createRuntime(), { apiKey: env.ANCHORAGE_API_KEY }, options);
}

function createRuntime(): CustodyProvisioningRuntime {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

export function listFireblocksVaults(
  env: Env,
  credential: { apiKey: string; apiSecretPem: string; assetId: "SOL" | "SOL_TEST" },
  options: { after?: string; namePrefix?: string }
) {
  return listFireblocksVaultsInCustody(createRuntime(), credential, options);
}
export function getFireblocksVault(
  env: Env,
  credential: { apiKey: string; apiSecretPem: string; assetId: "SOL" | "SOL_TEST" },
  id: string
) {
  return getFireblocksVaultInCustody(createRuntime(), credential, id);
}
