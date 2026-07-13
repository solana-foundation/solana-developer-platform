/**
 * API-side custody provisioning adapters.
 *
 * This module owns Env-to-config mapping. Provider HTTP and provisioning
 * behavior lives in @sdp/custody.
 */

import {
  custodyProvisioning,
  normalizePem,
  type ProvisionAnchorageResult,
  type ProvisionCoinbaseCdpResult,
  type ProvisionFireblocksResult,
  type ProvisionParaResult,
  type ProvisionPrivyResult,
  type ProvisionTurnkeyResult,
  type ProvisionUtilaResult,
} from "@sdp/custody/provisioning";
import type { Env } from "@/types/env";

export type {
  ProvisionAnchorageResult,
  ProvisionCoinbaseCdpResult,
  ProvisionFireblocksResult,
  ProvisionParaResult,
  ProvisionPrivyResult,
  ProvisionTurnkeyResult,
  ProvisionUtilaResult,
} from "@sdp/custody/provisioning";

export interface ProvisionFireblocksOptions {
  orgId: string;
  orgSlug: string;
  assetId?: string;
  apiBaseUrl?: string;
  vaultAccountId?: string;
  apiKey?: string;
  apiSecretPem?: string;
}

export interface ProvisionPrivyOptions {
  walletId?: string;
  apiBaseUrl?: string;
}

export interface ProvisionCoinbaseCdpOptions {
  orgId: string;
  orgSlug: string;
  apiBaseUrl?: string;
  network?: "solana" | "solana-devnet";
  walletAddress?: string;
  accountPolicy?: string;
}

export interface ProvisionTurnkeyOptions {
  orgId: string;
  orgSlug: string;
  privateKeyId?: string;
  apiBaseUrl?: string;
}

export interface ProvisionParaOptions {
  orgId: string;
  orgSlug: string;
  projectId?: string;
  walletId?: string;
  apiBaseUrl?: string;
}

export interface ProvisionUtilaOptions {
  serviceAccountEmail?: string;
  serviceAccountPrivateKeyPem?: string;
  vaultId?: string;
  network?: "networks/solana-mainnet" | "networks/solana-devnet";
  apiBaseUrl?: string;
  /** Display name for the new sub-wallet inside the vault. */
  displayName?: string;
}

export interface ProvisionAnchorageOptions {
  apiBaseUrl?: string;
  walletId?: string;
  walletLabel?: string;
  network?: "solana" | "solana-devnet";
}

export interface DeleteAnchorageOptions {
  apiBaseUrl?: string;
  walletId: string;
}

export function provisionFireblocksVaultAccount(
  env: Env,
  options: ProvisionFireblocksOptions
): Promise<ProvisionFireblocksResult> {
  return custodyProvisioning.provisionFireblocksVaultAccount({
    ...options,
    apiKey: options.apiKey ?? env.FIREBLOCKS_API_KEY,
    apiSecretPem: options.apiSecretPem
      ? normalizePem(options.apiSecretPem)
      : env.FIREBLOCKS_API_SECRET
        ? normalizePem(env.FIREBLOCKS_API_SECRET)
        : undefined,
    apiBaseUrl: options.apiBaseUrl ?? env.FIREBLOCKS_API_BASE_URL,
    assetId: options.assetId ?? env.FIREBLOCKS_ASSET_ID,
  });
}

export function provisionPrivyWallet(
  env: Env,
  options: ProvisionPrivyOptions
): Promise<ProvisionPrivyResult> {
  return custodyProvisioning.provisionPrivyWallet({
    ...options,
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    apiBaseUrl: options.apiBaseUrl ?? env.PRIVY_API_BASE_URL,
  });
}

export function provisionCoinbaseCdpAccount(
  env: Env,
  options: ProvisionCoinbaseCdpOptions
): Promise<ProvisionCoinbaseCdpResult> {
  return custodyProvisioning.provisionCoinbaseCdpAccount({
    ...options,
    apiKeyId: env.COINBASE_CDP_API_KEY_ID,
    apiKeySecret: env.COINBASE_CDP_API_KEY_SECRET,
    walletSecret: env.COINBASE_CDP_WALLET_SECRET,
    apiBaseUrl: options.apiBaseUrl ?? env.COINBASE_CDP_API_BASE_URL,
    network: options.network ?? env.COINBASE_CDP_NETWORK,
    accountScope: env.COINBASE_CDP_ACCOUNT_NAMESPACE?.trim() || env.ENVIRONMENT,
  });
}

export function provisionParaWallet(
  env: Env,
  options: ProvisionParaOptions
): Promise<ProvisionParaResult> {
  return custodyProvisioning.provisionParaWallet({
    ...options,
    apiKey: env.PARA_API_KEY,
    apiBaseUrl: options.apiBaseUrl ?? env.PARA_API_BASE_URL,
  });
}

export function provisionTurnkeyPrivateKey(
  env: Env,
  options: ProvisionTurnkeyOptions
): Promise<ProvisionTurnkeyResult> {
  return custodyProvisioning.provisionTurnkeyPrivateKey({
    ...options,
    apiPublicKey: env.TURNKEY_API_PUBLIC_KEY,
    apiPrivateKey: env.TURNKEY_API_PRIVATE_KEY,
    organizationId: env.TURNKEY_ORGANIZATION_ID,
    apiBaseUrl: options.apiBaseUrl ?? env.TURNKEY_API_BASE_URL,
  });
}

export function provisionUtilaWallet(
  env: Env,
  options: ProvisionUtilaOptions
): Promise<ProvisionUtilaResult> {
  return custodyProvisioning.provisionUtilaWallet({
    ...options,
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
  });
}

export function provisionAnchorageWallet(
  env: Env,
  options: ProvisionAnchorageOptions
): Promise<ProvisionAnchorageResult> {
  return custodyProvisioning.provisionAnchorageWallet({
    ...options,
    apiKey: env.ANCHORAGE_API_KEY,
    apiBaseUrl: options.apiBaseUrl ?? env.ANCHORAGE_API_BASE_URL,
  });
}

export function deleteAnchorageWallet(env: Env, options: DeleteAnchorageOptions): Promise<void> {
  return custodyProvisioning.deleteAnchorageWallet({
    ...options,
    apiKey: env.ANCHORAGE_API_KEY,
    apiBaseUrl: options.apiBaseUrl ?? env.ANCHORAGE_API_BASE_URL,
  });
}
