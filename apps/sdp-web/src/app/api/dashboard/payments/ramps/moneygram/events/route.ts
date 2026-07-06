import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payments.ramps.moneygram.events.post",
    path: "/v1/payments/ramps/moneygram/events",
  });
}
