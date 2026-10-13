import {
  type DeleteAnchorageOptions as CustodyDeleteAnchorageOptions,
  type ProvisionAnchorageOptions as CustodyProvisionAnchorageOptions,
  type ProvisionCoinbaseCdpOptions as CustodyProvisionCoinbaseCdpOptions,
  type ProvisionFireblocksOptions as CustodyProvisionFireblocksOptions,
  type CustodyProvisioningRuntime,
  type ProvisionParaOptions as CustodyProvisionParaOptions,
  type ProvisionPrivyOptions as CustodyProvisionPrivyOptions,
  type ProvisionTurnkeyOptions as CustodyProvisionTurnkeyOptions,
  type ProvisionUtilaOptions as CustodyProvisionUtilaOptions,
  deleteAnchorageWallet as deleteAnchorageWalletInCustody,
  findPrivyWalletByExternalId as findPrivyWalletByExternalIdInCustody,
  type ProvisionAnchorageResult,
  type ProvisionCoinbaseCdpResult,
  type ProvisionFireblocksResult,
  type ProvisionParaResult,
  type ProvisionPrivyResult,
  type ProvisionTurnkeyResult,
  type ProvisionUtilaResult,
  provisionAnchorageWallet as provisionAnchorageWalletInCustody,
  provisionCoinbaseCdpAccount as provisionCoinbaseCdpAccountInCustody,
  provisionFireblocksVaultAccount as provisionFireblocksVaultAccountInCustody,
  provisionParaWallet as provisionParaWalletInCustody,
  provisionPrivyWallet as provisionPrivyWalletInCustody,
  provisionTurnkeyPrivateKey as provisionTurnkeyPrivateKeyInCustody,
  provisionUtilaWallet as provisionUtilaWalletInCustody,
} from "@sdp/custody/provisioning";
import { currentCustodyProviderNetworks } from "@/services/custody/custody-network";
import type { PrivyCredentialAuthentication } from "@/services/custody/privy-credential";
import type { Env } from "@/types/env";

// Credential-bearing provider requests must resolve destinations from trusted
// server configuration. Operation options intentionally cannot override URLs.
export type ProvisionFireblocksOptions = CustodyProvisionFireblocksOptions & {
  apiKey?: string;
  apiSecretPem?: string;
};
export type { ProvisionFireblocksResult };

export type ProvisionPrivyOptions = CustodyProvisionPrivyOptions;
export type { PrivyCredentialAuthentication, ProvisionPrivyResult };

export type ProvisionCoinbaseCdpOptions = CustodyProvisionCoinbaseCdpOptions;
export type { ProvisionCoinbaseCdpResult };

export type ProvisionParaOptions = CustodyProvisionParaOptions;
export type { ProvisionParaResult };

export type ProvisionTurnkeyOptions = CustodyProvisionTurnkeyOptions;
export type { ProvisionTurnkeyResult };

export type ProvisionUtilaOptions = CustodyProvisionUtilaOptions & {
  serviceAccountEmail?: string;
  serviceAccountPrivateKeyPem?: string;
  vaultId?: string;
};
export type { ProvisionUtilaResult };

export type ProvisionAnchorageOptions = Omit<CustodyProvisionAnchorageOptions, "network">;
export type { ProvisionAnchorageResult };

export type DeleteAnchorageOptions = CustodyDeleteAnchorageOptions;

/**
 * Provisions a Fireblocks vault account holding the Solana asset of the caller's cluster.
 *
 * @param env - Process environment holding the platform Fireblocks credentials and base URL.
 * @param options - The vault to provision.
 * @param options.orgId - The organization the vault is named and referenced for.
 * @param options.orgSlug - The organization slug the vault name is built from.
 * @param options.vaultAccountId - An existing vault account to add the asset to, instead of creating one.
 * @param options.apiKey - Overrides `FIREBLOCKS_API_KEY`.
 * @param options.apiSecretPem - Overrides `FIREBLOCKS_API_SECRET`.
 * @returns The vault account, the asset it holds, and the base URL used.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` when no cluster scope is open.
 */
export async function provisionFireblocksVaultAccount(
  env: Env,
  options: ProvisionFireblocksOptions
): Promise<ProvisionFireblocksResult> {
  return provisionFireblocksVaultAccountInCustody(
    createRuntime(),
    {
      apiKey: options.apiKey ?? env.FIREBLOCKS_API_KEY,
      apiSecretPem: options.apiSecretPem ?? env.FIREBLOCKS_API_SECRET,
      apiBaseUrl: env.FIREBLOCKS_API_BASE_URL,
      assetId: currentCustodyProviderNetworks().fireblocksAssetId,
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
      apiBaseUrl: env.PRIVY_API_BASE_URL,
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
      apiBaseUrl: env.PRIVY_API_BASE_URL,
    },
    externalId
  );
}

/**
 * Provisions a Coinbase CDP Solana account on the caller's cluster.
 *
 * @param env - Process environment holding the platform CDP credentials and account namespace.
 * @param options - The account to provision.
 * @param options.orgId - The organization the account name is derived from.
 * @param options.projectId - The project the account name is derived from.
 * @param options.walletSeed - A unique seed for an additional wallet; omitted for the root account.
 * @param options.accountPolicy - The CDP account policy to attach.
 * @param options.reuseExisting - Reclaims an account that already has the derived name.
 * @returns The account address and the CDP network it lives on.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` when no cluster scope is open.
 */
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
      apiBaseUrl: env.COINBASE_CDP_API_BASE_URL,
      network: currentCustodyProviderNetworks().coinbaseCdp,
      accountScope: env.COINBASE_CDP_ACCOUNT_NAMESPACE?.trim() || env.ENVIRONMENT,
    },
    options
  );
}

export async function provisionParaWallet(
  env: Env,
  options: ProvisionParaOptions
): Promise<ProvisionParaResult> {
  return provisionParaWalletInCustody(
    createRuntime(),
    {
      apiKey: env.PARA_API_KEY,
      apiBaseUrl: env.PARA_API_BASE_URL,
    },
    options
  );
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
      apiBaseUrl: env.TURNKEY_API_BASE_URL,
    },
    options
  );
}

/**
 * Provisions a Utila Solana sub-wallet on the caller's cluster inside the platform vault.
 *
 * @param env - Process environment holding the platform Utila credentials, vault, and base URL.
 * @param options - The wallet to provision.
 * @param options.displayName - The sub-wallet's display name.
 * @param options.serviceAccountEmail - Overrides `UTILA_SERVICE_ACCOUNT_EMAIL`.
 * @param options.serviceAccountPrivateKeyPem - Overrides `UTILA_SERVICE_ACCOUNT_PRIVATE_KEY`.
 * @param options.vaultId - Overrides `UTILA_VAULT_ID`.
 * @returns The sub-wallet, its address, vault, and network.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` when no cluster scope is open.
 */
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
      network: currentCustodyProviderNetworks().utila,
      apiBaseUrl: env.UTILA_API_BASE_URL,
    },
    options
  );
}

/**
 * Provisions an Anchorage Solana wallet on the caller's cluster.
 *
 * @param env - Process environment holding the platform Anchorage credentials and base URL.
 * @param options - The wallet to provision.
 * @param options.walletLabel - The wallet's label.
 * @returns The wallet and its address.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` when no cluster scope is open.
 */
export async function provisionAnchorageWallet(
  env: Env,
  options: ProvisionAnchorageOptions
): Promise<ProvisionAnchorageResult> {
  return provisionAnchorageWalletInCustody(
    createRuntime(),
    {
      apiKey: env.ANCHORAGE_API_KEY,
      apiBaseUrl: env.ANCHORAGE_API_BASE_URL,
    },
    { ...options, network: currentCustodyProviderNetworks().anchorage }
  );
}

export async function deleteAnchorageWallet(
  env: Env,
  options: DeleteAnchorageOptions
): Promise<void> {
  await deleteAnchorageWalletInCustody(
    createRuntime(),
    {
      apiKey: env.ANCHORAGE_API_KEY,
      apiBaseUrl: env.ANCHORAGE_API_BASE_URL,
    },
    options
  );
}

function createRuntime(): CustodyProvisioningRuntime {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
    getRandomValues: (values) => crypto.getRandomValues(new Uint8Array(values)),
    sha256: (data) => crypto.subtle.digest("SHA-256", new Uint8Array(data)),
  };
}
