import {
  assertHttpsBaseUrl,
  encodeBasicAuth,
  parseJsonResponse,
  readErrorResponseText,
} from "#/shared/common";
import type { CustodyProvisioningRuntime } from "#/shared/runtime";
import { SigningError } from "#/signing";

const DEFAULT_PRIVY_API_BASE_URL = "https://api.privy.io/v1";
const PRIVY_REQUEST_TIMEOUT_MS = 10_000;

interface PrivyWalletResponse {
  id: string;
  address: string;
  archived_at?: number | null;
  chain_type?: string;
  external_id?: string;
}

export interface ProvisionPrivyOptions {
  walletId?: string;
  externalId?: string;
  idempotencyKey?: string;
  credentialRequest?: boolean;
}

export interface PrivyProvisioningConfig {
  appId?: string;
  appSecret?: string;
  apiBaseUrl?: string;
}

export interface ProvisionPrivyResult {
  walletId: string;
  address: string;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ponytail: keep legacy and credential modes in one Provider boundary; split if a third mode is added.
export async function provisionPrivyWallet(
  runtime: CustodyProvisioningRuntime,
  config: PrivyProvisioningConfig,
  options: ProvisionPrivyOptions
): Promise<ProvisionPrivyResult> {
  const appId = config.appId;
  const appSecret = config.appSecret;

  if (!appId || !appSecret) {
    throw new SigningError(
      "Privy environment variables not configured: PRIVY_APP_ID, PRIVY_APP_SECRET",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  const apiBaseUrl = assertHttpsBaseUrl(config.apiBaseUrl ?? DEFAULT_PRIVY_API_BASE_URL, "Privy");
  const authHeader = `Basic ${encodeBasicAuth(`${appId}:${appSecret}`)}`;
  validatePrivyProvisionOptions(options);

  if (options.walletId) {
    const existing = await privyRequest<PrivyWalletResponse>(runtime, {
      apiBaseUrl,
      authHeader,
      appId,
      method: "GET",
      path: `/wallets/${encodeURIComponent(options.walletId)}`,
    });

    if (!existing?.id || !existing?.address) {
      throw new SigningError("Privy wallet lookup failed", "PROVIDER_NOT_CONFIGURED");
    }

    return { walletId: existing.id, address: existing.address };
  }

  const externalWalletLookup = options.externalId
    ? { apiBaseUrl, authHeader, appId, externalId: options.externalId }
    : undefined;
  const credentialRequest =
    options.credentialRequest === true || externalWalletLookup !== undefined;

  // POST first: Privy dedupes a retry on privy-idempotency-key and external_id,
  // so the wallet is looked up by external ID only when the create does not
  // answer with it (a duplicate external_id, a conflict, or no answer).
  try {
    const created = await privyRequest<PrivyWalletResponse>(runtime, {
      apiBaseUrl,
      authHeader,
      appId,
      storedCredentialRequest: credentialRequest,
      idempotencyKey: options.idempotencyKey,
      method: "POST",
      path: "/wallets",
      body: {
        chain_type: "solana",
        ...(options.externalId ? { external_id: options.externalId } : {}),
      },
    });

    if (externalWalletLookup) {
      return validatePrivyExternalWallet(created, externalWalletLookup.externalId);
    }

    if (!created?.id || !created.address) {
      throw new SigningError(
        credentialRequest ? "Privy wallet outcome is unknown" : "Privy wallet creation failed",
        credentialRequest ? "NETWORK_ERROR" : "PROVIDER_NOT_CONFIGURED"
      );
    }
    return { walletId: created.id, address: created.address };
  } catch (error) {
    if (isTerminalPrivyProvisioningError(error)) {
      throw error;
    }
    if (externalWalletLookup) {
      try {
        const reconciled = await findPrivyWalletByExternalId(
          runtime,
          config,
          externalWalletLookup.externalId
        );
        if (reconciled) return reconciled;
      } catch (reconciliationError) {
        if (isPrivyProvisioningConflict(reconciliationError)) {
          throw reconciliationError;
        }
      }
    }
    throw error;
  }
}

function isPrivyProvisioningConflict(error: unknown): error is SigningError {
  return error instanceof SigningError && error.code === "CONFLICT";
}

/**
 * A create failure the external-ID lookup cannot resolve. A duplicate
 * external_id is not one: Privy answers it 409, which privyRequest reports as
 * PROVIDER_NOT_CONFIGURED, and a CONFLICT (the answer's identity does not match)
 * is settled by the lookup, which rethrows a conflict it finds itself.
 */
function isTerminalPrivyProvisioningError(error: unknown): error is SigningError {
  return error instanceof SigningError && error.code === "PROVIDER_CREDENTIAL_INVALID";
}

function validatePrivyProvisionOptions(options: ProvisionPrivyOptions): void {
  const hasExternalId = options.externalId !== undefined;
  const hasIdempotencyKey = options.idempotencyKey !== undefined;
  if (
    hasExternalId !== hasIdempotencyKey ||
    (options.walletId !== undefined && hasExternalId) ||
    (options.externalId !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(options.externalId)) ||
    (options.idempotencyKey !== undefined &&
      (options.idempotencyKey.length === 0 || options.idempotencyKey.length > 256))
  ) {
    throw new SigningError(
      "Privy wallet creation requires valid externalId and idempotencyKey options",
      "INVALID_REQUEST"
    );
  }
}

interface PrivyRequestParams {
  apiBaseUrl: string;
  authHeader: string;
  appId: string;
  allowNotFound?: boolean;
  idempotencyKey?: string;
  storedCredentialRequest?: boolean;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}

async function privyRequest<T>(
  runtime: CustodyProvisioningRuntime,
  params: PrivyRequestParams
): Promise<T> {
  try {
    const response = await runtime.fetch(`${params.apiBaseUrl}${params.path}`, {
      method: params.method,
      headers: {
        Authorization: params.authHeader,
        "privy-app-id": params.appId,
        ...(params.idempotencyKey ? { "privy-idempotency-key": params.idempotencyKey } : {}),
        ...(params.body ? { "Content-Type": "application/json" } : {}),
      },
      body: params.body ? JSON.stringify(params.body) : undefined,
      signal: params.storedCredentialRequest
        ? AbortSignal.timeout(PRIVY_REQUEST_TIMEOUT_MS)
        : undefined,
    });

    if (!response.ok) {
      const errorText = await readErrorResponseText(response);
      const code =
        response.status === 401 && params.storedCredentialRequest
          ? "PROVIDER_CREDENTIAL_INVALID"
          : response.status === 404 && params.allowNotFound
            ? "NOT_FOUND"
            : response.status >= 500 && params.storedCredentialRequest
              ? "NETWORK_ERROR"
              : "PROVIDER_NOT_CONFIGURED";
      throw new SigningError(`Privy API error: ${response.status} - ${errorText}`, code);
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

export async function findPrivyWalletByExternalId(
  runtime: CustodyProvisioningRuntime,
  config: PrivyProvisioningConfig,
  externalId: string
): Promise<ProvisionPrivyResult | undefined> {
  const appId = config.appId;
  const appSecret = config.appSecret;
  if (!appId || !appSecret) {
    throw new SigningError(
      "Privy environment variables not configured: PRIVY_APP_ID, PRIVY_APP_SECRET",
      "PROVIDER_NOT_CONFIGURED"
    );
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(externalId)) {
    throw new SigningError("Privy external wallet ID is invalid", "INVALID_REQUEST");
  }

  let wallet: PrivyWalletResponse;
  try {
    wallet = await privyRequest<PrivyWalletResponse>(runtime, {
      apiBaseUrl: assertHttpsBaseUrl(config.apiBaseUrl ?? DEFAULT_PRIVY_API_BASE_URL, "Privy"),
      allowNotFound: true,
      authHeader: `Basic ${encodeBasicAuth(`${appId}:${appSecret}`)}`,
      appId,
      method: "GET",
      path: `/wallets/ext_wal_${encodeURIComponent(externalId)}`,
      storedCredentialRequest: true,
    });
  } catch (error) {
    if (error instanceof SigningError && error.code === "NOT_FOUND") {
      return undefined;
    }
    throw error;
  }

  return validatePrivyExternalWallet(wallet, externalId);
}

function validatePrivyWalletPayload(wallet: PrivyWalletResponse): ProvisionPrivyResult {
  if (!wallet.id || !wallet.address) {
    throw new SigningError("Privy wallet outcome is unknown", "NETWORK_ERROR");
  }
  return { walletId: wallet.id, address: wallet.address };
}

function validatePrivyExternalWallet(
  wallet: PrivyWalletResponse,
  externalId: string
): ProvisionPrivyResult {
  const result = validatePrivyWalletPayload(wallet);
  if (wallet.archived_at != null) {
    throw new SigningError("Privy external wallet is archived", "CONFLICT");
  }
  if (!wallet.chain_type || !wallet.external_id) {
    throw new SigningError("Privy wallet identity is unknown", "NETWORK_ERROR");
  }
  if (wallet.chain_type !== "solana" || wallet.external_id !== externalId) {
    throw new SigningError("Privy external wallet identity does not match", "CONFLICT");
  }
  return result;
}
