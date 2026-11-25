import type { SolanaCluster } from "@sdp/types/well-known-tokens";
import { z } from "zod";
import type { CustodyProvisioningRuntime } from "#/shared/runtime";
import { PRIVY_BY_CLUSTER } from "./cluster-config";

const PRIVY_CHECK_TIMEOUT_MS = 10_000;
/** Privy answers a wrong secret or an unknown app ID with this 400 code, never with 401. */
export const PRIVY_INVALID_CREDENTIALS_CODE = "missing_or_invalid_privy_app_id";
export const privyErrorBodySchema = z.object({ code: z.string() });

export async function checkPrivyCredential(
  runtime: CustodyProvisioningRuntime,
  credential: { cluster: SolanaCluster; appId: string; appSecret: string }
): Promise<"success" | "failed" | "retry_unknown"> {
  try {
    // Privy can return 500 for an empty app with limit=1; use its default first page.
    const response = await runtime.fetch(`${PRIVY_BY_CLUSTER[credential.cluster].origin}/wallets`, {
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

function isWalletListResponse(value: unknown): value is { data: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    Array.isArray((value as { data?: unknown }).data)
  );
}
