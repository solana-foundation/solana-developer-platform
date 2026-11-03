import { ACTIONS, isApiKeyGrantableAction } from "@sdp/types/actions";
import { API_KEY_WALLET_SCOPES } from "@sdp/types/api-keys";
import { z } from "zod";
import { isValidIpAllowlistEntry } from "@/lib/ip-allowlist";

const apiKeyAllowedIpSchema = z.string().refine(isValidIpAllowlistEntry, {
  message: "Must be a valid IPv4 or IPv6 address or CIDR range",
});

/**
 * An API key's grants: known actions only (an unknown string is a 400, never
 * silently dropped), none an API key may never hold, each at most once.
 */
const apiKeyGrantsSchema = z
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
 * A field keys used before grants and custody-wallet lists. Refused with a 400
 * that names its replacement, never stripped: a request that narrows a key
 * with `allowedOperations` or `walletBindings` must not succeed while leaving
 * the key broad.
 */
function retiredApiKeyField(field: string, replacement: string) {
  return z.never({ error: `${field} is no longer accepted: send ${replacement}` }).optional();
}

const GRANTS_REPLACEMENT = "grants, the explicit module.verb actions the key holds";
const WALLETS_REPLACEMENT =
  "walletScope and walletIds, the custody wallet ids the key may sign with";
const PROVISION_REPLACEMENT =
  "create the wallet with POST /v1/wallets, then list its id in walletIds";

const retiredApiKeyFields = {
  role: retiredApiKeyField("role", GRANTS_REPLACEMENT),
  permissions: retiredApiKeyField("permissions", GRANTS_REPLACEMENT),
  allowedOperations: retiredApiKeyField("allowedOperations", GRANTS_REPLACEMENT),
  signingWalletId: retiredApiKeyField("signingWalletId", WALLETS_REPLACEMENT),
  signingWalletIds: retiredApiKeyField("signingWalletIds", WALLETS_REPLACEMENT),
  walletBindings: retiredApiKeyField("walletBindings", WALLETS_REPLACEMENT),
};

/** The most custody wallets one key may list. */
const API_KEY_MAX_SIGNING_WALLETS = 100;

/**
 * The custody wallets a selected key may sign with: exact `GET /v1/wallets`
 * ids (`cwlt_...`), never provider wallet ids (APE-390), each at most once.
 */
const apiKeyWalletIdsSchema = z
  .array(z.string().trim().min(1))
  .max(API_KEY_MAX_SIGNING_WALLETS)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "walletIds must not repeat a wallet",
  });

export const apiKeyCreateSchema = z.strictObject({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  grants: apiKeyGrantsSchema,
  walletScope: z.enum(API_KEY_WALLET_SCOPES),
  walletIds: apiKeyWalletIdsSchema.optional(),
  allowedIps: z.array(apiKeyAllowedIpSchema).optional(),
  expiresAt: z.string().datetime().optional(),
  connectionId: z.never().optional(),
  // Creating a key never creates a wallet (HOO-2099): two writes in one
  // request could leave a provider wallet with no key.
  provisionWallet: retiredApiKeyField("provisionWallet", PROVISION_REPLACEMENT),
  walletLabel: retiredApiKeyField("walletLabel", PROVISION_REPLACEMENT),
  walletPurpose: retiredApiKeyField("walletPurpose", PROVISION_REPLACEMENT),
  ...retiredApiKeyFields,
});

export const apiKeyUpdateSchema = z.strictObject({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  grants: apiKeyGrantsSchema.optional(),
  walletScope: z.enum(API_KEY_WALLET_SCOPES).optional(),
  walletIds: apiKeyWalletIdsSchema.optional(),
  allowedIps: z.array(apiKeyAllowedIpSchema).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  ...retiredApiKeyFields,
});

export const apiKeyRotateSchema = z.object({
  gracePeriodHours: z.number().min(0).max(168).optional(), // Max 7 days
});

export const apiKeyRevokeSchema = z.strictObject({
  confirmation: z.string().trim().min(1).optional(),
  /**
   * Also cancel the active recurring payments this key activated or resumed:
   * the compromised-key path. Revoking alone leaves them collecting (APE-343).
   */
  cancelRecurringPayments: z.boolean().optional(),
});
