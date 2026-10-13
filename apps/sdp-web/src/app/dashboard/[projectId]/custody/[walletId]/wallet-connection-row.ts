import {
  ConnectionDetailRequestError,
  type CustodyInstallationConnection,
  fetchConnectionInstallation,
} from "@/app/dashboard/[projectId]/custody/connections/connection-detail.data";
import { truncateMiddle } from "@/app/dashboard/[projectId]/custody/wallet-format-utils";
import { offersCustodyMode } from "@/lib/provider-availability";
import { fetchProjectProviderAvailability } from "@/lib/provider-availability.server";
import { requestProjectHref, type SdpApiClient } from "@/lib/sdp-api";

/**
 * The connection row of a wallet created in a custody connection: the
 * connection's label, linked to its detail page, for a viewer who may manage
 * custody, and the truncated connection id, unlinked, for one who may not read
 * connections or whose lookup is refused (403) or finds no connection (404).
 * The label stays unlinked while the project does not offer the connection's
 * provider in `byok` mode, the same rule that hides the detail page. Any other
 * lookup failure throws.
 *
 * @param params - The wallet's connection and the viewer's access.
 * @param params.client - The client scoped to the request's project.
 * @param params.connectionId - The wallet's custody connection id, absent for a Managed wallet.
 * @param params.canManageCustody - Whether the viewer may read custody connections.
 * @returns The row's label and link, or `null` for a Managed wallet.
 */
export async function resolveWalletConnectionRow(params: {
  client: SdpApiClient;
  connectionId: string | undefined;
  canManageCustody: boolean;
}): Promise<{ label: string; href: string | undefined } | null> {
  const { client, connectionId, canManageCustody } = params;
  if (connectionId === undefined) {
    return null;
  }
  if (!canManageCustody) {
    return { label: truncateMiddle(connectionId), href: undefined };
  }
  let connection: CustodyInstallationConnection;
  try {
    connection = await fetchConnectionInstallation(client.request, connectionId);
  } catch (error) {
    if (
      error instanceof ConnectionDetailRequestError &&
      (error.status === 403 || error.status === 404)
    ) {
      return { label: truncateMiddle(connectionId), href: undefined };
    }
    throw error;
  }
  if (
    !offersCustodyMode(await fetchProjectProviderAvailability(client), connection.provider, "byok")
  ) {
    return { label: connection.label, href: undefined };
  }
  return {
    label: connection.label,
    href: await requestProjectHref(
      `/dashboard/integrations/${connection.provider}/connections/${connectionId}`
    ),
  };
}
