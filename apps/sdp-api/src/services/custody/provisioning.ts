/**
 * Custody Provisioning Helpers
 *
 * Creates custody wallets for new organizations using provider APIs.
 */

import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";
import type { VaultAddressesResponse } from "@solana/keychain-fireblocks";
import { SignJWT, importPKCS8 } from "jose";

const DEFAULT_FIREBLOCKS_API_BASE_URL = "https://api.fireblocks.io";
const DEFAULT_PRIVY_API_BASE_URL = "https://api.privy.io/v1";
const DEFAULT_FIREBLOCKS_ASSET_ID = "SOL";

interface FireblocksVaultAccountResponse {
  id: string;
  name: string;
}

interface PrivyWalletResponse {
  id: string;
  address: string;
  chain_type?: string;
}

export interface ProvisionFireblocksOptions {
  orgId: string;
  orgSlug: string;
  assetId?: string;
  apiBaseUrl?: string;
  vaultAccountId?: string;
}

export interface ProvisionFireblocksResult {
  vaultAccountId: string;
  assetId: string;
}

export interface ProvisionPrivyOptions {
  walletId?: string;
  apiBaseUrl?: string;
}

export interface ProvisionPrivyResult {
  walletId: string;
  address: string;
}

export async function provisionFireblocksVaultAccount(
  env: Env,
  options: ProvisionFireblocksOptions
): Promise<ProvisionFireblocksResult> {
  const apiKey = env.FIREBLOCKS_API_KEY;
  const apiSecretPem = env.FIREBLOCKS_API_SECRET;

  if (!apiKey || !apiSecretPem) {
    throw new SigningError(
      "Fireblocks environment variables not configured: FIREBLOCKS_API_KEY, FIREBLOCKS_API_SECRET",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const apiBaseUrl =
    options.apiBaseUrl ?? env.FIREBLOCKS_API_BASE_URL ?? DEFAULT_FIREBLOCKS_API_BASE_URL;
  const assetId = options.assetId ?? env.FIREBLOCKS_ASSET_ID ?? DEFAULT_FIREBLOCKS_ASSET_ID;

  let vaultAccountId = options.vaultAccountId;

  if (!vaultAccountId) {
    const name = `sdp-${options.orgSlug || options.orgId}`.slice(0, 64);
    const response = await fireblocksRequest<FireblocksVaultAccountResponse>({
      apiBaseUrl,
      apiKey,
      apiSecretPem,
      method: "POST",
      uri: "/v1/vault/accounts",
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
  await fireblocksRequest<void>({
    apiBaseUrl,
    apiKey,
    apiSecretPem,
    method: "POST",
    uri: `/v1/vault/accounts/${vaultAccountId}/${assetId}`,
    body: {},
    allowStatuses: [409],
  });

  // Ensure the address exists (Fireblocks signer expects addresses_paginated to return at least one).
  const addresses = await fetchFireblocksAddressesWithRetry({
    apiBaseUrl,
    apiKey,
    apiSecretPem,
    vaultAccountId,
    assetId,
  });

  if (!addresses?.addresses?.length) {
    throw new SigningError(
      "Fireblocks vault wallet created, but no addresses are available",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  return { vaultAccountId, assetId };
}

export async function provisionPrivyWallet(
  env: Env,
  options: ProvisionPrivyOptions
): Promise<ProvisionPrivyResult> {
  const appId = env.PRIVY_APP_ID;
  const appSecret = env.PRIVY_APP_SECRET;

  if (!appId || !appSecret) {
    throw new SigningError(
      "Privy environment variables not configured: PRIVY_APP_ID, PRIVY_APP_SECRET",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const apiBaseUrl = options.apiBaseUrl ?? env.PRIVY_API_BASE_URL ?? DEFAULT_PRIVY_API_BASE_URL;
  const authHeader = `Basic ${encodeBasicAuth(`${appId}:${appSecret}`)}`;

  if (options.walletId) {
    const existing = await privyRequest<PrivyWalletResponse>({
      apiBaseUrl,
      authHeader,
      appId,
      method: "GET",
      path: `/wallets/${options.walletId}`,
    });

    if (!existing?.id || !existing?.address) {
      throw new SigningError("Privy wallet lookup failed", "PROVIDER_NOT_CONFIGURED");
    }

    return { walletId: existing.id, address: existing.address };
  }

  const created = await privyRequest<PrivyWalletResponse>({
    apiBaseUrl,
    authHeader,
    appId,
    method: "POST",
    path: "/wallets",
    body: {
      chain_type: "solana",
    },
  });

  if (!created?.id || !created?.address) {
    throw new SigningError("Privy wallet creation failed", "PROVIDER_NOT_CONFIGURED");
  }

  return { walletId: created.id, address: created.address };
}

interface FireblocksRequestParams {
  apiBaseUrl: string;
  apiKey: string;
  apiSecretPem: string;
  method: "GET" | "POST";
  uri: string;
  body?: unknown;
  allowStatuses?: number[];
}

interface FireblocksAddressesParams {
  apiBaseUrl: string;
  apiKey: string;
  apiSecretPem: string;
  vaultAccountId: string;
  assetId: string;
}

async function fetchFireblocksAddressesWithRetry(
  params: FireblocksAddressesParams
): Promise<VaultAddressesResponse> {
  const maxAttempts = 5;
  const delayMs = 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fireblocksRequest<VaultAddressesResponse>({
      apiBaseUrl: params.apiBaseUrl,
      apiKey: params.apiKey,
      apiSecretPem: params.apiSecretPem,
      method: "GET",
      uri: `/v1/vault/accounts/${params.vaultAccountId}/${params.assetId}/addresses_paginated?limit=1`,
    });

    if (response?.addresses?.length) {
      return response;
    }

    if (attempt < maxAttempts) {
      await sleep(delayMs);
    }
  }

  return { addresses: [] };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fireblocksRequest<T>(params: FireblocksRequestParams): Promise<T> {
  const bodyStr = params.body ? JSON.stringify(params.body) : "";
  const token = await createFireblocksJwt(params.apiKey, params.apiSecretPem, params.uri, bodyStr);

  const response = await fetch(`${params.apiBaseUrl}${params.uri}`, {
    method: params.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-API-Key": params.apiKey,
      ...(params.body ? { "Content-Type": "application/json" } : {}),
    },
    body: params.body ? bodyStr : undefined,
  });

  if (!response.ok && !(params.allowStatuses ?? []).includes(response.status)) {
    const errorText = await response.text().catch(() => "Failed to read error response");
    throw new SigningError(
      `Fireblocks API error: ${response.status} - ${errorText}`,
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  if (response.status === 204 || response.headers.get("content-length") === "0") {
    return undefined as T;
  }

  return (await response.json()) as T;
}

async function createFireblocksJwt(
  apiKey: string,
  privateKeyPem: string,
  uri: string,
  body: string
): Promise<string> {
  const privateKey = await importPKCS8(privateKeyPem, "RS256");
  const bodyHash = await sha256Hex(body);
  const nonce = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({ bodyHash, nonce, uri })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(apiKey)
    .setIssuedAt(now)
    .setExpirationTime(now + 30)
    .sign(privateKey);
}

async function sha256Hex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface PrivyRequestParams {
  apiBaseUrl: string;
  authHeader: string;
  appId: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}

async function privyRequest<T>(params: PrivyRequestParams): Promise<T> {
  try {
    const response = await fetch(`${params.apiBaseUrl}${params.path}`, {
      method: params.method,
      headers: {
        Authorization: params.authHeader,
        "privy-app-id": params.appId,
        ...(params.body ? { "Content-Type": "application/json" } : {}),
      },
      body: params.body ? JSON.stringify(params.body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Failed to read error response");
      throw new SigningError(
        `Privy API error: ${response.status} - ${errorText}`,
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return undefined as T;
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof SigningError) {
      throw error;
    }

    throw new SigningError(
      `Failed to call Privy API: ${error instanceof Error ? error.message : "Unknown error"}`,
      "NETWORK_ERROR",
      error instanceof Error ? error : undefined
    );
  }
}

function encodeBasicAuth(value: string): string {
  if (typeof btoa === "function") {
    return btoa(value);
  }

  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "utf-8").toString("base64");
  }

  throw new SigningError("Unable to encode Basic auth header", "PROVIDER_NOT_CONFIGURED");
}
