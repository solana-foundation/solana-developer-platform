/**
 * Custody Provisioning Helpers
 *
 * Creates custody wallets for new organizations using provider APIs.
 */

import { Buffer } from "node:buffer";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";
import type { VaultAddressesResponse } from "@solana/keychain-fireblocks";
import { ApiKeyStamper } from "@solana/keychain-turnkey";
import { SignJWT, importJWK, importPKCS8 } from "jose";

const DEFAULT_FIREBLOCKS_API_BASE_URL = "https://api.fireblocks.io";
const DEFAULT_PRIVY_API_BASE_URL = "https://api.privy.io/v1";
const DEFAULT_COINBASE_CDP_API_BASE_URL = "https://api.cdp.coinbase.com/platform";
const DEFAULT_PARA_API_BASE_URL = "https://api.getpara.com";
const DEFAULT_TURNKEY_API_BASE_URL = "https://api.turnkey.com";
const DEFAULT_COINBASE_CDP_NETWORK = "solana-devnet";
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

interface CoinbaseCdpSolanaAccountResponse {
  address: string;
  name?: string;
}

interface TurnkeyActivityResponse {
  activity?: {
    status?: string;
    result?: {
      createPrivateKeysResultV2?: {
        privateKeys?: Array<{
          privateKeyId?: string;
          addresses?: Array<{
            format?: string;
            address?: string;
          }>;
        }>;
      };
    };
  };
}

interface TurnkeyGetPrivateKeyResponse {
  privateKey?: {
    privateKeyId?: string;
    addresses?: Array<{
      format?: string;
      address?: string;
    }>;
  };
}

interface ParaWalletResponse {
  id: string;
  type?: "EVM" | "SOLANA" | "COSMOS";
  scheme?: "DKLS" | "CGGMP" | "ED25519";
  status?: "creating" | "ready" | string;
  address?: string;
  publicKey?: string;
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

export interface ProvisionCoinbaseCdpOptions {
  orgId: string;
  orgSlug: string;
  apiBaseUrl?: string;
  network?: "solana" | "solana-devnet";
  walletAddress?: string;
  accountPolicy?: string;
}

export interface ProvisionCoinbaseCdpResult {
  address: string;
  network: "solana" | "solana-devnet";
}

export interface ProvisionTurnkeyOptions {
  orgId: string;
  orgSlug: string;
  privateKeyId?: string;
  apiBaseUrl?: string;
}

export interface ProvisionTurnkeyResult {
  privateKeyId: string;
  address: string;
}

export interface ProvisionParaOptions {
  orgId: string;
  orgSlug: string;
  projectId?: string;
  walletId?: string;
  apiBaseUrl?: string;
}

export interface ProvisionParaResult {
  walletId: string;
  address: string;
  userIdentifier: string;
  userIdentifierType: "CUSTOM_ID";
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

export async function provisionCoinbaseCdpAccount(
  env: Env,
  options: ProvisionCoinbaseCdpOptions
): Promise<ProvisionCoinbaseCdpResult> {
  const apiKeyId = env.COINBASE_CDP_API_KEY_ID;
  const apiKeySecret = env.COINBASE_CDP_API_KEY_SECRET;
  const walletSecret = env.COINBASE_CDP_WALLET_SECRET;

  if (!apiKeyId || !apiKeySecret || !walletSecret) {
    throw new SigningError(
      "Coinbase CDP environment variables not configured: COINBASE_CDP_API_KEY_ID, COINBASE_CDP_API_KEY_SECRET, COINBASE_CDP_WALLET_SECRET",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const apiBaseUrl =
    options.apiBaseUrl ?? env.COINBASE_CDP_API_BASE_URL ?? DEFAULT_COINBASE_CDP_API_BASE_URL;
  const network = (options.network ?? env.COINBASE_CDP_NETWORK ?? DEFAULT_COINBASE_CDP_NETWORK) as
    | "solana"
    | "solana-devnet";

  const existingAddress = options.walletAddress;
  if (existingAddress) {
    const existing = await coinbaseCdpRequest<CoinbaseCdpSolanaAccountResponse>({
      method: "GET",
      path: `/v2/solana/accounts/${existingAddress}`,
      apiBaseUrl,
      apiKeyId,
      apiKeySecret,
      walletSecret,
    });

    const resolvedAddress = extractCoinbaseCdpAccountAddress(existing);
    if (!resolvedAddress) {
      throw new SigningError("Coinbase CDP wallet lookup failed", "PROVIDER_NOT_CONFIGURED");
    }

    return { address: resolvedAddress, network };
  }

  const name = buildCoinbaseCdpAccountName(
    options.orgSlug || options.orgId,
    resolveCoinbaseCdpAccountScope(env)
  );

  try {
    const created = await coinbaseCdpRequest<CoinbaseCdpSolanaAccountResponse>({
      method: "POST",
      path: "/v2/solana/accounts",
      apiBaseUrl,
      apiKeyId,
      apiKeySecret,
      walletSecret,
      idempotencyKey: crypto.randomUUID(),
      body: {
        name,
        ...(options.accountPolicy ? { accountPolicy: options.accountPolicy } : {}),
      },
    });

    const createdAddress = extractCoinbaseCdpAccountAddress(created);
    if (!createdAddress) {
      throw new SigningError("Coinbase CDP wallet creation failed", "PROVIDER_NOT_CONFIGURED");
    }

    return { address: createdAddress, network };
  } catch (error) {
    if (!isCoinbaseCdpAlreadyExistsError(error)) {
      throw error;
    }

    try {
      const existingByName = await coinbaseCdpRequest<CoinbaseCdpSolanaAccountResponse>({
        method: "GET",
        path: `/v2/solana/accounts/by-name/${encodeURIComponent(name)}`,
        apiBaseUrl,
        apiKeyId,
        apiKeySecret,
        walletSecret,
      });

      const existingAddressByName = extractCoinbaseCdpAccountAddress(existingByName);
      if (existingAddressByName) {
        return { address: existingAddressByName, network };
      }

      throw new SigningError(
        `Coinbase CDP account '${name}' already exists but lookup by name returned no address. Provide walletAddress to reuse the account.`,
        "PROVIDER_NOT_CONFIGURED"
      );
    } catch (lookupError) {
      if (lookupError instanceof SigningError && !isCoinbaseCdpAlreadyExistsError(lookupError)) {
        throw new SigningError(
          `Coinbase CDP account '${name}' already exists but could not be resolved by name. Provide walletAddress to reuse the account.`,
          "PROVIDER_NOT_CONFIGURED",
          lookupError
        );
      }

      throw lookupError;
    }
  }
}

export async function provisionParaWallet(
  env: Env,
  options: ProvisionParaOptions
): Promise<ProvisionParaResult> {
  const apiKey = env.PARA_API_KEY;
  if (!apiKey) {
    throw new SigningError(
      "Para environment variables not configured: PARA_API_KEY",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const apiBaseUrl = options.apiBaseUrl ?? env.PARA_API_BASE_URL ?? DEFAULT_PARA_API_BASE_URL;

  if (options.walletId) {
    const existing = await paraRequest<ParaWalletResponse>({
      apiBaseUrl,
      apiKey,
      method: "GET",
      path: `/v1/wallets/${encodeURIComponent(options.walletId)}`,
    });
    const validated = validateParaWallet(existing, options.walletId);
    return {
      walletId: validated.id,
      address: validated.address,
      userIdentifier: buildParaUserIdentifier(options),
      userIdentifierType: "CUSTOM_ID",
    };
  }

  const userIdentifier = buildParaUserIdentifier(options);
  const created = await paraRequest<ParaWalletResponse>({
    apiBaseUrl,
    apiKey,
    method: "POST",
    path: "/v1/wallets",
    body: {
      type: "SOLANA",
      scheme: "ED25519",
      userIdentifier,
      userIdentifierType: "CUSTOM_ID",
    },
  });

  if (!created?.id) {
    throw new SigningError("Para wallet creation failed", "PROVIDER_NOT_CONFIGURED");
  }

  const readyWallet = await waitForParaWalletReady({
    apiBaseUrl,
    apiKey,
    walletId: created.id,
  });
  const validated = validateParaWallet(readyWallet, created.id);

  return {
    walletId: validated.id,
    address: validated.address,
    userIdentifier,
    userIdentifierType: "CUSTOM_ID",
  };
}

export async function provisionTurnkeyPrivateKey(
  env: Env,
  options: ProvisionTurnkeyOptions
): Promise<ProvisionTurnkeyResult> {
  const apiPublicKey = env.TURNKEY_API_PUBLIC_KEY;
  const apiPrivateKey = env.TURNKEY_API_PRIVATE_KEY;
  const organizationId = env.TURNKEY_ORGANIZATION_ID;

  if (!apiPublicKey || !apiPrivateKey || !organizationId) {
    throw new SigningError(
      "Turnkey environment variables not configured: TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, TURNKEY_ORGANIZATION_ID",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const apiBaseUrl = options.apiBaseUrl ?? env.TURNKEY_API_BASE_URL ?? DEFAULT_TURNKEY_API_BASE_URL;

  if (options.privateKeyId) {
    const privateKeyId = denormalizeTurnkeyPrivateKeyId(options.privateKeyId);
    const existing = await turnkeyRequest<TurnkeyGetPrivateKeyResponse>({
      apiBaseUrl,
      apiPublicKey,
      apiPrivateKey,
      method: "POST",
      path: "/public/v1/query/get_private_key",
      body: {
        organizationId,
        privateKeyId,
      },
    });

    const address = findSolanaAddress(existing.privateKey?.addresses);
    if (!existing?.privateKey?.privateKeyId || !address) {
      throw new SigningError("Turnkey private key lookup failed", "PROVIDER_NOT_CONFIGURED");
    }

    return {
      privateKeyId: existing.privateKey.privateKeyId,
      address,
    };
  }

  const created = await turnkeyRequest<TurnkeyActivityResponse>({
    apiBaseUrl,
    apiPublicKey,
    apiPrivateKey,
    method: "POST",
    path: "/public/v1/submit/create_private_keys",
    body: {
      type: "ACTIVITY_TYPE_CREATE_PRIVATE_KEYS_V2",
      timestampMs: Date.now().toString(),
      organizationId,
      parameters: {
        privateKeys: [
          {
            privateKeyName: buildTurnkeyPrivateKeyName(options.orgSlug || options.orgId),
            curve: "CURVE_ED25519",
            privateKeyTags: [],
            addressFormats: ["ADDRESS_FORMAT_SOLANA"],
          },
        ],
      },
    },
  });

  const createdKey = created.activity?.result?.createPrivateKeysResultV2?.privateKeys?.[0];

  const privateKeyId = createdKey?.privateKeyId;
  const address = findSolanaAddress(createdKey?.addresses);
  if (!privateKeyId || !address) {
    throw new SigningError("Turnkey private key creation failed", "PROVIDER_NOT_CONFIGURED");
  }

  return { privateKeyId, address };
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

interface CoinbaseCdpRequestParams {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  apiBaseUrl: string;
  apiKeyId: string;
  apiKeySecret: string;
  walletSecret: string;
  idempotencyKey?: string;
  body?: Record<string, unknown>;
}

interface TurnkeyRequestParams {
  method: "POST";
  path: string;
  apiBaseUrl: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  body: Record<string, unknown>;
}

interface ParaRequestParams {
  method: "GET" | "POST";
  path: string;
  apiBaseUrl: string;
  apiKey: string;
  body?: Record<string, unknown>;
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

async function paraRequest<T>(params: ParaRequestParams): Promise<T> {
  try {
    const response = await fetch(`${params.apiBaseUrl}${params.path}`, {
      method: params.method,
      headers: {
        "X-API-Key": params.apiKey,
        ...(params.body ? { "Content-Type": "application/json" } : {}),
      },
      body: params.body ? JSON.stringify(params.body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Failed to read error response");
      throw new SigningError(
        `Para API error: ${response.status} - ${errorText}`,
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return undefined as T;
    }

    const payload = (await response.json()) as unknown;
    if (payload && typeof payload === "object" && "data" in payload && payload.data) {
      return payload.data as T;
    }

    return payload as T;
  } catch (error) {
    if (error instanceof SigningError) {
      throw error;
    }

    throw new SigningError(
      `Failed to call Para API: ${error instanceof Error ? error.message : "Unknown error"}`,
      "NETWORK_ERROR",
      error instanceof Error ? error : undefined
    );
  }
}

async function waitForParaWalletReady(params: {
  apiBaseUrl: string;
  apiKey: string;
  walletId: string;
}): Promise<ParaWalletResponse> {
  const maxAttempts = 8;
  const delayMs = 500;

  let latestWallet: ParaWalletResponse | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const wallet = await paraRequest<ParaWalletResponse>({
      apiBaseUrl: params.apiBaseUrl,
      apiKey: params.apiKey,
      method: "GET",
      path: `/v1/wallets/${encodeURIComponent(params.walletId)}`,
    });

    latestWallet = wallet;
    if (wallet.status === "ready" && wallet.address) {
      return wallet;
    }

    if (attempt < maxAttempts) {
      await sleep(delayMs);
    }
  }

  throw new SigningError(
    `Para wallet '${params.walletId}' did not become ready after ${maxAttempts} attempts (status: ${latestWallet?.status ?? "unknown"})`,
    "PROVIDER_NOT_CONFIGURED"
  );
}

function validateParaWallet(
  wallet: ParaWalletResponse | undefined,
  walletId: string
): {
  id: string;
  address: string;
} {
  if (!wallet?.id || !wallet?.address) {
    throw new SigningError("Para wallet lookup failed", "PROVIDER_NOT_CONFIGURED");
  }

  if (wallet.type && wallet.type !== "SOLANA") {
    throw new SigningError(
      `Para wallet '${walletId}' is not a Solana wallet`,
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  if (wallet.scheme && wallet.scheme !== "ED25519") {
    throw new SigningError(`Para wallet '${walletId}' is not ED25519`, "PROVIDER_NOT_CONFIGURED");
  }

  return {
    id: wallet.id,
    address: wallet.address,
  };
}

async function turnkeyRequest<T>(params: TurnkeyRequestParams): Promise<T> {
  const body = JSON.stringify(params.body);
  const stamper = new ApiKeyStamper({
    apiPrivateKey: params.apiPrivateKey,
    apiPublicKey: params.apiPublicKey,
  });
  // ApiKeyStamper is currently synchronous, but normalize in case the SDK
  // ever changes stamp() to return a Promise.
  const stamp = await Promise.resolve(stamper.stamp(body));

  try {
    const response = await fetch(`${params.apiBaseUrl}${params.path}`, {
      method: params.method,
      headers: {
        "Content-Type": "application/json",
        [stamp.stampHeaderName]: stamp.stampHeaderValue,
      },
      body,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Failed to read error response");
      throw new SigningError(
        `Turnkey API error: ${response.status} - ${errorText}`,
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
      `Failed to call Turnkey API: ${error instanceof Error ? error.message : "Unknown error"}`,
      "NETWORK_ERROR",
      error instanceof Error ? error : undefined
    );
  }
}

async function coinbaseCdpRequest<T>(params: CoinbaseCdpRequestParams): Promise<T> {
  const { requestPath, url } = resolveCoinbaseCdpRequestUrl(params.apiBaseUrl, params.path);
  const normalizedBody = params.body ? sortJsonKeys(params.body) : undefined;
  const bodyJson = normalizedBody ? JSON.stringify(normalizedBody) : undefined;

  try {
    const bearerToken = await createCoinbaseCdpBearerJwt({
      apiKeyId: params.apiKeyId,
      apiKeySecret: params.apiKeySecret,
      requestMethod: params.method,
      requestHost: url.host,
      requestPath,
    });

    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearerToken}`,
      ...(bodyJson ? { "Content-Type": "application/json" } : {}),
      ...(params.idempotencyKey ? { "X-Idempotency-Key": params.idempotencyKey } : {}),
    };

    if (requiresCoinbaseCdpWalletAuth(params.method, requestPath)) {
      const walletAuthToken = await createCoinbaseCdpWalletJwt({
        walletSecret: params.walletSecret,
        requestMethod: params.method,
        requestHost: url.host,
        requestPath,
        requestData: (normalizedBody ?? {}) as Record<string, unknown>,
      });
      headers["X-Wallet-Auth"] = walletAuthToken;
    }

    const response = await fetch(url.toString(), {
      method: params.method,
      headers,
      body: bodyJson,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Failed to read error response");
      throw new SigningError(
        `Coinbase CDP API error: ${response.status} - ${errorText}`,
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
      `Failed to call Coinbase CDP API: ${error instanceof Error ? error.message : "Unknown error"}`,
      "NETWORK_ERROR",
      error instanceof Error ? error : undefined
    );
  }
}

function resolveCoinbaseCdpRequestUrl(
  apiBaseUrl: string,
  path: string
): { requestPath: string; url: URL } {
  const normalizedBaseUrl = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const url = new URL(normalizedPath, normalizedBaseUrl);

  return {
    requestPath: `${url.pathname}${url.search}`,
    url,
  };
}

interface CoinbaseCdpBearerJwtParams {
  apiKeyId: string;
  apiKeySecret: string;
  requestMethod: string;
  requestHost: string;
  requestPath: string;
}

async function createCoinbaseCdpBearerJwt(params: CoinbaseCdpBearerJwtParams): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const nonce = randomHex(16);
  const uri = `${params.requestMethod} ${params.requestHost}${params.requestPath}`;

  const payload = new SignJWT({ uris: [uri] })
    .setIssuer("cdp")
    .setSubject(params.apiKeyId)
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 120);

  if (isPemEncodedKey(params.apiKeySecret)) {
    const key = await importPKCS8(params.apiKeySecret, "ES256");
    return payload.setProtectedHeader({ alg: "ES256", kid: params.apiKeyId, nonce }).sign(key);
  }

  const rawKey = decodeBase64ToBytes(params.apiKeySecret);
  if (rawKey.length !== 64) {
    throw new SigningError(
      "COINBASE_CDP_API_KEY_SECRET has an invalid format. Expected EC PEM or base64 Ed25519 private key (64 bytes).",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const seed = rawKey.slice(0, 32);
  const publicKey = rawKey.slice(32);
  const ed25519Jwk = {
    crv: "Ed25519",
    d: toBase64Url(seed),
    kty: "OKP",
    x: toBase64Url(publicKey),
  };

  const key = await importJWK(ed25519Jwk, "EdDSA");
  return payload.setProtectedHeader({ alg: "EdDSA", kid: params.apiKeyId, nonce }).sign(key);
}

interface CoinbaseCdpWalletJwtParams {
  walletSecret: string;
  requestMethod: string;
  requestHost: string;
  requestPath: string;
  requestData: Record<string, unknown>;
}

async function createCoinbaseCdpWalletJwt(params: CoinbaseCdpWalletJwtParams): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const uri = `${params.requestMethod} ${params.requestHost}${params.requestPath}`;
  const payload: Record<string, unknown> = { uris: [uri] };

  const shouldIncludeReqHash =
    Object.keys(params.requestData).length > 0 &&
    Object.values(params.requestData).some((value) => value !== undefined);

  if (shouldIncludeReqHash) {
    payload.reqHash = await sha256Hex(JSON.stringify(sortJsonKeys(params.requestData)));
  }

  const pkcs8DerBytes = decodeBase64ToBytes(params.walletSecret);
  const privateKeyPem = encodePkcs8Pem(pkcs8DerBytes);
  const key = await importPKCS8(privateKeyPem, "ES256");

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setJti(randomHex(16))
    .sign(key);
}

function requiresCoinbaseCdpWalletAuth(method: string, requestPath: string): boolean {
  if (!["POST", "PUT", "DELETE"].includes(method.toUpperCase())) {
    return false;
  }

  return requestPath.includes("/accounts") || requestPath.includes("/spend-permissions");
}

function buildCoinbaseCdpAccountName(value: string, scope?: string): string {
  let normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    normalized = "org";
  }

  const normalizedScope = scope
    ? scope
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
    : "";

  let name = `${normalizedScope ? `sdp-${normalizedScope}` : "sdp"}-${normalized}`.slice(0, 36);
  name = name.replace(/-+$/g, "");

  if (!/^[a-z0-9]/.test(name)) {
    name = `s${name}`;
  }

  if (!/[a-z0-9]$/.test(name)) {
    name = `${name}0`;
  }

  if (name.length < 2) {
    name = `sdp-${randomHex(2)}`.slice(0, 36);
  }

  return name;
}

function resolveCoinbaseCdpAccountScope(env: Env): string {
  const explicitNamespace = env.COINBASE_CDP_ACCOUNT_NAMESPACE?.trim();
  return explicitNamespace || env.ENVIRONMENT;
}

function extractCoinbaseCdpAccountAddress(response: unknown): string | null {
  if (!response || typeof response !== "object") {
    return null;
  }

  const record = response as Record<string, unknown>;
  const directAddress = record.address;
  if (typeof directAddress === "string" && directAddress.length > 0) {
    return directAddress;
  }

  const account = record.account;
  if (account && typeof account === "object") {
    const accountAddress = (account as Record<string, unknown>).address;
    if (typeof accountAddress === "string" && accountAddress.length > 0) {
      return accountAddress;
    }
  }

  const data = record.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const dataAddress = (data as Record<string, unknown>).address;
    if (typeof dataAddress === "string" && dataAddress.length > 0) {
      return dataAddress;
    }
  }

  if (Array.isArray(data)) {
    for (const entry of data) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const entryAddress = (entry as Record<string, unknown>).address;
      if (typeof entryAddress === "string" && entryAddress.length > 0) {
        return entryAddress;
      }
    }
  }

  return null;
}

function isCoinbaseCdpAlreadyExistsError(error: unknown): error is SigningError {
  if (!(error instanceof SigningError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes("coinbase cdp api error: 409") &&
    (message.includes("already_exists") || message.includes("already exists"))
  );
}

function buildTurnkeyPrivateKeyName(value: string): string {
  const suffix = randomHex(2);
  let normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    normalized = "org";
  }

  let name = `sdp-${normalized}-${suffix}`.slice(0, 60);
  name = name.replace(/-+$/g, "");

  if (!name) {
    name = `sdp-${randomHex(3)}`;
  }

  return name;
}

function buildParaUserIdentifier(options: ProvisionParaOptions): string {
  const scope = options.projectId
    ? `org:${options.orgId}:project:${options.projectId}`
    : `org:${options.orgId}`;
  return `sdp:${scope}:wallet:${crypto.randomUUID()}`;
}

function findSolanaAddress(
  addresses:
    | Array<{
        format?: string;
        address?: string;
      }>
    | undefined
): string | undefined {
  if (!addresses?.length) return undefined;

  const solana = addresses.find((entry) => entry.format === "ADDRESS_FORMAT_SOLANA");
  if (solana?.address) {
    return solana.address;
  }

  return addresses.find((entry) => Boolean(entry.address))?.address;
}

function denormalizeTurnkeyPrivateKeyId(privateKeyId: string): string {
  return privateKeyId.startsWith("turnkey_") ? privateKeyId.slice("turnkey_".length) : privateKeyId;
}

function isPemEncodedKey(value: string): boolean {
  return value.includes("-----BEGIN");
}

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function encodePkcs8Pem(privateKeyDer: Uint8Array): string {
  const base64 = encodeBase64FromBytes(privateKeyDer);
  const lines = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----`;
}

function toBase64Url(bytes: Uint8Array): string {
  return encodeBase64FromBytes(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64ToBytes(value: string): Uint8Array {
  const globalWithBuffer = globalThis as {
    Buffer?: {
      from: (input: string, encoding: "base64") => Uint8Array;
    };
  };

  if (globalWithBuffer.Buffer) {
    return new Uint8Array(globalWithBuffer.Buffer.from(value, "base64"));
  }

  if (typeof atob !== "function") {
    throw new SigningError("Unable to decode base64 secret", "PROVIDER_NOT_CONFIGURED");
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function encodeBase64FromBytes(bytes: Uint8Array): string {
  const globalWithBuffer = globalThis as {
    Buffer?: {
      from: (input: Uint8Array) => { toString: (encoding: "base64") => string };
    };
  };

  if (globalWithBuffer.Buffer) {
    return globalWithBuffer.Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  if (typeof btoa !== "function") {
    throw new SigningError("Unable to encode base64 payload", "PROVIDER_NOT_CONFIGURED");
  }

  return btoa(binary);
}

function sortJsonKeys(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => sortJsonKeys(item));
  }

  if (typeof value !== "object") {
    return value;
  }

  const objectValue = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(objectValue).sort()) {
    result[key] = sortJsonKeys(objectValue[key]);
  }
  return result;
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
