import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request) {
  return proxyToSdpApi(
    request,
    "route.dashboard.payments.ramps.sandbox.simulate.post",
    "/v1/payments/ramps/sandbox/simulate"
  );
}
