/**
 * The mainnet cluster's state from status.solana.com (a Statuspage page, keyless), folded to what
 * the Overview's badge tells apart.
 */
import {
  NETWORK_HEALTH_BY_STATUSPAGE_STATUS,
  type NetworkHealth,
  STATUSPAGE_COMPONENT_STATUSES,
} from "@sdp/types/network-metrics";
import { z } from "zod";
import { fetchProviderJson } from "@/lib/provider-json";
import { withVendorCall } from "@/runtime/vendor-calls";

const SOLANA_STATUS_COMPONENTS_URL = "https://status.solana.com/api/v2/components.json";

/** The badge is a nicety: a slow page drops it rather than holding the figures. */
export const SOLANA_STATUS_REQUEST_TIMEOUT_MS = 3_000;

/** The components list is a few kilobytes. */
const MAX_RESPONSE_BYTES = 256 * 1024;

/** status.solana.com's name in vendor calls, logs and errors. */
const PROVIDER = "solana-status";

/** The page's "Mainnet Beta - Cluster" component. */
const MAINNET_CLUSTER_COMPONENT_ID = "qxs6x3yc9cxg";

/** A state outside Statuspage's known ones fails the parse, which drops the badge rather than
 * guessing. */
const statusComponentsSchema = z.object({
  components: z.array(z.object({ id: z.string(), status: z.enum(STATUSPAGE_COMPONENT_STATUSES) })),
});
type StatusComponents = z.output<typeof statusComponentsSchema>;

/**
 * The cluster's health from the page's components.
 *
 * @param page - The page's parsed components.
 * @returns The cluster's health, or null when the page does not list the cluster.
 */
export function mainnetClusterHealth({ components }: StatusComponents): NetworkHealth | null {
  const cluster = components.find(({ id }) => id === MAINNET_CLUSTER_COMPONENT_ID);
  return cluster === undefined ? null : NETWORK_HEALTH_BY_STATUSPAGE_STATUS[cluster.status];
}

/**
 * Reads the page.
 *
 * @returns The cluster's health, or null when the page does not list the cluster.
 * @throws PROVIDER_UNAVAILABLE when the page does not answer usably; the caller shows no badge.
 */
export async function fetchMainnetClusterHealth(): Promise<NetworkHealth | null> {
  return withVendorCall(PROVIDER, "components", async () =>
    mainnetClusterHealth(
      await fetchProviderJson(PROVIDER, SOLANA_STATUS_COMPONENTS_URL, statusComponentsSchema, {
        method: "GET",
        headers: {},
        timeoutMs: SOLANA_STATUS_REQUEST_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
      })
    )
  );
}
