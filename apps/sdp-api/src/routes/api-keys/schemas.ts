import { ACTIONS, isApiKeyGrantableAction } from "@sdp/types/actions";
import { PERMISSIONS } from "@sdp/types/permissions";
import { z } from "zod";
import { isValidIpAllowlistEntry } from "@/lib/ip-allowlist";
import { custodyWalletOwnerSchema } from "@/routes/custody/schemas";

const apiKeyAllowedIpSchema = z.string().refine(isValidIpAllowlistEntry, {
  message: "Must be a valid IPv4 or IPv6 address or CIDR range",
});

/**
 * An API key's grants: known actions only (an unknown string is a 400, never
 * silently dropped), none an API key may never hold, each at most once.
 */
export const apiKeyGrantsSchema = z
  .array(z.enum(ACTIONS))
  .max(ACTIONS.length)
  .superRefine((grants, ctx) => {
    const forbidden = grants.filter((grant) => !isApiKeyGrantableAction(grant));
    if (forbidden.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `API keys cannot hold: ${forbidden.join(", ")}`,
      });
    }
    if (new Set(grants).size !== grants.length) {
      ctx.addIssue({ code: "custom", message: "Grants must not repeat an action" });
    }
  });

/**
 * A field keys used before grants. Refused with a 400 that points at
 * `grants`, never stripped: a request that narrows a key with
 * `allowedOperations` must not succeed while leaving its grants broad.
 */
function retiredApiKeyField(field: string) {
  return z
    .never({
      error: `${field} is no longer accepted: send grants, the explicit module.verb actions the key holds`,
    })
    .optional();
}

const retiredApiKeyFields = {
  role: retiredApiKeyField("role"),
  permissions: retiredApiKeyField("permissions"),
  allowedOperations: retiredApiKeyField("allowedOperations"),
};

const apiKeyWalletBindingSchema = z.object({
  walletId: z.string().min(1),
  permissions: z.array(z.enum(PERMISSIONS)).optional(),
});

export const apiKeyCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  grants: apiKeyGrantsSchema,
  walletScope: z.enum(["all", "selected"]),
  allowedIps: z.array(apiKeyAllowedIpSchema).optional(),
  expiresAt: z.string().datetime().optional(),
  signingWalletId: z.string().min(1).optional(),
  signingWalletIds: z.array(z.string().min(1)).optional(),
  walletBindings: z.array(apiKeyWalletBindingSchema).optional(),
  provisionWallet: custodyWalletOwnerSchema.optional(),
  connectionId: z.never().optional(),
  walletLabel: z.string().max(100).optional(),
  walletPurpose: z
    .enum(["root", "mint_authority", "freeze_authority", "fee_payer", "transfer"])
    .optional(),
  ...retiredApiKeyFields,
});

export const apiKeyUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  grants: apiKeyGrantsSchema.optional(),
  walletScope: z.enum(["all", "selected"]).optional(),
  allowedIps: z.array(apiKeyAllowedIpSchema).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  signingWalletId: z.string().min(1).nullable().optional(),
  signingWalletIds: z.array(z.string().min(1)).nullable().optional(),
  walletBindings: z.array(apiKeyWalletBindingSchema).nullable().optional(),
  ...retiredApiKeyFields,
});

export const apiKeyRotateSchema = z.object({
  gracePeriodHours: z.number().min(0).max(168).optional(), // Max 7 days
});

export const apiKeyRevokeSchema = z.strictObject({
  confirmation: z.string().trim().min(1).optional(),
});
