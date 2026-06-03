/**
 * Custody Provisioning Helpers
 *
 * Creates custody wallets for new organizations using provider APIs.
 */

import type { VaultAddressesResponse } from "@solana/keychain-fireblocks";
import { ApiKeyStamper } from "@solana/keychain-turnkey";
import { importPKCS8, SignJWT } from "jose";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";
import {
  buildCoinbaseCdpAccountName,
  coinbaseCdpRequest,
  extractCoinbaseCdpAccountAddress,
  isCoinbaseCdpAlreadyExistsError,
  resolveCoinbaseCdpAccountScope,
} from "./provisioning.coinbase";
import {
  encodeBasicAuth,
  normalizePem,
  parseJsonResponse,
  randomHex,
  readErrorResponseText,
  sha256Hex,
  sleep,
} from "./provisioning.common";
import {
  buildParaUserIdentifier,
  type ParaWalletResponse,
  paraRequest,
  validateParaWallet,
  waitForParaWalletReady,
} from "./provisioning.para";

export {
  type DeleteAnchorageOptions,
  deleteAnchorageWallet,
  type ProvisionAnchorageOptions,
  type ProvisionAnchorageResult,
  provisionAnchorageWallet,
} from "./provisioning.anchorage";

const DEFAULT_FIREBLOCKS_API_BASE_URL = "https://api.fireblocks.io";
const DEFAULT_PRIVY_API_BASE_URL = "https://api.privy.io/v1";
const DEFAULT_COINBASE_CDP_API_BASE_URL = "https://api.cdp.coinbase.com/platform";
const DEFAULT_PARA_API_BASE_URL = "https://api.getpara.com";
const DEFAULT_TURNKEY_API_BASE_URL = "https://api.turnkey.com";
const DEFAULT_COINBASE_CDP_NETWORK = "solana-devnet";
const DEFAULT_FIREBLOCKS_ASSET_ID = "SOL";
const DEFAULT_UTILA_NETWORK = "networks/solana-devnet";

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

export interface ProvisionFireblocksOptions {
  orgId: string;
  orgSlug: string;
  assetId?: string;
  apiBaseUrl?: string;
  vaultAccountId?: string;
  apiKey?: string;
  apiSecretPem?: string;
}

export interface ProvisionFireblocksResult {
  vaultAccountId: string;
  assetId: string;
  apiBaseUrl: string;
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

export interface ProvisionUtilaOptions {
  serviceAccountEmail?: string;
  serviceAccountPrivateKeyPem?: string;
  vaultId?: string;
  network?: "networks/solana-mainnet" | "networks/solana-devnet";
  apiBaseUrl?: string;
  /** Display name for the new sub-wallet inside the vault. */
  displayName?: string;
}

export interface ProvisionUtilaResult {
  walletId: string;
  address: string;
  vaultId: string;
  network: "networks/solana-mainnet" | "networks/solana-devnet";
}

export async function provisionFireblocksVaultAccount(
  env: Env,
  options: ProvisionFireblocksOptions
): Promise<ProvisionFireblocksResult> {
  const apiKey = options.apiKey ?? env.FIREBLOCKS_API_KEY;
  const apiSecretPem = options.apiSecretPem
    ? normalizePem(options.apiSecretPem)
    : env.FIREBLOCKS_API_SECRET
      ? normalizePem(env.FIREBLOCKS_API_SECRET)
      : undefined;

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

  return { vaultAccountId, assetId, apiBaseUrl };
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
      userIdentifier: buildParaUserIdentifier({
        orgId: options.orgId,
        projectId: options.projectId,
      }),
      userIdentifierType: "CUSTOM_ID",
    };
  }

  const userIdentifier = buildParaUserIdentifier({
    orgId: options.orgId,
    projectId: options.projectId,
  });
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

export async function provisionUtilaWallet(
  env: Env,
  options: ProvisionUtilaOptions
): Promise<ProvisionUtilaResult> {
  const serviceAccountEmail = options.serviceAccountEmail ?? env.UTILA_SERVICE_ACCOUNT_EMAIL;
  const serviceAccountPrivateKeyPem =
    options.serviceAccountPrivateKeyPem ?? env.UTILA_SERVICE_ACCOUNT_PRIVATE_KEY;
  const configuredVaultId = options.vaultId ?? env.UTILA_VAULT_ID;
  const network = resolveUtilaNetwork(env, options.network);

  if (!serviceAccountEmail || !serviceAccountPrivateKeyPem || !configuredVaultId) {
    throw new SigningError(
      "Utila environment variables not configured: UTILA_SERVICE_ACCOUNT_EMAIL, UTILA_SERVICE_ACCOUNT_PRIVATE_KEY, UTILA_VAULT_ID",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const vaultId = normalizeUtilaVaultId(configuredVaultId);
  if (!vaultId) {
    throw new SigningError(
      "Utila vault ID is empty after normalization",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  // Create a new Solana sub-wallet inside the configured vault. Passing `networks`
  // makes Utila derive the Solana address as part of wallet creation.
  const apiBaseUrl = normalizeUtilaApiBaseUrl(options.apiBaseUrl ?? env.UTILA_API_BASE_URL);
  const token = await mintUtilaAccessToken(serviceAccountEmail, serviceAccountPrivateKeyPem);

  const response = await fetch(`${apiBaseUrl}/v2/vaults/${encodeURIComponent(vaultId)}/wallets`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      displayName: options.displayName ?? "SDP Wallet",
      networks: [network],
    }),
  });

  if (!response.ok) {
    const detail = await safeReadUtilaError(response);
    throw new SigningError(
      `Utila CreateWallet failed (${response.status}): ${detail}`,
      "NETWORK_ERROR"
    );
  }

  const body = (await response.json()) as UtilaCreateWalletResponse;
  const walletId = extractUtilaWalletId(body.wallet?.name);
  const address = body.wallet?.solanaDetails?.address;

  if (!walletId || !address) {
    throw new SigningError(
      "Utila CreateWallet response missing wallet id or Solana address",
      "NETWORK_ERROR"
    );
  }

  return { walletId, address, vaultId, network };
}

interface UtilaCreateWalletResponse {
  wallet?: {
    name?: string;
    solanaDetails?: { address?: string };
  };
}

const UTILA_API_AUDIENCE = "https://api.utila.io/";
const DEFAULT_UTILA_API_BASE_URL = "https://api.utila.io";

/** Mint a short-lived Utila service-account JWT for the REST API. */
async function mintUtilaAccessToken(
  serviceAccountEmail: string,
  serviceAccountPrivateKeyPem: string
): Promise<string> {
  const privateKey = await importPKCS8(normalizePem(serviceAccountPrivateKeyPem), "RS256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(serviceAccountEmail)
    .setAudience(UTILA_API_AUDIENCE)
    .setExpirationTime("5m")
    .sign(privateKey);
}

function normalizeUtilaApiBaseUrl(value?: string): string {
  return (value ?? DEFAULT_UTILA_API_BASE_URL).replace(/\/+$/, "");
}

function normalizeUtilaVaultId(value: string): string {
  const trimmed = value.trim();
  const marker = "/vaults/";
  const markerIndex = trimmed.lastIndexOf(marker);
  const resourceId = markerIndex === -1 ? trimmed : trimmed.slice(markerIndex + marker.length);
  return resourceId.startsWith("vaults/") ? resourceId.slice("vaults/".length) : resourceId;
}

/** Extract the short wallet id from a `vaults/{vault}/wallets/{wallet}` resource name. */
function extractUtilaWalletId(name?: string): string | undefined {
  if (!name) return undefined;
  const marker = "/wallets/";
  const index = name.lastIndexOf(marker);
  return index === -1 ? name : name.slice(index + marker.length);
}

async function safeReadUtilaError(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return response.statusText;
  }
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

interface TurnkeyRequestParams {
  method: "POST";
  path: string;
  apiBaseUrl: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  body: Record<string, unknown>;
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
    const errorText = await readErrorResponseText(response);
    throw new SigningError(
      `Fireblocks API error: ${response.status} - ${errorText}`,
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  return parseJsonResponse<T>(response);
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
      const errorText = await readErrorResponseText(response);
      throw new SigningError(
        `Privy API error: ${response.status} - ${errorText}`,
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    return parseJsonResponse<T>(response);
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
      const errorText = await readErrorResponseText(response);
      throw new SigningError(
        `Turnkey API error: ${response.status} - ${errorText}`,
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    return parseJsonResponse<T>(response);
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

function resolveUtilaNetwork(
  env: Env,
  configured?: "networks/solana-mainnet" | "networks/solana-devnet"
): "networks/solana-mainnet" | "networks/solana-devnet" {
  if (configured) {
    return configured;
  }
  if (env.UTILA_NETWORK) {
    return env.UTILA_NETWORK;
  }
  return env.SOLANA_NETWORK === "mainnet-beta" ? "networks/solana-mainnet" : DEFAULT_UTILA_NETWORK;
}
