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

interface ProviderCredentialSubmissionResult {
  providerCredential: SafeProviderCredential;
  connectionId: string;
}

interface ProviderCredentialCompletionResult {
  providerCredential: SafeProviderCredential;
  connectionId: string;
  completion: {
    status: "running" | "success" | "failed" | "retry_unknown";
    attemptedAt: string;
    code?: string;
  };
}

/**
 * What the credential form renders next.
 *
 * `failed` is terminal for this attempt. When it carries a `connectionId` the
 * completion itself ran and conclusively rejected the credential: the failed
 * connection stays server-side and only accepts replacement credentials, so
 * the retry must resubmit against that connection under a NEW idempotency
 * key. Without a `connectionId` the connection is gone and the retry is a
 * fresh submission. `refused` means the server declined to run the completion
 * but the pending connection is untouched — re-running the same completion is
 * the only move that can still converge. `retry_unknown` keeps the
 * connection; the safe move is re-running the completion against the same id.
 */
export type PrivyByokSubmitResult =
  | { status: "success" }
  | { status: "failed"; message: string; connectionId?: string }
  | { status: "refused"; message: string; connectionId: string }
  // No self-service action converges: the connection's provider-account
  // fingerprint is pinned, so the server rejects replacement credentials and
  // blocks cancellation alike. Offering the replacement flow would loop.
  | { status: "unrecoverable"; message: string }
  | { status: "retry_unknown"; connectionId: string }
  // The action rejected the input before sending anything, so nothing can
  // have committed and the frozen-replay recovery path must not engage —
  // replaying an unsent payload can only fail the same way.
  | { status: "invalid"; message: string }
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

function completionFailureMessage(
  code: string | undefined,
  t: Awaited<ReturnType<typeof getTranslations>>
): string {
  if (code === "provider_account_already_connected") {
    return t("DashboardCustody.byokAccountAlreadyConnected");
  }
  return t("DashboardCustody.byokInvalidCredentials");
}

async function runCompletion(connectionId: string): Promise<PrivyByokSubmitResult> {
  const t = await getTranslations();
  const client = await createSdpApiClient();

  let result: ProviderCredentialCompletionResult;
  try {
    result = await client.fetch<ProviderCredentialCompletionResult>(
      `/internal/dashboard/custody/connections/${encodeURIComponent(connectionId)}/complete`,
      { method: "POST", body: JSON.stringify({}) }
    );
  } catch (error) {
    // A definite refusal answers the same way on every re-run, so selling it
    // as "checking again is safe" would trap the user in a loop; surface it as
    // terminal with the server's explanation instead.
    const { status, message } = extractApiMessage(error);
    if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      if (status === 404) {
        // The connection no longer exists server-side, so a fresh submission
        // is the correct recovery.
        return { status: "failed", message: message || t("DashboardCustody.byokCheckFailed") };
      }
      // Everything else (completion disabled, completion already in progress)
      // leaves the pending connection untouched; keep its id so the user can
      // still re-run the completion once the cause is fixed.
      return {
        status: "refused",
        message: message || t("DashboardCustody.byokCheckFailed"),
        connectionId,
      };
    }
    // The completion may have run server-side even though the response never
    // arrived; it is lease-guarded and replays a settled outcome, so re-running
    // it against the same connection is safe.
    return { status: "retry_unknown", connectionId };
  }

  if (result.completion.status === "success") {
    revalidatePath("/dashboard/custody");
    revalidatePath("/dashboard/wallets");
    return { status: "success" };
  }
  if (result.completion.status === "failed") {
    if (result.completion.code === "wallet_conflict") {
      // The connection is pinned to a provider account whose wallet state
      // cannot be reconciled; the server rejects replacement credentials for
      // this state, so routing the retry at replacement would 409 forever.
      return { status: "unrecoverable", message: t("DashboardCustody.byokWalletConflict") };
    }
    // The completion conclusively rejected the credential. The failed
    // connection survives and blocks fresh submissions, but accepts
    // replacement credentials — keep its id so the retry can replace.
    return {
      status: "failed",
      message: completionFailureMessage(result.completion.code, t),
      connectionId,
    };
  }
  // `retry_unknown` and a still-`running` completion both settle by running
  // the completion again once the current attempt's lease clears.
  return { status: "retry_unknown", connectionId };
}

/**
 * Stores the credential, then runs the connection completion in the same
 * action, per the install design: submit is call-and-wait, not submit-and-poll.
 *
 * When `connectionId` is present in the form data, the submission replaces the
 * credentials on that failed connection instead of creating a new one — the
 * only recovery the server allows once a completion has conclusively failed.
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
  const appId = String(formData.get("appId") ?? "").trim();
  const appSecret = String(formData.get("appSecret") ?? "");
  const walletLabel = String(formData.get("walletLabel") ?? "").trim();
  const replaceConnectionId = String(formData.get("connectionId") ?? "").trim();

  // Trimmed-empty fields pass the browser's `required` check but are known
  // rejects before any request leaves — `invalid`, never the replay path.
  if (!idempotencyKey || !credentialLabel || !appId || !appSecret) {
    return { status: "invalid", message: t("DashboardCustody.byokMissingFields") };
  }

  const client = await createSdpApiClient();

  const path = replaceConnectionId
    ? `/internal/dashboard/custody/connections/${encodeURIComponent(replaceConnectionId)}/provider-credentials`
    : "/internal/dashboard/custody/provider-credentials";

  let submitted: ProviderCredentialSubmissionResult;
  try {
    submitted = await client.fetch<ProviderCredentialSubmissionResult>(path, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        provider: "privy",
        ...(walletLabel ? { walletLabel } : {}),
        // Credentials always bind to the calling project; the API no longer
        // accepts an organization scope for stored custody credentials.
        fields: { credentialLabel, scope: "project", appId, appSecret },
      }),
    });
  } catch (error) {
    const { status, message } = extractApiMessage(error);
    if (status !== null && status < 500 && status !== 408 && status !== 429) {
      // A definitive rejection: the server answered and the submission did
      // not commit. Conflicts and validation rejections are terminal for this
      // attempt; routing them into the frozen-replay state would trap the
      // user replaying a request that can only fail the same way. A rejected
      // REPLACEMENT leaves the failed connection standing and still blocking
      // fresh submissions, so its id rides along or the next correction
      // would be routed into exactly that blocked fresh path — unless the
      // rejection is a 404: the connection is gone, and a fresh submission
      // is the only recovery that can converge.
      return {
        status: "failed",
        message: message || t("DashboardCustody.byokSubmitFailed"),
        ...(replaceConnectionId && status !== 404 ? { connectionId: replaceConnectionId } : {}),
      };
    }
    // No response, or an ambiguous answer (5xx/408/429) that does not
    // guarantee nothing was committed: the POST may have created the
    // connection server-side, so the exact payload and idempotency key are
    // kept for the frozen verbatim replay. Minting a new key here could
    // strand a committed pending connection forever.
    return {
      status: "error",
      message: message || t("DashboardCustody.byokSubmitFailed"),
    };
  }

  return runCompletion(submitted.connectionId);
}

/** Re-runs the connection completion after a `retry_unknown` or `refused` outcome. */
export async function recheckPrivyCredentialAction(
  connectionId: string
): Promise<PrivyByokSubmitResult> {
  if (!connectionId.trim()) {
    const t = await getTranslations();
    return { status: "error", message: t("DashboardCustody.byokMissingFields") };
  }
  return runCompletion(connectionId);
}
