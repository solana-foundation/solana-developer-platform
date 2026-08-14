import type {
  CustodyConnectionCheckStatus,
  CustodyConnectionFailureCode,
  CustodyConnectionLifecycle,
  CustodyProvider,
  CustodyWalletSummary,
  ProviderCredentialStatus,
} from "@sdp/types";
import type { SdpApiClient } from "@/lib/sdp-api";

export const CONNECTIONS_PAGE_SIZE = 20;

export interface ConnectionLastCheck {
  status: CustodyConnectionCheckStatus;
  at: string | null;
  failureCode: CustodyConnectionFailureCode | null;
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
    status: ProviderCredentialStatus;
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

/**
 * An empty slice with a nonzero total is never trustworthy, whether the page
 * was past the end or an in-range page emptied by concurrent deletions with a
 * stale count in the same response. Only rows, or a zero total, settle a page.
 */
function isSettledPage(result: ConnectionsPageResult): boolean {
  return result.connections.length > 0 || result.pagination.total === 0;
}

/**
 * A `?page=` whose slice comes back empty despite a nonzero total (stale URL,
 * shrunk inventory, or an in-range page emptied under the read) would render
 * the project-wide empty state while connections still exist. Clamp to the
 * last page the total implies and refetch; if that is still empty, fall back
 * to page 1, whose slice is definitionally the inventory's own answer.
 */
export async function resolveConnectionsPage(
  request: SdpApiClient["request"],
  filters: ConnectionsFilters
): Promise<{ result: ConnectionsPageResult; filters: ConnectionsFilters }> {
  const result = await fetchConnectionsPage(request, filters);
  if (isSettledPage(result)) {
    return { result, filters };
  }

  const clamped = {
    page: Math.max(1, Math.ceil(result.pagination.total / CONNECTIONS_PAGE_SIZE)),
  };
  if (clamped.page !== filters.page) {
    const clampedResult = await fetchConnectionsPage(request, clamped);
    if (isSettledPage(clampedResult)) {
      return { result: clampedResult, filters: clamped };
    }
  }

  const firstPage = { page: 1 };
  if (filters.page === firstPage.page) {
    return { result, filters };
  }
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
  const json = (await res.json()) as { data: { wallets: CustodyWalletSummary[] } };
  const byConnection = new Map<string, CustodyWalletSummary[]>();
  for (const wallet of json.data.wallets) {
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
