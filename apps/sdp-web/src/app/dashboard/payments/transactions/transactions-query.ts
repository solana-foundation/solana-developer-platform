export const TRANSACTION_TYPES = [
  "transfer",
  "transfer_confidential",
  "transfer_batch",
  "onramp",
  "offramp",
] as const;

export const TRANSACTION_STATUSES = [
  "pending",
  "processing",
  "confirmed",
  "finalized",
  "failed",
  "awaiting_payment",
  "settling",
  "completed",
  "canceled",
  "expired",
] as const;

export const TRANSACTION_SORT_FIELDS = ["createdAt", "updatedAt", "amount", "status"] as const;

export type TransactionTypeFilter = (typeof TRANSACTION_TYPES)[number];
export type TransactionStatusFilter = (typeof TRANSACTION_STATUSES)[number];
export type TransactionSortField = (typeof TRANSACTION_SORT_FIELDS)[number];

export interface TransactionFilters {
  search?: string;
  status?: TransactionStatusFilter;
  direction?: "inbound" | "outbound";
  type?: TransactionTypeFilter;
  walletId?: string;
  counterpartyId?: string;
  asset?: string;
  provider?: string;
  from?: string;
  to?: string;
  sortBy: TransactionSortField;
  sortDirection: "asc" | "desc";
  snapshot: string;
  page: number;
  pageSize: number;
}

type RawSearchParams = Record<string, string | string[] | undefined>;

const DEFAULT_PAGE_SIZE = 25;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseEnum<T extends string>(
  value: string | undefined,
  values: readonly T[]
): T | undefined {
  return value && values.includes(value as T) ? (value as T) : undefined;
}

function parsePositiveInteger(value: string | undefined, fallback: number, max?: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

function parseDate(value: string | undefined): string | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  return Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime()) ? undefined : value;
}

function parseTimestamp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function parseTrimmed(value: string | undefined, maxLength = 200): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

export function parseTransactionFilters(
  searchParams: RawSearchParams,
  now = new Date()
): TransactionFilters {
  return {
    search: parseTrimmed(firstValue(searchParams.search)),
    status: parseEnum(firstValue(searchParams.status), TRANSACTION_STATUSES),
    direction: parseEnum(firstValue(searchParams.direction), ["inbound", "outbound"] as const),
    type: parseEnum(firstValue(searchParams.type), TRANSACTION_TYPES),
    walletId: parseTrimmed(firstValue(searchParams.wallet)),
    counterpartyId: parseTrimmed(firstValue(searchParams.counterparty)),
    asset: parseTrimmed(firstValue(searchParams.asset), 64),
    provider: parseTrimmed(firstValue(searchParams.provider), 64),
    from: parseDate(firstValue(searchParams.from)),
    to: parseDate(firstValue(searchParams.to)),
    sortBy: parseEnum(firstValue(searchParams.sortBy), TRANSACTION_SORT_FIELDS) ?? "createdAt",
    sortDirection:
      parseEnum(firstValue(searchParams.sortDirection), ["asc", "desc"] as const) ?? "desc",
    snapshot: parseTimestamp(firstValue(searchParams.snapshot)) ?? now.toISOString(),
    page: parsePositiveInteger(firstValue(searchParams.page), 1),
    pageSize: parsePositiveInteger(firstValue(searchParams.pageSize), DEFAULT_PAGE_SIZE, 100),
  };
}

export function serializeTransactionFilters(filters: TransactionFilters): URLSearchParams {
  const query = new URLSearchParams();
  const set = (key: string, value: string | number | undefined) => {
    if (value !== undefined && value !== "") query.set(key, String(value));
  };

  set("search", filters.search);
  set("status", filters.status);
  set("direction", filters.direction);
  set("type", filters.type);
  set("wallet", filters.walletId);
  set("counterparty", filters.counterpartyId);
  set("asset", filters.asset);
  set("provider", filters.provider);
  set("from", filters.from);
  set("to", filters.to);
  if (filters.sortBy !== "createdAt") set("sortBy", filters.sortBy);
  if (filters.sortDirection !== "desc") set("sortDirection", filters.sortDirection);
  set("snapshot", filters.snapshot);
  if (filters.page !== 1) set("page", filters.page);
  if (filters.pageSize !== DEFAULT_PAGE_SIZE) set("pageSize", filters.pageSize);
  return query;
}

export function toTransactionsApiQuery(filters: TransactionFilters): URLSearchParams {
  const query = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(filters.pageSize),
    includeObserved: "false",
    sortBy: filters.sortBy,
    sortDirection: filters.sortDirection,
  });
  const set = (key: string, value: string | undefined) => {
    if (value) query.set(key, value);
  };

  set("search", filters.search);
  set("status", filters.status);
  set("direction", filters.direction);
  set("type", filters.type);
  set("wallet", filters.walletId);
  set("counterpartyId", filters.counterpartyId);
  set("token", filters.asset);
  set("provider", filters.provider);
  set("from", filters.from ? `${filters.from}T00:00:00.000Z` : undefined);
  const requestedTo = filters.to ? `${filters.to}T23:59:59.999Z` : undefined;
  set("to", requestedTo && requestedTo < filters.snapshot ? requestedTo : filters.snapshot);
  return query;
}

export function countActiveTransactionFilters(filters: TransactionFilters): number {
  return [
    filters.status,
    filters.direction,
    filters.type,
    filters.walletId,
    filters.counterpartyId,
    filters.asset,
    filters.provider,
    filters.from,
    filters.to,
  ].filter(Boolean).length;
}
