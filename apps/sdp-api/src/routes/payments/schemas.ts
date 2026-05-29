import {
  OFFRAMP_CRYPTO_RAILS,
  ONRAMP_CRYPTO_RAILS,
  type PrivateTransferRequest,
  RAMP_PROVIDERS,
} from "@sdp/types";
import { z } from "zod";
import { isDecimalString } from "@/lib/amount";
import { isAddress } from "@/lib/solana";
import { SOL_MINT } from "@/services/payment-operation.service";

// Per-field schema for any payments input that expects a base58 Solana address
// (destination, referenceAddress, allowlist entries). Trim whitespace in a
// preprocess and require both the 32–44 length window and `isAddress` to pass.
// Validating here returns 400 BAD_REQUEST with an actionable per-field message
// instead of letting `assertValidAddress` throw a plain Error downstream (500).
function solanaAddressSchema(fieldName: string) {
  return z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : value),
    z.string().refine((value) => value.length >= 32 && value.length <= 44 && isAddress(value), {
      message: `${fieldName} must be a base58 Solana address`,
    })
  );
}

// Payments token field: native SOL keyword, the canonical SOL mint, or a base58
// Solana mint address. Trim and case-fold the native keyword in a preprocess so
// validation matches `normalizePaymentToken`/`isNativePaymentToken` (which both
// accept case-insensitive "SOL" with surrounding whitespace). A single refine
// (rather than a union with `.min(32)`) avoids generic "String must contain at
// least 32 character(s)" errors for short inputs like `"USDC"`.
export const PAYMENT_TOKEN_VALIDATION_MESSAGE =
  "token must be 'SOL' or a base58 Solana mint address";

const paymentTokenSchema = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    return trimmed.toUpperCase() === "SOL" ? "SOL" : trimmed;
  },
  z.string().refine(
    (value) => {
      if (value === "SOL" || value === SOL_MINT) return true;
      return value.length >= 32 && value.length <= 44 && isAddress(value);
    },
    { message: PAYMENT_TOKEN_VALIDATION_MESSAGE }
  )
);

export const walletIdParamsSchema = z.object({
  walletId: z.string().min(1),
});

export const transferIdParamsSchema = z.object({
  transferId: z.string().min(1),
});

export const updateWalletPolicySchema = z.object({
  destinationAllowlist: z.array(solanaAddressSchema("destinationAllowlist entry")).max(500),
  maxTransferAmount: z
    .string()
    .refine((value) => isDecimalString(value), { message: "Invalid amount format" })
    .optional(),
  maxDailyAmount: z
    .string()
    .refine((value) => isDecimalString(value), { message: "Invalid amount format" })
    .optional(),
});

const paymentAmountSchema = z
  .string()
  .refine((value) => isDecimalString(value), { message: "Invalid amount format" })
  // Avoid adding a second error when the decimal-format check already failed.
  .refine((value) => !isDecimalString(value) || /[1-9]/.test(value), {
    message: "Amount must be greater than zero",
  });

const magicBlockPrivateTransferOptionsSchema = z
  .object({
    validator: z.string().min(32).max(44).optional(),
    initIfMissing: z.boolean().optional(),
    initAtasIfMissing: z.boolean().optional(),
    initVaultIfMissing: z.boolean().optional(),
    minDelayMs: z
      .string()
      .regex(/^\d+$/, { message: "minDelayMs must be an integer string" })
      .optional(),
    maxDelayMs: z
      .string()
      .regex(/^\d+$/, { message: "maxDelayMs must be an integer string" })
      .optional(),
    clientRefId: z
      .string()
      .regex(/^\d+$/, { message: "clientRefId must be an integer string" })
      .optional(),
    split: z.number().int().min(1).max(15).optional(),
    gasless: z.boolean().optional(),
    legacy: z.boolean().optional(),
  })
  .strict();

export const privateTransferSchema: z.ZodType<PrivateTransferRequest> = z.object({
  provider: z.literal("magicblock"),
  magicBlock: magicBlockPrivateTransferOptionsSchema,
});

const rampProviderSchema = z.enum(RAMP_PROVIDERS);
const onrampCryptoRailSchema = z.enum(ONRAMP_CRYPTO_RAILS);
const offrampCryptoRailSchema = z.enum(OFFRAMP_CRYPTO_RAILS);

const rampCurrencyCodeSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_]+$/, { message: "Invalid ramp currency code" });

export const listOnrampCurrenciesQuerySchema = z.object({
  source: z
    .preprocess(
      (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
      z.string().regex(/^[A-Z]{3}$/, { message: "source must be a 3-letter fiat currency code" })
    )
    .optional(),
  dest: onrampCryptoRailSchema.optional(),
  provider: rampProviderSchema.optional(),
});

export const listOfframpCurrenciesQuerySchema = z.object({
  source: offrampCryptoRailSchema.optional(),
  dest: z
    .preprocess(
      (value) => (typeof value === "string" ? value.trim().toUpperCase() : value),
      z.string().regex(/^[A-Z]{3}$/, { message: "dest must be a 3-letter fiat currency code" })
    )
    .optional(),
  provider: rampProviderSchema.optional(),
});

const bvnkComplianceSchema = z.object({
  partyDetails: z
    .array(z.record(z.string(), z.unknown()))
    .min(1, { message: "partyDetails must include at least one entry" }),
});

export const createTransferSchema = z.object({
  projectId: z.string().min(1).optional(),
  source: z.string().min(1),
  destination: solanaAddressSchema("destination"),
  token: paymentTokenSchema,
  amount: paymentAmountSchema,
  memo: z.string().max(256).optional(),
  privateTransfer: privateTransferSchema.optional(),
});

export const transferDirectionSchema = z.enum(["inbound", "outbound"]);

export const transferStatusSchema = z.enum([
  "pending",
  "processing",
  "confirmed",
  "finalized",
  "failed",
]);

export const listTransfersQuerySchema = z.object({
  wallet: z.string().optional(),
  walletAddress: z.string().optional(),
  token: z.string().optional(),
  direction: transferDirectionSchema.optional(),
  status: transferStatusSchema.optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const priorityFeeSchema = z.enum(["none", "low", "medium", "high", "auto"]);

export const prepareTransferOptionsSchema = z.object({
  priorityFee: priorityFeeSchema.optional(),
  simulate: z.boolean().optional(),
});

export const prepareTransferSchema = createTransferSchema.extend({
  referenceAddress: solanaAddressSchema("referenceAddress").optional(),
  options: prepareTransferOptionsSchema.optional(),
});

export const executeOnrampSchema = z.object({
  provider: rampProviderSchema,
  destinationWallet: z.string().min(1),
  cryptoToken: rampCurrencyCodeSchema,
  fiatCurrency: z.literal("USD").optional(),
  fiatAmount: paymentAmountSchema,
  kycReference: z.string().max(128).optional(),
  redirectUrl: z.string().url().optional(),
  bvnkCompliance: bvnkComplianceSchema.optional(),
});

export const executeOfframpSchema = z.object({
  provider: rampProviderSchema,
  sourceWallet: z.string().min(1),
  cryptoToken: rampCurrencyCodeSchema,
  fiatCurrency: z.literal("USD").optional(),
  cryptoAmount: paymentAmountSchema,
  kycReference: z.string().max(128).optional(),
  redirectUrl: z.string().url().optional(),
  bvnkCompliance: bvnkComplianceSchema.optional(),
});

const simulateLightsparkSandboxTransferPayloadSchema = z.object({
  quoteId: z.string().min(1),
  currencyCode: z.literal("USD").default("USD"),
  currencyAmount: z.number().int().positive().optional(),
});

export const simulateSandboxTransferSchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("lightspark"),
    payload: simulateLightsparkSandboxTransferPayloadSchema,
  }),
]);
