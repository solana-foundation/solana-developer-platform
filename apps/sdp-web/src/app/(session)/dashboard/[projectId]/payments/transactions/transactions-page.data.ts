import {
  UNIFIED_TRANSACTION_MODULE_CONTRACTS,
  UNIFIED_TRANSACTION_STATUSES,
} from "@sdp/types/unified-transactions";
import { z } from "zod";

const unifiedTransactionCommonSchema = z.object({
  id: z.string().min(1),
  moduleId: z.string().min(1),
  status: z.enum(UNIFIED_TRANSACTION_STATUSES),
  organizationId: z.string(),
  projectId: z.string().nullable(),
  custodyWalletId: z.string().nullable(),
  custodyWalletLabel: z.string().nullable(),
  token: z.string().nullable(),
  amount: z.string().nullable(),
  counterpartyId: z.string().nullable(),
  signature: z.string().nullable(),
  createdAt: z.string(),
});

const contracts = UNIFIED_TRANSACTION_MODULE_CONTRACTS;

export const unifiedTransactionSchema = z.discriminatedUnion("module", [
  unifiedTransactionCommonSchema.extend({
    module: z.literal("payments"),
    kind: z.enum(contracts.payments.kinds),
    moduleStatus: z.enum(contracts.payments.moduleStatuses),
  }),
  unifiedTransactionCommonSchema.extend({
    module: z.literal("earn"),
    kind: z.enum(contracts.earn.kinds),
    moduleStatus: z.enum(contracts.earn.moduleStatuses),
  }),
  unifiedTransactionCommonSchema.extend({
    module: z.literal("dvp"),
    kind: z.enum(contracts.dvp.kinds),
    moduleStatus: z.enum(contracts.dvp.moduleStatuses),
  }),
  unifiedTransactionCommonSchema.extend({
    module: z.literal("private_channels"),
    kind: z.enum(contracts.private_channels.kinds),
    moduleStatus: z.enum(contracts.private_channels.moduleStatuses),
  }),
  unifiedTransactionCommonSchema.extend({
    module: z.literal("issuance"),
    kind: z.enum(contracts.issuance.kinds),
    moduleStatus: z.enum(contracts.issuance.moduleStatuses),
  }),
  unifiedTransactionCommonSchema.extend({
    module: z.literal("rings"),
    kind: z.enum(contracts.rings.kinds),
    moduleStatus: z.enum(contracts.rings.moduleStatuses),
  }),
]);

export const transactionsPageResponseSchema = z.object({
  data: z.object({
    transactions: z.array(unifiedTransactionSchema),
    nextCursor: z.string().nullable(),
  }),
});

export type TransactionsPageResult = z.infer<typeof transactionsPageResponseSchema>["data"];
