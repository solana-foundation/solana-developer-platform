import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payments.requests.list",
    path: `/v1/payments/requests${new URL(request.url).search}`,
  });
}

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payment-requests.create",
    path: "/v1/payments/requests",
  });
}
