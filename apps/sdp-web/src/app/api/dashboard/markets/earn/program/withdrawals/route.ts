import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.program.withdrawals.create",
    path: "/v1/earn/program/withdrawals",
  });
}
