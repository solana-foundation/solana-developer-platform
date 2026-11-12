import type { ProviderPolicyCheck } from "@sdp/types/custody";
import { z } from "zod";
import { assertHttpsBaseUrl } from "./common";
import { FireblocksApiError, fireblocksRequest } from "./fireblocks-http";
import type { CustodyProvisioningRuntime } from "./runtime";

export type PolicyResult = Pick<ProviderPolicyCheck, "status" | "reason">;
const sourceSchema = z.union([
  z.tuple([z.literal("*")]),
  z.tuple([z.string(), z.string()]),
  z.tuple([z.string(), z.string(), z.string()]),
]);
const policySchema = z.object({
  policy: z.object({
    rules: z.array(
      z.object({
        type: z.string(),
        asset: z.unknown().optional(),
        src: z.unknown().optional(),
      })
    ),
  }),
});

/**
 * The legacy active-policy API remains supported and returns all Transfer rules in one read.
 * Source tuples are [id, type, subtype], not [type, id]. Unrecognised selectors stay unknown.
 * Presence says nothing about initiators, limits, destinations, rule order or approvals.
 */
export function inspectFireblocksPolicy(
  value: unknown,
  vaultId: string,
  assets: string[] | null
): PolicyResult {
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) return { status: "unknown", reason: "unsupported_response" };
  let unknown = false;
  for (const rule of parsed.data.policy.rules) {
    if (rule.type !== "TRANSFER") continue;
    if (typeof rule.asset !== "string") {
      unknown = true;
      continue;
    }
    if (assets !== null && rule.asset !== "*" && !assets.includes(rule.asset)) continue;
    const src = z.object({ ids: z.array(sourceSchema) }).safeParse(rule.src);
    if (!src.success) {
      unknown = true;
      continue;
    }
    for (const source of src.data.ids) {
      if (source.length === 1) return { status: "present", reason: "policy_detected" };
      const [id, type, subtype] = source;
      if (type !== "VAULT" && type !== "*") continue;
      if (subtype !== undefined && subtype !== "*") {
        unknown = true;
        continue;
      }
      if (id === vaultId || id === "*") return { status: "present", reason: "policy_detected" };
    }
  }
  return unknown
    ? { status: "unknown", reason: "unsupported_response" }
    : { status: "missing", reason: "no_policy" };
}

/** One read per credential in a check batch, shared across its vaults. Never writes policy. */
export async function readFireblocksPolicy(
  runtime: CustodyProvisioningRuntime,
  config: {
    apiKey: string;
    apiSecretPem: string;
    apiBaseUrl?: string;
  }
): Promise<{ value: z.infer<typeof policySchema> } | { error: PolicyResult }> {
  try {
    const parsed = policySchema.safeParse(
      await fireblocksRequest<unknown>(runtime, {
        apiBaseUrl: assertHttpsBaseUrl(
          config.apiBaseUrl ?? "https://api.fireblocks.io",
          "Fireblocks"
        ),
        apiKey: config.apiKey,
        apiSecretPem: config.apiSecretPem,
        method: "GET",
        uri: "/v1/tap/active_policy",
      })
    );
    return parsed.success
      ? { value: parsed.data }
      : { error: { status: "unknown", reason: "unsupported_response" } };
  } catch (error) {
    return {
      error: {
        status: "unknown",
        reason:
          error instanceof FireblocksApiError && [401, 403].includes(error.status)
            ? "access_denied"
            : "provider_unavailable",
      },
    };
  }
}
