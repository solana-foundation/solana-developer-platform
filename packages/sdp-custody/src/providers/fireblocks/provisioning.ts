import { isAddress } from "@solana/addresses";
import type { VaultAddressesResponse } from "@solana/keychain-fireblocks";
import { custodyClusterConfig } from "#/cluster-config";
import { normalizePem } from "#/shared/common";
import type { CustodyProvisioningRuntime } from "#/shared/runtime";
import { SigningError } from "#/signing";
import { fireblocksRequest } from "./http";

interface FireblocksVaultAccountResponse {
  id: string;
  name: string;
}

export interface ProvisionFireblocksOptions {
  idempotencyKey?: string;
  orgId: string;
  orgSlug: string;
  vaultAccountId?: string;
}

export interface FireblocksProvisioningConfig {
  apiKey?: string;
  apiSecretPem?: string;
}

export interface ProvisionFireblocksResult {
  publicKey: string;
  vaultAccountId: string;
}

export async function provisionFireblocksVaultAccount(
  runtime: CustodyProvisioningRuntime,
  config: FireblocksProvisioningConfig,
  options: ProvisionFireblocksOptions
): Promise<ProvisionFireblocksResult> {
  const apiKey = config.apiKey;
  const apiSecretPem = config.apiSecretPem ? normalizePem(config.apiSecretPem) : undefined;

  if (!apiKey || !apiSecretPem) {
    throw new SigningError(
      "Fireblocks environment variables not configured: FIREBLOCKS_API_KEY, FIREBLOCKS_API_SECRET",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const assetId = custodyClusterConfig().fireblocks.nativeAsset;

  let vaultAccountId = options.vaultAccountId;

  if (!vaultAccountId) {
    const name = `sdp-${options.orgSlug || options.orgId}`.slice(0, 64);
    const response = await fireblocksRequest<FireblocksVaultAccountResponse>(runtime, {
      apiKey,
      apiSecretPem,
      method: "POST",
      uri: "/v1/vault/accounts",
      idempotencyKey: options.idempotencyKey ? `${options.idempotencyKey}:vault` : undefined,
      body: {
        name,
        customerRefId: options.orgId,
      },
    });

    if (!response?.id) {
      throw new SigningError("Fireblocks vault account creation failed", "PROVIDER_NOT_CONFIGURED");
    }

    vaultAccountId = response.id;
  }

  // Ensure the asset wallet exists for this vault account.
  await fireblocksRequest<void>(runtime, {
    apiKey,
    apiSecretPem,
    method: "POST",
    uri: `/v1/vault/accounts/${vaultAccountId}/${assetId}`,
    idempotencyKey: options.idempotencyKey ? `${options.idempotencyKey}:asset` : undefined,
    body: {},
    allowStatuses: [409],
  });

  // Ensure the address exists (Fireblocks signer expects addresses_paginated to return at least one).
  const addresses = await fetchFireblocksAddressesWithRetry(runtime, {
    apiKey,
    apiSecretPem,
    vaultAccountId,
    assetId,
  });

  const publicKey = addresses?.addresses?.[0]?.address;
  if (!publicKey || !isAddress(publicKey)) {
    throw new SigningError(
      "Fireblocks vault wallet created, but no addresses are available",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  return { vaultAccountId, publicKey };
}

interface FireblocksAddressesParams {
  apiKey: string;
  apiSecretPem: string;
  vaultAccountId: string;
  assetId: string;
}

async function fetchFireblocksAddressesWithRetry(
  runtime: CustodyProvisioningRuntime,
  params: FireblocksAddressesParams
): Promise<VaultAddressesResponse> {
  const maxAttempts = 5;
  const delayMs = 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fireblocksRequest<VaultAddressesResponse>(runtime, {
      apiKey: params.apiKey,
      apiSecretPem: params.apiSecretPem,
      method: "GET",
      uri: `/v1/vault/accounts/${params.vaultAccountId}/${params.assetId}/addresses_paginated?limit=1`,
    });

    if (response?.addresses?.length) {
      return response;
    }

    if (attempt < maxAttempts) {
      await runtime.sleep(delayMs);
    }
  }

  return { addresses: [] };
}
