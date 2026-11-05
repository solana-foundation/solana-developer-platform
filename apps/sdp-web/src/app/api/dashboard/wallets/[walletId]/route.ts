import { custodyWalletMetadataSchema } from "@sdp/types/custody";
import { z } from "zod";
import { resolveWalletConnectionRow } from "@/app/(session)/dashboard/[projectId]/wallets/[walletId]/wallet-connection-row";
import { resolveDashboardAccess } from "@/lib/dashboard-access";
import { dashboardJson } from "@/lib/dashboard-response";
import { createTimedTrace, logRouteResult } from "@/lib/request-tracing";
import { createSdpApiClient, proxyToSdpApi, requestMemberRole } from "@/lib/sdp-api";
import { getWalletMetadataPath } from "@/lib/sdp-api-paths";

const walletMetadataEnvelopeSchema = z.object({
  data: z.object({ wallet: custodyWalletMetadataSchema }),
});

/**
 * One wallet's record and the connection row its page shows, read the way the wallet page read
 * them on the server: the record, then the viewer's role, then the connection and the
 * Project's provider availability. A refused record read is passed through as sdp-api answered.
 */
export async function GET(request: Request, context: { params: Promise<{ walletId: string }> }) {
  const { walletId } = await context.params;
  const walletResponse = await proxyToSdpApi({
    request,
    traceSource: "route.dashboard.wallets.detail.record",
    path: getWalletMetadataPath(walletId),
  });
  if (!walletResponse.ok) {
    return walletResponse;
  }

  const trace = createTimedTrace("route.dashboard.wallets.detail", request);
  try {
    const parsed = walletMetadataEnvelopeSchema.safeParse(await walletResponse.json());
    if (!parsed.success) {
      logRouteResult(trace, 502, { error: "invalid wallet record" });
      return dashboardJson(
        { error: { message: "Invalid wallet response" } },
        { status: 502, trace }
      );
    }
    const wallet = parsed.data.data.wallet;
    const canManageCustody = resolveDashboardAccess(await requestMemberRole()).capabilities
      .canManageCustody;
    const connection = await resolveWalletConnectionRow({
      client: await createSdpApiClient(trace.childContext("route.dashboard.wallets.detail.api")),
      connectionId: wallet.custodyConnectionId,
      canManageCustody,
    });
    logRouteResult(trace, 200);
    return dashboardJson(
      {
        data: {
          wallet,
          connection:
            connection === null ? null : { label: connection.label, href: connection.href ?? null },
        },
      },
      { trace }
    );
  } catch (error) {
    logRouteResult(trace, 500, {
      error: error instanceof Error ? error.message : "Wallet request failed",
    });
    return dashboardJson({ error: { message: "Wallet request failed" } }, { status: 500, trace });
  }
}
