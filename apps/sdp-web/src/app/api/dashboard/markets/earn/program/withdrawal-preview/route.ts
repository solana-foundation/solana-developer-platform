import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.program.withdrawal-preview",
    path: "/v1/earn/program/withdrawal-preview",
  });
}
