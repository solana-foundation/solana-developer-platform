import { hashString } from "@sdp/payments/hash";
import { z } from "zod";
import { badRequest } from "@/lib/errors";
import type { Env } from "@/types/env";

const PRIVY_CHECK_TIMEOUT_MS = 10_000;
const PRIVY_INVALID_CREDENTIALS_CODE = "missing_or_invalid_privy_app_id";
const privyErrorBodySchema = z.object({ code: z.string() });
const PRIVY_CREDENTIALS_REJECTED_MESSAGE =
  "The provider rejected these credentials. Check the credential fields, then connect again.";
const PRIVY_CREDENTIALS_UNCONFIRMED_MESSAGE =
  "Privy did not confirm these credentials, so nothing was saved. Try again.";

export interface PrivyCredentialAuthentication {
  appId: string;
  appSecret: string;
}

export type PrivyCredentialCheckResult = "success" | "failed" | "retry_unknown";

export async function getPrivyProviderAccountFingerprint(appId: string): Promise<string> {
  return `sha256:${await hashString(appId.trim())}`;
}

export async function checkPrivyCredential(
  env: Pick<Env, "PRIVY_API_BASE_URL">,
  credential: PrivyCredentialAuthentication
): Promise<PrivyCredentialCheckResult> {
  const baseUrl = (env.PRIVY_API_BASE_URL ?? "https://api.privy.io/v1").replace(/\/+$/, "");
  try {
    // Privy can return 500 for an empty app with limit=1; use its default first page.
    const response = await fetch(`${baseUrl}/wallets`, {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${credential.appId}:${credential.appSecret}`).toString("base64")}`,
        "privy-app-id": credential.appId,
      },
      signal: AbortSignal.timeout(PRIVY_CHECK_TIMEOUT_MS),
    });
    if (response.status === 401) return "failed";
    // Privy answers a wrong secret or an unknown app ID with this 400, never with 401.
    if (response.status === 400) {
      const body = privyErrorBodySchema.safeParse(await response.json());
      return body.success && body.data.code === PRIVY_INVALID_CREDENTIALS_CODE
        ? "failed"
        : "retry_unknown";
    }
    if (response.status !== 200) return "retry_unknown";
    const body = await response.json().catch(() => null);
    return isWalletListResponse(body) ? "success" : "retry_unknown";
  } catch {
    return "retry_unknown";
  }
}

export async function assertPrivyCredentialAccepted(
  env: Pick<Env, "PRIVY_API_BASE_URL">,
  credential: PrivyCredentialAuthentication
): Promise<void> {
  const result = await checkPrivyCredential(env, credential);
  if (result === "failed") {
    throw badRequest(PRIVY_CREDENTIALS_REJECTED_MESSAGE, { reason: "invalid_credentials" });
  }
  if (result === "retry_unknown") {
    throw badRequest(PRIVY_CREDENTIALS_UNCONFIRMED_MESSAGE, { reason: "provider_unconfirmed" });
  }
}

function isWalletListResponse(value: unknown): value is { data: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    Array.isArray((value as { data?: unknown }).data)
  );
}
