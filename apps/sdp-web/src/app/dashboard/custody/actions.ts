"use server";

import { sdpApiFetch, sdpApiRequest } from "@/lib/sdp-api";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

function getString(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function getOptionalString(formData: FormData, key: string): string | undefined {
  const value = getString(formData, key);
  return value ? value : undefined;
}

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Unknown error";
}

function getApiErrorMessageFromText(body: string): string {
  if (!body) return "Request failed";

  try {
    const json = JSON.parse(body) as unknown;
    if (
      json &&
      typeof json === "object" &&
      "error" in json &&
      json.error &&
      typeof json.error === "object" &&
      "message" in json.error &&
      typeof json.error.message === "string"
    ) {
      return json.error.message;
    }
  } catch {
    // Non-JSON response body.
  }

  return body;
}

function toApiActionErrorMessage(error: unknown): string {
  const raw = extractErrorMessage(error).trim();

  // Format thrown by sdpApiFetch helpers: "SDP API request failed (XXX): <body>"
  const match = /^SDP API request failed \((\d+)\):\s*([\s\S]*)$/.exec(raw);
  if (!match) {
    return raw || "Unknown error";
  }

  const status = match[1];
  const body = match[2] ?? "";
  return `${getApiErrorMessageFromText(body)} (HTTP ${status})`;
}

async function sdpApiFetchWithApiKey<T>(
  path: string,
  apiKey: string,
  options: RequestInit = {}
): Promise<T> {
  const res = await sdpApiRequest(path, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    const apiError = getApiErrorMessageFromText(body);
    throw new Error(`SDP API request failed (${res.status}): ${apiError}`);
  }

  if (res.status === 204) {
    return {} as T;
  }

  const json = (await res.json()) as unknown;
  if (json && typeof json === "object" && "data" in json) {
    return (json as { data: T }).data;
  }

  return json as T;
}

export async function initializeCustody(formData: FormData) {
  const provider = (getString(formData, "provider") || "privy") as
    | "privy"
    | "local"
    | "fireblocks"
    | "coinbase_cdp"
    | "para"
    | "turnkey"
    | "dfns"
    | "anchorage";
  const walletLabel = getOptionalString(formData, "walletLabel");
  const apiBaseUrl = getOptionalString(formData, "apiBaseUrl");
  const fireblocksApiKey = getOptionalString(formData, "apiKey");
  const fireblocksApiSecretPem = getOptionalString(formData, "apiSecretPem");
  const fireblocksVaultAccountId = getOptionalString(formData, "vaultAccountId");
  const fireblocksAssetId = getOptionalString(formData, "assetId");
  const network = getOptionalString(formData, "network");
  const walletAddress = getOptionalString(formData, "walletAddress");
  const accountPolicy = getOptionalString(formData, "accountPolicy");

  const payload: Record<string, unknown> = {
    provider,
    walletLabel,
  };

  if (provider === "fireblocks") {
    if (!fireblocksApiKey || !fireblocksApiSecretPem || !fireblocksVaultAccountId) {
      throw new Error("Fireblocks requires apiKey, apiSecretPem, and vaultAccountId");
    }

    payload.apiKey = fireblocksApiKey;
    payload.apiSecretPem = fireblocksApiSecretPem;
    payload.vaultAccountId = fireblocksVaultAccountId;
    if (fireblocksAssetId) {
      payload.assetId = fireblocksAssetId;
    }
    if (apiBaseUrl) {
      payload.apiBaseUrl = apiBaseUrl;
    }
  } else {
    if (apiBaseUrl) {
      payload.apiBaseUrl = apiBaseUrl;
    }
    if (network) {
      payload.network = network;
    }
    if (walletAddress) {
      payload.walletAddress = walletAddress;
    }
    if (accountPolicy) {
      payload.accountPolicy = accountPolicy;
    }
  }

  await sdpApiFetch("/v1/wallets/initialize", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  revalidatePath("/dashboard/custody");
  revalidatePath("/dashboard/wallets");
  redirect("/dashboard/wallets");
}

export async function createCustodyWallet(formData: FormData) {
  const provider = getOptionalString(formData, "provider") as
    | "privy"
    | "local"
    | "fireblocks"
    | "coinbase_cdp"
    | "para"
    | "turnkey"
    | "dfns"
    | "anchorage"
    | undefined;
  const label = getOptionalString(formData, "label");
  const purpose = getOptionalString(formData, "purpose") as
    | "root"
    | "mint_authority"
    | "freeze_authority"
    | "fee_payer"
    | "transfer"
    | undefined;

  await sdpApiFetch("/v1/wallets", {
    method: "POST",
    body: JSON.stringify({ provider, label, purpose }),
  });

  revalidatePath("/dashboard/custody");
  revalidatePath("/dashboard/wallets");
  redirect("/dashboard/wallets");
}

export type UpdateWalletLabelActionResult =
  | {
      status: "success";
      label: string | null;
    }
  | {
      status: "error";
      message: string;
    };

export async function updateWalletLabelAction(
  walletId: string,
  label: string
): Promise<UpdateWalletLabelActionResult> {
  const resolvedWalletId = walletId.trim();
  if (!resolvedWalletId) {
    return { status: "error", message: "walletId is required" };
  }

  const nextLabel = label.trim();

  try {
    await sdpApiFetch(`/v1/wallets/${encodeURIComponent(resolvedWalletId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        label: nextLabel || null,
      }),
    });

    revalidatePath("/dashboard/custody");
    revalidatePath("/dashboard/wallets");

    return {
      status: "success",
      label: nextLabel || null,
    };
  } catch (error) {
    return {
      status: "error",
      message: toApiActionErrorMessage(error),
    };
  }
}

interface EphemeralApiKeyResponse {
  apiKey: {
    id: string;
    name: string;
    key: string;
  };
}

interface WalletSignerCheckResponse {
  walletId: string;
  signature: string;
}

export type WalletSignerCheckActionResult =
  | {
      status: "success";
      walletId: string;
      signature: string;
    }
  | {
      status: "error";
      message: string;
    };

export async function checkWalletSignerMemoAction(
  walletId: string
): Promise<WalletSignerCheckActionResult> {
  const resolvedWalletId = walletId.trim();
  if (!resolvedWalletId) {
    return { status: "error", message: "walletId is required" };
  }

  const now = Date.now();
  const keyName = `wallet-check-${resolvedWalletId.slice(-8)}-${now.toString(36)}`;
  const memo = `Wallet signer check (${resolvedWalletId}) ${new Date(now).toISOString()}`;

  let ephemeralKey: EphemeralApiKeyResponse["apiKey"] | null = null;

  try {
    const created = await sdpApiFetch<EphemeralApiKeyResponse>("/v1/api-keys", {
      method: "POST",
      body: JSON.stringify({
        name: keyName,
        role: "api_developer",
        environment: "sandbox",
        walletScope: "selected",
        signingWalletId: resolvedWalletId,
        signingWalletIds: [resolvedWalletId],
        expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
      }),
    });

    ephemeralKey = created.apiKey;

    const check = await sdpApiFetchWithApiKey<WalletSignerCheckResponse>(
      "/v1/wallets/signer-check",
      ephemeralKey.key,
      {
        method: "POST",
        body: JSON.stringify({ memo }),
      }
    );

    return {
      status: "success",
      walletId: check.walletId,
      signature: check.signature,
    };
  } catch (error) {
    return {
      status: "error",
      message: toApiActionErrorMessage(error),
    };
  } finally {
    if (ephemeralKey) {
      try {
        await sdpApiFetch(`/v1/api-keys/${ephemeralKey.id}`, {
          method: "DELETE",
          body: JSON.stringify({ confirmation: ephemeralKey.name }),
        });
      } catch {
        // Best-effort cleanup of short-lived key.
      }
    }
  }
}

interface RpcRelayResponse {
  response?: {
    result?: string;
    error?: {
      code?: number;
      message?: string;
    };
  };
}

function parseSolToLamports(value: string): number {
  const normalized = value.trim();
  if (!/^\d+(\.\d{1,9})?$/.test(normalized)) {
    throw new Error("Enter a valid SOL amount");
  }

  const [wholePart, fractionPart = ""] = normalized.split(".");
  const lamportsWhole = Number(wholePart) * 1_000_000_000;
  const lamportsFraction = Number(`${fractionPart}000000000`.slice(0, 9));
  const lamports = lamportsWhole + lamportsFraction;

  if (!Number.isFinite(lamports) || lamports <= 0) {
    throw new Error("Amount must be greater than zero");
  }

  if (!Number.isSafeInteger(lamports)) {
    throw new Error("Amount is too large to convert safely");
  }

  return lamports;
}

export type WalletFaucetActionResult =
  | {
      status: "success";
      amountSol: string;
      signature: string;
    }
  | {
      status: "error";
      message: string;
    };

export async function requestWalletFaucetAction(
  walletAddress: string,
  amountSol: string
): Promise<WalletFaucetActionResult> {
  const resolvedWalletAddress = walletAddress.trim();
  if (!resolvedWalletAddress) {
    return { status: "error", message: "wallet address is required" };
  }

  try {
    const lamports = parseSolToLamports(amountSol);
    const rpcResponse = await sdpApiFetch<RpcRelayResponse>("/v1/rpc/proxy", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `wallet-faucet-${resolvedWalletAddress}`,
        method: "requestAirdrop",
        params: [resolvedWalletAddress, lamports],
      }),
    });

    if (rpcResponse.response?.error?.message) {
      return {
        status: "error",
        message: rpcResponse.response.error.message,
      };
    }

    const signature = rpcResponse.response?.result?.trim();
    if (!signature) {
      return {
        status: "error",
        message: "RPC provider did not return an airdrop signature",
      };
    }

    return {
      status: "success",
      amountSol: amountSol.trim(),
      signature,
    };
  } catch (error) {
    return {
      status: "error",
      message: toApiActionErrorMessage(error),
    };
  }
}
