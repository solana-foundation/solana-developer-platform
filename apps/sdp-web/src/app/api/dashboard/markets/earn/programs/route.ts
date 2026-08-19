import { proxyToSdpApi } from "@/lib/sdp-api";
import { programProxyQuery } from "../provider-query";

export async function GET(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.programs.list",
    path: `/v1/earn/programs${programProxyQuery(request, { provider: true, page: true })}`,
  });
}

/**
 * Explicit create (PRO-1670). The API requires exactly one of a body
 * `requestId` or an `Idempotency-Key` header — this legacy program client sends
 * the body form. The route intentionally supplies no upstream headers, so an
 * inbound `Idempotency-Key` is still dropped rather than implicitly relayed.
 */
export async function POST(request: Request) {
  return proxyToSdpApi({
    request,
    traceSource: "route.dashboard.earn.programs.create",
    path: "/v1/earn/programs",
  });
}
