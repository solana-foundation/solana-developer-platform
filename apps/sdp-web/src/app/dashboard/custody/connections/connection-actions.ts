"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient, extractSdpApiError } from "@/lib/sdp-api";
import type { CustodyOutcomeKind } from "./verification-outcome";
import { resolveHttpOutcome, resolveRotationOutcome } from "./verification-outcome";

/**
 * Every lifecycle action answers in one of three ways, and the third is the
 * point: `unknown` means the request may well have committed, so the UI must
 * offer a re-read rather than report a failure. Actions never throw — a
 * rejected promise would skip the branch that distinguishes the three.
 */
export type CustodyActionResult =
  | { status: "success" }
  | { status: "failed"; kind: CustodyOutcomeKind; message: string }
  | { status: "unknown"; message: string };

interface RotationResponse {
  providerCredential: { id: string };
  rotation: { status: "success" | "failed" | "retry_unknown"; code?: string };
}

function revalidateCustody(provider: string, connectionId?: string) {
  revalidatePath(`/dashboard/integrations/${provider}`);
  if (connectionId) {
    revalidatePath(`/dashboard/integrations/${provider}/connections/${connectionId}`);
  }
  // Wallet surfaces read the same connections, and a default switch or a new
  // wallet changes what they show.
  revalidatePath("/dashboard/wallets");
  revalidatePath("/dashboard/custody");
}

/**
 * Classify a thrown request. Mirrors the server-side split in `byok-actions.ts`:
 * under 500 and not 408/429, the server answered and nothing committed;
 * anything else — including no response at all — leaves the outcome open.
 */
function classifyThrown(
  error: unknown,
  fallback: string
): Exclude<CustodyActionResult, { status: "success" }> {
  const { status, message } = extractSdpApiError(error);
  if (status !== null && status < 500 && status !== 408 && status !== 429) {
    return {
      status: "failed",
      kind: resolveHttpOutcome(status).kind,
      message: message || fallback,
    };
  }
  return { status: "unknown", message: message || fallback };
}

/**
 * Replaces the credentials behind this account for every connection that uses
 * them. The idempotency key is minted by the client per user intent and MUST be
 * reused verbatim on retry: the server replays the original result for a
 * repeated key rather than opening a second rotation.
 *
 * Note the rejection path — an invalid or foreign-account credential comes back
 * on an HTTP **200** with `rotation.status === "failed"`, so the result body is
 * what settles this, not the status code.
 */
export async function rotateCredentialsAction(
  formData: FormData,
  isRecoveryAttempt = false
): Promise<CustodyActionResult> {
  const t = await getTranslations();
  const fallback = t("DashboardCustody.rotateFailed");

  const credentialId = String(formData.get("credentialId") ?? "").trim();
  const provider = String(formData.get("provider") ?? "privy").trim();
  const connectionId = String(formData.get("connectionId") ?? "").trim();
  const idempotencyKey = String(formData.get("idempotencyKey") ?? "").trim();
  const appId = String(formData.get("appId") ?? "").trim();
  const appSecret = String(formData.get("appSecret") ?? "");

  if (!credentialId || !idempotencyKey || !appId || !appSecret) {
    return {
      status: "failed",
      kind: "invalid_credentials",
      message: t("DashboardCustody.byokMissingFields"),
    };
  }

  let result: RotationResponse;
  try {
    const client = await createSdpApiClient();
    result = await client.fetch<RotationResponse>(
      `/internal/dashboard/custody/provider-credentials/${encodeURIComponent(credentialId)}/rotate`,
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ fields: { appId, appSecret } }),
      }
    );
  } catch (error) {
    const result = classifyThrown(error, fallback);
    // A replay can be refused before the server reads the original outcome.
    // Only a rotation result can settle an earlier unknown submission.
    return isRecoveryAttempt ? { status: "unknown", message: result.message } : result;
  }

  const outcome = resolveRotationOutcome(result.rotation);
  if (!outcome) {
    revalidateCustody(provider, connectionId);
    return { status: "success" };
  }
  // A candidate now exists server-side even though it did not cut over, so the
  // page must be re-read either way: the credentials card has a pending
  // rotation to offer retry or cancel on.
  revalidateCustody(provider, connectionId);
  return outcome.kind === "unknown"
    ? { status: "unknown", message: t("DashboardCustody.rotateUnknown") }
    : { status: "failed", kind: outcome.kind, message: fallback };
}

/** Settles a rotation candidate left pending by an unknown outcome. */
export async function completeRotationAction(
  candidateId: string,
  provider: string,
  connectionId: string
): Promise<CustodyActionResult> {
  const t = await getTranslations();
  let result: RotationResponse;
  try {
    const client = await createSdpApiClient();
    result = await client.fetch<RotationResponse>(
      `/internal/dashboard/custody/provider-credentials/${encodeURIComponent(candidateId)}/complete-rotation`,
      { method: "POST", body: JSON.stringify({}) }
    );
  } catch (error) {
    return classifyThrown(error, t("DashboardCustody.rotateFailed"));
  }

  revalidateCustody(provider, connectionId);
  const outcome = resolveRotationOutcome(result.rotation);
  if (!outcome) return { status: "success" };
  return outcome.kind === "unknown"
    ? { status: "unknown", message: t("DashboardCustody.rotateUnknown") }
    : { status: "failed", kind: outcome.kind, message: t("DashboardCustody.rotateFailed") };
}

/**
 * Cancels a pending rotation candidate. This is credential deactivation aimed
 * at the candidate rather than the active credential — the API distinguishes
 * the two intents in its audit trail.
 */
export async function cancelRotationAction(
  candidateId: string,
  provider: string,
  connectionId: string
): Promise<CustodyActionResult> {
  return deactivateCredentialAction(candidateId, provider, connectionId);
}

/** Restores the immediately previous credentials, inside the 24-hour window. */
export async function rollbackCredentialAction(
  credentialId: string,
  provider: string,
  connectionId: string
): Promise<CustodyActionResult> {
  const t = await getTranslations();
  try {
    const client = await createSdpApiClient();
    await client.fetch(
      `/internal/dashboard/custody/provider-credentials/${encodeURIComponent(credentialId)}/rollback`,
      { method: "POST", body: JSON.stringify({}) }
    );
  } catch (error) {
    return classifyThrown(error, t("DashboardCustody.rollbackFailed"));
  }
  revalidateCustody(provider, connectionId);
  return { status: "success" };
}

/** Deactivates credentials nothing references any more; deletes the stored secret. */
export async function deactivateCredentialAction(
  credentialId: string,
  provider: string,
  connectionId: string
): Promise<CustodyActionResult> {
  const t = await getTranslations();
  try {
    const client = await createSdpApiClient();
    await client.fetch(
      `/internal/dashboard/custody/provider-credentials/${encodeURIComponent(credentialId)}/deactivate`,
      { method: "POST", body: JSON.stringify({}) }
    );
  } catch (error) {
    return classifyThrown(error, t("DashboardCustody.deactivateCredentialsFailed"));
  }
  revalidateCustody(provider, connectionId);
  return { status: "success" };
}

/** Permanently ends a connection. Refused by the API while it has active wallets. */
export async function deactivateConnectionAction(
  connectionId: string,
  provider: string
): Promise<CustodyActionResult> {
  const t = await getTranslations();
  try {
    const client = await createSdpApiClient();
    await client.fetch(
      `/internal/dashboard/custody/connections/${encodeURIComponent(connectionId)}/deactivate`,
      { method: "POST", body: JSON.stringify({}) }
    );
  } catch (error) {
    return classifyThrown(error, t("DashboardCustody.deactivateConnectionFailed"));
  }
  revalidateCustody(provider, connectionId);
  return { status: "success" };
}

/**
 * Cancels unfinished setup and starts stored-secret cleanup.
 * The deactivated connection remains in the list for history.
 */
export async function cancelSetupAction(
  connectionId: string,
  provider: string
): Promise<CustodyActionResult> {
  const t = await getTranslations();
  try {
    const client = await createSdpApiClient();
    await client.fetch(
      `/internal/dashboard/custody/connections/${encodeURIComponent(connectionId)}/cancel`,
      { method: "POST", body: JSON.stringify({}) }
    );
  } catch (error) {
    return classifyThrown(error, t("DashboardCustody.cancelSetupFailed"));
  }
  revalidateCustody(provider);
  return { status: "success" };
}

/**
 * Points the project's wallet-less requests at this connection. Moves no
 * wallets, no funds, and no already-pinned operations.
 */
export async function makeDefaultConnectionAction(
  connectionId: string,
  provider: string
): Promise<CustodyActionResult> {
  const t = await getTranslations();
  try {
    const client = await createSdpApiClient();
    await client.fetch("/v1/wallets/switch", {
      method: "POST",
      body: JSON.stringify({ connectionId, provider }),
    });
  } catch (error) {
    return classifyThrown(error, t("DashboardCustody.makeDefaultFailed"));
  }
  revalidateCustody(provider, connectionId);
  return { status: "success" };
}

/**
 * Creates a wallet inside this connection's provider account.
 *
 * Deliberately not auto-retried on an unknown outcome: wallet creation is not
 * idempotent here, so a silent retry could mint a second wallet. The dialog
 * tells the user to check the list first.
 */
export async function createConnectionWalletAction(
  formData: FormData
): Promise<CustodyActionResult> {
  const t = await getTranslations();
  const connectionId = String(formData.get("connectionId") ?? "").trim();
  const provider = String(formData.get("provider") ?? "privy").trim();
  const label = String(formData.get("label") ?? "").trim();

  if (!connectionId) {
    return {
      status: "failed",
      kind: "invalid_credentials",
      message: t("DashboardCustody.byokMissingFields"),
    };
  }

  try {
    const client = await createSdpApiClient();
    await client.fetch("/v1/wallets", {
      method: "POST",
      body: JSON.stringify({ connectionId, ...(label ? { label } : {}) }),
    });
  } catch (error) {
    return classifyThrown(error, t("DashboardCustody.addWalletFailed"));
  }
  revalidateCustody(provider, connectionId);
  return { status: "success" };
}
