import type { CoinbaseRampEvent, MoneygramRampEvent } from "@sdp/types";
import { z } from "zod";

export const moneygramRampEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("transaction_created"),
    sessionId: z.string().min(1),
    transactionId: z.string().min(1),
    mgiTransactionId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("deposit_address"),
    sessionId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("onramp_completed"),
    sessionId: z.string().min(1),
    transactionId: z.string().min(1),
    status: z.string().min(1),
    amount: z.number().positive(),
    referenceNumber: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("signed"),
    sessionId: z.string().min(1),
    cryptoTransferId: z.string().min(1),
  }),
  z.object({
    kind: z.literal("completed"),
    sessionId: z.string().min(1),
    cryptoTransferId: z.string().min(1),
    transactionId: z.string().min(1),
    payoutAmount: z.number().positive(),
    payoutStatus: z.string().min(1),
    referenceNumber: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("errored"),
    sessionId: z.string().min(1),
    reason: z.string().min(1),
    cryptoTransferId: z.string().min(1).optional(),
    transactionId: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("closed"),
    sessionId: z.string().min(1),
  }),
]) satisfies z.ZodType<MoneygramRampEvent>;

export const coinbaseRampEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("committed"), orderId: z.string().min(1) }),
  z.object({ kind: z.literal("errored"), orderId: z.string().min(1), reason: z.string().min(1) }),
]) satisfies z.ZodType<CoinbaseRampEvent>;
