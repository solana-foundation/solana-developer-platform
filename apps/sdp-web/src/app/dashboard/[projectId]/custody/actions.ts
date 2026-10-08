"use server";

import { auth } from "@clerk/nextjs/server";
import {
  commitmentComparator,
  decimalFixedPointToNumber,
  type GetSignatureStatusesApi,
  isAddress,
  sol,
  solToLamports,
} from "@solana/kit";
import { revalidatePath } from "next/cache";
import { getTranslations } from "@/i18n/server";
import { extractPolicyDenialReason, withPolicyDenialReason } from "@/lib/policy-denial-reason";
import { createSdpApiClient, requestProjectHref, type SdpApiClient } from "@/lib/sdp-api";
import { isKnownCustodyProvider, type KnownCustodyProvider } from "./provider-catalog";

const DEVNET_FAUCET_SOL = sol("1");

function getString(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

function getOptionalString(formData: FormData, key: string): string | undefined {
  const value = getString(formData, key);
  return value ? value : undefined;
}

/**
 * Reads the custody provider a wallet form names. Every wallet form submits
 * one, so a missing or unknown value is a broken form and fails loudly.
 *
 * @param formData - The submitted wallet form.
 * @returns The named custody provider.
 */
function requireCustodyProvider(formData: FormData): KnownCustodyProvider {
  const provider = getString(formData, "provider");
  if (!isKnownCustodyProvider(provider)) {
    throw new Error(`Unknown custody provider: "${provider}"`);
  }
  return provider;
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

/**
 * Reads the HTTP status from an error thrown by `SdpApiClient.fetch`.
 *
 * @param error - The caught error.
 * @returns The response status, or null when the error is not an API response failure.
 */
function parseApiErrorStatus(error: unknown): number | null {
  const match = /^SDP API request failed \((\d+)\):/.exec(extractErrorMessage(error).trim());
  return match ? Number(match[1]) : null;
}

/**
 * Connects the provider the form names and provisions its first wallet.
 *
 * @param formData - The submitted setup form: `provider`, optional `walletLabel`, `network`, `accountPolicy`.
 */
async function initializeCustodyWallet(formData: FormData): Promise<void> {
  const provider = requireCustodyProvider(formData);
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
  await client.fetch("/v1/wallets/initialize", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function revalidateWalletPaths() {
  revalidatePath(await requestProjectHref("/dashboard/custody"));
  revalidatePath(await requestProjectHref("/dashboard/wallets"));
}

/**
 * Creates a wallet in the provider account the form names: the connection
 * when one is chosen (BYOK), otherwise the provider's Managed config. The
 * request always names exactly one of them; there is no default to fall to.
 *
 * @param formData - The submitted wallet form: `provider`, optional `connectionId`, optional `label`.
 */
async function createCustodyWalletForProvider(formData: FormData) {
  const label = getOptionalString(formData, "label");
  // A Connection pins the wallet to one specific stored credential, which
  // `provider` alone cannot do once a project holds several connections of the
  // same provider. Sending both would leave the API to guess, so the explicit
  // choice wins and `provider` is dropped.
  const connectionId = getOptionalString(formData, "connectionId");
  const target = connectionId ? { connectionId } : { provider: requireCustodyProvider(formData) };

  const client = await createSdpApiClient();
  await client.fetch("/v1/wallets", {
    method: "POST",
    body: JSON.stringify({ ...target, label }),
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

export type InitializeCustodySetupActionResult =
  | WalletSetupActionResult
  | {
      status: "provider_already_set_up";
    };

/**
 * Connects a provider from the setup flow. `/initialize` answers 409 only when
 * the project already holds this provider's Managed config; that is reported
 * as its own result so the flow can send the user to add a wallet instead.
 *
 * @param formData - The submitted setup form.
 * @returns The setup outcome.
 */
export async function initializeCustodySetupAction(
  formData: FormData
): Promise<InitializeCustodySetupActionResult> {
  const t = await getTranslations();
  try {
    await initializeCustodyWallet(formData);
    await revalidateWalletPaths();
    return { status: "success" };
  } catch (error) {
    if (parseApiErrorStatus(error) === 409) {
      return { status: "provider_already_set_up" };
    }
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
    await revalidateWalletPaths();
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

    revalidatePath(await requestProjectHref("/dashboard/custody"));
    revalidatePath(await requestProjectHref("/dashboard/wallets"));
    revalidatePath(
      await requestProjectHref(`/dashboard/wallets/${encodeURIComponent(resolvedWalletId)}`)
    );

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

interface SolanaRpcSignatureStatusesResponse {
  result?: ReturnType<GetSignatureStatusesApi["getSignatureStatuses"]>;
}

const FAUCET_CONFIRMATION_TIMEOUT_MS = 15_000;
const FAUCET_CONFIRMATION_POLL_MS = 1_000;

/**
 * Poll the transaction's status through the RPC relay until it is confirmed or
 * failed, or the timeout passes. On timeout the caller still revalidates, and the
 * page's balance polling picks up the result later.
 */
async function waitForSignatureConfirmation(
  client: SdpApiClient,
  signature: string
): Promise<"confirmed" | "failed" | "timeout"> {
  const deadline = Date.now() + FAUCET_CONFIRMATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let relay: RpcRelayResponse<SolanaRpcSignatureStatusesResponse>;
    try {
      relay = await client.fetch<RpcRelayResponse<SolanaRpcSignatureStatusesResponse>>(
        "/v1/rpc/proxy",
        {
          method: "POST",
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: `wallet-faucet-status-${signature}`,
            method: "getSignatureStatuses",
            params: [[signature]],
          }),
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        }
      );
    } catch (error) {
      // The deadline abort ends the wait; any other failure may be transient, so keep checking.
      if (error instanceof DOMException && error.name === "TimeoutError") {
        return "timeout";
      }
      console.warn(
        JSON.stringify({
          event: "wallet_faucet_confirmation_check_failed",
          name: error instanceof Error ? error.name : "non-error",
        })
      );
      await new Promise((resolve) => setTimeout(resolve, FAUCET_CONFIRMATION_POLL_MS));
      continue;
    }
    const status = relay.response?.result?.value[0];
    if (status?.err) {
      return "failed";
    }
    if (
      status?.confirmationStatus &&
      commitmentComparator(status.confirmationStatus, "confirmed") >= 0
    ) {
      return "confirmed";
    }
    await new Promise((resolve) => setTimeout(resolve, FAUCET_CONFIRMATION_POLL_MS));
  }
  return "timeout";
}

interface RpcRelayResponse<TResponse> {
  provider: {
    id: string;
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
  if (!isAddress(resolvedWalletAddress)) {
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
        params: [resolvedWalletAddress, Number(solToLamports(DEVNET_FAUCET_SOL))],
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

    // requestAirdrop returns once the transaction is submitted. Revalidating now would
    // re-read the pre-airdrop balance, so wait (bounded) for confirmation first.
    if ((await waitForSignatureConfirmation(client, payload.result)) === "failed") {
      return {
        status: "error",
        message: t("DashboardCustody.devnetFaucetProviderGenericError", {
          provider: relay.provider.id,
        }),
      };
    }

    revalidatePath(await requestProjectHref("/dashboard/custody"));
    revalidatePath(await requestProjectHref("/dashboard/wallets"));
    revalidatePath(
      await requestProjectHref(`/dashboard/custody/${encodeURIComponent(resolvedWalletId)}`)
    );
    revalidatePath(
      await requestProjectHref(`/dashboard/wallets/${encodeURIComponent(resolvedWalletId)}`)
    );

    return {
      status: "success",
      walletId: resolvedWalletId,
      signature: payload.result,
      amountSol: decimalFixedPointToNumber(DEVNET_FAUCET_SOL),
    };
  } catch (error) {
    return {
      status: "error",
      message: toApiActionErrorMessage(error, t),
    };
  }
}
