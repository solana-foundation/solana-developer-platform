import { programProxyQuery } from "@/app/api/dashboard/markets/earn/provider-query";
import { proxyToSdpApi } from "@/lib/sdp-api";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.programs.list",
    path: `/v1/earn/programs${programProxyQuery(request, { provider: true, page: true })}`,
  });
}

/**
 * Explicit create (PRO-1670). The API requires exactly one of a body
 * `requestId` or an `Idempotency-Key` header — this legacy program client
 * sends the body form. No browser flow keys this POST, so the proxy's
 * `withForwardedIdempotencyKey` relay has nothing to forward here.
 */
export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.programs.create",
    path: "/v1/earn/programs",
  });
}
