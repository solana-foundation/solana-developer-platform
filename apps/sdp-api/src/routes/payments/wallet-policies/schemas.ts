import { isIsoDuration } from "@sdp/policy";
import { isDecimalString } from "@sdp/solana/amount";
import { type PolicyRule, WALLET_OPERATION_FAMILIES, WALLET_OPERATION_TYPES } from "@sdp/types";
import { z } from "zod";
import { solanaAddressSchema } from "../schemas";

export const walletIdParamsSchema = z.object({
  walletId: z.string().min(1),
});

export const walletPolicyEvaluationParamsSchema = walletIdParamsSchema.extend({
  policyEvaluationId: z.string().min(1),
});

export const walletPolicyEvaluationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  decision: z
    .enum([
      "allow",
      "deny",
      "approval_required",
      "provider_approval_required",
      "review",
      "not_evaluated",
    ])
    .optional(),
  status: z
    .enum([
      "created",
      "evaluated",
      "pending_approval",
      "executing",
      "completed",
      "failed",
      "canceled",
    ])
    .optional(),
  operationFamily: z.enum(WALLET_OPERATION_FAMILIES).optional(),
  reasonCode: z.string().min(1).max(100).optional(),
});

const policyRuleBaseShape = {
  id: z.string().min(1).max(120).optional(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional(),
  action: z
    .enum(["allow", "deny", "approval_required", "provider_approval_required", "review"])
    .optional(),
};

const walletOperationFamilySchema = z.enum(WALLET_OPERATION_FAMILIES);
const walletOperationTypeSchema = z.enum(WALLET_OPERATION_TYPES, {
  error: "operation type must be one of the supported wallet operation types",
});

export const walletPolicyRuleSchema: z.ZodType<PolicyRule> = z.discriminatedUnion("kind", [
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("operation_family"),
    family: walletOperationFamilySchema.optional(),
    families: z.array(walletOperationFamilySchema).max(20).optional(),
  }),
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("operation_type"),
    operationType: walletOperationTypeSchema.optional(),
    operationTypes: z.array(walletOperationTypeSchema).max(100).optional(),
  }),
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("asset"),
    asset: z.string().min(1, "asset must not be empty").max(120).optional(),
    assets: z
      .array(z.string().min(1, "assets entries must not be empty").max(120))
      .max(100)
      .optional(),
  }),
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("destination"),
    allowlist: z.array(solanaAddressSchema("allowlist entry")).max(500).optional(),
    blocklist: z.array(solanaAddressSchema("blocklist entry")).max(500).optional(),
    destination: solanaAddressSchema("destination").optional(),
    destinations: z.array(solanaAddressSchema("destinations entry")).max(500).optional(),
  }),
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("amount"),
    min: z
      .string()
      .refine((value) => isDecimalString(value), { message: "Invalid amount format" })
      .optional(),
    max: z
      .string()
      .refine((value) => isDecimalString(value), { message: "Invalid amount format" })
      .optional(),
    asset: z.string().min(1).max(120).optional(),
    assets: z.array(z.string().min(1).max(120)).max(100).optional(),
  }),
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("velocity"),
    scope: z.enum(["wallet", "organization", "api_key"]).optional(),
    window: z.string().refine((value) => isIsoDuration(value), {
      message: "window must be an ISO 8601 duration such as PT1H, P1D or P1DT12H",
    }),
    max: z.string().refine((value) => isDecimalString(value), { message: "Invalid amount format" }),
    asset: z.string().min(1).max(120).optional(),
    assets: z.array(z.string().min(1).max(120)).max(100).optional(),
    operationTypes: z.array(walletOperationTypeSchema).max(100).optional(),
  }),
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("approval"),
    families: z.array(walletOperationFamilySchema).max(20).optional(),
    operationTypes: z.array(walletOperationTypeSchema).max(100).optional(),
    assets: z.array(z.string().min(1).max(120)).max(100).optional(),
    approvalGroupId: z.string().min(1).max(120).optional(),
  }),
  z.object({
    ...policyRuleBaseShape,
    kind: z.literal("always"),
  }),
]);

export const updateWalletPolicyBaseSchema = z.object({
  commitMessage: z.string().trim().min(1).max(500).optional(),
  defaultAction: z.enum(["allow", "deny", "approval_required", "review"]),
  rules: z.array(walletPolicyRuleSchema).max(100),
  // Stale-write guard. Every update activates a revision, so the active
  // revision id versions the whole policy; null means "expect no profile yet".
  expectedRevisionId: z.string().min(1).max(120).nullable().optional(),
});

/**
 * Cross-rule constraints shared by every policy-rules payload: unique rule
 * ids, and amount and velocity rules keyed by asset mint (a bound is
 * meaningless across tokens, so an asset-less rule is rejected rather than
 * blanket-applied).
 *
 * @param rules - The parsed rules array.
 * @param ctx - The zod refinement context to report issues on.
 */
export function refinePolicyRules(rules: PolicyRule[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, rule] of rules.entries()) {
    if (
      rule.kind === "amount" &&
      rule.asset === undefined &&
      (rule.assets === undefined || rule.assets.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["rules", index],
        message: "Amount rules must name the asset mint(s) they bound",
      });
    }
    if (
      rule.kind === "velocity" &&
      rule.asset === undefined &&
      (rule.assets === undefined || rule.assets.length === 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["rules", index],
        message: "Velocity rules must name the asset mint(s) they bound",
      });
    }
    if (rule.id === undefined) {
      continue;
    }
    if (seen.has(rule.id)) {
      ctx.addIssue({
        code: "custom",
        path: ["rules"],
        message: `Duplicate rule id: ${rule.id}`,
      });
    }
    seen.add(rule.id);
  }
}

export const updateWalletPolicySchema = updateWalletPolicyBaseSchema.superRefine((policy, ctx) =>
  refinePolicyRules(policy.rules, ctx)
);
