import { hashString } from "@sdp/payments/hash";
import type { Env } from "@/types/env";

const PRIVY_CHECK_TIMEOUT_MS = 10_000;

export interface PrivyCredentialAuthentication {
  appId: string;
  appSecret: string;
}

export type PrivyCredentialCheckResult = "success" | "failed" | "retry_unknown";

export const PRIVY_RUNTIME_ENV_FIELDS = {
  appId: "PRIVY_APP_ID",
  appSecret: "PRIVY_APP_SECRET",
} as const satisfies Record<string, keyof Env & string>;

export async function getPrivyProviderAccountFingerprint(appId: string): Promise<string> {
  return `sha256:${await hashString(appId.trim())}`;
}

export async function checkPrivyCredential(
  env: Pick<Env, "PRIVY_API_BASE_URL">,
  credential: PrivyCredentialAuthentication
): Promise<PrivyCredentialCheckResult> {
  const baseUrl = (env.PRIVY_API_BASE_URL ?? "https://api.privy.io/v1").replace(/\/+$/, "");
  try {
    const response = await fetch(`${baseUrl}/wallets?limit=1&chain_type=solana`, {
      method: "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${credential.appId}:${credential.appSecret}`).toString("base64")}`,
        "privy-app-id": credential.appId,
      },
      signal: AbortSignal.timeout(PRIVY_CHECK_TIMEOUT_MS),
    });
    if (response.status === 401) return "failed";
    if (response.status !== 200) return "retry_unknown";
    const body = await response.json().catch(() => null);
    return isWalletListResponse(body) ? "success" : "retry_unknown";
  } catch {
    return "retry_unknown";
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
