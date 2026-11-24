import { summarizeUpstreamErrorBody } from "@sdp/redaction/upstream-error";
import { importPKCS8, SignJWT } from "jose";
import { assertHttpsBaseUrl, normalizePem } from "#/shared/common";
import type { CustodyProvisioningRuntime } from "#/shared/runtime";
import { SigningError } from "#/signing";

const DEFAULT_UTILA_NETWORK = "networks/solana-devnet";

export interface ProvisionUtilaOptions {
  /** Display name for the new sub-wallet inside the vault. */
  displayName?: string;
}

export interface UtilaProvisioningConfig {
  serviceAccountEmail?: string;
  serviceAccountPrivateKeyPem?: string;
  vaultId?: string;
  network?: "networks/solana-mainnet" | "networks/solana-devnet";
  apiBaseUrl?: string;
}

export interface ProvisionUtilaResult {
  walletId: string;
  address: string;
  vaultId: string;
  network: "networks/solana-mainnet" | "networks/solana-devnet";
}

export async function provisionUtilaWallet(
  runtime: CustodyProvisioningRuntime,
  config: UtilaProvisioningConfig,
  options: ProvisionUtilaOptions
): Promise<ProvisionUtilaResult> {
  const serviceAccountEmail = config.serviceAccountEmail;
  const serviceAccountPrivateKeyPem = config.serviceAccountPrivateKeyPem;
  const configuredVaultId = config.vaultId;
  const network = config.network ?? DEFAULT_UTILA_NETWORK;

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
  const apiBaseUrl = normalizeUtilaApiBaseUrl(config.apiBaseUrl);
  const token = await mintUtilaAccessToken(
    runtime,
    serviceAccountEmail,
    serviceAccountPrivateKeyPem
  );

  const response = await runtime.fetch(
    `${apiBaseUrl}/v2/vaults/${encodeURIComponent(vaultId)}/wallets`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        displayName: options.displayName ?? "SDP Wallet",
        networks: [network],
      }),
    }
  );

  if (!response.ok) {
    const errorCode = await safeReadUtilaError(response);
    throw new SigningError(
      `Utila CreateWallet failed (${response.status}): code=${errorCode}`,
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
  runtime: CustodyProvisioningRuntime,
  serviceAccountEmail: string,
  serviceAccountPrivateKeyPem: string
): Promise<string> {
  const privateKey = await importPKCS8(normalizePem(serviceAccountPrivateKeyPem), "RS256");
  const now = Math.floor(runtime.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(serviceAccountEmail)
    .setAudience(UTILA_API_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 5 * 60)
    .sign(privateKey);
}

function normalizeUtilaApiBaseUrl(value?: string): string {
  const url = assertHttpsBaseUrl(value ?? DEFAULT_UTILA_API_BASE_URL, "Utila");
  let end = url.length;

  while (end > 0 && url.charCodeAt(end - 1) === 47) {
    end -= 1;
  }

  return url.slice(0, end);
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

/**
 * Utila error bodies can echo the request (including the service-account bearer
 * token), so only a whitelisted upstream error code is surfaced.
 */
async function safeReadUtilaError(response: Response): Promise<string> {
  try {
    return summarizeUpstreamErrorBody(await response.text(), response.status);
  } catch {
    return "unavailable";
  }
}
