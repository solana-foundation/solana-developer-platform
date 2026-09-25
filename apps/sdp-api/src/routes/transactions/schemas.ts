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

/**
 * Builds the unified transaction contract over exactly `modules`, for the
 * runtime (all modules) and for publication-filtered OpenAPI documents
 * (openapi/paths/transactions.ts): a held-back module must be omitted from
 * the module selector and its branch/status vocabulary from the response
 * union, so the published contract cannot name it (SOLA9-85).
 */
function unifiedTransactionSchemaForModules<
  const Modules extends readonly [UnifiedTransactionModule, ...UnifiedTransactionModule[]],
>(modules: Modules) {
  return z.discriminatedUnion(
    "module",
    // TS cannot carry tuple types through .map(); every element is exactly
    // the moduleSchemas entry for its module, each a ZodObject with a
    // `module` literal — the shape discriminatedUnion requires.
    modules.map((module) => moduleSchemas[module]) as {
      [K in keyof Modules]: (typeof moduleSchemas)[Modules[K]];
    }
  );
}

export function unifiedTransactionsQuerySchemaForModules<
  const Modules extends readonly [UnifiedTransactionModule, ...UnifiedTransactionModule[]],
>(modules: Modules) {
  return z
    .object({
      module: z.enum(modules).optional(),
      kind: z.string().optional(),
      status: z.enum(UNIFIED_TRANSACTION_STATUSES).optional(),
      custodyWalletId: z.string().max(128).optional(),
      counterpartyId: z.string().max(128).optional(),
      token: z.string().max(128).optional(),
      search: z
        .string()
        .trim()
        .min(3)
        .max(200)
        .describe(
          "Prefix match against transaction id, module id, or signature — not a substring search."
        )
        .optional(),
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
        context.addIssue({
          code: "custom",
          message: "kind is not valid for module",
          path: ["kind"],
        });
      }
    });
}

export const unifiedTransactionSchema = unifiedTransactionSchemaForModules(
  UNIFIED_TRANSACTION_MODULES
) satisfies z.ZodType<UnifiedTransaction>;

/**
 * The module-agnostic variant of the published transaction union. While a
 * module is held back (SOLA9-85) the published response union cannot branch
 * on its rows — but the runtime is not narrowed, so an unfiltered read still
 * returns held-back rows to an authorized caller, and a client generated
 * from the published document must parse them. This variant describes any
 * transaction over the shared envelope without naming its module or carrying
 * its vocabulary, so the published contract stays true (and parseable)
 * without leaking the held-back family. The OpenAPI layer appends it only
 * where the module selector omits modules (openapi/paths/transactions.ts).
 *
 * `namedModules` are the modules the union's other branches name (the
 * published allowlist). The variant refuses them, so a published row can
 * only parse through its own branch — an invalid `kind` or `moduleStatus`
 * on a published module fails the union instead of being absorbed here —
 * while rows of modules the selector does not name (held back, or added to
 * the runtime later) still parse.
 *
 * The refusal is carried twice, for the two audiences of the contract. The
 * runtime `.refine` enforces it when the Zod schema parses. The `.meta`
 * `not: { enum }` mirrors it into the published OpenAPI document, where a
 * refinement is invisible: generated clients read the document, so the
 * variant's `module` must exclude the named modules as a schema constraint,
 * or every published row (whatever its `kind`/`moduleStatus`) would still
 * match the variant and generated types could not narrow those fields by
 * module. The `not` enumerates only the published modules — naming the
 * held-back family is exactly what the hold forbids.
 */
export function unpublishedModuleTransactionSchema(namedModules: readonly string[]) {
  return z.object({
    ...commonFields,
    module: z
      .string()
      .refine((module) => !namedModules.includes(module))
      .meta({ not: { enum: [...namedModules] } }),
    kind: z.string(),
    moduleStatus: z.string(),
  });
}

export interface UnifiedTransactionsListResponseSchemaOptions {
  /**
   * Append `unpublishedModuleTransactionSchema` to the response union. Set
   * only for publication-filtered documents, where the union's branches name
   * a subset of the modules the runtime can return: the open variant keeps
   * every response the endpoint can produce parseable for a client generated
   * from the published document, while refusing the modules the branches
   * name so published rows only parse through their own branch.
   */
  openUnpublished?: boolean;
}

function closedUnifiedTransactionsListResponseSchemaForModules<
  const Modules extends readonly [UnifiedTransactionModule, ...UnifiedTransactionModule[]],
>(modules: Modules) {
  return z.object({
    transactions: z.array(unifiedTransactionSchemaForModules(modules)),
    nextCursor: z.string().nullable(),
  });
}

export function unifiedTransactionsListResponseSchemaForModules<
  const Modules extends readonly [UnifiedTransactionModule, ...UnifiedTransactionModule[]],
>(modules: Modules, options: UnifiedTransactionsListResponseSchemaOptions = {}) {
  if (!options.openUnpublished) {
    return closedUnifiedTransactionsListResponseSchemaForModules(modules);
  }
  // TS cannot carry the tuple type through .map(), so the head element is
  // destructured out to keep the literal a tuple for z.union; every module
  // element is exactly the moduleSchemas entry for its module.
  const [headModule, ...tailModules] = modules;
  const variants = [
    moduleSchemas[headModule],
    ...tailModules.map((module) => moduleSchemas[module]),
    unpublishedModuleTransactionSchema(modules),
  ];
  return z.object({
    transactions: z.array(z.union(variants)),
    nextCursor: z.string().nullable(),
  });
}

export const unifiedTransactionsListResponseSchema =
  closedUnifiedTransactionsListResponseSchemaForModules(
    UNIFIED_TRANSACTION_MODULES
  ) satisfies z.ZodType<UnifiedTransactionsListResponse>;

export const unifiedTransactionsQuerySchema = unifiedTransactionsQuerySchemaForModules(
  UNIFIED_TRANSACTION_MODULES
);

export type UnifiedTransactionsQuery = z.infer<typeof unifiedTransactionsQuerySchema>;
