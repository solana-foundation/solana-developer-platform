import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";
import { parseJsonResponse, readErrorResponseText } from "./provisioning.common";

const DEFAULT_ANCHORAGE_API_BASE_URL = "https://api.anchorage.com";

type AnchorageHttpMethod = "GET" | "POST" | "DELETE";

interface AnchorageRequestParams {
  method: AnchorageHttpMethod;
  apiBaseUrl: string;
  apiKey: string;
  path: string;
  body?: Record<string, unknown>;
}

type AnchorageAuthStrategy = "api-key" | "bearer";

export interface ProvisionAnchorageOptions {
  apiBaseUrl?: string;
  walletId?: string;
  walletLabel?: string;
  network?: "solana" | "solana-devnet";
}

export interface ProvisionAnchorageResult {
  walletId: string;
  address: string;
}

export interface DeleteAnchorageOptions {
  apiBaseUrl?: string;
  walletId: string;
}

export async function provisionAnchorageWallet(
  env: Env,
  options: ProvisionAnchorageOptions
): Promise<ProvisionAnchorageResult> {
  const { apiBaseUrl, apiKey } = resolveAnchorageConfig(env, options.apiBaseUrl);

  if (options.walletId) {
    const existing = await anchorageRequest<unknown>({
      method: "GET",
      apiBaseUrl,
      apiKey,
      path: `/v1/wallets/${encodeURIComponent(options.walletId)}`,
    });
    return extractAnchorageWallet(existing);
  }

  const created = await anchorageRequest<unknown>({
    method: "POST",
    apiBaseUrl,
    apiKey,
    path: "/v1/wallets",
    body: {
      network: options.network ?? "solana-devnet",
      ...(options.walletLabel ? { label: options.walletLabel } : {}),
    },
  });

  return extractAnchorageWallet(created);
}

export async function deleteAnchorageWallet(
  env: Env,
  options: DeleteAnchorageOptions
): Promise<void> {
  const { apiBaseUrl, apiKey } = resolveAnchorageConfig(env, options.apiBaseUrl);

  await anchorageRequest<void>({
    method: "DELETE",
    apiBaseUrl,
    apiKey,
    path: `/v1/wallets/${encodeURIComponent(options.walletId)}`,
  });
}

function resolveAnchorageConfig(
  env: Env,
  apiBaseUrlOverride?: string
): {
  apiBaseUrl: string;
  apiKey: string;
} {
  const apiKey = env.ANCHORAGE_API_KEY;
  if (!apiKey) {
    throw new SigningError(
      "Anchorage environment variables not configured: ANCHORAGE_API_KEY",
      "PROVIDER_NOT_CONFIGURED"
    );
  }

  return {
    apiBaseUrl: apiBaseUrlOverride ?? env.ANCHORAGE_API_BASE_URL ?? DEFAULT_ANCHORAGE_API_BASE_URL,
    apiKey,
  };
}

async function anchorageRequest<T>(params: AnchorageRequestParams): Promise<T> {
  try {
    const requestWithAuth = (authStrategy: AnchorageAuthStrategy) =>
      fetch(`${params.apiBaseUrl}${params.path}`, {
        method: params.method,
        headers: buildAnchorageHeaders(params, authStrategy),
        body: params.body ? JSON.stringify(params.body) : undefined,
      });

    let response = await requestWithAuth("api-key");
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      // Compatibility fallback for deployments still expecting Bearer auth.
      response = await requestWithAuth("bearer");
    }

    if (!response.ok) {
      const errorText = await readErrorResponseText(response);
      throw new SigningError(
        `Anchorage API error: ${response.status} - ${errorText}`,
        "NETWORK_ERROR"
      );
    }

    return parseJsonResponse<T>(response);
  } catch (error) {
    if (error instanceof SigningError) {
      throw error;
    }

    throw new SigningError(
      `Failed to call Anchorage API: ${error instanceof Error ? error.message : "Unknown error"}`,
      "NETWORK_ERROR",
      error instanceof Error ? error : undefined
    );
  }
}

function buildAnchorageHeaders(
  params: AnchorageRequestParams,
  authStrategy: AnchorageAuthStrategy
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (authStrategy === "api-key") {
    headers["Api-Key"] = params.apiKey;
  } else {
    headers.Authorization = `Bearer ${params.apiKey}`;
  }

  if (params.body) {
    headers["Content-Type"] = "application/json";
  }

  return headers;
}

function extractAnchorageWallet(payload: unknown): ProvisionAnchorageResult {
  const record = unwrapPayload(payload);
  const walletId = readString(record, ["walletId", "wallet_id", "id"]);
  const address = readString(record, ["address", "publicKey", "public_key"]);

  if (!walletId || !address) {
    throw new SigningError(
      "Anchorage wallet response missing wallet id or address",
      "INVALID_REQUEST"
    );
  }

  return { walletId, address };
}

function unwrapPayload(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const direct = payload as Record<string, unknown>;
    const nested = direct.data;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
    return direct;
  }

  return {};
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}
