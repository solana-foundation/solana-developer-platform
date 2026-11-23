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
    // Only the envelope is asserted here; the per-rule parsing is
    // transferRuleSchema's, which needs the rule's action terms intact.
    rules: z.array(z.object({ type: z.string() }).passthrough()),
  }),
});
/** A Transfer rule's asset selector is the provider's asset id or `*`. */
const transferRuleSchema = z.object({
  asset: z.string(),
  src: z.unknown().optional(),
  action: z.string(),
  // Fireblocks keeps `type: TRANSFER` fixed and names the operation here instead;
  // absent is the legacy default (transfers between accounts).
  transactionType: z.string().optional(),
  authorizers: z.array(z.string()).optional(),
  authorizersCount: z.number().optional(),
  authorizationGroups: z.object({ groups: z.array(z.unknown()).optional() }).optional(),
});

/**
 * Whether a parsed rule governs account transfers, the only operation this check
 * speaks about. A `transactionType` naming anything else (raw signing, contract
 * calls, staking, …) puts the rule out of scope rather than in the verdict.
 */
function isTransferOperation(rule: z.infer<typeof transferRuleSchema>): boolean {
  return rule.transactionType === undefined || rule.transactionType === "TRANSFER";
}

/**
 * Whether a matching rule stops SDP's credential from moving funds alone.
 * A `2-TIER` action requires approvers by definition and `BLOCK` allows nothing;
 * a plain `ALLOW` needs the legacy `authorizers` fields or configured authorization
 * groups. Unrecognised action terms return `null` and keep the rule unknown.
 */
function ruleRequiresApproval(rule: z.infer<typeof transferRuleSchema>): boolean | null {
  if (rule.action === "2-TIER" || rule.action === "BLOCK") return true;
  if (rule.action === "ALLOW") {
    if (rule.authorizers?.length || (rule.authorizersCount ?? 0) > 0) return true;
    if (rule.authorizationGroups) return (rule.authorizationGroups.groups ?? []).length > 0;
    return false;
  }
  return null;
}

/** Whether a rule's source tuples select the vault. Unreadable selectors stay unknown. */
function sourceMatchesVault(
  sources: string[][],
  vaultId: string
): { matches: boolean; interpretable: boolean } {
  let interpretable = true;
  for (const source of sources) {
    if (source.length === 1) return { matches: true, interpretable: true };
    const [id, type, subtype] = source;
    if (type !== "VAULT" && type !== "*") continue;
    if (subtype !== undefined && subtype !== "*") {
      interpretable = false;
      continue;
    }
    if (id === vaultId || id === "*") return { matches: true, interpretable: true };
  }
  return { matches: false, interpretable: interpretable };
}

/**
 * What a wallet's Transfer rules depend on, judged without the token catalogue.
 * Rules whose `transactionType` names another operation (raw signing, contract
 * calls, …) govern transfers' neighbors, not transfers, and are ignored.
 * - `native`: every rule names `assets` (or `*`), another vault, or is plainly
 *   absent, so inspecting the native asset alone already decides the wallet.
 * - `outside`: a matching rule with a recognised action names an asset outside
 *   `assets`, so resolving a canonical token's asset id can still change the answer.
 * - `unknown`: a rule that might match the vault names an asset outside `assets`
 *   but cannot be read (unrecognised action or selector), so an absent reading is
 *   not proven and the wallet must not be reported as missing coverage.
 */
export type FireblocksRuleScope = "native" | "outside" | "unknown";

export function fireblocksRuleScope(
  value: unknown,
  vaultId: string,
  assets: string[]
): FireblocksRuleScope {
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) return "native";
  let unknown = false;
  for (const rule of parsed.data.policy.rules) {
    if (rule.type !== "TRANSFER") continue;
    const transfer = transferRuleSchema.safeParse(rule);
    if (!transfer.success) {
      unknown = true;
      continue;
    }
    if (!isTransferOperation(transfer.data)) continue;
    if (transfer.data.asset === "*" || assets.includes(transfer.data.asset)) continue;
    const src = z.object({ ids: z.array(sourceSchema) }).safeParse(transfer.data.src);
    if (!src.success) {
      unknown = true;
      continue;
    }
    const source = sourceMatchesVault(src.data.ids, vaultId);
    if (!source.interpretable) unknown = true;
    if (!source.matches) continue;
    if (ruleRequiresApproval(transfer.data) !== null) return "outside";
    unknown = true;
  }
  return unknown ? "unknown" : "native";
}

/**
 * The legacy active-policy API remains supported and returns all Transfer rules in one read.
 * Rules whose `transactionType` names another operation (raw signing, contract calls, …)
 * are out of scope and ignored: this check speaks for transfer coverage only.
 * Source tuples are [id, type, subtype], not [type, id]. Unrecognised selectors stay unknown.
 * A matching rule proves coverage only when it stops SDP's credential from moving funds
 * alone: it must require approval (a `2-TIER` action or configured approvers) or block the
 * transfer. An `ALLOW` rule without approvers is missing. A null `assets` list judges every
 * readable rule whatever asset it names, keeping proven findings while refusing to report
 * absence past an unreadable rule. Presence says nothing about initiators, limits,
 * destinations or rule order.
 */
export function inspectFireblocksPolicy(
  value: unknown,
  vaultId: string,
  assets: string[] | null
): PolicyResult {
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) return { status: "unknown", reason: "unsupported_response" };
  let unknown = false;
  let gated = false;
  let ungated = false;
  for (const rule of parsed.data.policy.rules) {
    if (rule.type !== "TRANSFER") continue;
    const transfer = transferRuleSchema.safeParse(rule);
    if (!transfer.success) {
      unknown = true;
      continue;
    }
    if (!isTransferOperation(transfer.data)) continue;
    if (assets !== null && transfer.data.asset !== "*" && !assets.includes(transfer.data.asset))
      continue;
    const src = z.object({ ids: z.array(sourceSchema) }).safeParse(transfer.data.src);
    if (!src.success) {
      unknown = true;
      continue;
    }
    const source = sourceMatchesVault(src.data.ids, vaultId);
    if (!source.interpretable) unknown = true;
    if (!source.matches) continue;
    const approval = ruleRequiresApproval(transfer.data);
    if (approval === null) {
      unknown = true;
      continue;
    }
    if (approval) gated = true;
    else ungated = true;
  }
  // An allow rule without approvers wins over any safer matching rule: the credential
  // could move funds alone, so the wallet reports missing coverage.
  if (ungated) return { status: "missing", reason: "no_policy" };
  if (gated) return { status: "present", reason: "policy_detected" };
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
