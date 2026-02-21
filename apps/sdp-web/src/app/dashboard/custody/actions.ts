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

function toSignerCheckErrorMessage(error: unknown): string {
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
    | "coinbase_cdp";
  const walletLabel = getOptionalString(formData, "walletLabel");
  const apiBaseUrl = getOptionalString(formData, "apiBaseUrl");
  const network = getOptionalString(formData, "network");
  const walletAddress = getOptionalString(formData, "walletAddress");
  const accountPolicy = getOptionalString(formData, "accountPolicy");

  await sdpApiFetch("/v1/wallets/initialize", {
    method: "POST",
    body: JSON.stringify({
      provider,
      walletLabel,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
      ...(network ? { network } : {}),
      ...(walletAddress ? { walletAddress } : {}),
      ...(accountPolicy ? { accountPolicy } : {}),
    }),
  });

  revalidatePath("/dashboard/custody");
  revalidatePath("/dashboard/wallets");
  redirect("/dashboard/wallets");
}

export async function switchCustodyProvider(formData: FormData) {
  const provider = (getString(formData, "provider") || "privy") as
    | "privy"
    | "local"
    | "fireblocks"
    | "coinbase_cdp";
  const confirm = getString(formData, "confirm");
  const walletLabel = getOptionalString(formData, "walletLabel");
  const apiBaseUrl = getOptionalString(formData, "apiBaseUrl");
  const network = getOptionalString(formData, "network");
  const walletAddress = getOptionalString(formData, "walletAddress");
  const accountPolicy = getOptionalString(formData, "accountPolicy");

  if (confirm.toLowerCase() !== "switch") {
    throw new Error("Type SWITCH to confirm provider change");
  }

  await sdpApiFetch("/v1/wallets/switch", {
    method: "POST",
    body: JSON.stringify({
      provider,
      walletLabel,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
      ...(network ? { network } : {}),
      ...(walletAddress ? { walletAddress } : {}),
      ...(accountPolicy ? { accountPolicy } : {}),
    }),
  });

  revalidatePath("/dashboard/custody");
  revalidatePath("/dashboard/wallets");
  redirect("/dashboard/wallets");
}

export async function createCustodyWallet(formData: FormData) {
  const label = getOptionalString(formData, "label");
  const purpose = getOptionalString(formData, "purpose") as
    | "root"
    | "mint_authority"
    | "freeze_authority"
    | "fee_payer"
    | "transfer"
    | undefined;
  const setDefault = getString(formData, "setDefault") === "on";

  await sdpApiFetch("/v1/wallets", {
    method: "POST",
    body: JSON.stringify({ label, purpose, setDefault }),
  });

  revalidatePath("/dashboard/custody");
  revalidatePath("/dashboard/wallets");
  redirect("/dashboard/wallets");
}

export async function setDefaultCustodyWallet(formData: FormData) {
  const walletId = getString(formData, "walletId");
  if (!walletId) {
    throw new Error("walletId is required");
  }

  await sdpApiFetch("/v1/wallets/default-wallet", {
    method: "POST",
    body: JSON.stringify({ walletId }),
  });

  revalidatePath("/dashboard/custody");
  revalidatePath("/dashboard/wallets");
  redirect("/dashboard/wallets");
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
        signingWalletId: resolvedWalletId,
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
      message: toSignerCheckErrorMessage(error),
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
