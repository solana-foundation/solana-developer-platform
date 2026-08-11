import { proxyToSdpApi } from "@/lib/sdp-api";
import { programProxyQuery } from "../../provider-query";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ withdrawalRef: string }> }
) {
  const { withdrawalRef } = await params;
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.program.withdrawals.get",
    path: `/v1/earn/program/withdrawals/${encodeURIComponent(withdrawalRef)}${programProxyQuery(request)}`,
  });
}
