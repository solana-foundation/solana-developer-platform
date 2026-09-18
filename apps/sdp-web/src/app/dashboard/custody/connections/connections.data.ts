import {
  CUSTODY_CONNECTION_CHECK_STATUSES,
  CUSTODY_CONNECTION_FAILURE_CODES,
  CUSTODY_CONNECTION_LIFECYCLES,
  CUSTODY_PROVIDERS,
  type CustodyProvider,
  type CustodyWalletSummary,
} from "@sdp/types";
import { z } from "zod";
import type { SdpApiClient } from "@/lib/sdp-api";

export const CONNECTIONS_PAGE_SIZE = 20;

const connectionLastCheckSchema = z.object({
  status: z.enum(CUSTODY_CONNECTION_CHECK_STATUSES),
  at: z.string().nullable(),
  failureCode: z.enum(CUSTODY_CONNECTION_FAILURE_CODES).nullable(),
});

const custodyConnectionListItemSchema = z.object({
  id: z.string(),
  provider: z.enum(CUSTODY_PROVIDERS),
  label: z.string(),
  status: z.enum(CUSTODY_CONNECTION_LIFECYCLES),
  isDefault: z.boolean(),
  isRuntimeExecutionAllowed: z.boolean(),
  defaultCustodyWalletId: z.string().nullable(),
  createdAt: z.string(),
  activatedAt: z.string().nullable(),
  lastCheck: connectionLastCheckSchema.nullable(),
  pendingWalletLabel: z.string().nullable(),
});

const connectionsPageResultSchema = z.object({
  connections: z.array(custodyConnectionListItemSchema),
  pagination: z.object({
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});

export const connectionsPageEnvelopeSchema = z.object({
  data: connectionsPageResultSchema,
});

export type ConnectionLastCheck = z.infer<typeof connectionLastCheckSchema>;
export type CustodyConnectionListItem = z.infer<typeof custodyConnectionListItemSchema>;
export type ConnectionsPageResult = z.infer<typeof connectionsPageResultSchema>;

export interface ConnectionsFilters {
  page: number;
}

/**
 * The connections the project holds with one provider, as far as a bounded read
 * could see them, and whether that turned out to be all of them.
 */
export interface ProviderConnections {
  connections: CustodyConnectionListItem[];
  complete: boolean;
}

/**
 * What the banners above the table and the Make-default dialog assert, derived
 * from the whole project rather than the rows currently on screen.
 */
export interface ConnectionsProjectSummary {
  activeCount: number;
  defaultConnection: { id: string; label: string } | null;
  signingPaused: boolean;
  /**
   * False when the project holds more connections than the loader reads. The
   * table is still correct as far as it goes; the project-level claims are not,
   * so callers stay quiet instead of stating them.
   */
  complete: boolean;
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

/** The widest slice the endpoint serves; asking for more is silently clamped there. */
const CONNECTIONS_FETCH_LIMIT = 50;

/**
 * Four requests' worth. Past this the summary read stops and says so rather
 * than walking an unbounded list on every render of the provider page.
 */
const CONNECTIONS_FETCH_MAX = 200;

async function fetchConnectionsSlice(
  request: SdpApiClient["request"],
  { provider, limit, offset }: { provider: CustodyProvider; limit: number; offset: number }
): Promise<ConnectionsPageResult> {
  // `provider` narrows the count and the slice together, server-side. Filtering
  // a page after reading it would leave the row count and the total counting
  // different things, and would drop this provider's older connections as soon
  // as the project held more of others than one read covers.
  const query = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    provider,
  });
  const res = await request(`/internal/dashboard/custody/connections?${query.toString()}`);
  if (!res.ok) {
    throw new ConnectionsRequestError(res.status);
  }
  return connectionsPageEnvelopeSchema.parse(await res.json()).data;
}

/**
 * The rows for one page of the table.
 *
 * One request for the page the user is looking at, never the whole inventory:
 * because the endpoint narrows to the provider itself, its `total` is this
 * provider's total and the rows are this provider's page, at any project size.
 *
 * A `?page=` past the end (a stale URL, or an inventory that shrank under the
 * bookmark) costs one more request and lands on the last page that exists,
 * rather than rendering the empty state over a project that still has
 * connections. The page it settled on is returned so the footer, the URL and
 * the rows agree.
 */
export async function fetchConnectionsPage(
  request: SdpApiClient["request"],
  provider: CustodyProvider,
  filters: ConnectionsFilters
): Promise<{ result: ConnectionsPageResult; filters: ConnectionsFilters }> {
  const read = (page: number) =>
    fetchConnectionsSlice(request, {
      provider,
      limit: CONNECTIONS_PAGE_SIZE,
      offset: (page - 1) * CONNECTIONS_PAGE_SIZE,
    });

  const result = await read(filters.page);
  // Rows on the page settle it whatever the total says, and a page within range
  // is served as it came back — an empty page 1 is the empty state, not a stale
  // bookmark, and re-reading it would only ask the same question twice.
  const lastPage = Math.max(1, Math.ceil(result.pagination.total / CONNECTIONS_PAGE_SIZE));
  if (result.connections.length > 0 || filters.page <= lastPage) {
    return { result, filters };
  }
  return { result: await read(lastPage), filters: { ...filters, page: lastPage } };
}

/**
 * This provider's connections, for the claims that are about the project rather
 * than about the page: whether a default exists at all, and whether signing is
 * paused everywhere.
 *
 * Bounded on purpose. Those two questions need every connection, and no
 * endpoint answers them directly, so the read walks pages until it runs out or
 * hits the cap — and when it hits the cap it says so, which is what lets the
 * callers stay quiet instead of stating something they could not check. The
 * table itself never comes from here: it is paged by the server, so nothing on
 * screen is bounded by this cap.
 */
export async function fetchProviderConnections(
  request: SdpApiClient["request"],
  provider: CustodyProvider
): Promise<ProviderConnections> {
  const collected: CustodyConnectionListItem[] = [];
  let offset = 0;
  let total = 0;

  do {
    const page = await fetchConnectionsSlice(request, {
      provider,
      limit: CONNECTIONS_FETCH_LIMIT,
      offset,
    });
    total = page.pagination.total;
    // A short page against a nonzero total means rows moved under the read.
    // Stopping beats looping on an offset the server has already declined to
    // fill; `complete` then reports what the caller is missing.
    if (page.connections.length === 0) {
      break;
    }
    collected.push(...page.connections);
    offset += page.connections.length;
  } while (offset < total && offset < CONNECTIONS_FETCH_MAX);

  return { connections: collected, complete: offset >= total };
}

/**
 * The project-level facts the table's banners state.
 *
 * Deliberately not derived from the visible page: "no default connection" and
 * "signing is paused" are claims about the project, and a default sitting on
 * page 2 would have made both of them false alarms.
 */
export function summarizeProviderConnections(
  project: ProviderConnections
): ConnectionsProjectSummary {
  const active = project.connections.filter((connection) => connection.status === "active");
  const current = active.find((connection) => connection.isDefault) ?? null;

  return {
    activeCount: active.length,
    defaultConnection: current ? { id: current.id, label: current.label } : null,
    signingPaused:
      active.length > 0 && active.every((connection) => !connection.isRuntimeExecutionAllowed),
    complete: project.complete,
  };
}

/**
 * The connections a wallet can be created in, for the setup wizard's picker.
 *
 * Deactivated connections are dropped — they can never accept a wallet — while
 * pending and failed ones are kept so the picker can show them disabled with a
 * reason, rather than leave the user wondering where their connection went.
 *
 * Returns `[]` instead of throwing on any failure: the endpoint requires
 * `custody:admin`, and someone allowed to create a wallet without it must still
 * reach the wizard's provider form.
 */
export async function fetchConnectionPickerOptions(
  request: SdpApiClient["request"],
  provider: CustodyProvider
): Promise<CustodyConnectionListItem[]> {
  try {
    const page = await fetchConnectionsSlice(request, {
      provider,
      limit: CONNECTIONS_FETCH_LIMIT,
      offset: 0,
    });
    return page.connections.filter((connection) => connection.status !== "deactivated");
  } catch {
    return [];
  }
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
