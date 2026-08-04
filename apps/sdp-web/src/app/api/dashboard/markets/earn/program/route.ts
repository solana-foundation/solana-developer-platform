import { proxyToSdpApi } from "@/lib/sdp-api";
import { programProxyQuery } from "./provider-query";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.program.get",
    path: `/v1/earn/program${programProxyQuery(request)}`,
  });
}

export async function PUT(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.program.upsert",
    path: "/v1/earn/program",
  });
}
