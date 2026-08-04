/**
 * Deep links from the asset-management workspace into the shared API playground
 * (on the issuance overview page). The playground reads `?tab`, `?endpoint`, and
 * `?tokenId` from the URL, so a link preselects the endpoint + this token and the
 * resulting state is shareable. Endpoint ids match issuance-playground-config.ts.
 */

import type { FundManagementModalAction } from "../token-fund-management-section";
import type { AdminAction } from "../token-management-workspace.types";

type PlaygroundAction = AdminAction | FundManagementModalAction;

const ACTION_PLAYGROUND_ENDPOINTS: Record<PlaygroundAction, string> = {
  "update-metadata": "update-token",
  deploy: "deploy-token",
  mint: "mint-execute",
  burn: "burn-execute",
  seize: "seize-execute",
  "force-burn": "force-burn-execute",
  freeze: "freeze-account",
  pause: "pause-token",
  allowlist: "add-allowlist-entry",
  authority: "authority-execute",
};

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

export function playgroundHrefForAction(tokenId: string, action: PlaygroundAction): string {
  return buildIssuancePlaygroundHref(tokenId, ACTION_PLAYGROUND_ENDPOINTS[action]);
}
