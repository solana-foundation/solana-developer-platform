"use server";

import { auth } from "@clerk/nextjs/server";
import type { CustodyConfigsResponse, InitializeSigningResponse } from "@sdp/types";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTranslations } from "@/i18n/server";
import { extractPolicyDenialReason, withPolicyDenialReason } from "@/lib/policy-denial-reason";
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
  return "";
}

function getApiErrorMessageFromText(body: string): string {
  if (!body) return "";

  try {
    const json: unknown = JSON.parse(body);
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

function toApiActionErrorMessage(
  error: unknown,
  t: Awaited<ReturnType<typeof getTranslations>>
): string {
  const raw = extractErrorMessage(error).trim();

  // Format thrown by SdpApiClient.request/fetch: "SDP API request failed (XXX): <body>"
  const match = /^SDP API request failed \((\d+)\):\s*([\s\S]*)$/.exec(raw);
  if (!match) {
    return raw || t("DashboardCustody.unknownError");
  }

  const status = match[1];
  const body = match[2] ?? "";
  const base = getApiErrorMessageFromText(body) || t("DashboardCustody.requestFailed");
  return t("DashboardCustody.httpRequestFailed", {
    error: withPolicyDenialReason(base, extractPolicyDenialReason(body)),
    status,
  });
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

export async function initializeCustody(formData: FormData) {
  await initializeCustodyWallet(formData);
  revalidateWalletPaths();
  redirect("/dashboard/wallets");
}

/**
 * Returns the wallet the call provisioned so callers can show it. Onboarding
 * previously discarded this and left the user with no evidence of what setup
 * created for them.
 */
async function initializeCustodyWallet(formData: FormData): Promise<OnboardingProvisionedWallet> {
  const provider = (getString(formData, "provider") || "privy") as
    | "privy"
    | "local"
    | "fireblocks"
    | "coinbase_cdp"
    | "para"
    | "turnkey"
    | "dfns"
    | "ibm_haven"
    | "anchorage"
    | "utila";
  const walletLabel = getOptionalString(formData, "walletLabel");
  const network = getOptionalString(formData, "network");
  const accountPolicy = getOptionalString(formData, "accountPolicy");

  const payload: Record<string, unknown> = {
    provider,
    walletLabel,
  };

  if (provider !== "fireblocks") {
    if (network) {
      payload.network = network;
    }
    if (accountPolicy) {
      payload.accountPolicy = accountPolicy;
    }
  }

  const client = await createSdpApiClient();

  try {
    const initialized = await client.fetch<InitializeSigningResponse>("/v1/wallets/initialize", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return { publicKey: initialized.publicKey, walletId: initialized.walletId };
  } catch (error) {
    const apiError = parseApiActionError(error);

    if (
      apiError?.status === 409 &&
      apiError.message.includes("Signing already initialized for org")
    ) {
      const configurations = await client.fetch<CustodyConfigsResponse>("/v1/wallets/configs");

      // Repair must never cross providers. If another provider already owns the
      // default configuration, "repairing" with setDefault would silently flip
      // the organization's signing default to whatever provider this caller
      // submitted; changing providers is the switch flow's decision, behind its
      // own confirmation. Surface the conflict instead.
      const defaultConfiguration = configurations.configs.find(
        (configuration) => configuration.isDefault
      );
      if (defaultConfiguration && defaultConfiguration.provider !== provider) {
        throw error;
      }

      const readyConfiguration = configurations.configs.find(
        (configuration) =>
          configuration.provider === provider &&
          configuration.isDefault &&
          configuration.defaultWalletId !== null
      );

      if (readyConfiguration) {
        // Already provisioned by an earlier attempt; the configuration carries
        // the wallet, so completion can still show it.
        return {
          publicKey: readyConfiguration.publicKey,
          walletId: readyConfiguration.defaultWalletId as string,
        };
      }

      // Repair a provider connection whose first wallet did not finish
      // persisting instead of leaving the organization trapped in onboarding.
      // This endpoint nests its wallet, unlike initialize.
      const repaired = await client.fetch<{ wallet: { walletId: string; publicKey: string } }>(
        "/v1/wallets",
        {
          method: "POST",
          body: JSON.stringify({
            provider,
            label: walletLabel,
            purpose: "root",
            setDefault: true,
          }),
        }
      );
      return { publicKey: repaired.wallet.publicKey, walletId: repaired.wallet.walletId };
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
    | "ibm_haven"
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

/** A provisioned wallet is `null` when an earlier attempt had already created it. */
export interface OnboardingProvisionedWallet {
  publicKey: string;
  walletId: string;
}

export type OnboardingCustodyActionResult =
  | {
      status: "success";
      wallet: OnboardingProvisionedWallet;
    }
  | {
      status: "error";
      message: string;
    };

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
  const t = await getTranslations();
  try {
    await initializeCustodyWallet(formData);
    revalidateWalletPaths();
    return { status: "success" };
  } catch (error) {
    return {
      status: "error",
      message: toApiActionErrorMessage(error, t),
    };
  }
}

export async function initializeOnboardingCustodyAction(
  formData: FormData
): Promise<OnboardingCustodyActionResult> {
  const t = await getTranslations();
  try {
    const wallet = await initializeCustodyWallet(formData);
    // No revalidation here: any revalidatePath from this action invalidates the
    // client router cache and re-runs the onboarding route, whose server page
    // redirects once setup is complete, sweeping the completion panel away
    // after a beat. The panel exits through full document navigations, which
    // fetch fresh state without any help.
    return {
      status: "success",
      wallet: { publicKey: wallet.publicKey, walletId: wallet.walletId },
    };
  } catch (error) {
    return {
      status: "error",
      message: toApiActionErrorMessage(error, t),
    };
  }
}

export async function createCustodySetupWalletAction(
  formData: FormData
): Promise<WalletSetupActionResult> {
  const t = await getTranslations();
  try {
    await createCustodyWalletForProvider(formData);
    revalidateWalletPaths();
    return { status: "success" };
  } catch (error) {
    return {
      status: "error",
      message: toApiActionErrorMessage(error, t),
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
  const t = await getTranslations();
  const resolvedWalletId = walletId.trim();
  if (!resolvedWalletId) {
    return { status: "error", message: t("DashboardCustody.walletIdRequired") };
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
    revalidatePath(`/dashboard/wallets/${encodeURIComponent(resolvedWalletId)}`);

    return {
      status: "success",
      label: nextLabel || null,
    };
  } catch (error) {
    return {
      status: "error",
      message: toApiActionErrorMessage(error, t),
    };
  }
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
  const t = await getTranslations();
  const resolvedWalletId = walletId.trim();
  if (!resolvedWalletId) {
    return { status: "error", message: t("DashboardCustody.walletIdRequired") };
  }

  try {
    const client = await createSdpApiClient();
    const check = await client.fetch<WalletSignerCheckResponse>("/v1/wallets/signer-check", {
      method: "POST",
      body: JSON.stringify({ walletId: resolvedWalletId }),
    });

    return {
      status: "success",
      walletId: check.walletId,
      signature: check.signature,
    };
  } catch (error) {
    return {
      status: "error",
      message: toApiActionErrorMessage(error, t),
    };
  }
}

export async function requestDevnetSolanaFaucetAction(
  walletId: string,
  walletAddress: string
): Promise<WalletFaucetActionResult> {
  const t = await getTranslations();
  const resolvedWalletId = walletId.trim();
  const resolvedWalletAddress = walletAddress.trim();
  if (!resolvedWalletId) {
    return { status: "error", message: t("DashboardCustody.walletIdRequired") };
  }
  if (!SOLANA_ADDRESS_PATTERN.test(resolvedWalletAddress)) {
    return { status: "error", message: t("DashboardCustody.validWalletAddressRequired") };
  }

  try {
    const { orgId, userId } = await auth();
    if (!userId || !orgId) {
      return { status: "error", message: t("DashboardCustody.signInToRequestDevnetSol") };
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
        message: t("DashboardCustody.devnetFaucetHttpError", {
          provider: relay.provider.id,
          status: relay.upstream.status,
        }),
      };
    }

    const payload = relay.response;
    if (!payload) {
      return { status: "error", message: t("DashboardCustody.devnetFaucetEmptyResponse") };
    }

    if (payload.error) {
      const rpcMessage = payload.error.message?.trim();
      return {
        status: "error",
        message:
          rpcMessage && rpcMessage.length > 0
            ? t("DashboardCustody.devnetFaucetProviderError", {
                provider: relay.provider.id,
                error: rpcMessage,
              })
            : t("DashboardCustody.devnetFaucetProviderGenericError", {
                provider: relay.provider.id,
              }),
      };
    }
    if (!payload.result) {
      return { status: "error", message: t("DashboardCustody.devnetFaucetNoSignature") };
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
      message: toApiActionErrorMessage(error, t),
    };
  }
}
