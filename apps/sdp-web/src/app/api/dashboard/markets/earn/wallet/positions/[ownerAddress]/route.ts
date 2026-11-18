import {
  proxyQueryErrorResponse,
  walletPositionsProxyQuery,
} from "@/app/api/dashboard/markets/earn/provider-query";
import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ ownerAddress: string }> }
) {
  const validated = walletPositionsProxyQuery(request);
  if (!validated.ok) return proxyQueryErrorResponse(validated);

  const { ownerAddress } = await params;
  // The API addresses the owner as a required query filter (the shape every
  // per-owner wallet read shares); this route keeps its dashboard
  // path-param shape and translates.
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.wallet_positions.list",
    path: `/v1/earn/external-wallet/positions?ownerAddress=${encodeURIComponent(ownerAddress)}${validated.query.replace(/^\?/, "&")}`,
  });
}
