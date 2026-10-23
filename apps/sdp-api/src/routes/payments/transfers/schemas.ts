import { PAYMENT_TRANSFER_STATUSES, PAYMENT_TRANSFER_TYPES } from "@sdp/types/payments";
import {
  DEFAULT_TOKEN_MOVEMENT_BASIS,
  TOKEN_MOVEMENT_BASES,
  type TokenMovementBasis,
} from "@sdp/types/token-movements";
import { z } from "zod";
import { rampProviderSchema } from "@/routes/payments/ramps/schemas";
import {
  paymentAmountSchema,
  paymentTokenSchema,
  solanaAddressSchema,
} from "@/routes/payments/schemas";

export const createTransferSchema = z.strictObject({
  projectId: z.string().min(1).optional(),
  transferId: z.string().min(1).optional(),
  sourceCustodyWalletId: z.string().min(1),
  destination: solanaAddressSchema("destination"),
  token: paymentTokenSchema,
  amount: paymentAmountSchema,
  amountBasis: z.enum(TOKEN_MOVEMENT_BASES).optional(),
  memo: z.string().max(256).optional(),
});

/**
 * The basis a create-transfer request's amount has when it names none. A
 * request that funds an off-ramp deposit (`transferId`) names the provider's
 * deposit amount, a receipt, so its basis is `credit`; any other is `debit`.
 */
export function defaultTransferBasis(body: { transferId?: string }): TokenMovementBasis {
  return body.transferId === undefined ? DEFAULT_TOKEN_MOVEMENT_BASIS : "credit";
}

/** The basis a create-transfer request's amount has: the one it names, or its default. */
export function requestedTransferBasis(body: {
  transferId?: string;
  amountBasis?: TokenMovementBasis;
}): TokenMovementBasis {
  return body.amountBasis === undefined ? defaultTransferBasis(body) : body.amountBasis;
}

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
