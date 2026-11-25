import { denormalizePrivyWalletId } from "@sdp/custody/provider-wallet-ids";
import type { ProviderPolicyCheck } from "@sdp/types/custody";
import { z } from "zod";
import type { Env } from "@/types/env";
import {
  PRIVY_INVALID_CREDENTIALS_CODE,
  type PrivyCredentialAuthentication,
  privyErrorBodySchema,
} from "./privy-credential";

const walletSchema = z.object({ id: z.string(), policy_ids: z.array(z.string().min(1)) });

/** Inspect the connected wallet, never infer its coverage from unrelated policies in the app. */
export async function readPrivyWalletPolicy(
  env: Env,
  credential: PrivyCredentialAuthentication,
  walletId: string
): Promise<Pick<ProviderPolicyCheck, "status" | "reason">> {
  const id = denormalizePrivyWalletId(walletId);
  const baseUrl = (env.PRIVY_API_BASE_URL ?? "https://api.privy.io/v1").replace(/\/+$/, "");
  try {
    const response = await fetch(`${baseUrl}/wallets/${encodeURIComponent(id)}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${credential.appId}:${credential.appSecret}`).toString("base64")}`,
        "privy-app-id": credential.appId,
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if ([401, 403].includes(response.status)) return { status: "unknown", reason: "access_denied" };
    // Privy answers a rejected credential with this 400, never with 401; the
    // hourly check reads it the same way `checkPrivyCredential` does.
    if (response.status === 400) {
      const body = privyErrorBodySchema.safeParse(await response.json().catch(() => null));
      return body.success && body.data.code === PRIVY_INVALID_CREDENTIALS_CODE
        ? { status: "unknown", reason: "access_denied" }
        : { status: "unknown", reason: "provider_unavailable" };
    }
    if (!response.ok) return { status: "unknown", reason: "provider_unavailable" };
    const parsed = walletSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.id !== id)
      return { status: "unknown", reason: "unsupported_response" };
    return parsed.data.policy_ids.length > 0
      ? { status: "present", reason: "policy_detected" }
      : { status: "missing", reason: "no_policy" };
  } catch {
    return { status: "unknown", reason: "provider_unavailable" };
  }
}
