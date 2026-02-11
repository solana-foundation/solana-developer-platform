import { isDecimalString } from "@/lib/amount";
import { z } from "zod";

export const walletIdParamsSchema = z.object({
  walletId: z.string().min(1),
});

export const transferIdParamsSchema = z.object({
  transferId: z.string().min(1),
});

export const updateWalletPolicySchema = z.object({
  mode: z.enum(["none", "allowlist"]),
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

const transferAmountSchema = z
  .string()
  .refine((value) => isDecimalString(value), { message: "Invalid amount format" });

export const createTransferSchema = z.object({
  projectId: z.string().min(1).optional(),
  source: z.string().min(1),
  destination: z.string().min(32).max(44),
  token: z.string().min(1),
  amount: transferAmountSchema,
  memo: z.string().max(256).optional(),
});

export const prepareTransferSchema = createTransferSchema.extend({
  referenceAddress: z.string().min(32).max(44).optional(),
  options: z
    .object({
      priorityFee: z.enum(["none", "low", "medium", "high", "auto"]).optional(),
      simulate: z.boolean().optional(),
    })
    .optional(),
});

export const listTransfersQuerySchema = z.object({
  wallet: z.string().min(1).optional(),
  walletAddress: z.string().min(32).max(44).optional(),
  token: z.string().min(1).optional(),
  direction: z.enum(["inbound", "outbound"]).optional(),
  status: z.enum(["pending", "processing", "confirmed", "finalized", "failed"]).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(50),
});
