"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sdpApiFetch, sdpApiRequest } from "@/lib/sdp-api";

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

function parseApiActionError(error: unknown): { status: number; message: string } | null {
  const raw = extractErrorMessage(error).trim();
  const match = /^SDP API request failed \((\d+)\):\s*([\s\S]*)$/.exec(raw);
  if (!match) {
    return null;
  }

  const status = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(status)) {
    return null;
  }

  return {
    status,
    message: getApiErrorMessageFromText(match[2] ?? ""),
  };
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
  await initializeCustodyWallet(formData);
  revalidateWalletPaths();
  redirect("/dashboard/wallets");
}

async function initializeCustodyWallet(formData: FormData) {
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
  const network = getOptionalString(formData, "network");
  const walletAddress = getOptionalString(formData, "walletAddress");
  const accountPolicy = getOptionalString(formData, "accountPolicy");
  const apiBaseUrl = getOptionalString(formData, "apiBaseUrl");

  const payload: Record<string, unknown> = {
    provider,
    walletLabel,
  };

  if (provider !== "fireblocks") {
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

  try {
    await sdpApiFetch("/v1/wallets/initialize", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const apiError = parseApiActionError(error);

    if (
      apiError?.status === 409 &&
      apiError.message.includes("Signing already initialized for org")
    ) {
      await sdpApiFetch("/v1/wallets", {
        method: "POST",
        body: JSON.stringify({
          provider,
          label: walletLabel,
          purpose: "root",
          setDefault: true,
        }),
      });
    } else {
      throw error;
    }
  }
}

function revalidateWalletPaths() {
  revalidatePath("/dashboard/custody");
  revalidatePath("/dashboard/wallets");
}

export async function createCustodyWallet(formData: FormData) {
  await createCustodyWalletForProvider(formData);
  revalidateWalletPaths();
  redirect("/dashboard/wallets");
}

async function createCustodyWalletForProvider(formData: FormData) {
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

  await sdpApiFetch("/v1/wallets", {
    method: "POST",
    body: JSON.stringify({ provider, label }),
  });
}

export type WalletProvisionActionResult =
  | {
      status: "success";
    }
  | {
      status: "error";
      message: string;
    };

export async function initializeCustodyModalAction(
  formData: FormData
): Promise<WalletProvisionActionResult> {
  try {
    await initializeCustodyWallet(formData);
    revalidateWalletPaths();
    return { status: "success" };
  } catch (error) {
    return {
      status: "error",
      message: toApiActionErrorMessage(error),
    };
  }
}

export async function createCustodyWalletModalAction(
  formData: FormData
): Promise<WalletProvisionActionResult> {
  try {
    await createCustodyWalletForProvider(formData);
    revalidateWalletPaths();
    return { status: "success" };
  } catch (error) {
    return {
      status: "error",
      message: toApiActionErrorMessage(error),
    };
  }
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
