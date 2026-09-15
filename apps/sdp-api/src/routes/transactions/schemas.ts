import {
  UNIFIED_TRANSACTION_MODULE_CONTRACTS,
  UNIFIED_TRANSACTION_MODULES,
  UNIFIED_TRANSACTION_STATUSES,
  type UnifiedTransaction,
  type UnifiedTransactionModule,
  type UnifiedTransactionsListResponse,
} from "@sdp/types";
import { z } from "zod";

const commonFields = {
  id: z.string(),
  moduleId: z.string(),
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
};

function transactionSchemaFor<
  Module extends UnifiedTransactionModule,
  const Kinds extends readonly string[],
  const Statuses extends readonly string[],
>(module: Module, kinds: Kinds, statuses: Statuses) {
  return z.object({
    ...commonFields,
    module: z.literal(module),
    kind: z.enum(kinds),
    moduleStatus: z.enum(statuses),
  });
}

const moduleSchemas = {
  payments: transactionSchemaFor(
    "payments",
    UNIFIED_TRANSACTION_MODULE_CONTRACTS.payments.kinds,
    UNIFIED_TRANSACTION_MODULE_CONTRACTS.payments.moduleStatuses
  ),
  earn: transactionSchemaFor(
    "earn",
    UNIFIED_TRANSACTION_MODULE_CONTRACTS.earn.kinds,
    UNIFIED_TRANSACTION_MODULE_CONTRACTS.earn.moduleStatuses
  ),
  dvp: transactionSchemaFor(
    "dvp",
    UNIFIED_TRANSACTION_MODULE_CONTRACTS.dvp.kinds,
    UNIFIED_TRANSACTION_MODULE_CONTRACTS.dvp.moduleStatuses
  ),
  private_channels: transactionSchemaFor(
    "private_channels",
    UNIFIED_TRANSACTION_MODULE_CONTRACTS.private_channels.kinds,
    UNIFIED_TRANSACTION_MODULE_CONTRACTS.private_channels.moduleStatuses
  ),
  issuance: transactionSchemaFor(
    "issuance",
    UNIFIED_TRANSACTION_MODULE_CONTRACTS.issuance.kinds,
    UNIFIED_TRANSACTION_MODULE_CONTRACTS.issuance.moduleStatuses
  ),
  rings: transactionSchemaFor(
    "rings",
    UNIFIED_TRANSACTION_MODULE_CONTRACTS.rings.kinds,
    UNIFIED_TRANSACTION_MODULE_CONTRACTS.rings.moduleStatuses
  ),
} satisfies Record<UnifiedTransactionModule, z.ZodTypeAny>;

export const unifiedTransactionSchema = z.discriminatedUnion("module", [
  moduleSchemas.payments,
  moduleSchemas.earn,
  moduleSchemas.dvp,
  moduleSchemas.private_channels,
  moduleSchemas.issuance,
  moduleSchemas.rings,
]) satisfies z.ZodType<UnifiedTransaction>;

export const unifiedTransactionsListResponseSchema = z.object({
  transactions: z.array(unifiedTransactionSchema),
  nextCursor: z.string().nullable(),
}) satisfies z.ZodType<UnifiedTransactionsListResponse>;

export const unifiedTransactionsQuerySchema = z
  .object({
    module: z.enum(UNIFIED_TRANSACTION_MODULES).optional(),
    kind: z.string().optional(),
    status: z.enum(UNIFIED_TRANSACTION_STATUSES).optional(),
    custodyWalletId: z.string().optional(),
    counterpartyId: z.string().optional(),
    token: z.string().optional(),
    search: z.string().trim().min(3).optional(),
    createdAtFrom: z.string().datetime().optional(),
    createdAtTo: z.string().datetime().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .superRefine((query, context) => {
    if (query.kind === undefined) return;
    if (query.module === undefined) {
      context.addIssue({ code: "custom", message: "kind requires module", path: ["kind"] });
      return;
    }
    const kinds: readonly string[] = UNIFIED_TRANSACTION_MODULE_CONTRACTS[query.module].kinds;
    if (!kinds.includes(query.kind)) {
      context.addIssue({ code: "custom", message: "kind is not valid for module", path: ["kind"] });
    }
  });

export type UnifiedTransactionsQuery = z.infer<typeof unifiedTransactionsQuerySchema>;
