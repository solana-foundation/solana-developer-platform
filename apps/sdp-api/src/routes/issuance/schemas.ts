import { z } from "zod";

// ═══════════════════════════════════════════════════════════════════════════
// Extension Schemas
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Transfer fee extension configuration
 */
const transferFeeConfigSchema = z.object({
  basisPoints: z.number().int().min(0).max(10000),
  maxFee: z.string(),
  transferFeeConfigAuthority: z.string().optional(),
  withdrawWithheldAuthority: z.string().optional(),
});

/**
 * Interest-bearing extension configuration
 */
const interestBearingConfigSchema = z.object({
  rate: z.number(),
  rateAuthority: z.string().optional(),
});

/**
 * Legacy extensions schema (for backward compatibility)
 */
const legacyExtensionsSchema = z.object({
  confidentialTransfer: z.boolean().optional(),
  transferFee: z
    .object({
      basisPoints: z.number().int().min(0).max(10000),
      maxFee: z.string(),
      transferFeeConfigAuthority: z.string(),
      withdrawWithheldAuthority: z.string(),
    })
    .optional(),
  interestBearing: z
    .object({
      rate: z.number(),
      rateAuthority: z.string(),
    })
    .optional(),
  permanentDelegate: z.string().optional(),
  nonTransferable: z.boolean().optional(),
  defaultAccountState: z.enum(["initialized", "frozen"]).optional(),
});

/**
 * Extension overrides schema
 * Each extension can be:
 * - true/false: enable/disable
 * - config object: enable with specific configuration
 */
const extensionOverridesSchema = z.object({
  confidentialTransfer: z.boolean().optional(),
  transferFee: z.union([z.literal(false), transferFeeConfigSchema]).optional(),
  interestBearing: z.union([z.literal(false), interestBearingConfigSchema]).optional(),
  permanentDelegate: z.boolean().optional(),
  nonTransferable: z.boolean().optional(),
  defaultAccountState: z.enum(["initialized", "frozen"]).optional(),
});

/**
 * Template overrides schema
 */
const templateOverridesSchema = z.object({
  extensions: extensionOverridesSchema.optional(),
  requiresAllowlist: z.boolean().optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// Token Schemas
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Template type enum
 */
export const tokenTemplateSchema = z.preprocess(
  (value) =>
    value === "tokenized_security" || value === "rwa" ? "tokenized-security" : value,
  z.enum(["stablecoin", "arcade", "tokenized-security", "custom"])
);

/**
 * Create token request schema
 *
 * Supports two modes:
 * 1. Template mode: Specify template with optional overrides (recommended)
 * 2. Legacy mode: Specify extensions directly (backward compatible, treated as custom)
 */
export const createTokenSchema = z.object({
  name: z.string().min(1).max(100),
  symbol: z
    .string()
    .min(1)
    .max(10)
    .regex(/^[A-Z0-9]+$/),
  decimals: z.number().int().min(0).max(18).optional(),
  description: z.string().max(500).optional(),
  uri: z.string().url().optional(),
  imageUrl: z.string().url().optional(),
  maxSupply: z.string().regex(/^\d+$/).optional(),
  /** Token template - defaults to "custom" if not specified */
  template: tokenTemplateSchema.optional(),
  /** Template overrides for customization */
  overrides: templateOverridesSchema.optional(),
  /** @deprecated Use template + overrides instead */
  extensions: legacyExtensionsSchema.optional(),
  requiresAllowlist: z.boolean().optional(),
  isMintable: z.boolean().optional(),
  isFreezable: z.boolean().optional(),
});

export type CreateTokenInput = z.infer<typeof createTokenSchema>;

export const updateTokenSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  uri: z.string().url().nullable().optional(),
  imageUrl: z.string().url().nullable().optional(),
  status: z.enum(["active", "paused"]).optional(),
});

export const mintSchema = z.object({
  mint: z.object({
    destination: z.string().min(32).max(44),
    amount: z.string().regex(/^\d+$/),
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
  burn: z.object({
    source: z.string().min(32).max(44),
    amount: z.string().regex(/^\d+$/),
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

export const freezeSchema = z.object({
  accountAddress: z.string().min(32).max(44),
  reason: z.string().max(500).optional(),
});

export const unfreezeSchema = z.object({
  accountAddress: z.string().min(32).max(44),
});

export const addAllowlistSchema = z.object({
  address: z.string().min(32).max(44),
  label: z.string().max(100).optional(),
  kycStatus: z.enum(["none", "pending", "approved", "rejected"]).optional(),
  kycProvider: z.string().max(100).optional(),
});
