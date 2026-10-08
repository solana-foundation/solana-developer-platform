import { UNIFIED_TRANSACTION_STATUSES, type UnifiedTransactionModule } from "@sdp/types";
import { z } from "zod";
import { parseTransactionModule } from "./transactions-query";

// One reading of a module param for both designs: the redesign forked its own once and lost the
// release-channel filter.
export { parseTransactionModule };

/** Rows per page the list offers; 25 is the default and carries no URL param. */
export const TRANSACTION_PAGE_SIZES = [10, 25, 50, 100] as const;
export const DEFAULT_TRANSACTION_PAGE_SIZE = 25;

const rawFiltersSchema = z.object({
  module: z.string().optional().catch(undefined),
  // Links written before the module moved out of the header tabs carry it in `tab`.
  tab: z.string().optional().catch(undefined),
  pageSize: z.coerce
    .number()
    .refine((value) => TRANSACTION_PAGE_SIZES.some((size) => size === value))
    .optional()
    .catch(undefined),
  kind: z.string().trim().min(1).optional().catch(undefined),
  status: z.enum(UNIFIED_TRANSACTION_STATUSES).optional().catch(undefined),
  custodyWalletId: z.string().trim().max(128).min(1).optional().catch(undefined),
  counterpartyId: z.string().trim().max(128).min(1).optional().catch(undefined),
  token: z.string().trim().max(128).min(1).optional().catch(undefined),
  search: z.string().trim().max(200).min(3).optional().catch(undefined),
  from: z.iso.date().optional().catch(undefined),
  to: z.iso.date().optional().catch(undefined),
  cursor: z.string().min(1).optional().catch(undefined),
  cursors: z.string().optional().catch(undefined),
});

export type TransactionFilters = Omit<
  z.infer<typeof rawFiltersSchema>,
  "module" | "tab" | "cursors"
> & {
  module?: UnifiedTransactionModule;
  cursors: string[];
};

type RawSearchParams = Record<string, string | string[] | undefined>;

function scalar(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function parseTransactionFilters(
  searchParams: RawSearchParams,
  modules: readonly UnifiedTransactionModule[]
): TransactionFilters {
  const parsed = rawFiltersSchema.parse(
    Object.fromEntries(Object.entries(searchParams).map(([key, value]) => [key, scalar(value)]))
  );
  const { module: rawModule, tab, kind, pageSize, cursors: rawCursors, ...fields } = parsed;
  const rest = {
    ...fields,
    ...(pageSize === undefined || pageSize === DEFAULT_TRANSACTION_PAGE_SIZE ? {} : { pageSize }),
  };
  const cursors = rawCursors === undefined || rawCursors === "" ? [] : rawCursors.split(",");
  const requested = rawModule ?? tab;
  const module = parseTransactionModule(requested, modules);
  if (module !== undefined) return { ...rest, module, kind, cursors };
  // A kind belongs to its module (the API refuses one without it), so All never carries one.
  if (requested === undefined || requested === "all") return { ...rest, cursors };
  // The link named a module that is hidden or unknown: open All from its first page, since that
  // module's cursor would skip newer transactions on All.
  const { cursor: _discardedCursor, ...unpaged } = rest;
  return { ...unpaged, cursors: [] };
}

const TRANSACTION_URL_PARAM_KEYS = [
  "kind",
  "status",
  "custodyWalletId",
  "counterpartyId",
  "token",
  "search",
  "from",
  "to",
  "cursor",
] as const satisfies readonly (keyof Omit<TransactionFilters, "module" | "cursors">)[];

/**
 * Every URL param the transactions page owns, shaped for a shallow history
 * update: present filters carry their value and absent ones are null, so a
 * replaced filter set never leaves a stale param behind.
 *
 * @param filters - The filter set the URL should reflect.
 * @returns Param updates for `replaceDashboardSearchParams`.
 */
export function toTransactionUrlUpdates(
  filters: TransactionFilters
): Record<string, string | null> {
  return {
    module: filters.module === undefined ? null : filters.module,
    tab: null,
    pageSize:
      filters.pageSize === undefined || filters.pageSize === DEFAULT_TRANSACTION_PAGE_SIZE
        ? null
        : String(filters.pageSize),
    ...Object.fromEntries(
      TRANSACTION_URL_PARAM_KEYS.map((key) => [
        key,
        filters[key] === undefined ? null : filters[key],
      ])
    ),
    cursors: filters.cursors.length === 0 ? null : filters.cursors.join(","),
  };
}

export function serializeTransactionFilters(filters: TransactionFilters): URLSearchParams {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(toTransactionUrlUpdates(filters))) {
    if (value !== null) query.set(key, value);
  }
  return query;
}

export function toTransactionsApiQuery(
  filters: TransactionFilters,
  limit: number
): URLSearchParams {
  const query = new URLSearchParams({ limit: String(limit) });
  const values = {
    module: filters.module,
    kind: filters.kind,
    status: filters.status,
    custodyWalletId: filters.custodyWalletId,
    counterpartyId: filters.counterpartyId,
    token: filters.token,
    search: filters.search,
    createdAtFrom: filters.from === undefined ? undefined : `${filters.from}T00:00:00.000Z`,
    createdAtTo: filters.to === undefined ? undefined : `${filters.to}T23:59:59.999Z`,
    cursor: filters.cursor,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, value);
  }
  return query;
}
