"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "@/i18n/server";
import { createSdpApiClient } from "@/lib/sdp-api";

interface SafeProviderCredential {
  id: string;
  provider: "privy";
  label: string;
  scope: "organization" | "project";
  status: string;
  displayMetadata: { appIdSuffix?: string };
}

interface ProviderCredentialCheckResult {
  providerCredential: SafeProviderCredential;
  check: {
    status: "success" | "failed" | "retry_unknown";
    checkedAt: string;
  };
}

/**
 * What the credential form renders next.
 *
 * `failed` is terminal for this attempt: either the provider conclusively
 * rejected the credential (which the server then removes), or the server
 * refused the check in a way no re-check can change. The retry is a fresh
 * submission and the client must mint a NEW idempotency key. `retry_unknown`
 * keeps the credential; the safe move is re-running the check against the
 * same id.
 */
export type PrivyByokSubmitResult =
  | { status: "success" }
  | { status: "failed"; message: string }
  | { status: "retry_unknown"; providerCredentialId: string }
  | { status: "error"; message: string };

function extractApiMessage(error: unknown): { status: number | null; message: string } {
  const raw = error instanceof Error ? error.message : String(error);
  const match = /^SDP API request failed \((\d+)\):\s*([\s\S]*)$/.exec(raw.trim());
  if (!match) {
    return { status: null, message: raw };
  }
  let message = match[2] ?? "";
  try {
    const json = JSON.parse(message) as { error?: { message?: string } };
    if (json.error?.message) {
      message = json.error.message;
    }
  } catch {
    // Non-JSON body.
  }
  return { status: Number.parseInt(match[1] ?? "", 10), message };
}

async function runCheck(providerCredentialId: string): Promise<PrivyByokSubmitResult> {
  const t = await getTranslations();
  const client = await createSdpApiClient();

  let result: ProviderCredentialCheckResult;
  try {
    result = await client.fetch<ProviderCredentialCheckResult>(
      `/internal/dashboard/custody/provider-credentials/${encodeURIComponent(providerCredentialId)}/check`,
      { method: "POST", body: JSON.stringify({}) }
    );
  } catch (error) {
    // A definite refusal (no access, credential gone, unresolvable conflict)
    // answers the same way on every re-check, so offering "check again" would
    // trap the user in a loop; surface it as terminal with the server's
    // explanation instead.
    const { status, message } = extractApiMessage(error);
    if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return {
        status: "failed",
        message: message || t("DashboardCustody.byokCheckFailed"),
      };
    }
    // The check may have run to completion server-side even though the response
    // never arrived; re-checking the same credential is safe and idempotent.
    return { status: "retry_unknown", providerCredentialId };
  }

  if (result.check.status === "success") {
    revalidatePath("/dashboard/custody");
    revalidatePath("/dashboard/wallets");
    return { status: "success" };
  }
  if (result.check.status === "retry_unknown") {
    return { status: "retry_unknown", providerCredentialId };
  }
  // A completed check only reports `failed` when the provider conclusively
  // rejected the credential; every other failure maps to `retry_unknown`
  // server-side, and the response carries no failure detail beyond the status.
  return { status: "failed", message: t("DashboardCustody.byokInvalidCredentials") };
}

/**
 * Stores the credential, then runs the first connection check in the same
 * action, per the install design: submit is call-and-wait, not submit-and-poll.
 *
 * The idempotency key is minted by the client and MUST be reused verbatim when
 * retrying this submission; the server replays the original result for a
 * repeated key instead of creating a duplicate credential.
 */
export async function submitPrivyCredentialAction(
  formData: FormData
): Promise<PrivyByokSubmitResult> {
  const t = await getTranslations();

  const idempotencyKey = String(formData.get("idempotencyKey") ?? "").trim();
  const credentialLabel = String(formData.get("credentialLabel") ?? "").trim();
  const scope = String(formData.get("scope") ?? "organization");
  const appId = String(formData.get("appId") ?? "").trim();
  const appSecret = String(formData.get("appSecret") ?? "");
  const walletLabel = String(formData.get("walletLabel") ?? "").trim();

  if (!idempotencyKey || !credentialLabel || !appId || !appSecret) {
    return { status: "error", message: t("DashboardCustody.byokMissingFields") };
  }
  if (scope !== "organization" && scope !== "project") {
    return { status: "error", message: t("DashboardCustody.byokMissingFields") };
  }

  const client = await createSdpApiClient();

  let submitted: { providerCredential: SafeProviderCredential };
  try {
    submitted = await client.fetch<{ providerCredential: SafeProviderCredential }>(
      "/internal/dashboard/custody/provider-credentials",
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          provider: "privy",
          ...(walletLabel ? { walletLabel } : {}),
          fields: { credentialLabel, scope, appId, appSecret },
        }),
      }
    );
  } catch (error) {
    const { status, message } = extractApiMessage(error);
    if (status !== null) {
      // The server answered, so the submission definitively did not commit.
      // Conflicts and validation rejections are terminal for this attempt;
      // routing them into the frozen-replay state would trap the user
      // replaying a request that can only fail the same way.
      return { status: "failed", message: message || t("DashboardCustody.byokSubmitFailed") };
    }
    // No response at all: the POST may have committed server-side, which is
    // the only case the frozen verbatim replay exists for.
    return {
      status: "error",
      message: message || t("DashboardCustody.byokSubmitFailed"),
    };
  }

  return runCheck(submitted.providerCredential.id);
}

/** Re-runs the connection check after a `retry_unknown` outcome. */
export async function recheckPrivyCredentialAction(
  providerCredentialId: string
): Promise<PrivyByokSubmitResult> {
  if (!providerCredentialId.trim()) {
    const t = await getTranslations();
    return { status: "error", message: t("DashboardCustody.byokMissingFields") };
  }
  return runCheck(providerCredentialId);
}
