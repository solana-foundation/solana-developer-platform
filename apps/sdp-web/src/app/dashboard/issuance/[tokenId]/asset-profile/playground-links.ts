/**
 * Deep links from the asset-management workspace into the shared API playground
 * (on the issuance overview page). The playground reads `?tab`, `?endpoint`, and
 * `?tokenId` from the URL, so a link preselects the endpoint + this token and the
 * resulting state is shareable. Endpoint ids match issuance-playground-config.ts.
 */

// Endpoint shown when opening the playground without a specific action.
const DEFAULT_ENDPOINT_ID = "get-token";

export function buildIssuancePlaygroundHref(tokenId: string, endpointId?: string): string {
  const params = new URLSearchParams({
    tab: "playground",
    endpoint: endpointId ?? DEFAULT_ENDPOINT_ID,
    tokenId,
  });
  return `/dashboard/issuance?${params.toString()}`;
}
