import { proxyToSdpApi } from "@/lib/sdp-api";

/**
 * Demo mode's Simulate verification. The SDP API has no such endpoint: demo mode answers this
 * path, and refuses it outside the demo before anything is sent upstream.
 */
export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.payments.demo.verifications.post",
    path: "/v1/payments/demo/verifications",
  });
}
