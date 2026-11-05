import {
  counterpartyAccountSummarySchema,
  paymentTransferBatchEstimateSchema,
  paymentTransferBatchSchema,
  paymentTransferRecipientSchema,
  paymentTransferSummarySchema,
} from "@sdp/types/payments";
import { z } from "zod";

export const transferListResponseSchema = z.object({
  data: z.array(paymentTransferSummarySchema),
});

export const transferPageResponseSchema = transferListResponseSchema.extend({
  meta: z.object({ total: z.number().int().nonnegative() }),
});

/** A transfer as its own read returns it, with the network fee the shared record leaves out. */
export const transferDetailSchema = paymentTransferSummarySchema.extend({
  /** The Solana fee in lamports, once the transaction landed. */
  fee: z.number().nullable().optional(),
});

export const transferResponseSchema = z.object({
  data: z.object({ transfer: transferDetailSchema }),
});

export const transferBatchListResponseSchema = z.object({
  data: z.array(paymentTransferBatchSchema),
});

export const transferBatchResponseSchema = z.object({
  data: z.object({
    batch: paymentTransferBatchSchema,
    recipients: z.array(paymentTransferRecipientSchema),
    transfers: z.array(paymentTransferSummarySchema),
  }),
});

export const projectCounterpartyAccountsResponseSchema = z.object({
  data: z.object({
    accounts: z.array(counterpartyAccountSummarySchema),
    total: z.number().int().nonnegative(),
    page: z.number().int(),
    pageSize: z.number().int(),
  }),
});

export const transferBatchEstimateResponseSchema = z.object({
  data: z.object({ estimate: paymentTransferBatchEstimateSchema }),
});
