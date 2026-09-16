import {
  UNIFIED_TRANSACTION_MODULES,
  UNIFIED_TRANSACTION_STATUSES,
  type UnifiedTransactionModule,
} from "@sdp/types";
import { z } from "zod";

const rawFiltersSchema = z.object({
  tab: z.string().optional().catch(undefined),
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

export type TransactionFilters = Omit<z.infer<typeof rawFiltersSchema>, "tab" | "cursors"> & {
  module?: UnifiedTransactionModule;
  cursors: string[];
};

type RawSearchParams = Record<string, string | string[] | undefined>;

function scalar(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Narrows a raw `?tab=` value to a transaction module. The shared header tabs
 * carry the module id in `tab`, so the workspace and this parser interpret the
 * param identically.
 *
 * @param value - The raw tab value, if any.
 * @returns The matching module, or undefined for "all", an absent tab, or an unknown value.
 */
export function parseTransactionModule(
  value: string | null | undefined
): UnifiedTransactionModule | undefined {
  return UNIFIED_TRANSACTION_MODULES.find((candidate) => candidate === value);
}

export function parseTransactionFilters(searchParams: RawSearchParams): TransactionFilters {
  const parsed = rawFiltersSchema.parse(
    Object.fromEntries(Object.entries(searchParams).map(([key, value]) => [key, scalar(value)]))
  );
  const { tab, cursors: rawCursors, ...rest } = parsed;
  const cursors = rawCursors === undefined || rawCursors === "" ? [] : rawCursors.split(",");
  return { ...rest, module: parseTransactionModule(tab), cursors };
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
    tab: filters.module === undefined ? null : filters.module,
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
