import type { CustodyConnectionLifecycle, CustodyProvider, CustodyWalletSummary } from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";

export const CONNECTIONS_PAGE_SIZE = 20;

/** Failure codes the installation service publishes; anything unknown renders the generic copy. */
export type ConnectionCheckFailureCode =
  | "invalid_credentials"
  | "provider_response_unknown"
  | "provider_account_already_connected"
  | "wallet_conflict";

export interface ConnectionLastCheck {
  status: "running" | "success" | "failed" | "retry_unknown" | (string & {});
  at: string | null;
  failureCode: ConnectionCheckFailureCode | (string & {}) | null;
}

export interface CustodyConnectionListItem {
  id: string;
  provider: CustodyProvider;
  status: CustodyConnectionLifecycle;
  createdAt: string;
  activatedAt: string | null;
  lastCheck: ConnectionLastCheck | null;
  pendingWalletLabel: string | null;
  providerCredential: {
    id: string;
    label: string;
    status: "pending" | "active" | "failed_validation" | "retired" | "deactivated" | (string & {});
  };
}

export interface ConnectionsPageResult {
  connections: CustodyConnectionListItem[];
  pagination: { limit: number; offset: number; total: number };
}

export interface ConnectionsFilters {
  page: number;
}

export class ConnectionsRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Custody connections request failed (${status})`);
    this.name = "ConnectionsRequestError";
    this.status = status;
  }
}

type SearchParams = Record<string, string | string[] | undefined>;

function firstSearchParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseConnectionsFilters(searchParams: SearchParams): ConnectionsFilters {
  const parsedPage = Number.parseInt(firstSearchParam(searchParams.page) ?? "1", 10);
  return {
    page: Number.isInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1,
  };
}

export function buildConnectionsSearchParams(
  filters: ConnectionsFilters,
  overrides: Partial<ConnectionsFilters>
): URLSearchParams {
  const next = { ...filters, ...overrides };
  const query = new URLSearchParams();
  if (next.page > 1) query.set("page", String(next.page));
  return query;
}

export async function fetchConnectionsPage(
  request: SdpApiClient["request"],
  filters: ConnectionsFilters
): Promise<ConnectionsPageResult> {
  const offset = (filters.page - 1) * CONNECTIONS_PAGE_SIZE;
  const res = await request(
    `/internal/dashboard/custody/connections?limit=${CONNECTIONS_PAGE_SIZE}&offset=${offset}`
  );
  if (!res.ok) {
    throw new ConnectionsRequestError(res.status);
  }
  const json = (await res.json()) as { data: ConnectionsPageResult };
  return json.data;
}

function isSettledPage(result: ConnectionsPageResult, page: number): boolean {
  const pageCount = Math.max(1, Math.ceil(result.pagination.total / CONNECTIONS_PAGE_SIZE));
  return result.connections.length > 0 || result.pagination.total === 0 || page <= pageCount;
}

/**
 * A stale or hand-edited `?page=` past the end returns an empty slice with a
 * nonzero total, which would render an empty table with no pager to escape
 * through. Clamp to the last real page and refetch; if the total shrank again
 * between the two reads, fall back to page 1, which is always in range.
 */
export async function resolveConnectionsPage(
  request: SdpApiClient["request"],
  filters: ConnectionsFilters
): Promise<{ result: ConnectionsPageResult; filters: ConnectionsFilters }> {
  const result = await fetchConnectionsPage(request, filters);
  if (isSettledPage(result, filters.page)) {
    return { result, filters };
  }

  const clamped = {
    page: Math.max(1, Math.ceil(result.pagination.total / CONNECTIONS_PAGE_SIZE)),
  };
  const clampedResult = await fetchConnectionsPage(request, clamped);
  if (isSettledPage(clampedResult, clamped.page)) {
    return { result: clampedResult, filters: clamped };
  }

  const firstPage = { page: 1 };
  return { result: await fetchConnectionsPage(request, firstPage), filters: firstPage };
}

/**
 * The connections list itself carries no wallet columns, but every
 * connection-owned wallet knows its connection: `/v1/wallets` rows carry
 * `custodyConnectionId` when a Connection (not a legacy Config) owns them.
 */
export async function fetchWalletsByConnection(
  request: SdpApiClient["request"]
): Promise<Map<string, CustodyWalletSummary[]>> {
  const res = await request("/v1/wallets?includeAllProviders=true");
  if (!res.ok) {
    throw new ConnectionsRequestError(res.status);
  }
  const json = (await res.json()) as { data?: { wallets?: CustodyWalletSummary[] } };
  const byConnection = new Map<string, CustodyWalletSummary[]>();
  for (const wallet of json.data?.wallets ?? []) {
    if (!wallet.custodyConnectionId) continue;
    const existing = byConnection.get(wallet.custodyConnectionId);
    if (existing) {
      existing.push(wallet);
    } else {
      byConnection.set(wallet.custodyConnectionId, [wallet]);
    }
  }
  return byConnection;
}
