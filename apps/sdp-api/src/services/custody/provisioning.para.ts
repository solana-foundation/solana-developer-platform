import { SigningError } from "@/services/ports";
import { parseJsonResponse, readErrorResponseText, sleep } from "./provisioning.common";

const PARA_WALLET_READY_MAX_ATTEMPTS = 8;
const PARA_WALLET_READY_DELAY_MS = 500;

export interface ParaRequestParams {
  method: "GET" | "POST";
  path: string;
  apiBaseUrl: string;
  apiKey: string;
  body?: Record<string, unknown>;
}

export interface ParaWalletResponse {
  id: string;
  type?: "EVM" | "SOLANA" | "COSMOS";
  scheme?: "DKLS" | "CGGMP" | "ED25519";
  status?: "creating" | "ready" | string;
  address?: string;
  publicKey?: string;
}

export async function paraRequest<T>(params: ParaRequestParams): Promise<T> {
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
      const errorText = await readErrorResponseText(response);
      throw new SigningError(
        `Para API error: ${response.status} - ${errorText}`,
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    const payload = await parseJsonResponse<unknown>(response);
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

export async function waitForParaWalletReady(params: {
  apiBaseUrl: string;
  apiKey: string;
  walletId: string;
}): Promise<ParaWalletResponse> {
  let latestWallet: ParaWalletResponse | null = null;
  let latestTransientError: string | null = null;

  for (let attempt = 1; attempt <= PARA_WALLET_READY_MAX_ATTEMPTS; attempt += 1) {
    let wallet: ParaWalletResponse;
    try {
      wallet = await paraRequest<ParaWalletResponse>({
        apiBaseUrl: params.apiBaseUrl,
        apiKey: params.apiKey,
        method: "GET",
        path: `/v1/wallets/${encodeURIComponent(params.walletId)}`,
      });
    } catch (error) {
      if (!isParaAddressPendingError(error) || attempt === PARA_WALLET_READY_MAX_ATTEMPTS) {
        throw error;
      }

      latestTransientError = error.message;
      await sleep(PARA_WALLET_READY_DELAY_MS);
      continue;
    }

    latestWallet = wallet;
    if (wallet.status === "ready" && wallet.address) {
      return wallet;
    }

    if (attempt < PARA_WALLET_READY_MAX_ATTEMPTS) {
      await sleep(PARA_WALLET_READY_DELAY_MS);
    }
  }

  throw new SigningError(
    `Para wallet '${params.walletId}' did not become ready after ${PARA_WALLET_READY_MAX_ATTEMPTS} attempts (status: ${latestWallet?.status ?? "unknown"}${latestTransientError ? `, last error: ${latestTransientError}` : ""})`,
    "PROVIDER_NOT_CONFIGURED"
  );
}

function isParaAddressPendingError(error: unknown): error is SigningError {
  if (!(error instanceof SigningError)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("para api error: 500") && message.includes("wallet address not found");
}

export function validateParaWallet(
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

export function buildParaUserIdentifier(params: { orgId: string; projectId?: string }): string {
  const scope = params.projectId
    ? `org:${params.orgId}:project:${params.projectId}`
    : `org:${params.orgId}`;
  return `sdp:${scope}:wallet:${crypto.randomUUID()}`;
}
