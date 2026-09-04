import "server-only";

import type { OrganizationRpcProvider, RpcConnectionListResponse } from "@sdp/types";
import { ORGANIZATION_RPC_PROVIDERS } from "@sdp/types";
import { createSdpApiClient } from "@/lib/sdp-api";

export const CONNECTION_PAGE_SIZE = 50;

type Connection = RpcConnectionListResponse["connections"][number];

/**
 * Read one scope's connections to the end.
 *
 * Pages rather than taking the first response: the list is organization-wide,
 * so truncating at one page and then narrowing by provider would hide
 * credentials that exist but sit past the cut.
 */
export async function collectConnections(
  client: Awaited<ReturnType<typeof createSdpApiClient>>,
  scope: "project" | "organization"
): Promise<Connection[]> {
  const collected: Connection[] = [];
  let offset = 0;
  let total = 0;

  do {
    const payload = await client.fetch<RpcConnectionListResponse>(
      `/internal/dashboard/rpc/connections?scope=${scope}&limit=${CONNECTION_PAGE_SIZE}&offset=${offset}`
    );
    collected.push(...payload.connections);
    total = payload.pagination.total;
    offset += CONNECTION_PAGE_SIZE;
    // A page that comes back short means the list ended, whatever total says.
    if (payload.connections.length < CONNECTION_PAGE_SIZE) {
      break;
    }
  } while (collected.length < total);

  return collected;
}

/**
 * The provider the relay would route this project through, if any.
 *
 * Deliberately the same three-part test the row's "Serving traffic" badge uses
 * — project-scoped, active, and the default. A project may hold a proven key
 * per provider now, so `active` alone answers "does this key work", not "is
 * this the one". Anything looser named a provider that routes nothing, and the
 * copy built on it told people traffic ran somewhere it did not.
 */
export function findServingProvider(
  connections: readonly Connection[]
): OrganizationRpcProvider | null {
  const serving = connections.find(
    (connection) =>
      connection.scope === "project" && connection.status === "active" && connection.isDefault
  );
  if (!serving) {
    return null;
  }
  return (ORGANIZATION_RPC_PROVIDERS as readonly string[]).includes(serving.provider)
    ? (serving.provider as OrganizationRpcProvider)
    : null;
}

/** Every provider this scope holds a key for that has not been withdrawn. */
export function findProvidersWithOwnKey(connections: readonly Connection[]): string[] {
  const providers = new Set<string>();
  for (const connection of connections) {
    if (connection.scope === "project" && connection.status !== "deactivated") {
      providers.add(connection.provider);
    }
  }
  return [...providers];
}

/**
 * What the tenant's own credentials say about this project, for surfaces that
 * need the answer and not the list — the catalog states which providers are
 * connected but offers no control over any individual credential.
 *
 * The empty answer covers three things the caller treats alike on purpose:
 * nothing of the tenant's own is here, the viewer may not read connections (the
 * internal routes are org:admin for reads as well as writes), or the read
 * failed. In every one of them the organization's selection is the best answer
 * we hold, which is what the catalog showed before BYOK existed — so a member
 * sees exactly what they saw before rather than a claim we cannot support.
 */
export async function fetchRpcTenantState(canManage: boolean): Promise<{
  servingProvider: OrganizationRpcProvider | null;
  providersWithOwnKey: string[];
}> {
  if (!canManage) {
    return { servingProvider: null, providersWithOwnKey: [] };
  }

  try {
    const client = await createSdpApiClient();
    // Project scope only. Organization-scoped rows are the pre-HOO-1226
    // leftovers the relay no longer resolves, so none of them can be serving
    // and fetching them here would only cost a round trip.
    const connections = await collectConnections(client, "project");
    return {
      servingProvider: findServingProvider(connections),
      providersWithOwnKey: findProvidersWithOwnKey(connections),
    };
  } catch {
    return { servingProvider: null, providersWithOwnKey: [] };
  }
}
