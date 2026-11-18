import { programProxyQuery } from "@/app/api/dashboard/markets/earn/provider-query";
import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.programs.list",
    path: `/v1/earn/programs${programProxyQuery(request, { provider: true, page: true })}`,
  });
}
