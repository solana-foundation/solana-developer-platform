import { proxyToSdpApi } from "@/lib/sdp-api";

export async function POST(request: Request) {
  return proxyToSdpApi(
    request,
    "route.dashboard.payments.ramps.transfers.cancel.post",
    "/v1/payments/ramps/transfers/cancel"
  );
}
