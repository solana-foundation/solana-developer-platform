import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request) {
  return proxyToSdpApi(request, "route.dashboard.payment-requests.create", "/v1/payments/requests");
}
