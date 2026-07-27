import { PERMISSIONS } from "@sdp/types";
import { z } from "zod";
import { isValidIpAllowlistEntry } from "@/lib/ip-allowlist";

const apiKeyAllowedIpSchema = z.string().refine(isValidIpAllowlistEntry, {
  message: "Must be a valid IPv4 or IPv6 address or CIDR range",
});

const apiKeyWalletBindingSchema = z.object({
  walletId: z.string().min(1),
  permissions: z.array(z.enum(PERMISSIONS)).optional(),
});

export const apiKeyCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  role: z.enum(["api_admin", "api_developer", "api_readonly"]).optional(),
  permissions: z.array(z.enum(PERMISSIONS)).optional(),
  walletScope: z.enum(["all", "selected"]),
  allowedIps: z.array(apiKeyAllowedIpSchema).optional(),
  expiresAt: z.string().datetime().optional(),
  signingWalletId: z.string().min(1).optional(),
  signingWalletIds: z.array(z.string().min(1)).optional(),
  walletBindings: z.array(apiKeyWalletBindingSchema).optional(),
  provisionWallet: z.boolean().optional(),
  walletLabel: z.string().max(100).optional(),
  walletPurpose: z
    .enum(["root", "mint_authority", "freeze_authority", "fee_payer", "transfer"])
    .optional(),
});

export const apiKeyUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  walletScope: z.enum(["all", "selected"]).optional(),
  allowedIps: z.array(apiKeyAllowedIpSchema).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  permissions: z.array(z.enum(PERMISSIONS)).nullable().optional(),
  signingWalletId: z.string().min(1).nullable().optional(),
  signingWalletIds: z.array(z.string().min(1)).nullable().optional(),
  walletBindings: z.array(apiKeyWalletBindingSchema).nullable().optional(),
});

export const apiKeyRotateSchema = z.object({
  gracePeriodHours: z.number().min(0).max(168).optional(), // Max 7 days
});

const policyDefaultActionSchema = z.enum(["allow", "deny", "approval_required", "review"]);

const apiKeyPolicyRuleSchema = z
  .object({
    id: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(120).optional(),
    description: z.string().max(500).optional(),
    action: z
      .enum(["allow", "deny", "approval_required", "provider_approval_required", "review"])
      .optional(),
    kind: z.enum([
      "operation_family",
      "operation_type",
      "asset",
      "destination",
      "amount",
      "approval",
      "always",
    ]),
  })
  .passthrough();

export const apiKeyControlProfileCreateSchema = z.object({
  name: z.string().min(1).max(100),
});

export const apiKeyControlProfileRevisionCreateSchema = z.object({
  rules: z.array(apiKeyPolicyRuleSchema).max(100),
  defaultAction: policyDefaultActionSchema,
});

const allWalletPolicyBindingSchema = z.object({
  bindingScope: z.literal("all"),
  apiKeyControlProfileId: z.string().min(1),
});

const selectedWalletPolicyBindingSchema = z
  .object({
    bindingScope: z.literal("selected"),
    walletId: z.string().min(1),
    walletControlProfileId: z.string().min(1).optional(),
    apiKeyControlProfileId: z.string().min(1).optional(),
  })
  .refine(
    (binding) => binding.walletControlProfileId || binding.apiKeyControlProfileId,
    "Selected-wallet policy bindings must reference at least one control profile"
  );

const replacePolicyBindingsSchema = z.object({
  mode: z.literal("replace"),
  bindings: z
    .array(z.union([allWalletPolicyBindingSchema, selectedWalletPolicyBindingSchema]))
    .min(1)
    .max(100)
    .superRefine((bindings, ctx) => {
      const targets = new Set<string>();
      for (const [index, binding] of bindings.entries()) {
        const target = binding.bindingScope === "all" ? "all" : `selected:${binding.walletId}`;
        if (targets.has(target)) {
          ctx.addIssue({
            code: "custom",
            message: "Policy binding targets must be unique",
            path: [index],
          });
        }
        targets.add(target);
      }
    }),
});

export const apiKeyPolicyBindingsWriteSchema = z.discriminatedUnion("mode", [
  replacePolicyBindingsSchema,
  z.object({ mode: z.literal("clear") }),
]);
