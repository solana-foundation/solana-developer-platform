import {
  earnMovementsProxyQuery,
  proxyQueryErrorResponse,
} from "@/app/api/dashboard/markets/earn/provider-query";
import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  const validated = earnMovementsProxyQuery(request);
  if (!validated.ok) return proxyQueryErrorResponse(validated);

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.movements.list",
    path: `/v1/earn/movements${validated.query}`,
  });
}
