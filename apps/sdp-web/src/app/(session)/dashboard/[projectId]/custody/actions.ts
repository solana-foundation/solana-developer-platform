"use server";

import { auth } from "@clerk/nextjs/server";
import type { WalletFaucetResponse } from "@sdp/types/custody";
import { isIdempotencyErrorCode } from "@sdp/types/idempotency";
import { decimalFixedPointToNumber, lamports, lamportsToSol } from "@solana/kit";
import { revalidatePath } from "next/cache";
import { getTranslations } from "@/i18n/server";
import {
  type ApiAnswer,
  actionIdempotencyHeaders,
  isOutcomeUnknownAnswer,
} from "@/lib/idempotency";
import { createSdpApiClient, requestProjectHref, sdpApiAnswer } from "@/lib/sdp-api";
import { isKnownCustodyProvider, type KnownCustodyProvider } from "./provider-catalog";

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
  // The earlier request may have run: the user checks the list before trying again.
  if (isOutcomeUnknownAnswer(sdpApiAnswer(error))) {
    return t("Shared.idempotency.outcomeUnknownCheckList");
  }
  const raw = extractErrorMessage(error).trim();

  // Format thrown by SdpApiClient.request/fetch: "SDP API request failed (XXX): <body>"
  const match = /^SDP API request failed \((\d+)\):\s*([\s\S]*)$/.exec(raw);
  if (!match) {
    return raw || t("DashboardCustody.unknownError");
  }

  const status = match[1];
  const body = match[2] ?? "";
  const base = getApiErrorMessageFromText(body) || t("DashboardCustody.requestFailed");
  return t("DashboardCustody.httpRequestFailed", { error: base, status });
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
    headers: actionIdempotencyHeaders(formData.get("idempotencyKey")),
  });
}

async function revalidateWalletPaths() {
  revalidatePath(await requestProjectHref("/dashboard/custody"));
  revalidatePath(await requestProjectHref("/dashboard/wallets"));
}

/** The purposes the create endpoint accepts; anything else is left for the API to default. */
const CREATABLE_WALLET_PURPOSES = new Set<string>([
  "transfer",
  "mint_authority",
  "freeze_authority",
  "fee_payer",
]);

function parseWalletPurpose(value: string | undefined): string | undefined {
  return value && CREATABLE_WALLET_PURPOSES.has(value) ? value : undefined;
}

/**
 * Creates a wallet in the provider account the form names: the connection
 * when one is chosen (BYOK), otherwise the provider's Managed config. The
 * request always names exactly one of them; there is no default to fall to.
 *
 * @param formData - The submitted wallet form: `provider`, optional `connectionId`, optional
 *   `label`, optional `purpose`.
 */
async function createCustodyWalletForProvider(formData: FormData) {
  const label = getOptionalString(formData, "label");
  const purpose = parseWalletPurpose(getOptionalString(formData, "purpose"));
  // A Connection pins the wallet to one specific stored credential, which
  // `provider` alone cannot do once a project holds several connections of the
  // same provider. Sending both would leave the API to guess, so the explicit
  // choice wins and `provider` is dropped.
  const connectionId = getOptionalString(formData, "connectionId");
  const target = connectionId ? { connectionId } : { provider: requireCustodyProvider(formData) };

  const client = await createSdpApiClient();
  await client.fetch("/v1/wallets", {
    method: "POST",
    body: JSON.stringify({ ...target, label, purpose }),
    headers: actionIdempotencyHeaders(formData.get("idempotencyKey")),
  });
}

export type WalletSetupActionResult =
  | {
      status: "success";
    }
  | {
      status: "error";
      message: string;
      /** What the failure settles about the browser's key (`useActionIdempotencyKey`). */
      answer: ApiAnswer;
    };

export type InitializeCustodySetupActionResult =
  | WalletSetupActionResult
  | {
      status: "provider_already_set_up";
      answer: ApiAnswer;
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
    const answer = sdpApiAnswer(error);
    // Only the provider's own conflict means it is set up. The key's refusals (a
    // request still in flight, an unknown outcome) are errors the user can act on.
    if (answer.status === 409 && !isIdempotencyErrorCode(answer.code)) {
      return { status: "provider_already_set_up", answer };
    }
    return {
      status: "error",
      message: toApiActionErrorMessage(error, t),
      answer: sdpApiAnswer(error),
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
      answer: sdpApiAnswer(error),
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
      answer: ApiAnswer;
    };

export async function updateWalletLabelAction(
  walletId: string,
  label: string,
  idempotencyKey?: string
): Promise<UpdateWalletLabelActionResult> {
  const t = await getTranslations();
  const resolvedWalletId = walletId.trim();
  if (!resolvedWalletId) {
    // Refused before anything was sent.
    return {
      status: "error",
      message: t("DashboardCustody.walletIdRequired"),
      answer: { status: null, replayed: false, code: null },
    };
  }

  const nextLabel = label.trim();

  try {
    const client = await createSdpApiClient();
    await client.fetch(`/v1/wallets/${encodeURIComponent(resolvedWalletId)}`, {
      method: "PATCH",
      headers: actionIdempotencyHeaders(idempotencyKey),
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
      answer: sdpApiAnswer(error),
    };
  }
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

/**
 * Proves the wallet's signer can sign, in simulation. Nothing is broadcast, so
 * the check carries no Idempotency-Key: every press is a fresh probe of the
 * signer as it is now, where a key would replay an earlier failure after the
 * user fixed the signer.
 */
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

/** Airdrops devnet SOL to the wallet. */
export async function requestDevnetSolanaFaucetAction(
  walletId: string
): Promise<WalletFaucetActionResult> {
  const t = await getTranslations();
  const resolvedWalletId = walletId.trim();
  if (!resolvedWalletId) {
    return { status: "error", message: t("DashboardCustody.walletIdRequired") };
  }

  try {
    const { orgId, userId } = await auth();
    if (!userId || !orgId) {
      return { status: "error", message: t("DashboardCustody.signInToRequestDevnetSol") };
    }

    const client = await createSdpApiClient();
    // The API waits (bounded) for the airdrop to confirm, so revalidating next reads the funded balance.
    const airdrop = await client.fetch<WalletFaucetResponse>(
      `/internal/dashboard/wallets/${encodeURIComponent(resolvedWalletId)}/faucet`,
      { method: "POST" }
    );
    if (airdrop.status === "failed") {
      return { status: "error", message: t("DashboardCustody.devnetFaucetTransactionFailed") };
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
      signature: airdrop.signature,
      amountSol: decimalFixedPointToNumber(lamportsToSol(lamports(BigInt(airdrop.lamports)))),
    };
  } catch (error) {
    return {
      status: "error",
      message: toApiActionErrorMessage(error, t),
    };
  }
}
