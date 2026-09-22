import { proxyToSdpApi } from "@/lib/sdp-api";
import { earnMovementsProxyQuery, proxyQueryErrorResponse } from "../provider-query";

export async function GET(request: Request) {
  const validated = earnMovementsProxyQuery(request);
  if (!validated.ok) return proxyQueryErrorResponse(validated);

  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.movements.list",
    path: `/v1/earn/movements${validated.query}`,
  });
}
