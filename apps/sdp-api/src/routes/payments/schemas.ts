import { z } from "zod";
import { isDecimalString } from "@/lib/amount";
import { isAddress } from "@/lib/solana";
import { SOL_MINT } from "@/services/payment-operation.service";

// Payments token field: native SOL keyword, the canonical SOL mint, or a base58
// Solana mint address. Validating the base58 shape here returns 400 BAD_REQUEST
// instead of letting `assertValidAddress` throw a plain Error downstream (500),
// or — on Execute mode — letting the bad mint reach the RPC and surface as
// 502 SOLANA_RPC_ERROR after creating a stuck transfer record.
const paymentTokenSchema = z.union([
  z.literal("SOL"),
  z.literal(SOL_MINT),
  z
    .string()
    .min(32)
    .max(44)
    .refine((value) => isAddress(value), {
      message: "token must be a base58 Solana mint address",
    }),
]);

export const walletIdParamsSchema = z.object({
  walletId: z.string().min(1),
});

export const transferIdParamsSchema = z.object({
  transferId: z.string().min(1),
});

export const updateWalletPolicySchema = z.object({
  destinationAllowlist: z.array(z.string().min(32).max(44)).max(500),
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

const rampProviderSchema = z.enum(["moonpay", "lightspark", "bvnk"]);

const rampCurrencyCodeSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_]+$/, { message: "Invalid ramp currency code" });

const bvnkComplianceSchema = z.object({
  partyDetails: z
    .array(z.record(z.string(), z.unknown()))
    .min(1, { message: "partyDetails must include at least one entry" }),
});

export const createTransferSchema = z.object({
  projectId: z.string().min(1).optional(),
  source: z.string().min(1),
  destination: z.string().min(32).max(44),
  token: paymentTokenSchema,
  amount: paymentAmountSchema,
  memo: z.string().max(256).optional(),
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
  referenceAddress: z.string().min(32).max(44).optional(),
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
