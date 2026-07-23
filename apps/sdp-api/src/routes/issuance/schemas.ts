import { isDecimalString } from "@sdp/solana/amount";
import { z } from "zod";
import {
  assertAssetTypeSupported,
  assetCategorySchema,
  assetTypeSchema,
  issuanceMetadataSchema,
} from "../asset-profiles/schemas";

// ═══════════════════════════════════════════════════════════════════════════
// Extension Schemas
// ═══════════════════════════════════════════════════════════════════════════

const transferFeeConfigSchema = z.object({
  basisPoints: z.number().int().min(0).max(10000),
  maxFee: z.string().refine((value) => isDecimalString(value), {
    message: "Invalid amount format",
  }),
  transferFeeConfigAuthority: z.string().optional(),
  withdrawWithheldAuthority: z.string().optional(),
});

const interestBearingConfigSchema = z.object({
  rate: z.number(),
  rateAuthority: z.string().optional(),
});

const pausableConfigSchema = z.object({
  authority: z.string().min(32).max(44).optional(),
});

const scaledUiAmountConfigSchema = z.object({
  authority: z.string().min(32).max(44).optional(),
  multiplier: z.number().positive().optional(),
  newMultiplier: z.number().positive().optional(),
  newMultiplierEffectiveTimestamp: z.number().int().nonnegative().optional(),
});

const transferHookConfigSchema = z.object({
  programId: z.string().min(32).max(44),
  authority: z.string().min(32).max(44).optional(),
});

// Each extension can be: true/false (enable/disable) or a config object for custom settings
const extensionOverridesSchema = z
  .object({
    transferFee: z.union([z.literal(false), transferFeeConfigSchema]).optional(),
    interestBearing: z.union([z.literal(false), interestBearingConfigSchema]).optional(),
    permanentDelegate: z.union([z.literal(false), z.string()]).optional(),
    pausable: z.union([z.literal(false), pausableConfigSchema]).optional(),
    nonTransferable: z.boolean().optional(),
    defaultAccountState: z.enum(["initialized", "frozen"]).optional(),
    scaledUiAmount: z.union([z.literal(false), scaledUiAmountConfigSchema]).optional(),
    transferHook: z.union([z.literal(false), transferHookConfigSchema]).optional(),
  })
  .strict();

const templateOverridesSchema = z.object({
  extensions: extensionOverridesSchema.optional(),
  requiresAllowlist: z.boolean().optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// Token Schemas
// ═══════════════════════════════════════════════════════════════════════════

// Normalize legacy template names (tokenized_security, rwa) to canonical form
export const tokenTemplateSchema = z.preprocess(
  (value) => (value === "tokenized_security" || value === "rwa" ? "tokenized-security" : value),
  z.enum(["stablecoin", "arcade", "tokenized-security", "custom"])
);

// Supports template mode with optional overrides for customization

export const createTokenSchema = z.object({
  name: z.string().min(1).max(100),
  symbol: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Za-z0-9.]+$/),
  signingWalletId: z.string().min(1).optional(),
  decimals: z.number().int().min(0).max(18).optional(),
  description: z.string().max(500).optional(),
  uri: z.string().url().optional(),
  imageUrl: z.string().url().optional(),
  maxSupply: z
    .string()
    .refine((value) => isDecimalString(value), { message: "Invalid amount format" })
    .optional(),
  /** Token template - defaults to "custom" if not specified */
  template: tokenTemplateSchema.optional(),
  /** Template overrides for customization */
  overrides: templateOverridesSchema.optional(),
  requiresAllowlist: z.boolean().optional(),
  isMintable: z.boolean().optional(),
  isFreezable: z.boolean().optional(),
});

export type CreateTokenInput = z.infer<typeof createTokenSchema>;

// Body for POST /v1/issuance/tokens/asset-profile: the full token-create payload
// plus the asset-profile fields, so a token and its profile are created together.
// `superRefine` enforces the same category<->type consistency as the standalone
// asset-profile create (public metadata is server-computed, never accepted here).
export const createTokenWithAssetProfileSchema = createTokenSchema
  .extend({
    assetCategory: assetCategorySchema.default("generic"),
    assetType: assetTypeSchema.default("generic"),
    issuanceMetadata: issuanceMetadataSchema.optional(),
  })
  .superRefine(assertAssetTypeSupported);

export type CreateTokenWithAssetProfileInput = z.infer<typeof createTokenWithAssetProfileSchema>;

export const updateTokenSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  // Symbol and decimals define the mint; the handler rejects them after deploy.
  // Same constraints as createTokenSchema.
  symbol: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Za-z0-9.]+$/)
    .optional(),
  decimals: z.number().int().min(0).max(18).optional(),
  description: z.string().max(500).nullable().optional(),
  uri: z.string().url().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
  status: z.enum(["active", "paused"]).optional(),
  // Access-control enforcement input for deploy; only accepted while the token
  // is still undeployed (the handler rejects it after deployment).
  requiresAllowlist: z.boolean().optional(),
});

export const mintSchema = z.object({
  signingWalletId: z.string().min(1).optional(),
  mint: z.object({
    destination: z.string().min(32).max(44),
    amount: z
      .string()
      .refine((value) => isDecimalString(value), { message: "Invalid amount format" }),
    memo: z.string().max(100).optional(),
  }),
  options: z
    .object({
      priorityFee: z
        .union([z.enum(["none", "low", "medium", "high"]), z.number().int().min(0)])
        .optional(),
      simulate: z.boolean().optional(),
    })
    .optional(),
});

export const burnSchema = z.object({
  signingWalletId: z.string().min(1).optional(),
  burn: z.object({
    source: z.string().min(32).max(44),
    amount: z
      .string()
      .refine((value) => isDecimalString(value), { message: "Invalid amount format" }),
    memo: z.string().max(100).optional(),
  }),
  options: z
    .object({
      priorityFee: z
        .union([z.enum(["none", "low", "medium", "high"]), z.number().int().min(0)])
        .optional(),
      simulate: z.boolean().optional(),
    })
    .optional(),
});

export const seizeSchema = z.object({
  signingWalletId: z.string().min(1).optional(),
  seize: z.object({
    source: z.string().min(32).max(44),
    destination: z.string().min(32).max(44),
    amount: z
      .string()
      .refine((value) => isDecimalString(value), { message: "Invalid amount format" }),
    delegateAuthority: z.string().min(32).max(44).optional(),
    memo: z.string().max(100).optional(),
  }),
  options: z
    .object({
      priorityFee: z
        .union([z.enum(["none", "low", "medium", "high"]), z.number().int().min(0)])
        .optional(),
      simulate: z.boolean().optional(),
    })
    .optional(),
});

export const forceBurnSchema = z.object({
  signingWalletId: z.string().min(1).optional(),
  forceBurn: z.object({
    source: z.string().min(32).max(44),
    amount: z
      .string()
      .refine((value) => isDecimalString(value), { message: "Invalid amount format" }),
    delegateAuthority: z.string().min(32).max(44).optional(),
    memo: z.string().max(100).optional(),
  }),
  options: z
    .object({
      priorityFee: z
        .union([z.enum(["none", "low", "medium", "high"]), z.number().int().min(0)])
        .optional(),
      simulate: z.boolean().optional(),
    })
    .optional(),
});

export const updateAuthoritySchema = z.object({
  signingWalletId: z.string().min(1).optional(),
  authority: z.object({
    role: z.enum(["mint", "freeze", "permanentDelegate", "metadata"]),
    currentAuthority: z.string().min(32).max(44).optional(),
    newAuthority: z.string().min(32).max(44).nullable(),
  }),
  options: z
    .object({
      priorityFee: z
        .union([z.enum(["none", "low", "medium", "high"]), z.number().int().min(0)])
        .optional(),
      simulate: z.boolean().optional(),
    })
    .optional(),
});

export const deployTokenSchema = z.object({
  signingWalletId: z.string().min(1).optional(),
  feePayment: z.enum(["sponsored", "wallet"]).default("sponsored"),
});

// Records a confirmed non-custodial deploy: the client sends the `mint` it
// received from `deploy/prepare` plus the signature of the create tx it
// submitted, so the server can verify the tx landed and persist the mint.
// `listAddress` and `signingWalletId` are accepted for backward compatibility
// but ignored — the server re-derives the ABL list PDA from the mint authority
// and uses the signing wallet pinned at deploy/prepare, so neither can be
// changed at confirm time.
export const confirmDeploySchema = z.object({
  signature: z.string().min(1),
  mint: z.string().min(32).max(44),
  listAddress: z.string().min(32).max(44).optional(),
  signingWalletId: z.string().min(1).optional(),
});

export const pauseTokenSchema = z.object({
  options: z
    .object({
      priorityFee: z
        .union([z.enum(["none", "low", "medium", "high"]), z.number().int().min(0)])
        .optional(),
      simulate: z.boolean().optional(),
    })
    .optional(),
});

export const freezeSchema = z.object({
  accountAddress: z.string().min(32).max(44),
  reason: z.string().max(500).optional(),
  signingWalletId: z.string().min(1).optional(),
});

export const unfreezeSchema = z.object({
  accountAddress: z.string().min(32).max(44),
  signingWalletId: z.string().min(1).optional(),
});

export const addAllowlistSchema = z.object({
  address: z.string().min(32).max(44),
  label: z.string().max(100).optional(),
});
