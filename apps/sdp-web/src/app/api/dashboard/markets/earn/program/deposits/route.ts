import { proxyToSdpApi } from "@/lib/sdp-api";
import { programProxyQuery } from "../provider-query";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.program.deposits.list",
    path: `/v1/earn/program/deposits${programProxyQuery(request, { cursor: true })}`,
  });
}
