import { PAYMENT_TRANSFER_STATUSES, PAYMENT_TRANSFER_TYPES } from "@sdp/types";
import { z } from "zod";
import {
  paymentAmountSchema,
  paymentTokenSchema,
  rampProviderSchema,
  solanaAddressSchema,
} from "../schemas";

export const createTransferSchema = z.strictObject({
  projectId: z.string().min(1).optional(),
  transferId: z.string().min(1).optional(),
  sourceCustodyWalletId: z.string().min(1),
  destination: solanaAddressSchema("destination"),
  token: paymentTokenSchema,
  amount: paymentAmountSchema,
  memo: z.string().max(256).optional(),
});

export const transferDirectionSchema = z.enum(["inbound", "outbound"]);

export const transferStatusSchema = z.enum(PAYMENT_TRANSFER_STATUSES);
export const transferTypeSchema = z.enum(PAYMENT_TRANSFER_TYPES);

const transferFilterTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

export const listTransfersQuerySchema = z.strictObject({
  custodyWalletId: z.string().min(1).optional(),
  search: z
    .string()
    .trim()
    .max(200)
    .refine((value) => value.length === 0 || value.length >= 3, {
      message: "Search must be blank or contain at least 3 characters",
    })
    .optional(),
  token: z.string().optional(),
  direction: transferDirectionSchema.optional(),
  status: z
    .string()
    .transform((value) => value.split(","))
    .pipe(z.array(transferStatusSchema).min(1))
    .optional(),
  category: z.enum(["wallet", "ramp"]).optional(),
  type: z
    .string()
    .transform((value) => value.split(","))
    .pipe(z.array(transferTypeSchema).min(1))
    .optional(),
  counterpartyId: z.string().min(1).optional(),
  provider: rampProviderSchema.optional(),
  providerReference: z.string().min(1).optional(),
  from: transferFilterTimestampSchema.optional(),
  to: transferFilterTimestampSchema.optional(),
  includeObserved: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .default(false),
  sortBy: z.enum(["createdAt", "updatedAt", "amount", "status"]).default("createdAt"),
  sortDirection: z.enum(["asc", "desc"]).default("desc"),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
