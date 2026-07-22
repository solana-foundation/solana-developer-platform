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
import type { Env } from "@/types/env";

export type ProvisionFireblocksOptions = CustodyProvisionFireblocksOptions & {
  assetId?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  apiSecretPem?: string;
};
export type { ProvisionFireblocksResult };

export type ProvisionPrivyOptions = CustodyProvisionPrivyOptions & {
  apiBaseUrl?: string;
};
export type { ProvisionPrivyResult };

export type ProvisionCoinbaseCdpOptions = CustodyProvisionCoinbaseCdpOptions & {
  apiBaseUrl?: string;
  network?: "solana" | "solana-devnet";
};
export type { ProvisionCoinbaseCdpResult };

export type ProvisionParaOptions = CustodyProvisionParaOptions & {
  apiBaseUrl?: string;
};
export type { ProvisionParaResult };

export type ProvisionTurnkeyOptions = CustodyProvisionTurnkeyOptions & {
  apiBaseUrl?: string;
};
export type { ProvisionTurnkeyResult };

export type ProvisionUtilaOptions = CustodyProvisionUtilaOptions & {
  serviceAccountEmail?: string;
  serviceAccountPrivateKeyPem?: string;
  vaultId?: string;
  network?: "networks/solana-mainnet" | "networks/solana-devnet";
  apiBaseUrl?: string;
};
export type { ProvisionUtilaResult };

export type ProvisionAnchorageOptions = CustodyProvisionAnchorageOptions & {
  apiBaseUrl?: string;
};
export type { ProvisionAnchorageResult };

export type DeleteAnchorageOptions = CustodyDeleteAnchorageOptions & {
  apiBaseUrl?: string;
};

export async function provisionFireblocksVaultAccount(
  env: Env,
  options: ProvisionFireblocksOptions
): Promise<ProvisionFireblocksResult> {
  return provisionFireblocksVaultAccountInCustody(
    createRuntime(),
    {
      apiKey: options.apiKey ?? env.FIREBLOCKS_API_KEY,
      apiSecretPem: options.apiSecretPem ?? env.FIREBLOCKS_API_SECRET,
      apiBaseUrl: options.apiBaseUrl ?? env.FIREBLOCKS_API_BASE_URL,
      assetId: options.assetId ?? env.FIREBLOCKS_ASSET_ID,
    },
    options
  );
}

export async function provisionPrivyWallet(
  env: Env,
  options: ProvisionPrivyOptions
): Promise<ProvisionPrivyResult> {
  return provisionPrivyWalletInCustody(
    createRuntime(),
    {
      appId: env.PRIVY_APP_ID,
      appSecret: env.PRIVY_APP_SECRET,
      apiBaseUrl: options.apiBaseUrl ?? env.PRIVY_API_BASE_URL,
    },
    options
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
      apiBaseUrl: options.apiBaseUrl ?? env.COINBASE_CDP_API_BASE_URL,
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
  return provisionParaWalletInCustody(
    createRuntime(),
    {
      apiKey: env.PARA_API_KEY,
      apiBaseUrl: options.apiBaseUrl ?? env.PARA_API_BASE_URL,
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
      apiBaseUrl: options.apiBaseUrl ?? env.TURNKEY_API_BASE_URL,
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
        (env.SOLANA_NETWORK === "mainnet-beta"
          ? "networks/solana-mainnet"
          : "networks/solana-devnet"),
      apiBaseUrl: options.apiBaseUrl ?? env.UTILA_API_BASE_URL,
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
    {
      apiKey: env.ANCHORAGE_API_KEY,
      apiBaseUrl: options.apiBaseUrl ?? env.ANCHORAGE_API_BASE_URL,
    },
    options
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
      apiBaseUrl: options.apiBaseUrl ?? env.ANCHORAGE_API_BASE_URL,
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
