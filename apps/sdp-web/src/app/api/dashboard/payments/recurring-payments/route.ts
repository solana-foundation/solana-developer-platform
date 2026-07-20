import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.recurring-payments.list",
    path: `/v1/payments/recurring-payments${new URL(request.url).search}`,
  });
}

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.recurring-payments.create",
    path: "/v1/payments/recurring-payments",
  });
}
