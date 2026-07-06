"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createSdpApiClient } from "@/lib/sdp-api";

const DEVNET_FAUCET_LAMPORTS = 1_000_000_000;
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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

  // Format thrown by SdpApiClient.request/fetch: "SDP API request failed (XXX): <body>"
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
  const client = await createSdpApiClient();
  const res = await client.request(path, {
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
    | "anchorage"
    | "utila";
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

  const client = await createSdpApiClient();

  try {
    await client.fetch("/v1/wallets/initialize", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  } catch (error) {
    const apiError = parseApiActionError(error);

    if (
      apiError?.status === 409 &&
      apiError.message.includes("Signing already initialized for org")
    ) {
      await client.fetch("/v1/wallets", {
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
    | "utila"
    | undefined;
  const label = getOptionalString(formData, "label");

  const client = await createSdpApiClient();
  await client.fetch("/v1/wallets", {
    method: "POST",
    body: JSON.stringify({ provider, label }),
  });
}

export type WalletSetupActionResult =
  | {
      status: "success";
    }
  | {
      status: "error";
      message: string;
    };

export async function initializeCustodySetupAction(
  formData: FormData
): Promise<WalletSetupActionResult> {
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

export async function createCustodySetupWalletAction(
  formData: FormData
): Promise<WalletSetupActionResult> {
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
    const client = await createSdpApiClient();
    await client.fetch(`/v1/wallets/${encodeURIComponent(resolvedWalletId)}`, {
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

interface SolanaRpcAirdropResponse {
  result?: string;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface RpcRelayResponse<TResponse> {
  provider: {
    id: string;
    selectionMode: string;
    endpoint: string;
  };
  upstream: {
    ok: boolean;
    status: number;
    statusText: string;
  };
  response: TResponse | null;
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

export type WalletFaucetActionResult =
  | {
      status: "success";
      walletId: string;
      signature: string;
      amountSol: number;
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

  try {
    const client = await createSdpApiClient();
    const created = await client.fetch<EphemeralApiKeyResponse>("/v1/api-keys", {
      method: "POST",
      body: JSON.stringify({
        name: keyName,
        role: "api_developer",
        walletScope: "selected",
        signingWalletId: resolvedWalletId,
        signingWalletIds: [resolvedWalletId],
        expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
      }),
    });
    const ephemeralKey = created.apiKey;

    try {
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
    } finally {
      try {
        await client.fetch(`/v1/api-keys/${ephemeralKey.id}`, {
          method: "DELETE",
          body: JSON.stringify({ confirmation: ephemeralKey.name }),
        });
      } catch {
        // Best-effort cleanup of short-lived key.
      }
    }
  } catch (error) {
    return {
      status: "error",
      message: toApiActionErrorMessage(error),
    };
  }
}

export async function requestDevnetSolanaFaucetAction(
  walletId: string,
  walletAddress: string
): Promise<WalletFaucetActionResult> {
  const resolvedWalletId = walletId.trim();
  const resolvedWalletAddress = walletAddress.trim();
  if (!resolvedWalletId) {
    return { status: "error", message: "walletId is required" };
  }
  if (!SOLANA_ADDRESS_PATTERN.test(resolvedWalletAddress)) {
    return { status: "error", message: "A valid wallet address is required" };
  }

  try {
    const { orgId, userId } = await auth();
    if (!userId || !orgId) {
      return { status: "error", message: "Sign in to request devnet SOL." };
    }

    const client = await createSdpApiClient();
    const relay = await client.fetch<RpcRelayResponse<SolanaRpcAirdropResponse>>("/v1/rpc/proxy", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `wallet-faucet-${resolvedWalletId}`,
        method: "requestAirdrop",
        params: [resolvedWalletAddress, DEVNET_FAUCET_LAMPORTS],
      }),
    });

    if (!relay.upstream.ok) {
      return {
        status: "error",
        message: `Devnet faucet RPC provider ${relay.provider.id} returned HTTP ${relay.upstream.status}.`,
      };
    }

    const payload = relay.response;
    if (!payload) {
      return { status: "error", message: "Devnet faucet returned an empty RPC response." };
    }

    if (payload.error) {
      const rpcMessage = payload.error.message?.trim();
      return {
        status: "error",
        message:
          rpcMessage && rpcMessage.length > 0
            ? `Devnet faucet RPC provider ${relay.provider.id} returned: ${rpcMessage}`
            : `Devnet faucet RPC provider ${relay.provider.id} returned an error.`,
      };
    }
    if (!payload.result) {
      return { status: "error", message: "Devnet faucet returned no transaction signature." };
    }

    revalidatePath("/dashboard/custody");
    revalidatePath("/dashboard/wallets");
    revalidatePath(`/dashboard/custody/${encodeURIComponent(resolvedWalletId)}`);
    revalidatePath(`/dashboard/wallets/${encodeURIComponent(resolvedWalletId)}`);

    return {
      status: "success",
      walletId: resolvedWalletId,
      signature: payload.result,
      amountSol: DEVNET_FAUCET_LAMPORTS / 1_000_000_000,
    };
  } catch (error) {
    return {
      status: "error",
      message: toApiActionErrorMessage(error),
    };
  }
}
